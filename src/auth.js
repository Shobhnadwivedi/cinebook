// src/auth.js
// Real accounts: email + password. Passwords are never stored, only a slow
// "scrypt" hash, so even if the database leaked nobody could read them.

const crypto = require('crypto');
const { promisify } = require('util');
const { query } = require('./db');

const scrypt = promisify(crypto.scrypt);
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

const fail = (status, message) => Object.assign(new Error(message), { status });

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}
async function checkPassword(password, stored) {
  const [saltHex, keyHex] = stored.split(':');
  const key = await scrypt(password, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(key, Buffer.from(keyHex, 'hex'));
}

function cleanEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 200) throw fail(400, 'Enter a valid email.');
  return e;
}

async function newSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  await query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1,$2,$3)',
    [sha(token), user.id, Date.now() + SESSION_MS]);
  return { token, user: { id: user.id, name: user.name, email: user.email } };
}

async function signup({ name, email, password }) {
  name = String(name || '').trim().slice(0, 60);
  if (!name) throw fail(400, 'Enter your name.');
  email = cleanEmail(email);
  password = String(password || '');
  if (password.length < 8) throw fail(400, 'Password must be at least 8 characters.');
  const hash = await hashPassword(password);
  const r = await query(
    `INSERT INTO users (email, name, password_hash, created_at) VALUES ($1,$2,$3,$4)
     ON CONFLICT (email) DO NOTHING RETURNING id, email, name`, [email, name, hash, Date.now()]);
  if (!r.rows[0]) throw fail(409, 'An account with this email already exists. Sign in instead.');
  return newSession(r.rows[0]);
}

// Used when the email doesn't exist, so a wrong email takes as long as a wrong
// password. Otherwise attackers could time responses to learn who has an account.
const DUMMY_HASH = crypto.randomBytes(16).toString('hex') + ':' + crypto.randomBytes(64).toString('hex');

async function login({ email, password }) {
  email = cleanEmail(email);
  const user = (await query('SELECT id, email, name, password_hash FROM users WHERE email = $1', [email])).rows[0];
  const ok = await checkPassword(String(password || ''), user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) throw fail(401, 'Email or password is wrong.');
  return newSession(user);
}

async function logout(token) {
  if (token) await query('DELETE FROM sessions WHERE token_hash = $1', [sha(token)]);
}

function tokenFrom(req) {
  const h = req.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

async function requireAuth(req, res, next) {
  try {
    const token = tokenFrom(req);
    const user = token && (await query(
      `SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > $2`, [sha(token), Date.now()])).rows[0];
    if (!user) return res.status(401).json({ error: 'Please sign in first.' });
    req.user = user;
    next();
  } catch (e) { next(e); }
}

// Admin panel: protected by the ADMIN_PASSWORD you set on Render.
function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_PASSWORD || '';
  const given = req.get('x-admin-password') || '';
  const ok = expected.length >= 8 && given.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!ok) return res.status(401).json({ error: 'Wrong admin password.' });
  next();
}

module.exports = { signup, login, logout, tokenFrom, requireAuth, requireAdmin };
