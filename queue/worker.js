import { Worker } from 'bullmq'
import { connection, scheduleMatching, startMatchingScheduler } from './queues.js'
import { runMatching } from '../agent/matching.js'
import { processTurn } from '../agent/proxy.js'
import { db } from '../db/postgres.js'
import 'dotenv/config'

// Import bot lazily to avoid circular deps
let bot = null
async function getBot() {
  if (!bot) {
    const { createBot } = await import('../bot/telegram.js')
    bot = createBot()
  }
  return bot
}

// ─── Matching worker ──────────────────────────────────────────────────────────

new Worker('matching', async (job) => {
  const { userId } = job.data
  console.log(`[matching] Running for user ${userId}`)

  let results
  try {
    results = await runMatching(userId)
  } catch (e) {
    console.error(`[matching] CRASH for ${userId}:`, e.message, e.stack?.split('\n')[1])
    return
  }

  if (results.error) {
    console.warn(`[matching] Error: ${results.error}`)
    return
  }

  // Notify user A about new matches
  if (results.matches.length > 0) {
    const initiator = await db.query('SELECT telegram_id FROM users WHERE id = $1', [userId]).then(r => r.rows[0])
    if (initiator) {
      const b = await getBot()
      await b.api.sendMessage(
        initiator.telegram_id,
        `🔍 Нашёл <b>${results.matches.length}</b> подходящих кандидатов.\n\n/matches — посмотреть`,
        { parse_mode: 'HTML' }
      )
    }
  }

  console.log(`[matching] Done for ${userId}: ${results.matches.length} matches`)
}, { connection })

// ─── Dialogue worker ──────────────────────────────────────────────────────────

new Worker('dialogue', async (job) => {
  const { dialogueId, senderId, message } = job.data
  console.log(`[dialogue] Processing turn in ${dialogueId}`)

  const result = await processTurn(dialogueId, senderId, message)

  const dialogue = await db.getDialogue(dialogueId)
  if (!dialogue) return

  const recipientId = dialogue.user_a_id === senderId
    ? dialogue.user_b_id
    : dialogue.user_a_id

  const senderUser    = await db.query('SELECT * FROM users WHERE id = $1', [senderId]).then(r => r.rows[0])
  const recipientUser = await db.query('SELECT * FROM users WHERE id = $1', [recipientId]).then(r => r.rows[0])

  const b = await getBot()

  if (result.blocked && result.forSender) {
    // Send block explanation to sender
    await b.api.sendMessage(senderUser.telegram_id,
      `⛔ ${result.message}`
    )
    return
  }

  // Deliver processed message to recipient
  await b.api.sendMessage(
    recipientUser.telegram_id,
    `💬 *Сообщение от агента:*\n\n${result.messageForRecipient}`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '↩️ Ответить', callback_data: `reply:${dialogueId}` },
          { text: '🤝 Хочу контакт', callback_data: `intent:${dialogueId}` }
        ]]
      }
    }
  )

  // Deliver agent's response back to sender
  await b.api.sendMessage(
    senderUser.telegram_id,
    `💬 *Ответ агента B:*\n\n${result.agentResponseForSender}${result.turnsLeft <= 2 ? `\n\n⏱ Осталось ходов: ${result.turnsLeft}` : ''}`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '↩️ Ответить', callback_data: `reply:${dialogueId}` },
          { text: '🤝 Хочу контакт', callback_data: `intent:${dialogueId}` }
        ]]
      }
    }
  )

  // If intent signal detected — prompt
  if (result.hasIntentSignal) {
    await b.api.sendMessage(
      recipientUser.telegram_id,
      `💡 Похоже ты готов к прямому контакту? Нажми "Хочу контакт" если это так.`
    )
  }
}, { connection })

// ─── Notification worker ──────────────────────────────────────────────────────

new Worker('notify', async (job) => {
  const { telegramId, message, extra } = job.data
  const b = await getBot()
  await b.api.sendMessage(telegramId, message, { parse_mode: 'Markdown', ...extra })
}, { connection })

// ─── Scheduler worker ─────────────────────────────────────────────────────────

new Worker('scheduler', async (job) => {
  if (job.name !== 'match-all') return
  const users = await db.getActiveMatchingUsers()
  console.log(`[scheduler] Running matching for ${users.length} active users`)
  for (const user of users) {
    await scheduleMatching(user.id)
  }
}, { connection })

// Start periodic scheduler on worker boot
startMatchingScheduler()

console.log('Workers started')
