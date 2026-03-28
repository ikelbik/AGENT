import { Bot, InlineKeyboard } from 'grammy'
import { db } from '../db/postgres.js'
import { conductOnboarding } from '../agent/onboarding.js'
import { scheduleMatching } from '../queue/queues.js'
import { updateProfileEmbedding, agentAnswerQuestion } from '../agent/matching.js'
import 'dotenv/config'

let botInstance = null


// Escape HTML special chars in dynamic (user/Claude-generated) content
function esc(s) {
  return String(s ?? '—').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function createBot() {
  if (botInstance) return botInstance

  const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN)
  botInstance = bot

  // ─── /start ────────────────────────────────────────────────────────────────

  bot.command('start', async (ctx) => {
    try {
      const user = await db.upsertUser(ctx.from.id, ctx.from.username)
      const profile = await db.getProfile(user.id)

      if (!profile || profile.onboarding_phase === 0) {
        await db.upsertProfile(user.id, { onboarding_phase: 0 })
        await ctx.reply(
          `👋 Привет! Я AgentNet — сеть агентов для поиска людей и возможностей.\n\n` +
          `Расскажи о себе и о том кого ищешь — свободно, подробно, своими словами. ` +
          `Чем больше расскажешь сразу, тем меньше я буду переспрашивать.`
        )
      } else if (profile.onboarding_phase < 8) {
        await ctx.reply(`С возвращением! Продолжим — напиши что-нибудь.`)
      } else {
        await ctx.reply(
          `С возвращением! Твой профиль готов.\n\n` +
          `Используй:\n/matches — найденные матчи\n/profile — твой профиль\n/found — нашёл что искал\n/restart — начать заново`
        )
      }
    } catch (e) {
      console.error('/start error:', e)
      await ctx.reply('Ошибка при запуске. Попробуй ещё раз через минуту.').catch(() => {})
    }
  })

  // ─── /profile ──────────────────────────────────────────────────────────────

  bot.command('profile', async (ctx) => {
    const user = await db.getUserByTelegramId(ctx.from.id)
    if (!user) return ctx.reply('Сначала напиши /start')

    const profile = await db.getProfile(user.id)
    if (!profile || profile.onboarding_phase < 8) {
      return ctx.reply('Профиль ещё не завершён. Продолжай отвечать на вопросы.')
    }

    await ctx.reply(
      `👤 <b>Твой профиль</b>\n\n` +
      `<b>Цель:</b> ${esc(profile.goal_type || '—')}\n` +
      `<b>Теги:</b> ${esc((profile.archetype_tags || []).join(', ') || '—')}\n` +
      `<b>Открытость:</b> ${Math.round((profile.openness_score || 0.5) * 100)}%\n` +
      `<b>Прямолинейность:</b> ${Math.round((profile.communication_directness || 0.5) * 100)}%\n\n` +
      `<b>Витрина:</b>\n${esc(profile.showcase_public || '—')}`,
      { parse_mode: 'HTML' }
    )
  })

  // ─── /seed (TEST_MODE only) ────────────────────────────────────────────────

  if (process.env.TEST_MODE === 'true') {
    bot.command('skip', async (ctx) => {
      const user = await db.upsertUser(ctx.from.id, ctx.from.username)

      // Seed partial data so Claude asks only for missing fields (romantic by default)
      const partialData = {
        goal_type: 'romantic',
        archetype_tags: ['creative', 'introvert', 'deep-thinker'],
        decision_style: 'intuitive',
        communication_directness: 0.75,
        openness_score: 0.8,
        hard_filters: {},
        style_vector: { directness: 0.75, pace: 0.4, structure: 0.3 },
        showcase_tags: ['depth', 'creative']
      }

      await db.upsertProfile(user.id, {
        onboarding_phase: 1,
        onboarding_data: partialData
      })

      await ctx.reply(
        `⏭ <b>Пропуск</b>\n\nБазовые данные заполнены. Напиши что-нибудь — агент запросит только недостающее (физические параметры, интимные предпочтения).`,
        { parse_mode: 'HTML' }
      )
    })

    bot.command('seed', async (ctx) => {
      const user = await db.upsertUser(ctx.from.id, ctx.from.username)
      const arg = ctx.match?.trim() || 'romantic'
      const goalType = ['romantic', 'business', 'mentor'].includes(arg) ? arg : 'romantic'

      const profiles = {
        romantic: {
          goal_type: 'romantic',
          archetype_tags: ['creative', 'introvert', 'deep-thinker'],
          decision_style: 'intuitive',
          communication_directness: 0.75,
          openness_score: 0.8,
          hard_filters: { geographic_constraints: 'same city' },
          style_vector: { directness: 0.75, pace: 0.4, structure: 0.3 },
          showcase_public: 'Думаю больше чем говорю, но когда говорю — по делу. Ищу человека с которым тишина не неловкая.',
          showcase_tags: ['depth', 'introvert', 'creative'],
          gender: 'male',
          age: 28,
          physical_self: { height: 180, weight: 75, body_type: 'athletic' },
          orientation: 'heterosexual',
          relationship_format: 'serious',
          physical_preferences: { age_range: '24-33', height_min: 160 },
          intimate_tags: ['monogamy', 'slow-burn'],
          intimate_dealbreakers: ['open-relationship']
        },
        business: {
          goal_type: 'business',
          archetype_tags: ['executor', 'analytical', 'systems-thinker'],
          decision_style: 'analytical',
          communication_directness: 0.9,
          openness_score: 0.6,
          hard_filters: { value_dealbreakers: 'no remote' },
          style_vector: { directness: 0.9, pace: 0.8, structure: 0.85 },
          showcase_public: 'Строю процессы и нахожу точки роста там где другие видят хаос. Ищу партнёра который дополняет по навыкам.',
          showcase_tags: ['executor', 'systems', 'growth'],
          gender: 'female',
          age: 32,
          orientation: null,
          relationship_format: null
        },
        mentor: {
          goal_type: 'mentor',
          archetype_tags: ['strategist', 'experienced', 'connector'],
          decision_style: 'mixed',
          communication_directness: 0.7,
          openness_score: 0.85,
          hard_filters: {},
          style_vector: { directness: 0.7, pace: 0.5, structure: 0.6 },
          showcase_public: '15 лет в продукте. Помог запустить 8 команд. Интересует передача опыта тем кто готов его взять.',
          showcase_tags: ['mentor', 'product', 'strategy'],
          gender: 'male',
          age: 42,
          orientation: null,
          relationship_format: null
        }
      }

      await db.upsertProfile(user.id, {
        ...profiles[goalType],
        onboarding_phase: 8,
        profile_confirmed: true,
        matching_active: true
      })

      await scheduleMatching(user.id)

      await ctx.reply(
        `🧪 <b>Тестовый профиль создан!</b>\n\nТип: ${goalType}\nПоиск запущен. /matches — мои матчи`,
        { parse_mode: 'HTML' }
      )
    })
  }

  // ─── /found ────────────────────────────────────────────────────────────────

  bot.command('found', async (ctx) => {
    const user = await db.getUserByTelegramId(ctx.from.id)
    if (!user) return ctx.reply('Сначала напиши /start')
    await db.setMatchingActive(user.id, false)
    await ctx.reply('🎉 Поиск остановлен. Удачи!\n\nЕсли захочешь возобновить — /start.')
  })

  // ─── /matches ──────────────────────────────────────────────────────────────

  bot.command('matches', async (ctx) => {
    const user = await db.getUserByTelegramId(ctx.from.id)
    if (!user) return ctx.reply('Сначала напиши /start')

    const matches = await db.getMatchesForUser(user.id)
    if (matches.length === 0) return ctx.reply('Пока нет матчей. Поиск работает в фоне.')

    for (const m of matches.slice(0, 5)) {
      const isA = String(m.user_a_id) === String(user.id)
      const score = Math.round(m.score * 100)
      const status = m.status === 'mutual' ? '🎉 Взаимный интерес' : isA ? '🔍 Найден тобой' : '👋 Тебя нашли'

      const kb = new InlineKeyboard()
        .text('💬 Показать диалог', `show_conv:${m.id}`)
        .row()
        .text('🤝 Хочу познакомиться', `want_match:${m.id}`)
        .text('❌ Пропустить', `skip_match:${m.id}`)

      await ctx.reply(
        `${status} · <b>${score}%</b>\n\n<i>${esc(m.hypothesis)}</i>`,
        { parse_mode: 'HTML', reply_markup: kb }
      )
    }
  })

  // ─── /restart ──────────────────────────────────────────────────────────────

  bot.command('restart', async (ctx) => {
    const user = await db.getUserByTelegramId(ctx.from.id)
    if (!user) return ctx.reply('Сначала напиши /start')

    const kb = new InlineKeyboard()
      .text('✅ Да, начать заново', 'confirm_restart')
      .text('❌ Отмена', 'cancel_restart')

    await ctx.reply(
      `⚠️ <b>Начать заново?</b>\n\nПрофиль и история будут удалены.\n\nУверен?`,
      { parse_mode: 'HTML', reply_markup: kb }
    )
  })

  // ─── Callback: show agent conversation ─────────────────────────────────────

  bot.callbackQuery(/^show_conv:(.+)$/, async (ctx) => {
    const matchId = ctx.match[1]
    const match = await db.getMatch(matchId)
    if (!match) return ctx.answerCallbackQuery('Матч не найден')

    const conv = match.conversation || []
    const lines = conv.map(t => `<b>${t.from}:</b> ${esc(t.text)}`).join('\n\n')

    const messages = await db.getMatchMessages(matchId)
    const msgLines = messages.map(m => {
      const label = m.sender === 'user_a' ? '🧑 Ты' : m.sender === 'user_b' ? '🧑 Они' : '🤖 Агент'
      return `${label}: ${esc(m.content)}`
    }).join('\n\n')

    const kb = new InlineKeyboard()
      .text('❓ Задать вопрос агенту', `ask_q:${matchId}`)
      .row()
      .text('🤝 Хочу познакомиться', `want_match:${matchId}`)

    await ctx.reply(
      `💬 <b>Диалог агентов</b>\n\n${lines || '—'}` +
      (msgLines ? `\n\n<b>Переписка:</b>\n${msgLines}` : ''),
      { parse_mode: 'HTML', reply_markup: kb }
    )
    await ctx.answerCallbackQuery()
  })

  // ─── Callback: want to match ───────────────────────────────────────────────

  bot.callbackQuery(/^want_match:(.+)$/, async (ctx) => {
    const matchId = ctx.match[1]
    const user = await db.getUserByTelegramId(ctx.from.id)
    if (!user) return ctx.answerCallbackQuery()

    const result = await db.setMatchIntent(matchId, user.id)
    const match = await db.getMatch(matchId)

    if (result === 'mutual') {
      // Exchange contacts
      const userA = await db.query('SELECT telegram_id, username FROM users WHERE id = $1', [match.user_a_id]).then(r => r.rows[0])
      const userB = await db.query('SELECT telegram_id, username FROM users WHERE id = $1', [match.user_b_id]).then(r => r.rows[0])

      const msgA = `🎉 <b>Взаимный интерес!</b>\n\nTelegram: @${esc(userB.username || '—')}\nID: ${userB.telegram_id}`
      const msgB = `🎉 <b>Взаимный интерес!</b>\n\nTelegram: @${esc(userA.username || '—')}\nID: ${userA.telegram_id}`

      await ctx.api.sendMessage(userA.telegram_id, msgA, { parse_mode: 'HTML' })
      await ctx.api.sendMessage(userB.telegram_id, msgB, { parse_mode: 'HTML' })
      await ctx.answerCallbackQuery('🎉 Контакт обменян!')
    } else {
      // Notify the other side they were chosen
      const isA = String(match.user_a_id) === String(user.id)
      const otherTelegramId = isA ? match.user_b_telegram : match.user_a_telegram

      if (otherTelegramId && !match.notified_b) {
        await db.markMatchNotifiedB(matchId)
        await ctx.api.sendMessage(
          otherTelegramId,
          `👋 Тебя выбрали как потенциальный матч.\n\n/matches — посмотреть`,
        )
      }

      await ctx.editMessageText(ctx.msg.text + '\n\n⏳ Ждём ответа...', { parse_mode: 'HTML' })
      await ctx.answerCallbackQuery('Намерение зафиксировано')
    }
  })

  // ─── Callback: skip match ──────────────────────────────────────────────────

  bot.callbackQuery(/^skip_match:(.+)$/, async (ctx) => {
    const matchId = ctx.match[1]
    await db.query(`UPDATE matches SET status = 'closed', updated_at = NOW() WHERE id = $1`, [matchId])
    await ctx.editMessageText(ctx.msg.text + '\n\n❌ Пропущен', { parse_mode: 'HTML' })
    await ctx.answerCallbackQuery()
  })

  // ─── Callback: ask question ────────────────────────────────────────────────

  bot.callbackQuery(/^ask_q:(.+)$/, async (ctx) => {
    const matchId = ctx.match[1]
    const user = await db.getUserByTelegramId(ctx.from.id)
    if (!user) return ctx.answerCallbackQuery()

    await db.setPendingAction(user.id, `ask_question:${matchId}`)
    await ctx.reply('Напиши вопрос — агент попробует ответить сам или передаст человеку.')
    await ctx.answerCallbackQuery()
  })

  // ─── Profile confirmation callbacks ────────────────────────────────────────

  bot.callbackQuery(/^confirm_profile:(.+)$/, async (ctx) => {
    const userId = ctx.match[1]
    await db.confirmProfile(userId)
    const user = await db.getUserByTelegramId(ctx.from.id)
    if (user) await scheduleMatching(user.id)

    await ctx.editMessageText(ctx.msg.text + '\n\n✅ Подтверждено — запускаю поиск!', { parse_mode: 'HTML' })
    await ctx.reply(`🔍 Поиск запущен.\n\n/matches — найденные матчи\n/profile — твой профиль\n/found — нашёл что искал`)
    await ctx.answerCallbackQuery()
  })

  bot.callbackQuery(/^edit_showcase:(.+)$/, async (ctx) => {
    const userId = ctx.match[1]
    await db.setPendingAction(userId, 'showcase_edit')
    await ctx.editMessageText(ctx.msg.text + '\n\n✏️ Жду новый текст...', { parse_mode: 'HTML' })
    await ctx.reply('Напиши как агент должен говорить от твоего имени (3-5 предложений от первого лица).')
    await ctx.answerCallbackQuery()
  })

  bot.callbackQuery('confirm_restart', async (ctx) => {
    const user = await db.getUserByTelegramId(ctx.from.id)
    if (!user) return ctx.answerCallbackQuery()
    await db.resetProfile(user.id)
    await ctx.editMessageText('♻️ Профиль сброшен.')
    await ctx.reply('👋 Начнём заново!\n\nРасскажи о себе и о том кого ищешь.')
    await ctx.answerCallbackQuery()
  })

  bot.callbackQuery('cancel_restart', async (ctx) => {
    await ctx.editMessageText('Отмена. Профиль сохранён.')
    await ctx.answerCallbackQuery()
  })

  // ─── Default message handler ───────────────────────────────────────────────

  bot.on('message:text', async (ctx) => {
    const user = await db.upsertUser(ctx.from.id, ctx.from.username)
    const profileCheck = await db.getProfile(user.id)
    const pendingAction = profileCheck?.pending_action

    // ── Pending: persona edit ──
    if (pendingAction === 'showcase_edit') {
      await db.setPendingAction(user.id, null)
      await db.upsertProfile(user.id, { persona_ref: ctx.message.text })
      await db.confirmProfile(user.id)
      await scheduleMatching(user.id)
      await ctx.reply(`✅ Описание обновлено. Запускаю поиск!`)
      return
    }

    // ── Pending: user asking a question about a match ──
    if (pendingAction?.startsWith('ask_question:')) {
      const matchId = pendingAction.split(':')[1]
      await db.setPendingAction(user.id, null)

      const match = await db.getMatch(matchId)
      if (!match) return ctx.reply('Матч не найден.')

      await db.addMatchMessage(matchId, 'user_a', ctx.message.text, false)

      const targetPersona = match.persona_b || match.showcase_b || ''
      const { routed, answer } = await agentAnswerQuestion(ctx.message.text, targetPersona)

      if (!routed) {
        await db.addMatchMessage(matchId, 'agent_b', answer, false)
        const kb = new InlineKeyboard()
          .text('❓ Ещё вопрос', `ask_q:${matchId}`)
          .text('🤝 Хочу познакомиться', `want_match:${matchId}`)
        await ctx.reply(`🤖 <b>Агент отвечает:</b>\n\n${esc(answer)}`, { parse_mode: 'HTML', reply_markup: kb })
      } else {
        // Route to real user B
        await db.addMatchMessage(matchId, 'user_a', ctx.message.text, true)
        const otherTelegramId = String(match.user_a_id) === String(user.id)
          ? match.user_b_telegram
          : match.user_a_telegram

        await db.setPendingAction(
          String(match.user_a_id) === String(user.id) ? match.user_b_id : match.user_a_id,
          `answering_question:${matchId}`
        )
        await ctx.api.sendMessage(
          otherTelegramId,
          `❓ Тебя спрашивают:\n\n<i>${esc(ctx.message.text)}</i>\n\nПросто ответь — я передам.`,
          { parse_mode: 'HTML' }
        )
        await ctx.reply('⏳ Вопрос передан человеку, ждём ответа.')
      }
      return
    }

    // ── Pending: user B answering a routed question ──
    if (pendingAction?.startsWith('answering_question:')) {
      const matchId = pendingAction.split(':')[1]
      await db.setPendingAction(user.id, null)

      await db.addMatchMessage(matchId, 'user_b', ctx.message.text, false)
      const match = await db.getMatch(matchId)
      const otherTelegramId = String(match.user_b_id) === String(user.id)
        ? match.user_a_telegram
        : match.user_b_telegram

      const kb = new InlineKeyboard()
        .text('❓ Ещё вопрос', `ask_q:${matchId}`)
        .text('🤝 Хочу познакомиться', `want_match:${matchId}`)

      await ctx.api.sendMessage(
        otherTelegramId,
        `💬 <b>Ответ:</b>\n\n${esc(ctx.message.text)}`,
        { parse_mode: 'HTML', reply_markup: kb }
      )
      await ctx.reply('✅ Ответ передан.')
      return
    }

    const profile = await db.getProfile(user.id)

    // ── Onboarding ──
    if (!profile || profile.onboarding_phase < 8) {
      try {
        const result = await conductOnboarding(user.id, ctx.message.text)

        if (result.done) {
          const freshProfile = await db.getProfile(user.id)
          if (!freshProfile?.profile_confirmed) {
            const kb = new InlineKeyboard()
              .text('✅ Всё верно', `confirm_profile:${user.id}`)
              .text('✏️ Изменить', `edit_showcase:${user.id}`)
            await ctx.reply(
              `Вот как агент будет говорить от твоего имени:\n\n<i>${esc(freshProfile?.persona_ref)}</i>\n\nПодтверди или отредактируй.`,
              { parse_mode: 'HTML', reply_markup: kb }
            )
          }
          return
        }

        if (result.message) await ctx.reply(result.message)

        if (result.finalPhase) {
          const personaRef = result.personaRef || (await db.getProfile(user.id))?.persona_ref
          const kb = new InlineKeyboard()
            .text('✅ Всё верно', `confirm_profile:${user.id}`)
            .text('✏️ Изменить', `edit_showcase:${user.id}`)
          await ctx.reply(
            `✅ <b>Профиль собран!</b>\n\nВот как агент будет говорить от твоего имени:\n\n<i>${esc(personaRef)}</i>\n\nПодтверди или отредактируй.`,
            { parse_mode: 'HTML', reply_markup: kb }
          )
        }
      } catch (e) {
        console.error('Onboarding error:', e)
        await ctx.reply('Что-то пошло не так. Попробуй ещё раз.')
      }
      return
    }

    // ── Default ──
    await ctx.reply(
      `Используй:\n/matches — найденные матчи\n/profile — твой профиль\n/found — нашёл что искал\n/restart — начать заново`
    )
  })

  bot.catch((err) => {
    console.error('Bot error:', err.message, err.ctx?.update)
  })

  return bot
}
