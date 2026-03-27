-- AgentNet Database Schema
-- Run: psql $DATABASE_URL -f scripts/schema.sql

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;

-- ─── Users ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  telegram_id BIGINT UNIQUE NOT NULL,
  username    TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Profiles (agent's knowledge about the user) ─────────────────────────────

CREATE TABLE IF NOT EXISTS profiles (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID UNIQUE REFERENCES users(id) ON DELETE CASCADE,

  -- Onboarding state
  onboarding_phase  INT DEFAULT 0,   -- 0=not started, 1-6=phase, 7=complete
  onboarding_data   JSONB DEFAULT '{}',

  -- Structured profile (filled after onboarding)
  goal_type         TEXT,            -- romantic | business | mentor
  archetype_tags    TEXT[],
  decision_style    TEXT,
  communication_directness FLOAT,   -- 0..1
  openness_score    FLOAT,          -- 0..1
  hard_filters      JSONB DEFAULT '{}',
  style_vector      JSONB DEFAULT '{}',

  -- Needs detected passively from conversations
  detected_needs    JSONB DEFAULT '[]',

  -- Public showcase (shown to other agents)
  showcase_public   TEXT,           -- 2-3 sentence summary
  showcase_tags     TEXT[],

  -- Embedding (computed once, updated on profile change)
  embedding         vector(1536),

  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS profiles_embedding_idx
  ON profiles USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- ─── Pings ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pings (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  from_user_id  UUID REFERENCES users(id) ON DELETE CASCADE,
  to_user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  score         FLOAT,
  hypothesis    TEXT,
  ping_text     TEXT,
  status        TEXT DEFAULT 'sent',  -- sent | accepted | rejected | expired
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  responded_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS pings_to_user_idx ON pings(to_user_id, status);
CREATE INDEX IF NOT EXISTS pings_from_user_idx ON pings(from_user_id, created_at);

-- ─── Dialogues ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS dialogues (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ping_id         UUID REFERENCES pings(id),
  user_a_id       UUID REFERENCES users(id),
  user_b_id       UUID REFERENCES users(id),
  status          TEXT DEFAULT 'active',  -- active | handoff | closed
  turns           INT DEFAULT 0,
  transcript      JSONB DEFAULT '[]',

  -- Temporal lock
  intent_a        BOOLEAN DEFAULT FALSE,
  intent_b        BOOLEAN DEFAULT FALSE,
  intent_a_at     TIMESTAMPTZ,
  intent_b_at     TIMESTAMPTZ,
  handoff_at      TIMESTAMPTZ,

  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Watchlist ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS watchlist (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID REFERENCES users(id) ON DELETE CASCADE,
  target_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  score         FLOAT,
  reason        TEXT,
  added_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, target_user_id)
);

-- ─── Conversations (bot chat history per user) ───────────────────────────────

CREATE TABLE IF NOT EXISTS conversations (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,   -- user | assistant
  content     TEXT NOT NULL,
  metadata    JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS conversations_user_idx ON conversations(user_id, created_at DESC);

-- ─── Ping rate limiting ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ping_quota (
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  date       DATE DEFAULT CURRENT_DATE,
  count      INT DEFAULT 0,
  PRIMARY KEY (user_id, date)
);

-- ─── Functions ───────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER profiles_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER dialogues_updated_at
  BEFORE UPDATE ON dialogues
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
