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

  // Find candidates by vector similarity, excluding already-pinged
  async findCandidates(userId, embedding, limit = 20) {
    const { rows } = await pool.query(
      `SELECT p.*, u.telegram_id, u.username,
              1 - (p.embedding <=> $2::vector) AS similarity
       FROM profiles p
       JOIN users u ON u.id = p.user_id
       WHERE p.user_id != $1
         AND p.onboarding_phase = 7
         AND p.embedding IS NOT NULL
         AND p.user_id NOT IN (
           SELECT to_user_id FROM pings
           WHERE from_user_id = $1
             AND created_at > NOW() - INTERVAL '7 days'
         )
       ORDER BY p.embedding <=> $2::vector
       LIMIT $3`,
      [userId, JSON.stringify(embedding), limit]
    )
    return rows
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
  }
}
