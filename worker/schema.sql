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

-- ── $10,000 Scholarship ─────────────────────────────────────────────────────

-- One row per applicant. Re-submitting with the same email updates the row
-- (lets students fix mistakes before the deadline).
CREATE TABLE IF NOT EXISTS scholarship_applications (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name         TEXT NOT NULL,
  last_name          TEXT NOT NULL,
  email              TEXT NOT NULL UNIQUE,
  phone              TEXT,
  school             TEXT NOT NULL,
  major              TEXT,
  classification     TEXT,
  grad_term          TEXT,
  gpa                TEXT,
  service_hours      TEXT,
  supervisor_name    TEXT,
  supervisor_email   TEXT,
  supervisor_phone   TEXT,
  campus_involvement TEXT,
  video_url          TEXT,
  video_embed        TEXT,
  video_key          TEXT,
  video_name         TEXT,
  proof_key          TEXT,
  proof_name         TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_sch_apps_school ON scholarship_applications (school);

-- Board scoring: one row per (application, reviewer). Saving again overwrites.
CREATE TABLE IF NOT EXISTS scholarship_reviews (
  application_id INTEGER NOT NULL,
  reviewer       TEXT NOT NULL,
  score          INTEGER,
  note           TEXT,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (application_id, reviewer)
);
