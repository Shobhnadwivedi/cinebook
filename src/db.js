// src/db.js
// Connects to PostgreSQL (hosted free on Neon) and creates the tables on first start.

const { Pool, types } = require('pg');

// Postgres sends big integers as text. Our numbers (paise, timestamps in ms)
// fit safely in JavaScript numbers, so convert them back.
types.setTypeParser(20, (v) => Number(v));

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Add it in Render > Environment.');
  process.exit(1);
}

// A pool keeps a few database connections open and reuses them.
// Opening a new connection per request would add ~50ms of latency each time.
// Neon's link says sslmode=require; verify-full is the same strict check,
// stated explicitly (it also silences a noisy warning in the logs).
const connectionString = process.env.DATABASE_URL.replace(/sslmode=(require|prefer|verify-ca)/, 'sslmode=verify-full');

const pool = new Pool({
  connectionString,
  max: Number(process.env.DB_POOL_SIZE || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});
pool.on('error', (err) => console.error('[db] idle client error', err.message));

const query = (text, params) => pool.query(text, params);

// Run fn inside a transaction: all of it happens, or none of it.
// If Postgres detects a deadlock or conflict it tells us to retry; we do, up to 3 times.
async function tx(fn) {
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      const retryable = err.code === '40P01' || err.code === '40001';
      if (retryable && attempt < 3) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id),
  expires_at  BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS movies (
  id           BIGSERIAL PRIMARY KEY,
  title        TEXT NOT NULL,
  language     TEXT NOT NULL,
  duration_min INT NOT NULL,
  certificate  TEXT NOT NULL,
  genre        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS theatres (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  city        TEXT NOT NULL,
  rows_count  INT NOT NULL,
  cols_count  INT NOT NULL,
  premium_rows INT NOT NULL DEFAULT 2
);

CREATE TABLE IF NOT EXISTS shows (
  id          BIGSERIAL PRIMARY KEY,
  movie_id    BIGINT NOT NULL REFERENCES movies(id),
  theatre_id  BIGINT NOT NULL REFERENCES theatres(id),
  starts_at   BIGINT NOT NULL,
  base_price  INT NOT NULL,
  premium_price INT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shows_starts ON shows(starts_at);

-- One row per seat per show. AVAILABLE -> HELD -> BOOKED
CREATE TABLE IF NOT EXISTS show_seats (
  show_id         BIGINT NOT NULL REFERENCES shows(id),
  seat_label      TEXT NOT NULL,
  tier            TEXT NOT NULL,
  price           INT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE','HELD','BOOKED')),
  booking_id      BIGINT,
  hold_expires_at BIGINT,
  PRIMARY KEY (show_id, seat_label)
);
CREATE INDEX IF NOT EXISTS idx_show_seats_booking ON show_seats(booking_id);

CREATE TABLE IF NOT EXISTS bookings (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id),
  show_id         BIGINT NOT NULL REFERENCES shows(id),
  status          TEXT NOT NULL CHECK (status IN ('HELD','CONFIRMED','EXPIRED','CANCELLED','REFUND_PENDING','REFUNDED')),
  amount          INT NOT NULL,
  seats           JSONB NOT NULL,
  hold_expires_at BIGINT NOT NULL,
  created_at      BIGINT NOT NULL,
  confirmed_at    BIGINT
);
CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookings_held ON bookings(hold_expires_at) WHERE status = 'HELD';

-- Final guard: the database refuses to sell the same seat twice.
CREATE TABLE IF NOT EXISTS confirmed_seats (
  show_id     BIGINT NOT NULL,
  seat_label  TEXT NOT NULL,
  booking_id  BIGINT NOT NULL REFERENCES bookings(id),
  PRIMARY KEY (show_id, seat_label)
);

CREATE TABLE IF NOT EXISTS payments (
  id                 BIGSERIAL PRIMARY KEY,
  booking_id         BIGINT NOT NULL REFERENCES bookings(id),
  gateway_order_id   TEXT NOT NULL UNIQUE,
  gateway_payment_id TEXT UNIQUE,
  amount             INT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('CREATED','SUCCESS','FAILED')),
  refund_id          TEXT,
  created_at         BIGINT NOT NULL,
  updated_at         BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_booking ON payments(booking_id);

-- Only used by the built-in demo gateway.
CREATE TABLE IF NOT EXISTS demo_payments (
  id          TEXT PRIMARY KEY,
  order_id    TEXT NOT NULL,
  amount      INT NOT NULL,
  status      TEXT NOT NULL,
  created_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_demo_payments_order ON demo_payments(order_id);
-- One successful payment per order, like a real gateway (failed attempts can repeat).
CREATE UNIQUE INDEX IF NOT EXISTS uq_demo_one_payment_per_order ON demo_payments(order_id) WHERE status <> 'failed';

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key         TEXT NOT NULL,
  user_id     BIGINT NOT NULL,
  response    JSONB,
  created_at  BIGINT NOT NULL,
  PRIMARY KEY (key, user_id)
);
`;

async function initSchema() {
  await query(SCHEMA);
}

module.exports = { pool, query, tx, initSchema };
