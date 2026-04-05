import pg from 'pg'
import 'dotenv/config'

const { Pool } = pg

export const pool = new Pool({ connectionString: process.env.DATABASE_URL })

export const db = {
  query: (text, params) => pool.query(text, params),

  // ─── Agents ─────────────────────────────────────────────────────────────────

  async createAgent(name = 'Агент', ownerHash = null) {
    const { rows } = await pool.query(
      `INSERT INTO agents (agent_name, owner_hash, onboarding_phase, onboarding_data)
       VALUES ($1, $2, 0, '{}') RETURNING *`,
      [name, ownerHash]
    )
    return rows[0]
  },

  async getAgentsByOwner(ownerHash) {
    const { rows } = await pool.query(
      `SELECT * FROM agents WHERE owner_hash = $1 ORDER BY created_at ASC`,
      [ownerHash]
    )
    return rows
  },

  async getAgentById(agentId) {
    const { rows } = await pool.query('SELECT * FROM agents WHERE id = $1', [agentId])
    return rows[0] || null
  },

  async updateAgent(agentId, data) {
    const keys   = Object.keys(data)
    const values = Object.values(data)
    if (!keys.length) return null
    const set = keys.map((k, i) => `${k} = $${i + 2}`).join(', ')
    const { rows } = await pool.query(
      `UPDATE agents SET ${set}, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [agentId, ...values]
    )
    return rows[0] || null
  },

  async deleteAgent(agentId) {
    await pool.query('DELETE FROM agents WHERE id = $1', [agentId])
  },

  async setMatchingActive(agentId, active) {
    await pool.query(
      `UPDATE agents SET matching_active = $2, matching_stopped_at = $3 WHERE id = $1`,
      [agentId, active, active ? null : new Date()]
    )
  },

  async getActiveMatchingAgents() {
    const { rows } = await pool.query(
      `SELECT id FROM agents WHERE profile_confirmed = TRUE AND matching_active = TRUE`
    )
    return rows
  },

  // ─── Onboarding conversations ────────────────────────────────────────────────

  async saveOnboardingMessage(agentId, role, content) {
    await pool.query(
      `INSERT INTO onboarding_conversations (agent_id, role, content) VALUES ($1, $2, $3)`,
      [agentId, role, content]
    )
  },

  async getOnboardingHistory(agentId, limit = 40) {
    const { rows } = await pool.query(
      `SELECT role, content FROM onboarding_conversations
       WHERE agent_id = $1
       ORDER BY created_at DESC LIMIT $2`,
      [agentId, limit]
    )
    return rows.reverse()
  },

  // ─── Candidate search ────────────────────────────────────────────────────────

  async findCandidates(agentId, limit = 50) {
    // Debug counts
    try {
      const { rows: d } = await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE id != $1)                                          AS total_other,
           COUNT(*) FILTER (WHERE id != $1 AND profile_confirmed = TRUE)             AS confirmed,
           COUNT(*) FILTER (WHERE id != $1 AND profile_confirmed AND matching_active) AS active
         FROM agents`,
        [agentId]
      )
      console.log(`[db:candidates] agent=${agentId.slice(0,8)} other=${d[0].total_other} confirmed=${d[0].confirmed} active=${d[0].active}`)
    } catch (e) {
      console.error('[db:candidates] debug query failed:', e.message)
    }

    const { rows } = await pool.query(
      `SELECT a.*
       FROM agents a
       WHERE a.id != $1
         AND a.profile_confirmed = TRUE
         AND a.matching_active = TRUE
         AND NOT EXISTS (
           SELECT 1 FROM matches m
           WHERE ((m.agent_a_id = $1 AND m.agent_b_id = a.id)
               OR (m.agent_b_id = $1 AND m.agent_a_id = a.id))
             AND m.created_at > COALESCE(
               (SELECT profile_updated_at FROM agents self WHERE self.id = $1),
               '1970-01-01'::timestamptz)
             AND m.created_at > COALESCE(a.profile_updated_at, '1970-01-01'::timestamptz)
         )
       LIMIT $2`,
      [agentId, limit]
    )
    return rows
  },

  // ─── Matches ─────────────────────────────────────────────────────────────────

  async createMatch(agentAId, agentBId, score, hypothesis, conversation) {
    // Normalize order so (A,B) and (B,A) resolve to the same row
    const [aId, bId] = agentAId < agentBId
      ? [agentAId, agentBId]
      : [agentBId, agentAId]

    const { rows } = await pool.query(
      `INSERT INTO matches (agent_a_id, agent_b_id, score, hypothesis, conversation)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (agent_a_id, agent_b_id) DO UPDATE
         SET score        = GREATEST(matches.score, EXCLUDED.score),
             hypothesis   = EXCLUDED.hypothesis,
             conversation = EXCLUDED.conversation,
             updated_at   = NOW()
       RETURNING *`,
      [aId, bId, score, hypothesis, JSON.stringify(conversation)]
    )
    return rows[0]
  },

  async getMatchesForAgent(agentId) {
    const { rows } = await pool.query(
      `SELECT m.*,
              aa.agent_name   AS agent_a_name,
              aa.showcase_public AS showcase_a,
              aa.persona_ref  AS persona_a,
              ab.agent_name   AS agent_b_name,
              ab.showcase_public AS showcase_b,
              ab.persona_ref  AS persona_b
       FROM matches m
       JOIN agents aa ON aa.id = m.agent_a_id
       JOIN agents ab ON ab.id = m.agent_b_id
       WHERE (m.agent_a_id = $1 OR m.agent_b_id = $1)
         AND m.status != 'closed'
       ORDER BY m.score DESC`,
      [agentId]
    )
    return rows
  },

  async getMatch(matchId) {
    const { rows } = await pool.query(
      `SELECT m.*,
              aa.agent_name   AS agent_a_name,
              aa.showcase_public AS showcase_a,
              aa.persona_ref  AS persona_a,
              ab.agent_name   AS agent_b_name,
              ab.showcase_public AS showcase_b,
              ab.persona_ref  AS persona_b
       FROM matches m
       JOIN agents aa ON aa.id = m.agent_a_id
       JOIN agents ab ON ab.id = m.agent_b_id
       WHERE m.id = $1`,
      [matchId]
    )
    return rows[0] || null
  },

  async setMatchIntent(matchId, agentId) {
    const { rows } = await pool.query(
      'SELECT agent_a_id, agent_b_id, intent_a, intent_b FROM matches WHERE id = $1',
      [matchId]
    )
    const m = rows[0]
    if (!m) return null

    const isA  = String(m.agent_a_id) === String(agentId)
    const field = isA ? 'intent_a' : 'intent_b'
    await pool.query(
      `UPDATE matches SET ${field} = TRUE, updated_at = NOW() WHERE id = $1`,
      [matchId]
    )

    const otherIntent = isA ? m.intent_b : m.intent_a
    if (otherIntent) {
      await pool.query(
        `UPDATE matches SET status = 'mutual', updated_at = NOW() WHERE id = $1`,
        [matchId]
      )
      return 'mutual'
    }
    return 'waiting'
  },

  // ─── Match messages — NOT saved after mutual intent ───────────────────────────

  async addMatchMessage(matchId, sender, content, routed = false) {
    const { rows: [m] } = await pool.query(
      'SELECT status FROM matches WHERE id = $1',
      [matchId]
    )
    // After mutual intent, chat goes local — nothing saved to DB
    if (!m || m.status === 'mutual') return null

    const { rows } = await pool.query(
      `INSERT INTO match_messages (match_id, sender, content, routed)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [matchId, sender, content, routed]
    )
    await pool.query('UPDATE matches SET updated_at = NOW() WHERE id = $1', [matchId])
    return rows[0]
  },

  async getMatchMessages(matchId) {
    const { rows } = await pool.query(
      'SELECT * FROM match_messages WHERE match_id = $1 ORDER BY created_at ASC',
      [matchId]
    )
    return rows
  },

  async markMatchNotifiedB(matchId) {
    await pool.query(
      'UPDATE matches SET notified_b = TRUE, updated_at = NOW() WHERE id = $1',
      [matchId]
    )
  }
}
