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

-- ── Seat selection ──────────────────────────────────────────────────────────

-- One row per buyer. Filled automatically by the Stripe webhook
-- (/api/stripe-webhook); `tickets` is how many seats they may claim and
-- `token` is the secret in their magic "pick your seats" link.
CREATE TABLE IF NOT EXISTS purchases (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL UNIQUE,
  name       TEXT,
  tickets    INTEGER NOT NULL DEFAULT 0,
  token      TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

-- One row per claimed seat. seat_id looks like "T5-S7" (Table 5, Seat 7).
-- The PRIMARY KEY makes double-booking impossible.
CREATE TABLE IF NOT EXISTS seats (
  seat_id    TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  guest_name TEXT,
  claimed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seats_email ON seats (email);

-- Processed Stripe event ids so webhook retries never double-count tickets.
CREATE TABLE IF NOT EXISTS stripe_events (
  event_id   TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
