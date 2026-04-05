-- AgentNet Database Schema v2 — anonymized, agent-centric
-- Run: psql $DATABASE_URL -f schema.sql

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── Clean up old tables ──────────────────────────────────────────────────────

DROP TABLE IF EXISTS match_messages            CASCADE;
DROP TABLE IF EXISTS matches                   CASCADE;
DROP TABLE IF EXISTS conversations             CASCADE;
DROP TABLE IF EXISTS ping_quota                CASCADE;
DROP TABLE IF EXISTS watchlist                 CASCADE;
DROP TABLE IF EXISTS dialogues                 CASCADE;
DROP TABLE IF EXISTS pings                     CASCADE;
DROP TABLE IF EXISTS profiles                  CASCADE;
DROP TABLE IF EXISTS users                     CASCADE;
DROP TABLE IF EXISTS onboarding_conversations  CASCADE;
DROP TABLE IF EXISTS agents                    CASCADE;

-- ─── Agents (self-contained — no user FK, no personal data) ──────────────────

CREATE TABLE agents (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_name      TEXT DEFAULT 'Агент',

  -- Onboarding state
  onboarding_phase    INT DEFAULT 0,         -- 0 = not started, 1 = in progress, 8 = done
  onboarding_data     JSONB DEFAULT '{}',
  profile_confirmed   BOOLEAN DEFAULT FALSE,
  matching_active     BOOLEAN DEFAULT FALSE,
  matching_stopped_at TIMESTAMPTZ,
  profile_updated_at  TIMESTAMPTZ,

  -- Personality profile
  goal_type                  TEXT,            -- romantic | business | mentor
  archetype_tags             TEXT[],
  decision_style             TEXT,
  communication_directness   FLOAT,
  openness_score             FLOAT,
  hard_filters               JSONB DEFAULT '{}',
  style_vector               JSONB DEFAULT '{}',
  showcase_public            TEXT,            -- public-facing summary
  showcase_tags              TEXT[],

  -- Romantic-only fields
  gender                     TEXT,
  age                        INT,
  physical_self              JSONB DEFAULT '{}',
  orientation                TEXT,
  relationship_format        TEXT,
  partner_gender_preference  TEXT,
  physical_preferences       JSONB DEFAULT '{}',
  intimate_tags              TEXT[],
  intimate_dealbreakers      TEXT[],

  -- Agent personality prompt (used when answering questions from candidates)
  persona_ref TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Onboarding conversations (user ↔ agent during setup) ────────────────────

CREATE TABLE onboarding_conversations (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_id   UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,    -- 'user' | 'assistant'
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX oc_agent_idx ON onboarding_conversations(agent_id, created_at DESC);

-- ─── Matches ──────────────────────────────────────────────────────────────────

CREATE TABLE matches (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_a_id  UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  agent_b_id  UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  score       FLOAT,
  hypothesis  TEXT,
  conversation JSONB DEFAULT '[]',    -- agent-to-agent intro transcript [{from,text}]
  status      TEXT DEFAULT 'new',     -- new | active | mutual | closed
  intent_a    BOOLEAN DEFAULT FALSE,
  intent_b    BOOLEAN DEFAULT FALSE,
  notified_b  BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(agent_a_id, agent_b_id)
);

CREATE INDEX matches_a_idx ON matches(agent_a_id, status);
CREATE INDEX matches_b_idx ON matches(agent_b_id, status);

-- ─── Match messages (NOT saved after status = mutual — direct chat goes local) ─

CREATE TABLE match_messages (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  match_id   UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  sender     TEXT NOT NULL,    -- agentId | 'agent' | 'human:<agentId>'
  content    TEXT NOT NULL,
  routed     BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX mm_match_idx ON match_messages(match_id, created_at ASC);

-- ─── Triggers ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agents_updated_at
  BEFORE UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER matches_updated_at
  BEFORE UPDATE ON matches
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
