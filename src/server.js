// src/server.js
// The web server. Render runs "npm start", which runs this file.

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

const { query, pool, initSchema } = require('./db');
const auth = require('./auth');
const booking = require('./bookingService');
const payments = require('./paymentService');
const catalog = require('./catalog');
const rzp = require('./razorpay');

const PORT = Number(process.env.PORT || 3000);
const app = express();
app.set('trust proxy', 1); // Render sits in front of us; use the real visitor IP for rate limits

// Razorpay webhook needs the exact raw bytes to check the signature,
// so it's registered BEFORE the JSON parser.
app.post('/api/payments/webhook', express.raw({ type: '*/*', limit: '100kb' }), async (req, res) => {
  try {
    const result = await payments.handleWebhook(req.body, req.get('x-razorpay-signature'));
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[webhook]', e.message);
    // 400 for bad signatures; 500 makes Razorpay retry later for temporary problems.
    res.status(e.status && e.status < 500 ? e.status : 500).json({ error: e.message });
  }
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://checkout.razorpay.com', 'https://*.razorpay.com'],
      frameSrc: ['https://api.razorpay.com', 'https://checkout.razorpay.com', 'https://*.razorpay.com'],
      connectSrc: ["'self'", 'https://*.razorpay.com'],
      imgSrc: ["'self'", 'data:', 'https://*.razorpay.com'],
      styleSrc: ["'self'", "'unsafe-inline'"],
    },
  },
}));
app.use(compression());
app.use(express.json({ limit: '20kb' }));
app.use((req, res, next) => { req.body = req.body || {}; next(); });

app.use((req, res, next) => {
  if (!req.path.startsWith('/api')) return next();
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    console.log(`${req.method} ${req.path} -> ${res.statusCode} (${ms.toFixed(1)} ms)`);
  });
  next();
});

const limiter = (limit, windowMs, message) => rateLimit({ windowMs, limit, standardHeaders: 'draft-7',
  legacyHeaders: false, message: { error: message } });
app.use('/api', limiter(600, 60_000, 'Too many requests. Slow down a little.'));
const authLimiter = limiter(20, 15 * 60_000, 'Too many sign-in attempts. Try again in 15 minutes.');
const adminLimiter = limiter(60, 15 * 60_000, 'Too many admin requests. Try again in 15 minutes.');
const holdLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: (req) => `user-${req.user.id}`, message: { error: 'Too many seat requests. Wait a minute.' } });

app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

// ---------- public ----------
app.get('/api/health', async (req, res) => {
  await query('SELECT 1');
  res.json({ ok: true, uptimeSec: Math.round(process.uptime()) });
});

app.get('/api/config', (req, res) => res.json({ testMode: !rzp.isLive }));

let moviesCache = { at: 0, data: null };
async function getMovies() {
  if (moviesCache.data && Date.now() - moviesCache.at < 30_000) return moviesCache.data;
  const { rows } = await query(`
    SELECT m.id AS movie_id, m.title, m.language, m.duration_min, m.certificate, m.genre,
           s.id AS show_id, s.starts_at, s.base_price, t.name AS theatre, t.city
    FROM shows s JOIN movies m ON m.id = s.movie_id JOIN theatres t ON t.id = s.theatre_id
    WHERE s.starts_at > $1 AND s.starts_at < $2
    ORDER BY m.id, t.name, s.starts_at`, [Date.now(), Date.now() + 14 * 86400_000]);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.movie_id)) map.set(r.movie_id, { id: r.movie_id, title: r.title, language: r.language,
      durationMin: r.duration_min, certificate: r.certificate, genre: r.genre, shows: [] });
    map.get(r.movie_id).shows.push({ id: r.show_id, startsAt: r.starts_at, theatre: r.theatre, city: r.city, basePrice: r.base_price });
  }
  moviesCache = { at: Date.now(), data: [...map.values()] };
  return moviesCache.data;
}

app.get('/api/movies', async (req, res) => {
  res.set('Cache-Control', 'public, max-age=15');
  res.json({ movies: await getMovies() });
});

app.get('/api/shows/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Show not found.' });
  const info = (await query(`
    SELECT s.id, s.starts_at, m.title, m.language, m.certificate, t.name AS theatre, t.rows_count, t.cols_count, t.premium_rows
    FROM shows s JOIN movies m ON m.id = s.movie_id JOIN theatres t ON t.id = s.theatre_id WHERE s.id = $1`, [id])).rows[0];
  if (!info) return res.status(404).json({ error: 'Show not found.' });
  res.set('Cache-Control', 'no-cache'); // ETag lets unchanged seat maps return a tiny 304
  res.json({
    show: { id: info.id, startsAt: info.starts_at, title: info.title, language: info.language, certificate: info.certificate,
      theatre: info.theatre, rows: info.rows_count, cols: info.cols_count, premiumRows: info.premium_rows },
    seats: await booking.getSeatMap(id),
  });
});

// ---------- accounts ----------
app.post('/api/signup', authLimiter, async (req, res) => res.status(201).json(await auth.signup(req.body)));
app.post('/api/login', authLimiter, async (req, res) => res.json(await auth.login(req.body)));
app.post('/api/logout', async (req, res) => { await auth.logout(auth.tokenFrom(req)); res.json({ ok: true }); });
app.get('/api/me', auth.requireAuth, (req, res) => res.json({ user: req.user }));

// ---------- booking ----------
app.post('/api/holds', auth.requireAuth, holdLimiter, async (req, res) => {
  const result = await booking.holdSeats(req.user.id, req.body.showId, req.body.seats, req.get('Idempotency-Key'));
  res.status(201).json({ ...result, serverNow: Date.now() });
});

const BOOKING_SQL = `
  SELECT b.*, m.title, t.name AS theatre, s.starts_at FROM bookings b
  JOIN shows s ON s.id = b.show_id JOIN movies m ON m.id = s.movie_id JOIN theatres t ON t.id = s.theatre_id`;
const present = (b) => ({
  id: b.id, status: b.status === 'HELD' && b.hold_expires_at <= Date.now() ? 'EXPIRED' : b.status,
  amount: b.amount, seats: b.seats, title: b.title, theatre: b.theatre, startsAt: b.starts_at,
  holdExpiresAt: b.hold_expires_at, createdAt: b.created_at, showId: b.show_id,
});

app.get('/api/bookings/:id', auth.requireAuth, async (req, res) => {
  const b = (await query(`${BOOKING_SQL} WHERE b.id = $1`, [Number(req.params.id) || 0])).rows[0];
  if (!b || b.user_id !== req.user.id) return res.status(404).json({ error: 'Booking not found.' });
  res.set('Cache-Control', 'no-store');
  res.json({ booking: present(b), serverNow: Date.now() });
});

app.get('/api/my-bookings', auth.requireAuth, async (req, res) => {
  const { rows } = await query(`${BOOKING_SQL}
    WHERE b.user_id = $1 AND b.status IN ('CONFIRMED','REFUND_PENDING','REFUNDED','HELD')
    ORDER BY b.created_at DESC LIMIT 50`, [req.user.id]);
  res.set('Cache-Control', 'no-store');
  res.json({ bookings: rows.map(present).filter((b) => b.status !== 'EXPIRED') });
});

app.delete('/api/bookings/:id', auth.requireAuth, async (req, res) => {
  res.json(await booking.cancelHold(req.user.id, Number(req.params.id) || 0));
});

app.post('/api/bookings/:id/pay', auth.requireAuth, async (req, res) => {
  res.status(201).json(await payments.startPayment(req.user, Number(req.params.id) || 0));
});

app.post('/api/payments/verify', auth.requireAuth, async (req, res) => {
  res.json(await payments.verifyCheckout(req.user, req.body));
});

// ---------- admin ----------
app.use('/api/admin', adminLimiter, auth.requireAdmin);
app.get('/api/admin/overview', async (req, res) => {
  const [movies, theatres, shows, bookings] = await Promise.all([
    query('SELECT id, title, language FROM movies ORDER BY id DESC'),
    query('SELECT id, name, city, rows_count, cols_count FROM theatres ORDER BY id'),
    query(`SELECT s.id, s.starts_at, m.title, t.name AS theatre,
             COUNT(*) FILTER (WHERE ss.status = 'BOOKED') AS sold, COUNT(*) AS total
           FROM shows s JOIN movies m ON m.id = s.movie_id JOIN theatres t ON t.id = s.theatre_id
           JOIN show_seats ss ON ss.show_id = s.id
           WHERE s.starts_at > $1 GROUP BY s.id, m.title, t.name ORDER BY s.starts_at LIMIT 100`, [Date.now()]),
    query(`SELECT b.id, b.status, b.amount, b.seats, b.created_at, u.email, m.title
           FROM bookings b JOIN users u ON u.id = b.user_id JOIN shows s ON s.id = b.show_id JOIN movies m ON m.id = s.movie_id
           WHERE b.status IN ('CONFIRMED','REFUND_PENDING','REFUNDED') ORDER BY b.id DESC LIMIT 50`),
  ]);
  res.json({ movies: movies.rows, theatres: theatres.rows, shows: shows.rows, bookings: bookings.rows, liveMode: rzp.isLive });
});
const bust = () => { moviesCache = { at: 0, data: null }; };
app.post('/api/admin/movies', async (req, res) => { const r = await catalog.createMovie(req.body); bust(); res.status(201).json(r); });
app.post('/api/admin/theatres', async (req, res) => res.status(201).json(await catalog.createTheatre(req.body)));
app.post('/api/admin/shows', async (req, res) => { const r = await catalog.createShow(req.body); bust(); res.status(201).json(r); });

// ---------- errors ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong on our side. Please try again.' : err.message, ...(err.extra || {}) });
});

// ---------- start ----------
async function start() {
  await initSchema();
  if (await catalog.seedIfEmpty()) console.log('Empty database: added sample theatres, movies and shows.');
  const server = app.listen(PORT, () => console.log(`CineBook running on port ${PORT} (${rzp.isLive ? 'LIVE' : 'TEST'} payments)`));

  const every = (ms, name, fn) => setInterval(() => fn().catch((e) => console.error(`[${name}]`, e.message)), ms).unref();
  every(Number(process.env.SWEEP_SECONDS || 15) * 1000, 'sweeper', async () => {
    const n = await booking.sweep(); if (n) console.log(`[sweeper] released ${n} expired hold(s)`);
  });
  every(Number(process.env.RECONCILE_SECONDS || 120) * 1000, 'reconcile', payments.reconcile);

  const stop = () => { console.log('Shutting down...'); server.close(() => pool.end().then(() => process.exit(0))); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) start().catch((e) => { console.error('Failed to start:', e); process.exit(1); });
module.exports = app;
