import pg from 'pg'
import 'dotenv/config'

const { Pool } = pg

export const pool = new Pool({ connectionString: process.env.DATABASE_URL })

export const db = {
  query: (text, params) => pool.query(text, params),

  // Get or create user by Telegram ID
  async upsertUser(telegramId, username) {
    const { rows } = await pool.query(
      `INSERT INTO users (telegram_id, username)
       VALUES ($1, $2)
       ON CONFLICT (telegram_id) DO UPDATE SET username = EXCLUDED.username
       RETURNING *`,
      [telegramId, username]
    )
    return rows[0]
  },

  async getUserByTelegramId(telegramId) {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE telegram_id = $1',
      [telegramId]
    )
    return rows[0] || null
  },

  // Get active profile for user (for matching / bot compat)
  async getProfile(userId) {
    const { rows } = await pool.query(
      `SELECT * FROM profiles WHERE user_id = $1 ORDER BY is_active DESC, created_at ASC LIMIT 1`,
      [userId]
    )
    return rows[0] || null
  },

  // Get specific agent by id
  async getProfileById(agentId) {
    const { rows } = await pool.query('SELECT * FROM profiles WHERE id = $1', [agentId])
    return rows[0] || null
  },

  // Get all agents for user
  async getAgents(userId) {
    const { rows } = await pool.query(
      `SELECT * FROM profiles WHERE user_id = $1 ORDER BY created_at ASC`,
      [userId]
    )
    return rows
  },

  // Create a new agent (blank profile)
  async createAgent(userId, name = 'Новый агент') {
    const existing = await this.getAgents(userId)
    const isFirst  = existing.length === 0
    const { rows } = await pool.query(
      `INSERT INTO profiles (user_id, agent_name, is_active, onboarding_phase, onboarding_data)
       VALUES ($1, $2, $3, 0, '{}') RETURNING *`,
      [userId, name, isFirst]
    )
    return rows[0]
  },

  // Set active agent (one active per user)
  async setActiveAgent(userId, agentId) {
    await pool.query('UPDATE profiles SET is_active = FALSE WHERE user_id = $1', [userId])
    await pool.query('UPDATE profiles SET is_active = TRUE  WHERE id = $1', [agentId])
  },

  // Delete agent
  async deleteAgent(agentId) {
    await pool.query('DELETE FROM profiles WHERE id = $1', [agentId])
  },

  async upsertProfile(userId, data, agentId = null) {
    const keys = Object.keys(data)
    const values = Object.values(data)
    const setClauses = keys.map((k, i) => `${k} = $${i + 2}`).join(', ')

    // If agentId given — update that specific agent
    if (agentId) {
      const { rows } = await pool.query(
        `UPDATE profiles SET ${setClauses}, updated_at = NOW() WHERE id = $1 RETURNING *`,
        [agentId, ...values]
      )
      return rows[0]
    }

    // Legacy: find existing profile and update, or insert first one
    const existing = await this.getProfile(userId)
    if (existing) {
      const { rows } = await pool.query(
        `UPDATE profiles SET ${setClauses}, updated_at = NOW() WHERE id = $1 RETURNING *`,
        [existing.id, ...values]
      )
      return rows[0]
    }

    // No profile yet — create first one (active)
    const { rows } = await pool.query(
      `INSERT INTO profiles (user_id, is_active, ${keys.join(', ')})
       VALUES ($1, TRUE, ${keys.map((_, i) => `$${i + 2}`).join(', ')})
       RETURNING *`,
      [userId, ...values]
    )
    return rows[0]
  },

  async saveConversation(userId, role, content, metadata = {}, agentId = null) {
    await pool.query(
      'INSERT INTO conversations (user_id, role, content, metadata, agent_id) VALUES ($1, $2, $3, $4, $5)',
      [userId, role, content, metadata, agentId]
    )
  },

  async getRecentConversation(userId, limit = 20, agentId = null) {
    const { rows } = await pool.query(
      `SELECT role, content FROM conversations
       WHERE user_id = $1 AND agent_id ${agentId ? '= $3' : 'IS NULL'}
       ORDER BY created_at DESC LIMIT $2`,
      agentId ? [userId, limit, agentId] : [userId, limit]
    )
    return rows.reverse()
  },

  // Find candidates by vector similarity, excluding already-pinged and inactive
  async findCandidates(userId, embedding, limit = 20) {
    const { rows } = await pool.query(
      `SELECT p.*, u.telegram_id, u.username,
              1 - (p.embedding <=> $2::vector) AS similarity
       FROM profiles p
       JOIN users u ON u.id = p.user_id
       WHERE p.user_id != $1
         AND p.profile_confirmed = TRUE
         AND p.embedding IS NOT NULL
         AND p.matching_active = TRUE
         AND NOT EXISTS (
           SELECT 1 FROM matches m
           WHERE ((m.user_a_id = $1 AND m.user_b_id = p.user_id)
               OR (m.user_b_id = $1 AND m.user_a_id = p.user_id))
             AND m.created_at > COALESCE(
               (SELECT profile_updated_at FROM profiles self WHERE self.user_id = $1 ORDER BY profile_updated_at DESC NULLS LAST LIMIT 1),
               '1970-01-01'::timestamptz
             )
             AND m.created_at > COALESCE(p.profile_updated_at, '1970-01-01'::timestamptz)
         )
       ORDER BY p.embedding <=> $2::vector
       LIMIT $3`,
      [userId, JSON.stringify(embedding), limit]
    )
    return rows
  },

  // Find candidates without embedding (fallback)
  async findCandidatesWithoutEmbedding(userId, limit = 50) {
    // Debug: count why candidates are excluded
    try {
      const { rows: d1 } = await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE user_id != $1)                                        AS total_other,
           COUNT(*) FILTER (WHERE user_id != $1 AND profile_confirmed = TRUE)           AS confirmed,
           COUNT(*) FILTER (WHERE user_id != $1 AND profile_confirmed = TRUE
                              AND matching_active = TRUE)                               AS active
         FROM profiles`,
        [userId]
      )
      const { rows: d2 } = await pool.query(
        `SELECT COUNT(*) AS after_dedup
         FROM profiles p
         WHERE p.user_id != $1
           AND p.profile_confirmed = TRUE
           AND p.matching_active = TRUE
           AND NOT EXISTS (
             SELECT 1 FROM matches m
             WHERE ((m.user_a_id = $1 AND m.user_b_id = p.user_id)
                 OR (m.user_b_id = $1 AND m.user_a_id = p.user_id))
               AND m.created_at > COALESCE(
                 (SELECT profile_updated_at FROM profiles s WHERE s.user_id = $1 LIMIT 1),
                 '1970-01-01'::timestamptz)
               AND m.created_at > COALESCE(p.profile_updated_at, '1970-01-01'::timestamptz)
           )`,
        [userId]
      )
      const d = d1[0]
      console.log(`[db:candidates] user=${userId.slice(0,8)} other=${d.total_other} confirmed=${d.confirmed} active=${d.active} after_dedup=${d2[0].after_dedup}`)
    } catch (e) {
      console.error(`[db:candidates] debug query failed:`, e.message)
    }

    const { rows } = await pool.query(
      `SELECT p.*, u.telegram_id, u.username
       FROM profiles p
       JOIN users u ON u.id = p.user_id
       WHERE p.user_id != $1
         AND p.profile_confirmed = TRUE
         AND p.matching_active = TRUE
         AND NOT EXISTS (
           SELECT 1 FROM matches m
           WHERE ((m.user_a_id = $1 AND m.user_b_id = p.user_id)
               OR (m.user_b_id = $1 AND m.user_a_id = p.user_id))
             AND m.created_at > COALESCE(
               (SELECT profile_updated_at FROM profiles self WHERE self.user_id = $1 ORDER BY profile_updated_at DESC NULLS LAST LIMIT 1),
               '1970-01-01'::timestamptz
             )
             AND m.created_at > COALESCE(p.profile_updated_at, '1970-01-01'::timestamptz)
         )
       LIMIT $2`,
      [userId, limit]
    )
    return rows
  },

  async getActiveMatchingUsers() {
    const { rows } = await pool.query(
      `SELECT DISTINCT u.id, u.telegram_id FROM users u
       JOIN profiles p ON p.user_id = u.id
       WHERE p.profile_confirmed = TRUE AND p.matching_active = TRUE`
    )
    return rows
  },

  async setMatchingActive(userId, active) {
    await pool.query(
      `UPDATE profiles SET matching_active = $2, matching_stopped_at = $3 WHERE user_id = $1`,
      [userId, active, active ? null : new Date()]
    )
  },

  async setPendingAction(userId, action) {
    await pool.query(
      'UPDATE profiles SET pending_action = $2 WHERE user_id = $1',
      [userId, action]
    )
  },

  async confirmProfile(userId, showcasePublic = null) {
    await pool.query(
      `UPDATE profiles SET profile_confirmed = TRUE, matching_active = TRUE, profile_updated_at = NOW()${showcasePublic ? ', showcase_public = $2' : ''} WHERE user_id = $1`,
      showcasePublic ? [userId, showcasePublic] : [userId]
    )
  },

  async resetProfile(userId) {
    await pool.query(
      `UPDATE profiles SET
        onboarding_phase = 0, onboarding_data = '{}',
        profile_confirmed = FALSE, matching_active = FALSE,
        matching_stopped_at = NULL,
        goal_type = NULL, archetype_tags = NULL, decision_style = NULL,
        communication_directness = NULL, openness_score = NULL,
        hard_filters = '{}', style_vector = '{}', detected_needs = '[]',
        showcase_public = NULL, showcase_tags = NULL, embedding = NULL,
        gender = NULL, age = NULL, physical_self = '{}', orientation = NULL,
        relationship_format = NULL, physical_preferences = '{}',
        intimate_tags = NULL, intimate_dealbreakers = NULL
       WHERE user_id = $1`,
      [userId]
    )
    await pool.query('DELETE FROM conversations WHERE user_id = $1', [userId])
  },

  async createPing(fromUserId, toUserId, score, hypothesis, pingText) {
    const { rows } = await pool.query(
      `INSERT INTO pings (from_user_id, to_user_id, score, hypothesis, ping_text)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [fromUserId, toUserId, score, hypothesis, pingText]
    )
    return rows[0]
  },

  async getPendingPings(userId) {
    const { rows } = await pool.query(
      `SELECT p.*, u.username,
              pr.showcase_public, pr.archetype_tags, pr.goal_type
       FROM pings p
       JOIN users u ON u.id = p.from_user_id
       JOIN profiles pr ON pr.user_id = p.from_user_id
       WHERE p.to_user_id = $1 AND p.status = 'sent'
       ORDER BY p.created_at DESC`,
      [userId]
    )
    return rows
  },

  async updatePingStatus(pingId, status) {
    await pool.query(
      'UPDATE pings SET status = $1, responded_at = NOW() WHERE id = $2',
      [status, pingId]
    )
  },

  async createDialogue(pingId, userAId, userBId) {
    const { rows } = await pool.query(
      `INSERT INTO dialogues (ping_id, user_a_id, user_b_id)
       VALUES ($1, $2, $3) RETURNING *`,
      [pingId, userAId, userBId]
    )
    return rows[0]
  },

  async getDialogue(dialogueId) {
    const { rows } = await pool.query(
      'SELECT * FROM dialogues WHERE id = $1',
      [dialogueId]
    )
    return rows[0] || null
  },

  async getActiveDialogue(userId) {
    const { rows } = await pool.query(
      `SELECT * FROM dialogues
       WHERE (user_a_id = $1 OR user_b_id = $1) AND status = 'active'
       ORDER BY created_at DESC LIMIT 1`,
      [userId]
    )
    return rows[0] || null
  },

  async appendDialogueTurn(dialogueId, turn) {
    await pool.query(
      `UPDATE dialogues
       SET transcript = transcript || $2::jsonb,
           turns = turns + 1,
           updated_at = NOW()
       WHERE id = $1`,
      [dialogueId, JSON.stringify([turn])]
    )
  },

  async setHandoffIntent(dialogueId, userId) {
    // Determine if user is A or B
    const { rows } = await pool.query(
      'SELECT user_a_id, user_b_id, intent_a, intent_b FROM dialogues WHERE id = $1',
      [dialogueId]
    )
    const d = rows[0]
    if (!d) return null

    const isA = d.user_a_id === userId
    const field = isA ? 'intent_a' : 'intent_b'
    const timeField = isA ? 'intent_a_at' : 'intent_b_at'

    await pool.query(
      `UPDATE dialogues SET ${field} = TRUE, ${timeField} = NOW() WHERE id = $1`,
      [dialogueId]
    )

    // Check if both intents are set → handoff
    const updatedField = isA ? d.intent_b : d.intent_a
    if (updatedField) {
      await pool.query(
        `UPDATE dialogues SET status = 'handoff', handoff_at = NOW() WHERE id = $1`,
        [dialogueId]
      )
      return 'handoff'
    }
    return 'waiting'
  },

  async checkPingQuota(userId) {
    const limit = parseInt(process.env.PING_DAILY_LIMIT || '5')
    const { rows } = await pool.query(
      `INSERT INTO ping_quota (user_id, date, count)
       VALUES ($1, CURRENT_DATE, 1)
       ON CONFLICT (user_id, date) DO UPDATE SET count = ping_quota.count + 1
       RETURNING count`,
      [userId]
    )
    return rows[0].count <= limit
  },

  async addToWatchlist(userId, targetUserId, score, reason) {
    await pool.query(
      `INSERT INTO watchlist (user_id, target_user_id, score, reason)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, target_user_id) DO UPDATE
         SET score = EXCLUDED.score, reason = EXCLUDED.reason`,
      [userId, targetUserId, score, reason]
    )
  },

  // ─── Matches ────────────────────────────────────────────────────────────────

  async createMatch(userAId, userBId, score, hypothesis, conversation, profileAId = null, profileBId = null) {
    // Normalize order so (A,B) and (B,A) always resolve to the same row
    const [aId, bId, pAId, pBId] = userAId < userBId
      ? [userAId, userBId, profileAId, profileBId]
      : [userBId, userAId, profileBId, profileAId]

    const { rows } = await pool.query(
      `INSERT INTO matches (user_a_id, user_b_id, score, hypothesis, conversation, profile_a_id, profile_b_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_a_id, user_b_id) DO UPDATE
         SET score = GREATEST(matches.score, EXCLUDED.score),
             hypothesis = EXCLUDED.hypothesis,
             conversation = EXCLUDED.conversation,
             profile_a_id = EXCLUDED.profile_a_id, profile_b_id = EXCLUDED.profile_b_id,
             updated_at = NOW()
       RETURNING *`,
      [aId, bId, score, hypothesis, JSON.stringify(conversation), pAId, pBId]
    )
    return rows[0]
  },

  async getMatchesForUser(userId, profileId = null) {
    const filter = profileId
      ? `AND (m.profile_a_id = $2 OR m.profile_b_id = $2)`
      : ''
    const params = profileId ? [userId, profileId] : [userId]
    const { rows } = await pool.query(
      `SELECT m.*,
              ua.telegram_id AS user_a_telegram, ua.username AS user_a_username,
              ub.telegram_id AS user_b_telegram, ub.username AS user_b_username,
              pa.persona_ref AS persona_a, pb.persona_ref AS persona_b,
              pb.showcase_public AS showcase_b
       FROM matches m
       JOIN users ua ON ua.id = m.user_a_id
       JOIN users ub ON ub.id = m.user_b_id
       LEFT JOIN profiles pa ON pa.id = m.profile_a_id
       LEFT JOIN profiles pb ON pb.id = m.profile_b_id
       WHERE (m.user_a_id = $1 OR m.user_b_id = $1)
         AND m.status != 'closed'
         ${filter}
       ORDER BY m.score DESC`,
      params
    )
    return rows
  },

  async getMatch(matchId) {
    const { rows } = await pool.query(
      `SELECT m.*,
              ua.telegram_id AS user_a_telegram, ua.username AS user_a_username,
              ub.telegram_id AS user_b_telegram, ub.username AS user_b_username,
              pa.persona_ref AS persona_a, pa.showcase_public AS showcase_a,
              pb.persona_ref AS persona_b, pb.showcase_public AS showcase_b
       FROM matches m
       JOIN users ua ON ua.id = m.user_a_id
       JOIN users ub ON ub.id = m.user_b_id
       LEFT JOIN profiles pa ON pa.id = m.profile_a_id
       LEFT JOIN profiles pb ON pb.id = m.profile_b_id
       WHERE m.id = $1`,
      [matchId]
    )
    return rows[0] || null
  },

  async setMatchIntent(matchId, userId) {
    const { rows } = await pool.query(
      'SELECT user_a_id, user_b_id, intent_a, intent_b FROM matches WHERE id = $1',
      [matchId]
    )
    const m = rows[0]
    if (!m) return null

    const isA = String(m.user_a_id) === String(userId)
    const field = isA ? 'intent_a' : 'intent_b'
    await pool.query(
      `UPDATE matches SET ${field} = TRUE, status = 'active', updated_at = NOW() WHERE id = $1`,
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

  async addMatchMessage(matchId, sender, content, routed = false) {
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
