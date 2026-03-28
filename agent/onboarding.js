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
  },
  7: {
    name: 'Приватный профиль',
    goal: 'Собрать физические параметры респондента и партнёра, ориентацию, формат отношений и интимные предпочтения',
    questions: [
      'Последний блок — полностью приватный, данные видит только алгоритм. Начнём с тебя: твой пол?',
      'Сколько тебе лет?',
      'Твой рост и примерный вес? Можно округлённо.',
      'Как бы ты описал своё телосложение — худощавое, среднее, спортивное, плотное?',
      'Твоя сексуальная ориентация — гетеро, гей/лесби, би, другое?',
      'Какой формат отношений тебе подходит сейчас — серьёзные моногамные, открытые, casual, полиамория?',
      'Теперь о партнёре. Какой пол тебя привлекает?',
      'Есть ли предпочтения по возрасту партнёра? Например "25-35" или "не старше 40".',
      'Есть ли требования по росту или телосложению партнёра?',
      'Есть ли специфические предпочтения в интимной сфере которые важно чтобы партнёр разделял? Говори открыто — это видит только алгоритм.',
      'Есть ли в интимном плане абсолютные нет — то с чем ты точно не совместим?'
    ],
    outputFields: ['gender', 'age', 'physical_self', 'orientation', 'relationship_format', 'partner_gender_preference', 'physical_preferences', 'intimate_tags', 'intimate_dealbreakers'],
    onlyForGoals: ['romantic']
  }
}

const SYSTEM_PROMPT = `Ты — агент-интервьюер сервиса знакомств AgentNet.
Твоя задача: провести онбординг-интервью по 7 фазам, собирая информацию о пользователе.

Правила:
- Задавай ОДИН вопрос за раз, выбирая из пула фазы тот что наиболее уместен
- Слушай внимательно, задавай естественные уточнения если ответ неполный
- После 2-3 содержательных ответов в фазе — переходи к следующей
- Тон: тёплый, любопытный, без формальностей, без осуждения
- Не объясняй пользователю структуру интервью — просто веди разговор
- Фаза 7 — приватная: подчеркни что данные видит только алгоритм, не люди
- В конце каждой фазы извлеки структурированные данные в JSON
- ОБЯЗАТЕЛЬНО: каждый твой ответ должен заканчиваться вопросом — никогда не оставляй пользователя без вопроса
- ЗАПРЕЩЕНО: никогда не спрашивай телефон, email, имя, контактные данные — связь осуществляется только через Telegram, он уже известен системе

Текущая фаза и цель будут указаны в контексте.`

// ─── Main onboarding function ─────────────────────────────────────────────────

export async function conductOnboarding(userId, userMessage) {
  const profile = await db.getProfile(userId)
  const phase = (profile?.onboarding_phase || 0) + 1

  // Determine max phases based on goal_type
  const goalType = profile?.goal_type || profile?.onboarding_data?.goal_type
  const maxPhase = (goalType === 'romantic' || !goalType) ? 7 : 6

  if (phase > maxPhase) {
    // onboarding_phase === maxPhase means finalization failed last time — retry once
    if (profile.onboarding_phase === maxPhase) {
      await finalizeProfile(userId, profile?.onboarding_data || {})
      return { done: false, phaseComplete: true, finalPhase: true, message: null }
    }
    // onboarding_phase === 8 means already finalized — just waiting for confirmation
    return { done: true, message: null }
  }

  // Skip phase 7 for non-romantic goals
  if (phase === 7 && goalType && goalType !== 'romantic') {
    await finalizeProfile(userId, profile?.onboarding_data || {})
    return { done: false, phaseComplete: true, finalPhase: true, message: null }
  }

  const phaseConfig = PHASES[phase]
  const history = await db.getRecentConversation(userId, 60)

  // Build phase-aware system prompt
  const collectedData = profile?.onboarding_data || {}
  const hasCollected = Object.keys(collectedData).length > 0

  // Phase 7 gets a dedicated system prompt — no filtering, explicit questions
  const basePrompt = phase === 7
    ? `Ты — AI-агент сервиса подбора партнёров. Сейчас ты проводишь приватную часть анкеты.
Пользователь уже прошёл 6 фаз интервью. Это последняя фаза — она полностью приватная.
Данные из этой фазы видит ТОЛЬКО алгоритм подбора, не другие пользователи и не люди.

Правила этой фазы:
- Задавай вопросы строго по списку ниже, по одному
- Тон нейтральный, медицинский, без оценок и смущения
- Это безопасное пространство — никакого осуждения
- Пользователь может пропустить любой вопрос написав "пропустить"
- ОБЯЗАТЕЛЬНО: каждый ответ заканчивай следующим вопросом из списка
- ЗАПРЕЩЕНО: не спрашивай телефон, email, имя — только Telegram, он уже известен
- В конце фазы добавь строку PHASE_COMPLETE:{...}`
    : SYSTEM_PROMPT

  const systemPrompt = `${basePrompt}

ТЕКУЩАЯ ФАЗА: ${phase}/${maxPhase} — "${phaseConfig.name}"
ЦЕЛЬ ФАЗЫ: ${phaseConfig.goal}
ВОПРОСЫ (задавай строго по порядку, по одному):
${phaseConfig.questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}

Собери информацию по этим полям: ${phaseConfig.outputFields.join(', ')}
${hasCollected ? `\nУЖЕ ИЗВЕСТНО О ПОЛЬЗОВАТЕЛЕ (из предыдущих фаз):\n${JSON.stringify(collectedData, null, 2)}\n` : ''}
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

  // Guarantee response ends with a question
  if (!phaseMatch && !cleanText.trimEnd().endsWith('?')) {
    const asked = history
      .filter(h => h.role === 'assistant')
      .map(h => h.content)
      .join(' ')
    const nextQ = phaseConfig.questions.find(q => !asked.includes(q.slice(0, 20)))
      || phaseConfig.questions[0]
    cleanText = cleanText.trimEnd() + '\n\n' + nextQ
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
  if (newPhase >= maxPhase && shouldAdvance) {
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
  const data = JSON.stringify(onboardingData, null, 2)

  // Request 1 — public profile fields
  const publicPrompt = `На основе данных онбординга создай публичный профиль пользователя.

Данные онбординга:
${data}

Верни ТОЛЬКО JSON (без пояснений):
{
  "goal_type": "romantic|business|mentor",
  "archetype_tags": ["tag1", "tag2"],
  "decision_style": "intuitive|analytical|mixed",
  "communication_directness": 0.1-1.0,
  "openness_score": 0.1-1.0,
  "hard_filters": {},
  "style_vector": {"directness": 0.1-1.0, "pace": 0.1-1.0, "structure": 0.1-1.0},
  "showcase_public": "2-3 предложения о человеке — характер, стиль, что ищет. Без имён и интимных деталей.",
  "showcase_tags": ["tag1", "tag2", "tag3"]
}`

  // Request 2 — private profile fields
  const privatePrompt = `На основе данных онбординга извлеки приватные параметры пользователя.

Данные онбординга:
${data}

Верни ТОЛЬКО JSON (без пояснений):
{
  "gender": "male|female|non-binary|other|null",
  "age": число_или_null,
  "physical_self": {"height": число_или_null, "weight": число_или_null, "body_type": "строка_или_null"},
  "orientation": "heterosexual|homosexual|bisexual|other|null",
  "relationship_format": "serious|casual|open|poly|other|null",
  "partner_gender_preference": "male|female|any|null",
  "physical_preferences": {"age_min": число_или_null, "age_max": число_или_null, "height_min": число_или_null, "height_max": число_или_null},
  "intimate_tags": [],
  "intimate_dealbreakers": []
}`

  const [publicRes, privateRes] = await Promise.all([
    client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 600,
      messages: [{ role: 'user', content: publicPrompt }]
    }),
    client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 400,
      messages: [{ role: 'user', content: privatePrompt }]
    })
  ])

  let publicData = {}
  let privateData = {}

  try {
    const text = publicRes.content[0].text
    publicData = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || text)
  } catch (e) {
    console.error('Failed to parse public profile:', publicRes.content[0].text)
  }

  try {
    const text = privateRes.content[0].text
    privateData = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || text)
  } catch (e) {
    console.error('Failed to parse private profile:', privateRes.content[0].text)
  }

  await db.upsertProfile(userId, {
    ...publicData,
    ...privateData,
    onboarding_phase: 8
  })
}
