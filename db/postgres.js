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

  async getProfile(userId) {
    const { rows } = await pool.query(
      'SELECT * FROM profiles WHERE user_id = $1',
      [userId]
    )
    return rows[0] || null
  },

  async upsertProfile(userId, data) {
    const keys = Object.keys(data)
    const values = Object.values(data)
    const setClauses = keys.map((k, i) => `${k} = $${i + 2}`).join(', ')
    const { rows } = await pool.query(
      `INSERT INTO profiles (user_id, ${keys.join(', ')})
       VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(', ')})
       ON CONFLICT (user_id) DO UPDATE SET ${setClauses}, updated_at = NOW()
       RETURNING *`,
      [userId, ...values]
    )
    return rows[0]
  },

  async saveConversation(userId, role, content, metadata = {}) {
    await pool.query(
      'INSERT INTO conversations (user_id, role, content, metadata) VALUES ($1, $2, $3, $4)',
      [userId, role, content, metadata]
    )
  },

  async getRecentConversation(userId, limit = 20) {
    const { rows } = await pool.query(
      `SELECT role, content FROM conversations
       WHERE user_id = $1
       ORDER BY created_at DESC LIMIT $2`,
      [userId, limit]
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
               (SELECT profile_updated_at FROM profiles self WHERE self.user_id = $1),
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
               (SELECT profile_updated_at FROM profiles self WHERE self.user_id = $1),
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
      `SELECT u.id, u.telegram_id FROM users u
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

  async createMatch(userAId, userBId, score, hypothesis, conversation) {
    const { rows } = await pool.query(
      `INSERT INTO matches (user_a_id, user_b_id, score, hypothesis, conversation)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_a_id, user_b_id) DO UPDATE
         SET score = EXCLUDED.score, hypothesis = EXCLUDED.hypothesis,
             conversation = EXCLUDED.conversation, updated_at = NOW()
       RETURNING *`,
      [userAId, userBId, score, hypothesis, JSON.stringify(conversation)]
    )
    return rows[0]
  },

  async getMatchesForUser(userId) {
    const { rows } = await pool.query(
      `SELECT m.*,
              ua.telegram_id AS user_a_telegram, ua.username AS user_a_username,
              ub.telegram_id AS user_b_telegram, ub.username AS user_b_username,
              pa.persona_ref AS persona_a, pb.persona_ref AS persona_b,
              pb.showcase_public AS showcase_b
       FROM matches m
       JOIN users ua ON ua.id = m.user_a_id
       JOIN users ub ON ub.id = m.user_b_id
       LEFT JOIN profiles pa ON pa.user_id = m.user_a_id
       LEFT JOIN profiles pb ON pb.user_id = m.user_b_id
       WHERE (m.user_a_id = $1 OR m.user_b_id = $1)
         AND m.status != 'closed'
       ORDER BY m.score DESC`,
      [userId]
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
       LEFT JOIN profiles pa ON pa.user_id = m.user_a_id
       LEFT JOIN profiles pb ON pb.user_id = m.user_b_id
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
