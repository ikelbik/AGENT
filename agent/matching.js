import Anthropic from '@anthropic-ai/sdk'
import { db } from '../db/postgres.js'

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// Embedding removed — using score-based matching only
export async function updateProfileEmbedding() {}

// Normalize goal_type regardless of language/format Claude used
function normalizeGoal(g) {
  if (!g) return 'business'
  if (/romantic|романт|личн|партн|любов|отнош|физическ|интимн|свидан|встреч|знаком/i.test(g)) return 'romantic'
  if (/mentor|ментор|наставн/i.test(g)) return 'mentor'
  return 'business'
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

const WEIGHTS = {
  romantic: { values: 0.28, comm: 0.22, compl: 0.12, stage: 0.22, domain: 0.04, openness: 0.12 },
  business: { values: 0.14, comm: 0.18, compl: 0.26, stage: 0.08, domain: 0.22, openness: 0.12 },
  mentor:   { values: 0.18, comm: 0.14, compl: 0.22, stage: 0.14, domain: 0.22, openness: 0.10 }
}

export function scoreCompatibility(profileA, profileB, log = () => {}) {
  // Hard deterministic filters before scoring
  if (!isOrientationCompatible(profileA, profileB)) {
    log(`    orientation mismatch: A(gender=${profileA.gender} orient=${profileA.orientation} pref=${profileA.partner_gender_preference}) B(gender=${profileB.gender} orient=${profileB.orientation} pref=${profileB.partner_gender_preference})`)
    return { score: 0, dimensions: {}, action: 'skip', reason: 'orientation' }
  }
  if (!isRelationshipFormatCompatible(profileA, profileB)) {
    log(`    format mismatch: A=${profileA.relationship_format} B=${profileB.relationship_format}`)
    return { score: 0, dimensions: {}, action: 'skip', reason: 'format' }
  }

  const goalType = normalizeGoal(profileA.goal_type)
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

  let totalScore = Object.entries(w).reduce((sum, [dim, weight]) => {
    return sum + (dimensions[dim] || 0.5) * weight
  }, 0)

  // For romantic goal — blend in intimate + physical compatibility
  if (goalType === 'romantic') {
    const intimateScore = intimateCompatibilityScore(profileA, profileB)
    if (intimateScore === 0) {
      log(`    intimate dealbreaker: A.tags=${JSON.stringify(profileA.intimate_tags)} B.db=${JSON.stringify(profileB.intimate_dealbreakers)} / B.tags=${JSON.stringify(profileB.intimate_tags)} A.db=${JSON.stringify(profileA.intimate_dealbreakers)}`)
      return { score: 0, dimensions, action: 'skip', reason: 'intimate_dealbreaker' }
    }

    const physScoreAB = physicalPreferencesScore(profileA, profileB)
    const physScoreBA = physicalPreferencesScore(profileB, profileA)
    const physScore   = (physScoreAB + physScoreBA) / 2
    if (physScore === 0) {
      log(`    physical mismatch: A→B=${physScoreAB.toFixed(2)} B→A=${physScoreBA.toFixed(2)} | A.prefs=${JSON.stringify(profileA.physical_preferences)} B.self=${JSON.stringify(profileB.physical_self)} | B.prefs=${JSON.stringify(profileB.physical_preferences)} A.self=${JSON.stringify(profileA.physical_self)}`)
      return { score: 0, dimensions, action: 'skip', reason: 'physical' }
    }

    log(`    intimate=${intimateScore.toFixed(2)} phys=${physScore.toFixed(2)}`)
    totalScore = totalScore * 0.65 + intimateScore * 0.20 + physScore * 0.15
  }

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
  if (goalA === 'mentor' || goalB === 'mentor') return true
  return false
}

// ─── Gender & orientation compatibility ──────────────────────────────────────

function isOrientationCompatible(a, b) {
  // Use explicit partner_gender_preference if available (most accurate)
  const prefA = a.partner_gender_preference
  const prefB = b.partner_gender_preference
  const genderA = a.gender
  const genderB = b.gender

  if (prefA && genderB) {
    if (!genderB.toLowerCase().includes(prefA.toLowerCase()) &&
        !prefA.toLowerCase().includes(genderB.toLowerCase()) &&
        prefA !== 'any' && prefA !== 'любой') return false
  }
  if (prefB && genderA) {
    if (!genderA.toLowerCase().includes(prefB.toLowerCase()) &&
        !prefB.toLowerCase().includes(genderA.toLowerCase()) &&
        prefB !== 'any' && prefB !== 'любой') return false
  }

  // Fallback: orientation-based check
  if (!a.orientation || !b.orientation) return true
  if (a.orientation === 'bisexual' || b.orientation === 'bisexual') return true
  if (a.orientation === 'heterosexual' && b.orientation === 'heterosexual')
    return !!genderA && !!genderB && genderA !== genderB
  if (a.orientation === 'homosexual' && b.orientation === 'homosexual')
    return !!genderA && !!genderB && genderA === genderB
  if ((a.orientation === 'heterosexual' && b.orientation === 'homosexual') ||
      (a.orientation === 'homosexual'  && b.orientation === 'heterosexual')) return false
  return true
}

// ─── Physical preferences score ───────────────────────────────────────────────

function physicalPreferencesScore(a, b) {
  // a looks at b's physical params against a's preferences
  let score = 1.0
  const prefsA = a.physical_preferences || {}
  const selfB  = b.physical_self || {}

  if (prefsA.age_min && b.age && b.age < prefsA.age_min) score -= 0.4
  if (prefsA.age_max && b.age && b.age > prefsA.age_max) score -= 0.4
  if (prefsA.height_min && selfB.height && selfB.height < prefsA.height_min) score -= 0.3
  if (prefsA.height_max && selfB.height && selfB.height > prefsA.height_max) score -= 0.3

  return Math.max(0, score)
}

// ─── Relationship format compatibility ───────────────────────────────────────

function isRelationshipFormatCompatible(a, b) {
  if (!a.relationship_format || !b.relationship_format) return true
  // serious needs serious, casual is flexible, open needs open or bi-compatible
  const strictPairs = [['serious', 'casual'], ['serious', 'open'], ['serious', 'poly']]
  const key = [a.relationship_format, b.relationship_format].sort().join('|')
  return !strictPairs.some(p => p.sort().join('|') === key)
}

// ─── Intimate tags overlap score ──────────────────────────────────────────────

function intimateCompatibilityScore(a, b) {
  const tagsA = a.intimate_tags || []
  const tagsB = b.intimate_tags || []
  const dbA   = a.intimate_dealbreakers || []
  const dbB   = b.intimate_dealbreakers || []

  if (tagsA.length === 0 && tagsB.length === 0) return 0.7

  // Check dealbreakers: if A's tag is in B's dealbreakers → incompatible
  const aViolatesB = tagsA.some(t => dbB.includes(t))
  const bViolatesA = tagsB.some(t => dbA.includes(t))
  if (aViolatesB || bViolatesA) return 0.0

  // Overlap score
  const union = new Set([...tagsA, ...tagsB])
  const intersection = tagsA.filter(t => tagsB.includes(t))
  return union.size > 0 ? intersection.length / union.size : 0.7
}

// ─── Hard filters check via Claude ───────────────────────────────────────────

async function passesHardFilters(profileA, profileB, log = () => {}) {
  const filtersA = profileA.hard_filters
  const filtersB = profileB.hard_filters
  const empty = v => !v || (typeof v === 'object' && Object.keys(v).length === 0)
  if (empty(filtersA) && empty(filtersB)) return true

  log(`  hard filters A: ${JSON.stringify(filtersA)} | B: ${JSON.stringify(filtersB)}`)

  try {
    const response = await claude.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 10,
      messages: [{
        role: 'user',
        content: `Проверь, есть ли ЯВНОЕ противоречие между жёсткими фильтрами двух профилей.
ФИЛЬТРЫ A: ${JSON.stringify(filtersA)}
ФИЛЬТРЫ B: ${JSON.stringify(filtersB)}
ПРОФИЛЬ A: ${profileA.showcase_public || ''}
ПРОФИЛЬ B: ${profileB.showcase_public || ''}
Правило: отвечай "no" ТОЛЬКО если в профиле есть прямое несоответствие фильтру (например, фильтр "не курящий", а в профиле написано "курю"). Если данных недостаточно — отвечай "yes". По умолчанию "yes".
Ответь ТОЛЬКО "yes" или "no".`
      }]
    })

    const answer = response.content[0].text.trim().toLowerCase()
    log(`  hard filters verdict: "${answer}"`)
    return answer.startsWith('yes')
  } catch (e) {
    log(`  hard filters ERROR: ${e.message} — defaulting to pass`)
    return true
  }
}

// ─── Find candidates ──────────────────────────────────────────────────────────

export async function findCandidates(userId, profile, log = () => {}) {
  const candidates = await db.findCandidatesWithoutEmbedding(userId, 50)
  log(`  DB returned ${candidates.length} raw candidates`)

  if (candidates.length === 0) return []

  // Filter by goal type compatibility
  const goalFiltered = candidates.filter(c => {
    const ok = isGoalCompatible(profile.goal_type, c.goal_type)
    if (!ok) log(`  SKIP ${c.user_id?.slice(0,8)} — goal mismatch: A=${profile.goal_type} B=${c.goal_type}`)
    return ok
  })
  log(`  after goal filter: ${goalFiltered.length}`)

  // Score each and log reason for skip
  const scored = []
  for (const c of goalFiltered) {
    const cid = c.user_id?.slice(0, 8)
    const scoring = scoreCompatibility(profile, c, (...a) => log(`  [${cid}]`, ...a))
    if (scoring.action === 'skip') {
      log(`  SKIP ${cid} — reason=${scoring.reason || 'score'} (${scoring.score.toFixed(2)}) goal=${c.goal_type} gender=${c.gender} orient=${c.orientation}`)
    } else {
      log(`  OK   ${cid} — score=${scoring.score.toFixed(2)} action=${scoring.action}`)
      scored.push({ ...c, scoring })
    }
  }

  log(`  after scoring: ${scored.length} pass`)
  return scored.sort((a, b) => b.scoring.score - a.scoring.score).slice(0, 10)
}

// ─── Agent-to-agent conversation (two independent agents) ────────────────────
//
// Each agent knows ONLY its own persona and sees only incoming messages.
// Neither agent knows the other's profile — friction is real, not simulated.

async function agentSpeak(myPersona, incomingMessage, conversationSoFar, isOpener) {
  const system = `Ты — агент, который представляет конкретного человека в разговоре с незнакомцем.

ТВОЯ ЛИЧНОСТЬ:
${myPersona}

Правила:
— Говори строго от этой личности: её ценности, стиль, интересы
— Ты НЕ знаешь профиль собеседника — только то что он написал
— Сообщение короткое: 25–40 слов, живое, естественное
— Без формальностей, без шаблонов
— Можешь задать вопрос, можно ответить на вопрос, можно поделиться мыслью`

  const messages = isOpener
    ? [{ role: 'user', content: 'Напиши первое сообщение незнакомому человеку. Только текст сообщения.' }]
    : [
        ...conversationSoFar,
        { role: 'user', content: incomingMessage }
      ]

  const response = await claude.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 120,
    system,
    messages
  })

  return response.content[0].text.trim()
}

async function agentConversation(profileA, profileB) {
  const personaA = profileA.persona_ref || profileA.showcase_public || ''
  const personaB = profileB.persona_ref || profileB.showcase_public || ''

  if (!personaA || !personaB) {
    return { score: 0.5, hypothesis: 'Недостаточно данных для диалога', openingMessage: '' }
  }

  // Each agent maintains its own conversation history (only sees own side + incoming)
  const historyA = [] // what agent A has said and received
  const historyB = [] // what agent B has said and received
  const transcript = []

  // Turn 1: A opens
  const msg1 = await agentSpeak(personaA, null, [], true)
  transcript.push({ from: 'A', text: msg1 })
  historyA.push({ role: 'assistant', content: msg1 })
  historyB.push({ role: 'user',      content: msg1 })

  // Turn 2: B responds (knows only A's opening, not A's profile)
  const msg2 = await agentSpeak(personaB, msg1, historyB.slice(0, -1), false)
  transcript.push({ from: 'B', text: msg2 })
  historyB.push({ role: 'assistant', content: msg2 })
  historyA.push({ role: 'user',      content: msg2 })

  // Turn 3: A replies
  const msg3 = await agentSpeak(personaA, msg2, historyA.slice(0, -1), false)
  transcript.push({ from: 'A', text: msg3 })
  historyA.push({ role: 'assistant', content: msg3 })
  historyB.push({ role: 'user',      content: msg3 })

  // Turn 4: B closes
  const msg4 = await agentSpeak(personaB, msg3, historyB.slice(0, -1), false)
  transcript.push({ from: 'B', text: msg4 })

  // Neutral evaluator — sees both personas and the conversation
  const evalResponse = await claude.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 150,
    messages: [{
      role: 'user',
      content: `Оцени совместимость двух людей по их разговору.

Профиль A: ${personaA}
Профиль B: ${personaB}

Разговор:
A: ${msg1}
B: ${msg2}
A: ${msg3}
B: ${msg4}

Ответь JSON одной строкой:
{"score":0.0-1.0,"hypothesis":"одно предложение о совместимости"}`
    }]
  })

  let score = 0.5
  let hypothesis = 'Умеренная совместимость'
  try {
    const parsed = JSON.parse(evalResponse.content[0].text.match(/\{.+\}/)?.[0] || '{}')
    score     = Math.min(1, Math.max(0, parsed.score     ?? 0.5))
    hypothesis = parsed.hypothesis ?? hypothesis
  } catch (e) { /* keep defaults */ }

  return { score, hypothesis, openingMessage: msg1, transcript }
}

// ─── Agent answers a question on behalf of its user ──────────────────────────

export async function agentAnswerQuestion(question, targetPersona) {
  const response = await claude.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 200,
    system: `Ты — агент, представляющий человека. Отвечай на вопросы от его лица, опираясь на его профиль.
Если вопрос личный и требует подтверждения от реального человека — выведи ROUTE_TO_USER и больше ничего.
Если можешь ответить уверенно из профиля — ответь кратко (1-2 предложения).

ПРОФИЛЬ ЧЕЛОВЕКА:
${targetPersona}`,
    messages: [{ role: 'user', content: question }]
  })

  const text = response.content[0].text.trim()
  if (text.startsWith('ROUTE_TO_USER')) return { routed: true, answer: null }
  return { routed: false, answer: text }
}

// ─── Run matching for a user ──────────────────────────────────────────────────

export async function runMatching(userId) {
  const log = (...args) => console.log(`[match:${userId.slice(0,8)}]`, ...args)

  const agents = await db.getAgents(userId)
  const confirmed = agents.filter(a => a.profile_confirmed && a.matching_active)

  if (confirmed.length === 0) {
    log('SKIP — no confirmed agents')
    return { error: 'Нет готовых агентов' }
  }

  log(`running for ${confirmed.length} agent(s)`)

  const allResults = { found: 0, matches: [] }
  for (const profile of confirmed) {
    const r = await runMatchingForProfile(userId, profile, log)
    allResults.found   += r.found   || 0
    allResults.matches.push(...(r.matches || []))
  }
  return allResults
}

async function runMatchingForProfile(userId, profile, log) {
  log(`profile: goal=${profile.goal_type} gender=${profile.gender} orient=${profile.orientation} format=${profile.relationship_format} persona=${!!profile.persona_ref}`)

  const candidates = await findCandidates(userId, profile, log)
  log(`candidates ready: ${candidates.length}`)

  if (candidates.length === 0) {
    return { found: 0, matches: [] }
  }

  const results = { found: candidates.length, matches: [] }
  const MAX_PER_RUN = parseInt(process.env.PINGS_PER_RUN || '5')

  for (const candidate of candidates) {
    if (results.matches.length >= MAX_PER_RUN) break

    const cid = candidate.user_id?.slice(0, 8)
    const { scoring } = candidate

    log(`→ candidate ${cid} | score=${scoring.score.toFixed(2)} action=${scoring.action}`)

    if (scoring.action === 'skip') {
      log(`  SKIP — score filter`)
      continue
    }

    const passes = await passesHardFilters(profile, candidate, log)
    if (!passes) {
      log(`  SKIP — hard filters`)
      continue
    }

    log(`  running agent conversation...`)
    const conv = await agentConversation(profile, candidate)
    log(`  conv score=${conv.score.toFixed(2)} | "${conv.hypothesis}"`)
    if (conv.transcript) {
      conv.transcript.forEach(t => log(`    [${t.from}]: ${t.text?.slice(0, 80)}`))
    }

    // data score (структура профиля) весит больше — агентский диалог вспомогательный
    const combinedScore = scoring.score * 0.6 + conv.score * 0.4
    log(`  combined=${combinedScore.toFixed(2)} (data=${scoring.score.toFixed(2)} conv=${conv.score.toFixed(2)})`)

    if (combinedScore < 0.35) {
      log(`  SKIP — combined score too low`)
      continue
    }

    const match = await db.createMatch(
      userId,
      candidate.user_id,
      combinedScore,
      conv.hypothesis,
      conv.transcript || [],
      profile.id,
      candidate.id
    )
    log(`  MATCH created ${match.id.slice(0,8)}`)

    results.matches.push({
      matchId:    match.id,
      userBId:    candidate.user_id,
      score:      combinedScore,
      hypothesis: conv.hypothesis
    })
  }

  log(`done — ${results.matches.length} matches from ${candidates.length} candidates`)
  return results
}

function detectTone(profile) {
  const directness = profile.communication_directness || 0.5
  const openness = profile.openness_score || 0.5
  if (profile.goal_type === 'business') return 'business'
  if (openness > 0.7) return 'curious'
  return 'direct'
}
