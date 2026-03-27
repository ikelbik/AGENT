import Anthropic from '@anthropic-ai/sdk'
import { db } from '../db/postgres.js'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ─── Phase definitions ────────────────────────────────────────────────────────

export const PHASES = {
  1: {
    name: 'Якорь',
    goal: 'Понять контекст и тип цели пользователя',
    questions: [
      'Что привело тебя сюда — что-то конкретное случилось, или это давнее желание?',
      'Скажи одним словом: что сейчас важнее — партнёрство, рост, или связь?',
      'Ты уже знаешь кого ищешь, или хочешь разобраться в этом вместе?'
    ],
    outputFields: ['goal_type', 'urgency_signal', 'self_awareness_level']
  },
  2: {
    name: 'Автопортрет',
    goal: 'Построить образ человека через конкретные ситуации',
    questions: [
      'Опиши период, когда ты был в своей лучшей форме. Что происходило?',
      'Как ты обычно принимаешь важные решения — долго взвешиваешь или чувствуешь сразу?',
      'Чем ты отличаешься от большинства людей в твоей сфере?'
    ],
    outputFields: ['archetype_tags', 'decision_style', 'domain_context']
  },
  3: {
    name: 'Образ желаемого',
    goal: 'Выяснить кого ищут через воспоминания и контрасты',
    questions: [
      'Вспомни человека, с которым тебе было бы идеально. Что в нём главное?',
      'Что тебя обычно разочаровывает в людях уже после первого месяца общения?',
      'Тебе важнее чтобы этот человек тебя дополнял или разделял твои взгляды?'
    ],
    outputFields: ['desired_archetype', 'implicit_expectations', 'complementarity_vs_similarity']
  },
  4: {
    name: 'Жёсткие фильтры',
    goal: 'Установить dealbreakers',
    questions: [
      'Есть ли что-то, при наличии чего у другого человека разговор просто не стоит начинать?',
      'Какие ограничения по расстоянию или формату для тебя принципиальны?',
      'Есть ли ценности, несовпадение по которым для тебя критично?'
    ],
    outputFields: ['hard_filters', 'geographic_constraints', 'value_dealbreakers']
  },
  5: {
    name: 'Стиль взаимодействия',
    goal: 'Понять коммуникационный стиль и ритм',
    questions: [
      'Ты предпочитаешь когда говорят прямо, даже если неудобно, или ценишь такт?',
      'Как часто ты готов общаться с новым человеком на старте?',
      'Тебе комфортно когда другой задаёт много вопросов о тебе?'
    ],
    outputFields: ['communication_directness', 'contact_frequency', 'openness_score']
  },
  6: {
    name: 'Стресс-тест',
    goal: 'Проверить реакцию на неопределённость и несогласие',
    questions: [
      'Представь: вы хорошо общаетесь три недели, а потом другой человек резко замолчал. Твоя первая реакция?',
      'Если я скажу что по профилю ты больше подходишь для делового партнёрства, а не для того что ты назвал — как отнесёшься?',
      'Вспомни момент когда ты сильно ошибся в человеке. Что это тебе дало?'
    ],
    outputFields: ['conflict_response', 'attachment_signal', 'self_reflection_capacity']
  }
}

const SYSTEM_PROMPT = `Ты — агент-интервьюер сервиса знакомств AgentNet.
Твоя задача: провести онбординг-интервью по 6 фазам, собирая информацию о пользователе.

Правила:
- Задавай ОДИН вопрос за раз, выбирая из пула фазы тот что наиболее уместен
- Слушай внимательно, задавай естественные уточнения если ответ неполный
- После 2-3 содержательных ответов в фазе — переходи к следующей
- Тон: тёплый, любопытный, без формальностей
- Не объясняй пользователю структуру интервью — просто веди разговор
- В конце каждой фазы извлеки структурированные данные в JSON

Текущая фаза и цель будут указаны в контексте.`

// ─── Main onboarding function ─────────────────────────────────────────────────

export async function conductOnboarding(userId, userMessage) {
  const profile = await db.getProfile(userId)
  const phase = (profile?.onboarding_phase || 0) + 1

  if (phase > 6) {
    return { done: true, message: null }
  }

  const phaseConfig = PHASES[phase]
  const history = await db.getRecentConversation(userId, 30)

  // Build phase-aware system prompt
  const systemPrompt = `${SYSTEM_PROMPT}

ТЕКУЩАЯ ФАЗА: ${phase}/6 — "${phaseConfig.name}"
ЦЕЛЬ ФАЗЫ: ${phaseConfig.goal}
ВОПРОСЫ ИЗ ПУЛА: ${phaseConfig.questions.join(' | ')}

Собери информацию по этим полям: ${phaseConfig.outputFields.join(', ')}

Если ты собрал достаточно информации по текущей фазе, закончи ответ строкой:
PHASE_COMPLETE:{"field1":"value1","field2":"value2"}`

  const messages = [
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: userMessage }
  ]

  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 400,
    system: systemPrompt,
    messages
  })

  const text = response.content[0].text

  // Check if phase is complete
  const phaseMatch = text.match(/PHASE_COMPLETE:({.+})/s)
  let phaseData = {}
  let cleanText = text

  if (phaseMatch) {
    try {
      phaseData = JSON.parse(phaseMatch[1])
      cleanText = text.replace(/PHASE_COMPLETE:.+/s, '').trim()
    } catch (e) {
      // continue without extracted data
    }
  }

  // Save conversation
  await db.saveConversation(userId, 'user', userMessage)
  await db.saveConversation(userId, 'assistant', cleanText)

  // Update profile with phase data
  const currentData = profile?.onboarding_data || {}
  const updatedData = { ...currentData, ...phaseData }

  const shouldAdvance = !!phaseMatch

  await db.upsertProfile(userId, {
    onboarding_phase: shouldAdvance ? phase : (profile?.onboarding_phase || 0),
    onboarding_data: updatedData
  })

  // Check if all phases done
  const newPhase = shouldAdvance ? phase : (profile?.onboarding_phase || 0)
  if (newPhase >= 6 && shouldAdvance) {
    // Finalize profile
    await finalizeProfile(userId, updatedData)
    return {
      done: false,
      phaseComplete: true,
      finalPhase: true,
      message: cleanText
    }
  }

  return {
    done: false,
    phaseComplete: shouldAdvance,
    message: cleanText
  }
}

// ─── Finalize profile after onboarding ───────────────────────────────────────

async function finalizeProfile(userId, onboardingData) {
  // Extract structured fields from onboarding data
  const prompt = `На основе данных онбординга создай структурированный профиль пользователя.

Данные онбординга:
${JSON.stringify(onboardingData, null, 2)}

Верни JSON с полями:
{
  "goal_type": "romantic|business|mentor",
  "archetype_tags": ["tag1", "tag2"],
  "decision_style": "intuitive|analytical|mixed",
  "communication_directness": 0.0-1.0,
  "openness_score": 0.0-1.0,
  "hard_filters": {},
  "style_vector": {"directness": 0.0-1.0, "pace": 0.0-1.0, "structure": 0.0-1.0},
  "showcase_public": "2-3 предложения о человеке для витрины",
  "showcase_tags": ["tag1", "tag2", "tag3"]
}

Верни ТОЛЬКО JSON, без пояснений.`

  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 600,
    messages: [{ role: 'user', content: prompt }]
  })

  try {
    const structured = JSON.parse(response.content[0].text)
    await db.upsertProfile(userId, {
      ...structured,
      onboarding_phase: 7  // complete
    })
  } catch (e) {
    // Fallback: mark as complete with raw data
    await db.upsertProfile(userId, { onboarding_phase: 7 })
  }
}
