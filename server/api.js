import express from 'express'
import { db, pool }          from '../db/postgres.js'
import { conductOnboarding } from '../agent/onboarding.js'
import { agentAnswerQuestion } from '../agent/matching.js'
import { scheduleMatching }  from '../queue/queues.js'

const app = express()

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const allowed = process.env.CORS_ORIGIN || '*'
  res.setHeader('Access-Control-Allow-Origin',  allowed)
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Agent-Id,X-Dev-Agent-Id')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

app.use(express.json())

// ─── Auth middleware ───────────────────────────────────────────────────────────
// Auth = agent UUID sent as X-Agent-Id header. No personal data stored.

async function auth(req, res, next) {
  // Dev mode
  if (process.env.NODE_ENV !== 'production' && req.headers['x-dev-agent-id']) {
    req.agentId = req.headers['x-dev-agent-id']
    return next()
  }

  const agentId = req.headers['x-agent-id'] || req.body?.agentId
  if (!agentId) return res.status(401).json({ error: 'Missing X-Agent-Id' })

  try {
    const agent = await db.getAgentById(agentId)
    if (!agent) return res.status(401).json({ error: 'Unknown agent' })
    req.agentId = agentId
    next()
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
}

// ─── Agents ───────────────────────────────────────────────────────────────────

// Create agent — open endpoint, returns new UUID that client stores locally
app.post('/api/agents', async (req, res) => {
  try {
    const { name } = req.body
    const agent = await db.createAgent(name || 'Агент')
    res.json({ agent })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Get agent by ID — open endpoint (UUID is effectively the access token)
app.get('/api/agents/:agentId', async (req, res) => {
  try {
    const agent = await db.getAgentById(req.params.agentId)
    if (!agent) return res.status(404).json({ error: 'Not found' })
    res.json({ agent })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Delete agent — must be the agent itself
app.delete('/api/agents/:agentId', auth, async (req, res) => {
  if (req.agentId !== req.params.agentId)
    return res.status(403).json({ error: 'Forbidden' })
  try {
    await db.deleteAgent(req.params.agentId)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Toggle matching active
app.put('/api/agents/:agentId/matching', auth, async (req, res) => {
  if (req.agentId !== req.params.agentId)
    return res.status(403).json({ error: 'Forbidden' })
  try {
    const { active } = req.body
    await db.setMatchingActive(req.params.agentId, !!active)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Reset agent — wipes profile + onboarding history
app.post('/api/agents/:agentId/reset', auth, async (req, res) => {
  if (req.agentId !== req.params.agentId)
    return res.status(403).json({ error: 'Forbidden' })
  try {
    await pool.query('DELETE FROM onboarding_conversations WHERE agent_id = $1', [req.params.agentId])
    await db.updateAgent(req.params.agentId, {
      onboarding_phase: 0, onboarding_data: '{}',
      profile_confirmed: false, matching_active: false,
      persona_ref: null, showcase_public: null,
      goal_type: null, archetype_tags: null, decision_style: null,
      communication_directness: null, openness_score: null,
      hard_filters: '{}', style_vector: '{}',
      gender: null, age: null, physical_self: '{}', orientation: null,
      relationship_format: null, physical_preferences: '{}',
      intimate_tags: null, intimate_dealbreakers: null,
      partner_gender_preference: null, profile_updated_at: null
    })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ─── Onboarding chat ──────────────────────────────────────────────────────────

app.post('/api/chat', auth, async (req, res) => {
  try {
    const { message } = req.body
    if (!message?.trim()) return res.status(400).json({ error: 'Empty message' })

    const result = await conductOnboarding(req.agentId, message)

    if (result.finalPhase) {
      await db.updateAgent(req.agentId, {
        profile_confirmed: true,
        matching_active: true,
        profile_updated_at: new Date()
      })
      await scheduleMatching(req.agentId)
    }

    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ─── Matches ──────────────────────────────────────────────────────────────────

// Get all matches for this agent
app.get('/api/matches', auth, async (req, res) => {
  try {
    const matches = await db.getMatchesForAgent(req.agentId)
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
    // Verify caller is a participant
    if (match.agent_a_id !== req.agentId && match.agent_b_id !== req.agentId)
      return res.status(403).json({ error: 'Forbidden' })
    res.json({ match })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Get match messages
app.get('/api/match/:matchId/messages', auth, async (req, res) => {
  try {
    const match = await db.getMatch(req.params.matchId)
    if (!match) return res.status(404).json({ error: 'Not found' })
    if (match.agent_a_id !== req.agentId && match.agent_b_id !== req.agentId)
      return res.status(403).json({ error: 'Forbidden' })
    const messages = await db.getMatchMessages(req.params.matchId)
    res.json({ messages })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Ask the counterpart's agent a question
app.post('/api/match/:matchId/ask', auth, async (req, res) => {
  try {
    const { question, forceAgent } = req.body
    if (!question?.trim()) return res.status(400).json({ error: 'Empty question' })

    const match = await db.getMatch(req.params.matchId)
    if (!match) return res.status(404).json({ error: 'Not found' })
    if (match.agent_a_id !== req.agentId && match.agent_b_id !== req.agentId)
      return res.status(403).json({ error: 'Forbidden' })

    const isA           = String(match.agent_a_id) === String(req.agentId)
    const targetPersona = isA
      ? (match.persona_b || match.showcase_b || '')
      : (match.persona_a || match.showcase_a || '')

    const result = await agentAnswerQuestion(question, targetPersona, !!forceAgent)

    await db.addMatchMessage(req.params.matchId, req.agentId, question, result.routed)
    if (!result.routed) {
      await db.addMatchMessage(req.params.matchId, 'agent', result.answer, false)
    }

    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Send a direct human reply (question routed to you, or direct mode)
app.post('/api/match/:matchId/reply', auth, async (req, res) => {
  try {
    const { text } = req.body
    if (!text?.trim()) return res.status(400).json({ error: 'Empty reply' })

    const match = await db.getMatch(req.params.matchId)
    if (!match) return res.status(404).json({ error: 'Not found' })
    if (match.agent_a_id !== req.agentId && match.agent_b_id !== req.agentId)
      return res.status(403).json({ error: 'Forbidden' })

    // addMatchMessage returns null if match is mutual (not saved)
    const msg = await db.addMatchMessage(req.params.matchId, `human:${req.agentId}`, text, false)
    res.json({ message: msg, saved: !!msg })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Set intent (want to meet)
app.post('/api/match/:matchId/intent', auth, async (req, res) => {
  try {
    const match = await db.getMatch(req.params.matchId)
    if (!match) return res.status(404).json({ error: 'Not found' })
    if (match.agent_a_id !== req.agentId && match.agent_b_id !== req.agentId)
      return res.status(403).json({ error: 'Forbidden' })

    const result = await db.setMatchIntent(req.params.matchId, req.agentId)

    if (result === 'mutual') {
      await db.setMatchingActive(match.agent_a_id, false)
      await db.setMatchingActive(match.agent_b_id, false)
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
