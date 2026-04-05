import Anthropic from '@anthropic-ai/sdk'
import { db } from '../db/postgres.js'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export async function updateProfileEmbedding() {} // stub

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Ты — агент-интервьюер сервиса знакомств AgentNet.

ЗАДАЧА: собери данные профиля через свободный разговор. Не анкета — живой диалог.

КАК РАБОТАТЬ:
— Слушай внимательно, извлекай данные из каждого ответа
— Задавай уточняющий вопрос ТОЛЬКО если не хватает важных данных для цели
— По одному вопросу за раз
— Тон: тёплый, любопытный, без осуждения
— Для romantic: приватные вопросы (тело, интимные предпочтения) в конце, предупреди что видит только алгоритм
— ЗАПРЕЩЕНО: не спрашивай имя, телефон, email, адрес

ПОЛЯ ДЛЯ СБОРА:
Базовые (все цели):
• goal_type: "romantic" | "business" | "mentor"
• archetype_tags: ["tag1","tag2"] — теги личности
• decision_style: "intuitive" | "analytical" | "mixed"
• communication_directness: 0.0–1.0
• openness_score: 0.0–1.0
• hard_filters: {} — жёсткие ограничения
• style_vector: {"directness":0-1,"pace":0-1,"structure":0-1}
• showcase_public: "2-3 предложения о человеке от третьего лица для витрины"
• showcase_tags: ["tag1","tag2"]

Для "romantic" дополнительно:
• gender, age
• physical_self: {"height":см,"weight":кг,"body_type":"строка"}
• orientation: "heterosexual"|"homosexual"|"bisexual"|"other"
• relationship_format: "serious"|"casual"|"open"|"poly"
• partner_gender_preference: "male"|"female"|"any"
• physical_preferences: {"age_min":N,"age_max":N,"height_min":N,"height_max":N}
• intimate_tags: [] — предпочтения
• intimate_dealbreakers: [] — абсолютные нет

Веди разговор естественно — только вопросы и уточнения, без служебных блоков.

Когда собрал ВСЕ нужные поля — добавь в конец ответа (невидимо для пользователя):
DONE
DATA:{"goal_type":"...","field":"value",...все поля одной строкой...}
PERSONA_REF:Я — [3–5 предложений от первого лица: кто ты, твои особенности и стиль, кого ищешь и почему]`

// ─── Main onboarding function ─────────────────────────────────────────────────

export async function conductOnboarding(agentId, userMessage) {
  const agent = await db.getAgentById(agentId)
  if (!agent) throw new Error('Agent not found')

  if (agent.onboarding_phase === 8) {
    return { done: true, message: null }
  }

  const history   = await db.getOnboardingHistory(agentId, 40)
  const knownData = agent.onboarding_data || {}

  const knownStr = Object.keys(knownData).length > 0
    ? `\n\nУЖЕ ИЗВЕСТНО О ПОЛЬЗОВАТЕЛЕ:\n${JSON.stringify(knownData, null, 2)}`
    : ''

  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 700,
    system: SYSTEM_PROMPT + knownStr,
    messages: [
      ...history.map(h => ({ role: h.role, content: h.content })),
      { role: 'user', content: userMessage }
    ]
  })

  const raw = response.content[0].text

  const isDone      = /DONE\n/.test(raw) || raw.includes('\nDONE')
  const dataMatch   = isDone ? raw.match(/DATA:(\{.+?\})\s*\n?PERSONA_REF:/s) || raw.match(/DATA:(\{[^\n]+\})/) : null
  const personaMatch = isDone ? raw.match(/PERSONA_REF:([\s\S]+)$/) : null

  const cleanText = raw
    .replace(/\nDONE[\s\S]*$/, '')
    .replace(/DONE[\s\S]*$/, '')
    .trim()

  let newData = { ...knownData }
  if (isDone && dataMatch) {
    try {
      newData = { ...knownData, ...JSON.parse(dataMatch[1]) }
    } catch (e) {
      console.error('DATA parse error:', dataMatch?.[1], e.message)
    }
  }

  await db.saveOnboardingMessage(agentId, 'user',      userMessage)
  await db.saveOnboardingMessage(agentId, 'assistant', cleanText)

  if (isDone && personaMatch) {
    const personaRef = personaMatch[1].trim()
    await finalizeProfile(agentId, newData, personaRef)
    return { done: false, finalPhase: true, message: cleanText, personaRef }
  }

  await db.updateAgent(agentId, { onboarding_phase: 1, onboarding_data: newData })

  return { done: false, message: cleanText }
}

// ─── Finalize profile ─────────────────────────────────────────────────────────

async function finalizeProfile(agentId, data, personaRef) {
  const fields = {
    goal_type:                data.goal_type,
    archetype_tags:           data.archetype_tags,
    decision_style:           data.decision_style,
    communication_directness: data.communication_directness,
    openness_score:           data.openness_score,
    hard_filters:             data.hard_filters             ?? {},
    style_vector:             data.style_vector             ?? {},
    showcase_public:          data.showcase_public,
    showcase_tags:            data.showcase_tags,
    gender:                   data.gender,
    age:                      data.age,
    physical_self:            data.physical_self            ?? {},
    orientation:              data.orientation,
    relationship_format:      data.relationship_format,
    partner_gender_preference:data.partner_gender_preference,
    physical_preferences:     data.physical_preferences     ?? {},
    intimate_tags:            data.intimate_tags,
    intimate_dealbreakers:    data.intimate_dealbreakers,
    persona_ref:              personaRef,
    onboarding_phase:         8,
    onboarding_data:          data,
    profile_updated_at:       new Date()
  }

  const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined))
  await db.updateAgent(agentId, clean)
}
