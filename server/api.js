import express from 'express'
import crypto  from 'crypto'
import { fileURLToPath } from 'url'
import { dirname, join }  from 'path'

import { db }                from '../db/postgres.js'
import { conductOnboarding } from '../agent/onboarding.js'
import { agentAnswerQuestion } from '../agent/matching.js'
import { scheduleMatching }  from '../queue/queues.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const allowed = process.env.CORS_ORIGIN || '*'
  res.setHeader('Access-Control-Allow-Origin',  allowed)
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Telegram-Init-Data,X-Dev-User-Id')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

app.use(express.json())

// ─── Telegram init data validation ───────────────────────────────────────────

function parseTelegramInitData(initData) {
  if (!initData) return null
  try {
    const params = new URLSearchParams(initData)
    const hash   = params.get('hash')
    if (!hash) return null

    params.delete('hash')
    const checkString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')

    const secretKey = crypto.createHmac('sha256', 'WebAppData')
      .update(process.env.BOT_TOKEN || '')
      .digest()

    const expectedHash = crypto.createHmac('sha256', secretKey)
      .update(checkString)
      .digest('hex')

    if (expectedHash !== hash) return null

    const userStr = params.get('user')
    return userStr ? JSON.parse(userStr) : null
  } catch { return null }
}

// ─── Auth middleware ──────────────────────────────────────────────────────────

async function auth(req, res, next) {
  const initData = req.headers['x-telegram-init-data'] || req.body?.initData

  // Dev mode fallback
  if (process.env.NODE_ENV !== 'production' && req.headers['x-dev-user-id']) {
    req.userId = req.headers['x-dev-user-id']
    return next()
  }

  const tgUser = parseTelegramInitData(initData)
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' })

  try {
    const user = await db.upsertUser(tgUser.id, tgUser.username)
    req.userId = user.id
    next()
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Auth — get or create user, return profile
app.post('/api/auth', async (req, res) => {
  try {
    const { initData } = req.body

    // Dev fallback
    if (process.env.NODE_ENV !== 'production' && req.body.devUserId) {
      const profile = await db.getProfile(req.body.devUserId)
      return res.json({ userId: req.body.devUserId, profile })
    }

    const tgUser = parseTelegramInitData(initData)
    if (!tgUser) return res.status(401).json({ error: 'Unauthorized' })

    const user    = await db.upsertUser(tgUser.id, tgUser.username)
    const profile = await db.getProfile(user.id)
    res.json({ userId: user.id, profile })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Get profile
app.get('/api/profile', auth, async (req, res) => {
  try {
    const profile = await db.getProfile(req.userId)
    res.json({ profile })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Reset profile
app.post('/api/profile/reset', auth, async (req, res) => {
  try {
    await db.resetProfile(req.userId)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Onboarding chat
app.post('/api/chat', auth, async (req, res) => {
  try {
    const { message } = req.body
    if (!message?.trim()) return res.status(400).json({ error: 'Empty message' })

    const result = await conductOnboarding(req.userId, message)

    if (result.finalPhase) {
      await db.confirmProfile(req.userId)
      await scheduleMatching(req.userId)
    }

    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Get matches
app.get('/api/matches', auth, async (req, res) => {
  try {
    const matches = await db.getMatchesForUser(req.userId)
    res.json({ matches })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Get single match
app.get('/api/match/:matchId', auth, async (req, res) => {
  try {
    const match = await db.getMatch(req.params.matchId)
    if (!match) return res.status(404).json({ error: 'Not found' })
    res.json({ match })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Ask agent a question on behalf of match candidate
app.post('/api/match/:matchId/ask', auth, async (req, res) => {
  try {
    const { question } = req.body
    if (!question?.trim()) return res.status(400).json({ error: 'Empty question' })

    const match = await db.getMatch(req.params.matchId)
    if (!match) return res.status(404).json({ error: 'Not found' })

    const isA         = String(match.user_a_id) === String(req.userId)
    const targetPersona = isA
      ? (match.persona_b || match.showcase_b || '')
      : (match.persona_a || match.showcase_a || '')

    const result = await agentAnswerQuestion(question, targetPersona)

    await db.addMatchMessage(req.params.matchId, req.userId, question, false)
    if (!result.routed) {
      await db.addMatchMessage(req.params.matchId, 'agent', result.answer, false)
    }

    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Set intent (want to meet)
app.post('/api/match/:matchId/intent', auth, async (req, res) => {
  try {
    const result = await db.setMatchIntent(req.params.matchId, req.userId)

    if (result === 'mutual') {
      const match = await db.getMatch(req.params.matchId)
      await db.setMatchingActive(match.user_a_id, false)
      await db.setMatchingActive(match.user_b_id, false)
    }

    res.json({ result })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ─── Start ────────────────────────────────────────────────────────────────────

export function startApiServer() {
  const port = process.env.PORT || 3000
  app.listen(port, () => console.log(`[api] Server on :${port}`))
}
