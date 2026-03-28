import Anthropic from '@anthropic-ai/sdk'
import { db } from '../db/postgres.js'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export async function updateProfileEmbedding() {} // stub — embedding removed

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

ФОРМАТ КАЖДОГО ОТВЕТА:
[текст разговора]

DATA:{"goal_type":"...","field":"value"} ← однострочный JSON, только поля о которых уверен

Когда собрал ВСЕ нужные поля для цели пользователя — добавь после DATA:
DONE
PERSONA_REF:Я — [3–5 предложений от первого лица: кто ты, твои особенности и стиль, кого ищешь и почему]`

// ─── Main onboarding function ─────────────────────────────────────────────────

export async function conductOnboarding(userId, userMessage) {
  const profile = await db.getProfile(userId)

  if (profile?.onboarding_phase === 8) {
    return { done: true, message: null }
  }

  const history = await db.getRecentConversation(userId, 40)
  const knownData = profile?.onboarding_data || {}

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

  // Parse DATA block (single line JSON after DATA:)
  const dataMatch = raw.match(/DATA:(\{[^\n]+\})/)
  const isDone = /\nDONE/.test(raw)
  const personaMatch = raw.match(/PERSONA_REF:([\s\S]+)$/)

  // Strip markers from user-visible text
  const cleanText = raw
    .replace(/\nDATA:\{[^\n]+\}/, '')
    .replace(/\nDONE/, '')
    .replace(/\nPERSONA_REF:[\s\S]+$/, '')
    .trim()

  // Merge newly extracted data
  let newData = { ...knownData }
  if (dataMatch) {
    try {
      const extracted = JSON.parse(dataMatch[1])
      newData = { ...knownData, ...extracted }
    } catch (e) {
      console.error('DATA parse error:', dataMatch[1], e.message)
    }
  }

  // Save conversation turn
  await db.saveConversation(userId, 'user', userMessage)
  await db.saveConversation(userId, 'assistant', cleanText)

  if (isDone && personaMatch) {
    const personaRef = personaMatch[1].trim()
    await finalizeProfile(userId, newData, personaRef)
    return { done: false, finalPhase: true, message: cleanText, personaRef }
  }

  // Save partial progress
  await db.upsertProfile(userId, {
    onboarding_phase: 1,
    onboarding_data: newData
  })

  return { done: false, message: cleanText }
}

// ─── Finalize profile ─────────────────────────────────────────────────────────

async function finalizeProfile(userId, data, personaRef) {
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
    onboarding_data:          data
  }

  // Drop undefined — let DB keep existing values
  const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined))
  await db.upsertProfile(userId, clean)
}
