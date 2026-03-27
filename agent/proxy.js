import Anthropic from '@anthropic-ai/sdk'
import { db } from '../db/postgres.js'

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const MAX_TURNS = parseInt(process.env.DIALOGUE_MAX_TURNS || '8')

// ─── Proxy modes ──────────────────────────────────────────────────────────────

const MODES = {
  RELAY:    'relay',    // pass through as-is
  REPHRASE: 'rephrase', // soften/improve form, keep meaning
  ENRICH:   'enrich',   // add context from sender's profile
  BLOCK:    'block'     // refuse and explain why
}

// ─── Classify and process a message ──────────────────────────────────────────

async function processMessage(message, senderProfile, recipientProfile, dialogue, phase) {
  const prompt = `Ты — агент-посредник в прокси-диалоге между двумя людьми.

ОТПРАВИТЕЛЬ (профиль):
${JSON.stringify(senderProfile, null, 2)}

ПОЛУЧАТЕЛЬ (профиль):
${JSON.stringify(recipientProfile, null, 2)}

ФАЗА ДИАЛОГА: ${phase} из ${MAX_TURNS} ходов
ТРАНСКРИПТ:
${JSON.stringify(dialogue.transcript?.slice(-6) || [], null, 2)}

СООБЩЕНИЕ ОТПРАВИТЕЛЯ:
"${message}"

Определи режим обработки и выдай результат в JSON:

{
  "mode": "relay|rephrase|enrich|block",
  "processed_message": "итоговое сообщение для получателя",
  "reasoning": "1-2 слова почему этот режим",
  "block_explanation": "если mode=block: объяснение пользователю почему заблокировано"
}

Правила:
- RELAY: вопрос корректен, на нужной фазе, без личных данных
- REPHRASE: вопрос резкий/неловкий, но суть правильная
- ENRICH: добавь контекст "мой пользователь спрашивает это потому что..." если это поможет
- BLOCK: личные данные (имя, контакты), просьба о прямом контакте до mutual intent, оскорбление

Верни ТОЛЬКО JSON.`

  const response = await claude.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }]
  })

  try {
    return JSON.parse(response.content[0].text)
  } catch {
    return {
      mode: MODES.RELAY,
      processed_message: message,
      reasoning: 'parse error fallback'
    }
  }
}

// ─── Generate agent response to a message ─────────────────────────────────────

async function generateAgentResponse(incomingMessage, recipientProfile, dialogue) {
  const prompt = `Ты — агент пользователя в прокси-диалоге.

ТВОЙ ПРОФИЛЬ (от имени кого отвечаешь):
${JSON.stringify(recipientProfile, null, 2)}

ИСТОРИЯ ДИАЛОГА:
${JSON.stringify(dialogue.transcript?.slice(-6) || [], null, 2)}

ВХОДЯЩЕЕ СООБЩЕНИЕ:
"${incomingMessage}"

Ответь от имени пользователя: честно, в его стиле, кратко (2-4 предложения).
Если в конце ответа ощущается что пользователь хочет прямого контакта — добавь тег [INTENT_SIGNAL].`

  const response = await claude.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }]
  })

  const text = response.content[0].text
  const hasIntentSignal = text.includes('[INTENT_SIGNAL]')
  const cleanText = text.replace('[INTENT_SIGNAL]', '').trim()

  return { text: cleanText, hasIntentSignal }
}

// ─── Main dialogue turn ───────────────────────────────────────────────────────

export async function processTurn(dialogueId, senderId, message) {
  const dialogue = await db.getDialogue(dialogueId)
  if (!dialogue || dialogue.status !== 'active') {
    return { error: 'Диалог не активен' }
  }

  const isUserA = dialogue.user_a_id === senderId
  const recipientId = isUserA ? dialogue.user_b_id : dialogue.user_a_id

  const senderProfile = await db.getProfile(senderId)
  const recipientProfile = await db.getProfile(recipientId)

  // Check turn limit
  if (dialogue.turns >= MAX_TURNS) {
    return {
      blocked: true,
      message: `Диалог завершён — достигнут лимит ${MAX_TURNS} ходов. Хочешь установить прямой контакт?`,
      suggestHandoff: true
    }
  }

  // Process message through proxy
  const phase = dialogue.turns + 1
  const processed = await processMessage(
    message,
    senderProfile,
    recipientProfile,
    dialogue,
    phase
  )

  // Save sender's turn
  const senderTurn = {
    from: 'user_' + (isUserA ? 'a' : 'b'),
    original: message,
    processed: processed.processed_message,
    mode: processed.mode,
    timestamp: new Date().toISOString()
  }
  await db.appendDialogueTurn(dialogueId, senderTurn)

  // If blocked — return explanation to sender
  if (processed.mode === MODES.BLOCK) {
    return {
      blocked: true,
      message: processed.block_explanation || 'Это действие недоступно на текущем этапе диалога.',
      forSender: true
    }
  }

  // Generate recipient agent's response
  const agentResponse = await generateAgentResponse(
    processed.processed_message,
    recipientProfile,
    dialogue
  )

  // Save recipient's turn
  const recipientTurn = {
    from: 'user_' + (isUserA ? 'b' : 'a'),
    agent_generated: true,
    content: agentResponse.text,
    intent_signal: agentResponse.hasIntentSignal,
    timestamp: new Date().toISOString()
  }
  await db.appendDialogueTurn(dialogueId, recipientTurn)

  return {
    blocked: false,
    mode: processed.mode,
    messageForRecipient: processed.processed_message,
    agentResponseForSender: agentResponse.text,
    hasIntentSignal: agentResponse.hasIntentSignal,
    turnsLeft: MAX_TURNS - (dialogue.turns + 2)
  }
}

// ─── Temporal lock ────────────────────────────────────────────────────────────

export async function expressHandoffIntent(dialogueId, userId) {
  const result = await db.setHandoffIntent(dialogueId, userId)

  if (result === 'handoff') {
    // Both parties confirmed — get contact info for handoff
    const dialogue = await db.getDialogue(dialogueId)
    return {
      status: 'handoff',
      message: 'Взаимное согласие подтверждено! Контакты переданы обеим сторонам одновременно.',
      dialogue
    }
  }

  return {
    status: 'waiting',
    message: 'Твоё намерение зафиксировано. Ожидаю подтверждения от другой стороны.'
  }
}

// ─── Start dialogue after ping accepted ───────────────────────────────────────

export async function startDialogue(pingId, acceptorId) {
  const { rows } = await import('../db/postgres.js').then(m =>
    m.pool.query('SELECT * FROM pings WHERE id = $1', [pingId])
  )
  const ping = rows[0]
  if (!ping) return null

  await db.updatePingStatus(pingId, 'accepted')

  const dialogue = await db.createDialogue(pingId, ping.from_user_id, acceptorId)

  // Opening turn — sender's ping text is the first message
  const openingTurn = {
    from: 'user_a',
    original: ping.ping_text,
    processed: ping.ping_text,
    mode: MODES.RELAY,
    is_opening_ping: true,
    timestamp: new Date().toISOString()
  }
  await db.appendDialogueTurn(dialogue.id, openingTurn)

  return dialogue
}
