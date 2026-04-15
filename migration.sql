-- CastSync Organizations Migration
-- Run this in Railway PostgreSQL > Data tab

-- 1. Add google_id to users if not already there
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id VARCHAR(255) UNIQUE;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- 2. Organizations
CREATE TABLE IF NOT EXISTS orgs (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(255) NOT NULL,
  join_code   VARCHAR(20)  NOT NULL UNIQUE,
  created_at  TIMESTAMP DEFAULT NOW()
);

-- 3. Org members (directors linked to orgs, supports co-directors)
CREATE TABLE IF NOT EXISTS org_members (
  id         SERIAL PRIMARY KEY,
  org_id     INTEGER REFERENCES orgs(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  role       VARCHAR(20) NOT NULL DEFAULT 'owner', -- owner | editor
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (org_id, user_id)
);

-- 4. Seasons (each org can have multiple seasons)
CREATE TABLE IF NOT EXISTS seasons (
  id         SERIAL PRIMARY KEY,
  org_id     INTEGER REFERENCES orgs(id) ON DELETE CASCADE,
  name       VARCHAR(255) NOT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 5. Dancer profiles (reusable across orgs — one per user account)
CREATE TABLE IF NOT EXISTS dancer_profiles (
  id                SERIAL PRIMARY KEY,
  user_id           INTEGER REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  first_name        VARCHAR(100),
  last_name         VARCHAR(100),
  phone             VARCHAR(50),
  address           TEXT,
  grade             VARCHAR(50),
  technique_classes TEXT,
  updated_at        TIMESTAMP DEFAULT NOW()
);

-- 6. Submissions (per org + season — contains availability for that audition)
CREATE TABLE IF NOT EXISTS submissions (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
  org_id       INTEGER REFERENCES orgs(id) ON DELETE CASCADE,
  season_id    INTEGER REFERENCES seasons(id) ON DELETE CASCADE,
  injuries     TEXT,
  absences     TEXT,
  availability JSONB,
  created_at   TIMESTAMP DEFAULT NOW(),
  UNIQUE (user_id, season_id)
);

-- 7. Update pieces to be season-scoped (add season_id column)
ALTER TABLE pieces ADD COLUMN IF NOT EXISTS season_id INTEGER REFERENCES seasons(id) ON DELETE CASCADE;

-- 8. Keep existing tables intact for now (dancers, master_blocks still work)
--    New submissions flow uses dancer_profiles + submissions tables
