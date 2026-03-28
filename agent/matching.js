import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'
import { db } from '../db/postgres.js'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ─── Embedding ────────────────────────────────────────────────────────────────

export async function computeEmbedding(text) {
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text
  })
  return response.data[0].embedding
}

export async function updateProfileEmbedding(userId, profile) {
  const text = buildEmbeddingText(profile)
  const embedding = await computeEmbedding(text)
  await db.upsertProfile(userId, { embedding: JSON.stringify(embedding) })
  return embedding
}

function buildEmbeddingText(profile) {
  return [
    profile.goal_type,
    profile.archetype_tags?.join(' '),
    profile.showcase_public,
    profile.showcase_tags?.join(' '),
    profile.decision_style,
    JSON.stringify(profile.style_vector || {})
  ].filter(Boolean).join('. ')
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

const WEIGHTS = {
  romantic: { values: 0.28, comm: 0.22, compl: 0.12, stage: 0.22, domain: 0.04, openness: 0.12 },
  business: { values: 0.14, comm: 0.18, compl: 0.26, stage: 0.08, domain: 0.22, openness: 0.12 },
  mentor:   { values: 0.18, comm: 0.14, compl: 0.22, stage: 0.14, domain: 0.22, openness: 0.10 }
}

export function scoreCompatibility(profileA, profileB) {
  const goalType = profileA.goal_type || 'business'
  const w = WEIGHTS[goalType] || WEIGHTS.business

  // Similarity score (1 = identical, 0 = opposite)
  const sim = (a, b) => 1 - Math.abs((a || 0.5) - (b || 0.5))

  // Complementarity score (1 = opposite, 0 = identical)
  const comp = (a, b) => Math.abs((a || 0.5) - (b || 0.5))

  const dimensions = {
    values:   sim(profileA.openness_score, profileB.openness_score),
    comm:     sim(profileA.communication_directness, profileB.communication_directness),
    compl:    comp(
                profileA.style_vector?.structure || 0.5,
                profileB.style_vector?.structure || 0.5
              ),
    stage:    sim(
                profileA.style_vector?.pace || 0.5,
                profileB.style_vector?.pace || 0.5
              ),
    domain:   comp(
                profileA.style_vector?.directness || 0.5,
                profileB.style_vector?.directness || 0.5
              ),
    openness: sim(profileA.openness_score, profileB.openness_score)
  }

  const totalScore = Object.entries(w).reduce((sum, [dim, weight]) => {
    return sum + (dimensions[dim] || 0.5) * weight
  }, 0)

  return {
    score: totalScore,
    dimensions,
    action: totalScore >= 0.72 ? 'ping' : totalScore >= 0.5 ? 'watchlist' : 'skip'
  }
}

// ─── Goal type compatibility ──────────────────────────────────────────────────

function isGoalCompatible(goalA, goalB) {
  if (!goalA || !goalB) return true
  if (goalA === goalB) return true
  // mentor is compatible with anyone
  if (goalA === 'mentor' || goalB === 'mentor') return true
  return false
}

// ─── Hard filters check via Claude ───────────────────────────────────────────

async function passesHardFilters(profileA, profileB) {
  const filtersA = profileA.hard_filters
  const filtersB = profileB.hard_filters
  const empty = v => !v || (typeof v === 'object' && Object.keys(v).length === 0)
  if (empty(filtersA) && empty(filtersB)) return true

  const response = await claude.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 10,
    messages: [{
      role: 'user',
      content: `Проверь совместимость жёстких фильтров двух профилей.
ФИЛЬТРЫ A: ${JSON.stringify(filtersA)}
ФИЛЬТРЫ B: ${JSON.stringify(filtersB)}
ПРОФИЛЬ A: ${profileA.showcase_public || ''}
ПРОФИЛЬ B: ${profileB.showcase_public || ''}
Ответь ТОЛЬКО "yes" или "no".`
    }]
  })

  return response.content[0].text.trim().toLowerCase().startsWith('yes')
}

// ─── Find candidates ──────────────────────────────────────────────────────────

export async function findCandidates(userId, profile) {
  let candidates

  if (profile.embedding) {
    const embeddingArray = typeof profile.embedding === 'string'
      ? JSON.parse(profile.embedding)
      : profile.embedding
    candidates = await db.findCandidates(userId, embeddingArray, 30)
  } else {
    candidates = await db.findCandidatesWithoutEmbedding(userId, 50)
  }

  // Filter by goal type compatibility first (cheap, no API calls)
  const goalFiltered = candidates.filter(c =>
    isGoalCompatible(profile.goal_type, c.goal_type)
  )

  // Score and sort
  const scored = goalFiltered
    .map(c => ({ ...c, scoring: scoreCompatibility(profile, c) }))
    .filter(c => c.scoring.action !== 'skip')
    .sort((a, b) => b.scoring.score - a.scoring.score)
    .slice(0, 10)

  return scored
}

// ─── Generate cold ping ───────────────────────────────────────────────────────

export async function generatePing(senderProfile, recipientProfile, scoring, tone = 'direct') {
  const toneInstructions = {
    direct: 'Прямой, конкретный, без лишних слов. Сразу к сути.',
    curious: 'Любопытный, тёплый, через искреннее наблюдение.',
    business: 'Деловой, чёткий, уважающий время собеседника.'
  }

  const prompt = `Напиши холодный пинг от агента А агенту Б.

ПРОФИЛЬ ОТПРАВИТЕЛЯ:
${JSON.stringify(senderProfile, null, 2)}

ПРОФИЛЬ ПОЛУЧАТЕЛЯ:
${JSON.stringify(recipientProfile, null, 2)}

SCORE СОВМЕСТИМОСТИ: ${Math.round(scoring.score * 100)}%
СИЛЬНЫЕ СТОРОНЫ: ${Object.entries(scoring.dimensions)
  .filter(([, v]) => v > 0.65)
  .map(([k]) => k)
  .join(', ')}

ТОН: ${toneInstructions[tone] || toneInstructions.direct}

СТРУКТУРА ПИНГА (4 блока, до 80 слов):
1. ЗЕРКАЛО: конкретная деталь из витрины получателя (1 предложение)
2. ГИПОТЕЗА: почему мы могли бы быть совместимы (1-2 предложения)
3. ВОПРОС: один вопрос который важнее всего (1 предложение)
4. ВЫХОД: лёгкий отказ (1 короткое предложение)

Верни только текст пинга без заголовков блоков.`

  const response = await claude.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }]
  })

  const pingText = response.content[0].text

  // Generate hypothesis separately for internal use
  const hypothesisPrompt = `В одном предложении: почему эти два профиля могут быть совместимы?
Профиль A: ${senderProfile.showcase_public}
Профиль B: ${recipientProfile.showcase_public}`

  const hypResponse = await claude.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 100,
    messages: [{ role: 'user', content: hypothesisPrompt }]
  })

  return {
    pingText,
    hypothesis: hypResponse.content[0].text
  }
}

// ─── Run matching for a user ──────────────────────────────────────────────────

export async function runMatching(userId) {
  const profile = await db.getProfile(userId)
  if (!profile || profile.onboarding_phase < 7) {
    return { error: 'Профиль не завершён' }
  }

  const candidates = await findCandidates(userId, profile)
  if (candidates.length === 0) {
    return { found: 0, pings: [], watchlist: [] }
  }

  const results = { found: candidates.length, pings: [], watchlist: [] }
  const MAX_PINGS_PER_RUN = parseInt(process.env.PINGS_PER_RUN || '5')

  for (const candidate of candidates) {
    if (results.pings.length >= MAX_PINGS_PER_RUN) break

    const { scoring } = candidate

    if (scoring.action === 'ping') {
      // Check hard filters via Claude before sending ping
      const passes = await passesHardFilters(profile, candidate)
      if (!passes) continue

      const withinQuota = await db.checkPingQuota(userId)
      if (!withinQuota) break

      const { pingText, hypothesis } = await generatePing(
        profile,
        candidate,
        scoring,
        detectTone(candidate)
      )

      const ping = await db.createPing(
        userId,
        candidate.user_id,
        scoring.score,
        hypothesis,
        pingText
      )

      results.pings.push({
        pingId: ping.id,
        recipientId: candidate.user_id,
        score: scoring.score,
        hypothesis
      })

    } else if (scoring.action === 'watchlist') {
      await db.addToWatchlist(
        userId,
        candidate.user_id,
        scoring.score,
        'Умеренная совместимость, добавлен в watchlist'
      )
      results.watchlist.push({ userId: candidate.user_id, score: scoring.score })
    }
  }

  return results
}

function detectTone(profile) {
  const directness = profile.communication_directness || 0.5
  const openness = profile.openness_score || 0.5
  if (profile.goal_type === 'business') return 'business'
  if (openness > 0.7) return 'curious'
  return 'direct'
}
