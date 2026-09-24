// src/bookingService.js
// All seat rules. The safety idea:
//   1. Lock the exact seat rows (SELECT ... FOR UPDATE), always in the same order.
//   2. Check they're free. 3. Take them. 4. Commit.
// Anyone else wanting the same seats waits at step 1 until we commit, then sees
// they're taken. Same order for everyone = no deadlocks.

const { query, tx } = require('./db');

const HOLD_MS = Number(process.env.HOLD_MINUTES || 8) * 60 * 1000;
const MAX_SEATS = 10;

class BookingError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

const isFree = (s, now) => s.status === 'AVAILABLE' || (s.status === 'HELD' && s.hold_expires_at <= now);

async function getSeatMap(showId) {
  const now = Date.now();
  const { rows } = await query(
    'SELECT seat_label, tier, price, status, booking_id, hold_expires_at FROM show_seats WHERE show_id = $1',
    [showId]);
  return rows.map((s) => {
    const expired = s.status === 'HELD' && s.hold_expires_at <= now;
    return { seat: s.seat_label, tier: s.tier, price: s.price,
      status: expired ? 'AVAILABLE' : s.status, bookingId: expired ? null : s.booking_id };
  });
}

function validateSeats(seats) {
  if (!Array.isArray(seats) || seats.length === 0) throw new BookingError(400, 'Pick at least one seat.');
  if (seats.length > MAX_SEATS) throw new BookingError(400, `You can book up to ${MAX_SEATS} seats at once.`);
  const clean = [...new Set(seats.map(String))];
  if (clean.length !== seats.length) throw new BookingError(400, 'The same seat was sent twice.');
  if (!clean.every((s) => /^[A-Z][0-9]{1,2}$/.test(s))) throw new BookingError(400, 'Invalid seat label.');
  return clean.sort();
}

async function lockSeats(c, showId, seats) {
  return (await c.query(
    `SELECT seat_label, status, booking_id, hold_expires_at, price FROM show_seats
     WHERE show_id = $1 AND seat_label = ANY($2) ORDER BY seat_label FOR UPDATE`, [showId, seats])).rows;
}

async function releaseBooking(c, bookingId, status) {
  await c.query(`UPDATE show_seats SET status = 'AVAILABLE', booking_id = NULL, hold_expires_at = NULL
                 WHERE booking_id = $1 AND status = 'HELD'`, [bookingId]);
  await c.query('UPDATE bookings SET status = $1 WHERE id = $2', [status, bookingId]);
}

async function holdSeats(userId, rawShowId, rawSeats, rawKey) {
  const seats = validateSeats(rawSeats);
  const showId = Number(rawShowId);
  if (!Number.isInteger(showId)) throw new BookingError(400, 'Invalid show.');
  const key = rawKey ? String(rawKey).slice(0, 100) : null;

  return tx(async (c) => {
    const now = Date.now();

    // Idempotency: claim the key. If the same request is already running,
    // this line waits for it, then we return its answer instead of booking twice.
    if (key) {
      const claimed = await c.query(
        `INSERT INTO idempotency_keys (key, user_id, created_at) VALUES ($1,$2,$3)
         ON CONFLICT DO NOTHING RETURNING key`, [key, userId, now]);
      if (!claimed.rows[0]) {
        const prev = (await c.query('SELECT response FROM idempotency_keys WHERE key = $1 AND user_id = $2', [key, userId])).rows[0];
        if (prev?.response) return prev.response;
      }
    }

    const show = (await c.query('SELECT id, starts_at FROM shows WHERE id = $1', [showId])).rows[0];
    if (!show) throw new BookingError(404, 'Show not found.');
    if (show.starts_at <= now) throw new BookingError(400, 'This show has already started.');

    // One active hold per user per show: picking again replaces the old hold.
    const prev = (await c.query(
      "SELECT id FROM bookings WHERE user_id = $1 AND show_id = $2 AND status = 'HELD' FOR UPDATE", [userId, showId])).rows;
    for (const p of prev) await releaseBooking(c, p.id, 'CANCELLED');

    const rows = await lockSeats(c, showId, seats);
    if (rows.length !== seats.length) {
      const missing = seats.filter((s) => !rows.find((r) => r.seat_label === s));
      throw new BookingError(400, `Seat ${missing.join(', ')} does not exist.`);
    }
    const taken = rows.filter((r) => !isFree(r, now)).map((r) => r.seat_label);
    if (taken.length) {
      throw new BookingError(409, `Sorry, ${taken.join(', ')} ${taken.length > 1 ? 'were' : 'was'} just taken by someone else.`, { taken });
    }

    const amount = rows.reduce((sum, r) => sum + r.price, 0); // price from the database, never the browser
    const expiresAt = now + HOLD_MS;
    const bookingId = (await c.query(
      `INSERT INTO bookings (user_id, show_id, status, amount, seats, hold_expires_at, created_at)
       VALUES ($1,$2,'HELD',$3,$4,$5,$6) RETURNING id`,
      [userId, showId, amount, JSON.stringify(seats), expiresAt, now])).rows[0].id;
    await c.query(
      `UPDATE show_seats SET status = 'HELD', booking_id = $1, hold_expires_at = $2
       WHERE show_id = $3 AND seat_label = ANY($4)`, [bookingId, expiresAt, showId, seats]);

    const result = { bookingId, showId, seats, amount, holdExpiresAt: expiresAt };
    if (key) await c.query('UPDATE idempotency_keys SET response = $1 WHERE key = $2 AND user_id = $3', [result, key, userId]);
    return result;
  });
}

async function cancelHold(userId, bookingId) {
  return tx(async (c) => {
    const b = (await c.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [bookingId])).rows[0];
    if (!b || b.user_id !== userId) throw new BookingError(404, 'Booking not found.');
    if (b.status !== 'HELD') return { status: b.status };
    await releaseBooking(c, bookingId, 'CANCELLED');
    return { status: 'CANCELLED' };
  });
}

// Called inside the payment transaction once money is confirmed.
// Returns CONFIRMED, or REFUND_PENDING if the seats were lost while paying.
async function confirmBooking(c, bookingId) {
  const now = Date.now();
  const b = (await c.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [bookingId])).rows[0];
  if (!b) throw new BookingError(404, 'Booking not found.');
  if (b.status === 'CONFIRMED') return 'CONFIRMED';

  const seats = [...b.seats].sort();
  const rows = await lockSeats(c, b.show_id, seats);
  const ours = (r) => r.status === 'HELD' && r.booking_id === b.id;
  const canHave = rows.length === seats.length && rows.every((r) => ours(r) || isFree(r, now));

  if (!canHave) {
    // Hold expired and someone else got a seat. They keep it; this customer is refunded.
    await releaseBooking(c, b.id, 'REFUND_PENDING');
    return 'REFUND_PENDING';
  }
  await c.query(
    `UPDATE show_seats SET status = 'BOOKED', booking_id = $1, hold_expires_at = NULL
     WHERE show_id = $2 AND seat_label = ANY($3)`, [b.id, b.show_id, seats]);
  // Primary key on (show_id, seat_label): a duplicate here aborts everything.
  await c.query(
    'INSERT INTO confirmed_seats (show_id, seat_label, booking_id) SELECT $1, unnest($2::text[]), $3',
    [b.show_id, seats, b.id]);
  await c.query("UPDATE bookings SET status = 'CONFIRMED', confirmed_at = $1 WHERE id = $2", [now, b.id]);
  return 'CONFIRMED';
}

async function sweep() {
  return tx(async (c) => {
    const { rows } = await c.query(
      `UPDATE bookings SET status = 'EXPIRED'
       WHERE id IN (SELECT id FROM bookings WHERE status = 'HELD' AND hold_expires_at <= $1
                    ORDER BY id LIMIT 500 FOR UPDATE SKIP LOCKED)
       RETURNING id`, [Date.now()]);
    if (rows.length) {
      await c.query(`UPDATE show_seats SET status = 'AVAILABLE', booking_id = NULL, hold_expires_at = NULL
                     WHERE booking_id = ANY($1) AND status = 'HELD'`, [rows.map((r) => r.id)]);
    }
    return rows.length;
  });
}

module.exports = { BookingError, getSeatMap, holdSeats, cancelHold, confirmBooking, sweep, HOLD_MS };
