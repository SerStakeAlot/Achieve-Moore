-- Early-bird waitlist for the Hands of Time Gala.
-- Apply with:
--   npx wrangler d1 execute gala-waitlist --file=./schema.sql            (local)
--   npx wrangler d1 execute gala-waitlist --file=./schema.sql --remote   (production)

CREATE TABLE IF NOT EXISTS waitlist (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT,
  email      TEXT UNIQUE,
  phone      TEXT,
  source     TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_waitlist_created_at ON waitlist (created_at);
