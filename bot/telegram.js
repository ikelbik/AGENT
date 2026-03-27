import { Bot, InlineKeyboard } from 'grammy'
import { db } from '../db/postgres.js'
import { conductOnboarding } from '../agent/onboarding.js'
import { scheduleMatching, scheduleDialogueTurn } from '../queue/queues.js'
import { startDialogue, expressHandoffIntent } from '../agent/proxy.js'
import { updateProfileEmbedding } from '../agent/matching.js'
import 'dotenv/config'

let botInstance = null

export function createBot() {
  if (botInstance) return botInstance

  const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN)
  botInstance = bot

  // ─── /start ────────────────────────────────────────────────────────────────

  bot.command('start', async (ctx) => {
    const user = await db.upsertUser(ctx.from.id, ctx.from.username)
    const profile = await db.getProfile(user.id)

    if (!profile || profile.onboarding_phase === 0) {
      await db.upsertProfile(user.id, { onboarding_phase: 0 })
      await ctx.reply(
        `👋 Привет! Я AgentNet — сеть агентов для поиска людей и возможностей.\n\n` +
        `Сначала я хочу немного узнать тебя — это займёт 10-15 минут. ` +
        `Отвечай свободно, как в разговоре с другом.\n\n` +
        `Итак — что привело тебя сюда?`
      )
    } else if (profile.onboarding_phase < 7) {
      await ctx.reply(
        `С возвращением! Продолжим где остановились — фаза ${profile.onboarding_phase}/6.\n\n` +
        `Продолжай рассказывать...`
      )
    } else {
      await ctx.reply(
        `С возвращением! Твой профиль готов.\n\n` +
        `Используй:\n/match — найти кандидатов\n/pings — входящие пинги\n/dialogue — активный диалог\n/profile — твой профиль`
      )
    }
  })

  // ─── /profile ──────────────────────────────────────────────────────────────

  bot.command('profile', async (ctx) => {
    const user = await db.getUserByTelegramId(ctx.from.id)
    if (!user) return ctx.reply('Сначала напиши /start')

    const profile = await db.getProfile(user.id)
    if (!profile || profile.onboarding_phase < 7) {
      return ctx.reply('Профиль ещё не завершён. Продолжай отвечать на вопросы.')
    }

    await ctx.reply(
      `👤 *Твой профиль*\n\n` +
      `*Цель:* ${profile.goal_type || '—'}\n` +
      `*Теги:* ${(profile.archetype_tags || []).join(', ') || '—'}\n` +
      `*Открытость:* ${Math.round((profile.openness_score || 0.5) * 100)}%\n` +
      `*Прямолинейность:* ${Math.round((profile.communication_directness || 0.5) * 100)}%\n\n` +
      `*Витрина:*\n${profile.showcase_public || '—'}`,
      { parse_mode: 'Markdown' }
    )
  })

  // ─── /match ────────────────────────────────────────────────────────────────

  bot.command('match', async (ctx) => {
    const user = await db.getUserByTelegramId(ctx.from.id)
    if (!user) return ctx.reply('Сначала напиши /start')

    const profile = await db.getProfile(user.id)
    if (!profile || profile.onboarding_phase < 7) {
      return ctx.reply('Сначала заверши онбординг — продолжай отвечать на вопросы.')
    }

    await ctx.reply('🔍 Ищу кандидатов... Это займёт минуту.')

    // Update embedding if needed
    if (!profile.embedding) {
      await updateProfileEmbedding(user.id, profile)
    }

    await scheduleMatching(user.id)
    await ctx.reply(
      '✅ Запустил поиск. Если найду подходящих — пришлю пинги от твоего имени.\n' +
      'Обычно это занимает 1-2 минуты.'
    )
  })

  // ─── /pings ────────────────────────────────────────────────────────────────

  bot.command('pings', async (ctx) => {
    const user = await db.getUserByTelegramId(ctx.from.id)
    if (!user) return ctx.reply('Сначала напиши /start')

    const pings = await db.getPendingPings(user.id)

    if (pings.length === 0) {
      return ctx.reply('📭 Входящих пингов пока нет.')
    }

    for (const ping of pings.slice(0, 5)) {
      const kb = new InlineKeyboard()
        .text('✅ Принять', `accept:${ping.id}`)
        .text('❌ Отклонить', `reject:${ping.id}`)

      await ctx.reply(
        `📨 *Пинг от агента*\n\n` +
        `_Гипотеза: ${ping.hypothesis}_\n\n` +
        `${ping.ping_text}`,
        { parse_mode: 'Markdown', reply_markup: kb }
      )
    }
  })

  // ─── /dialogue ─────────────────────────────────────────────────────────────

  bot.command('dialogue', async (ctx) => {
    const user = await db.getUserByTelegramId(ctx.from.id)
    if (!user) return ctx.reply('Сначала напиши /start')

    const dialogue = await db.getActiveDialogue(user.id)
    if (!dialogue) {
      return ctx.reply('Активных диалогов нет. Прими пинг чтобы начать.')
    }

    const transcript = dialogue.transcript || []
    const last = transcript.slice(-4)

    const text = last.map(t =>
      `${t.from === 'user_a' ? '👤 A' : '👤 B'}: ${t.processed || t.content}`
    ).join('\n\n')

    const kb = new InlineKeyboard()
      .text('↩️ Ответить', `reply:${dialogue.id}`)
      .text('🤝 Хочу контакт', `intent:${dialogue.id}`)

    await ctx.reply(
      `💬 *Диалог* (ход ${dialogue.turns}/${process.env.DIALOGUE_MAX_TURNS || 8})\n\n${text}`,
      { parse_mode: 'Markdown', reply_markup: kb }
    )
  })

  // ─── Callback handlers ─────────────────────────────────────────────────────

  bot.callbackQuery(/^accept:(.+)$/, async (ctx) => {
    const pingId = ctx.match[1]
    const user = await db.getUserByTelegramId(ctx.from.id)
    if (!user) return

    const dialogue = await startDialogue(pingId, user.id)
    if (!dialogue) {
      return ctx.answerCallbackQuery('Ошибка: пинг не найден')
    }

    await ctx.editMessageText(
      ctx.msg.text + '\n\n✅ _Принято — диалог начат_',
      { parse_mode: 'Markdown' }
    )

    // Get the opening ping text to show
    const { rows } = await db.query(
      'SELECT ping_text FROM pings WHERE id = $1',
      [pingId]
    )
    const ping = rows[0]

    await ctx.reply(
      `🤝 Диалог начат! Агент-посредник будет передавать сообщения между вами.\n\n` +
      `*Первое сообщение от агента A:*\n${ping?.ping_text || ''}`,
      {
        parse_mode: 'Markdown',
        reply_markup: new InlineKeyboard()
          .text('↩️ Ответить', `reply:${dialogue.id}`)
          .text('🤝 Хочу контакт', `intent:${dialogue.id}`)
      }
    )

    // Notify sender
    const pingData = await db.query(
      'SELECT from_user_id FROM pings WHERE id = $1',
      [pingId]
    ).then(r => r.rows[0])

    if (pingData) {
      const sender = await db.query(
        'SELECT telegram_id FROM users WHERE id = $1',
        [pingData.from_user_id]
      ).then(r => r.rows[0])

      if (sender) {
        await ctx.api.sendMessage(
          sender.telegram_id,
          `✅ *Твой пинг принят!* Диалог начат.\n\nНапиши /dialogue чтобы открыть.`,
          { parse_mode: 'Markdown' }
        )
      }
    }

    await ctx.answerCallbackQuery('Диалог начат!')
  })

  bot.callbackQuery(/^reject:(.+)$/, async (ctx) => {
    const pingId = ctx.match[1]
    await db.updatePingStatus(pingId, 'rejected')
    await ctx.editMessageText(ctx.msg.text + '\n\n❌ _Отклонено_', { parse_mode: 'Markdown' })
    await ctx.answerCallbackQuery('Пинг отклонён')
  })

  bot.callbackQuery(/^intent:(.+)$/, async (ctx) => {
    const dialogueId = ctx.match[1]
    const user = await db.getUserByTelegramId(ctx.from.id)
    if (!user) return

    const result = await expressHandoffIntent(dialogueId, user.id)

    if (result.status === 'handoff') {
      // Get both users' contacts
      const dialogue = result.dialogue
      const userA = await db.query(
        'SELECT telegram_id, username FROM users WHERE id = $1',
        [dialogue.user_a_id]
      ).then(r => r.rows[0])
      const userB = await db.query(
        'SELECT telegram_id, username FROM users WHERE id = $1',
        [dialogue.user_b_id]
      ).then(r => r.rows[0])

      const msgA = `🎉 *Взаимное согласие!*\n\nВы оба хотите прямого контакта.\n\n` +
        `Telegram: @${userB.username || 'пользователь'}\n` +
        `ID: ${userB.telegram_id}`

      const msgB = `🎉 *Взаимное согласие!*\n\nВы оба хотите прямого контакта.\n\n` +
        `Telegram: @${userA.username || 'пользователь'}\n` +
        `ID: ${userA.telegram_id}`

      await ctx.api.sendMessage(userA.telegram_id, msgA, { parse_mode: 'Markdown' })
      await ctx.api.sendMessage(userB.telegram_id, msgB, { parse_mode: 'Markdown' })
      await ctx.answerCallbackQuery('🎉 Хэндофф выполнен!')
    } else {
      await ctx.reply(result.message)
      await ctx.answerCallbackQuery('Намерение зафиксировано')
    }
  })

  bot.callbackQuery(/^reply:(.+)$/, async (ctx) => {
    const dialogueId = ctx.match[1]
    await ctx.reply(
      'Напиши своё сообщение — я передам его через агента-посредника:\n\n' +
      `_Формат: просто напиши сообщение в чат. Отправь /dialogue чтобы вернуться к просмотру._`,
      { parse_mode: 'Markdown' }
    )
    // Store pending reply context in session (simplified — use Redis in prod)
    await ctx.answerCallbackQuery('Пиши сообщение!')
  })

  // ─── Default message handler ───────────────────────────────────────────────

  bot.on('message:text', async (ctx) => {
    const user = await db.upsertUser(ctx.from.id, ctx.from.username)
    const profile = await db.getProfile(user.id)

    // Still in onboarding
    if (!profile || profile.onboarding_phase < 7) {
      try {
        const result = await conductOnboarding(user.id, ctx.message.text)

        await ctx.reply(result.message)

        if (result.finalPhase) {
          // Onboarding complete
          await updateProfileEmbedding(user.id, await db.getProfile(user.id))
          await ctx.reply(
            `✅ *Профиль готов!*\n\n` +
            `Теперь я знаю тебя достаточно чтобы искать подходящих людей.\n\n` +
            `Используй:\n/match — запустить поиск\n/pings — входящие пинги\n/profile — твой профиль`,
            { parse_mode: 'Markdown' }
          )
        }
      } catch (e) {
        console.error('Onboarding error:', e)
        await ctx.reply('Что-то пошло не так. Попробуй ещё раз.')
      }
      return
    }

    // Check for active dialogue — route message through proxy
    const activeDialogue = await db.getActiveDialogue(user.id)
    if (activeDialogue) {
      await ctx.reply('⏳ Передаю через агента...')
      await scheduleDialogueTurn(activeDialogue.id, user.id, ctx.message.text)
      return
    }

    // General assistant mode
    await ctx.reply(
      `Не понял команду. Используй:\n` +
      `/match — найти кандидатов\n` +
      `/pings — входящие пинги\n` +
      `/dialogue — активный диалог\n` +
      `/profile — твой профиль`
    )
  })

  return bot
}
