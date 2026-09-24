// src/catalog.js
// Movies, theatres and shows. Used by the admin panel and by the first-start seed.

const { query, tx } = require('./db');

class InputError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

function text(v, name, max = 100) {
  const s = String(v ?? '').trim();
  if (!s) throw new InputError(`${name} is required.`);
  if (s.length > max) throw new InputError(`${name} is too long.`);
  return s;
}
function int(v, name, min, max) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new InputError(`${name} must be a whole number from ${min} to ${max}.`);
  return n;
}

async function createMovie(body, db = { query }) {
  const r = await db.query(
    `INSERT INTO movies (title, language, duration_min, certificate, genre)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [text(body.title, 'Title'), text(body.language, 'Language', 30), int(body.durationMin, 'Duration', 30, 300),
      text(body.certificate, 'Certificate', 5), text(body.genre, 'Genre', 30)]);
  return { id: r.rows[0].id };
}

async function createTheatre(body, db = { query }) {
  const rows = int(body.rows, 'Rows', 1, 26);
  const r = await db.query(
    `INSERT INTO theatres (name, city, rows_count, cols_count, premium_rows)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [text(body.name, 'Theatre name'), text(body.city, 'City', 40), rows,
      int(body.cols, 'Seats per row', 1, 40), int(body.premiumRows ?? 2, 'Premium rows', 0, rows)]);
  return { id: r.rows[0].id };
}

// Creating a show also creates every seat for it, in one SQL statement.
async function createShow(body, client) {
  const run = async (c) => {
    const startsAt = Number(body.startsAt);
    if (!Number.isFinite(startsAt) || startsAt < Date.now() + 60_000) throw new InputError('Pick a date and time in the future.');
    if (startsAt > Date.now() + 365 * 86400_000) throw new InputError('Shows can be added up to one year ahead.');
    const base = int(Math.round(Number(body.basePrice) * 100), 'Regular price', 100, 10_000_00);
    const premium = int(Math.round(Number(body.premiumPrice) * 100), 'Premium price', 100, 10_000_00);
    const t = (await c.query('SELECT * FROM theatres WHERE id = $1', [Number(body.theatreId)])).rows[0];
    if (!t) throw new InputError('Theatre not found.');
    const m = (await c.query('SELECT id FROM movies WHERE id = $1', [Number(body.movieId)])).rows[0];
    if (!m) throw new InputError('Movie not found.');
    const show = (await c.query(
      `INSERT INTO shows (movie_id, theatre_id, starts_at, base_price, premium_price)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`, [m.id, t.id, startsAt, base, premium])).rows[0];
    // Rows A, B, C... and seats 1..N. The last few rows are premium.
    await c.query(
      `INSERT INTO show_seats (show_id, seat_label, tier, price)
       SELECT $1, chr(64 + r) || c,
              CASE WHEN r > $2 - $4 THEN 'PREMIUM' ELSE 'REGULAR' END,
              CASE WHEN r > $2 - $4 THEN $6::int ELSE $5::int END
       FROM generate_series(1, $2::int) AS r, generate_series(1, $3::int) AS c`,
      [show.id, t.rows_count, t.cols_count, t.premium_rows, base, premium]);
    return { id: show.id };
  };
  return client ? run(client) : tx(run);
}

// Fill an empty database with sample data so the site isn't blank on day one.
async function seedIfEmpty() {
  const { rows } = await query('SELECT COUNT(*) AS n FROM theatres');
  if (rows[0].n > 0) return false;
  await tx(async (c) => {
    const theatres = [];
    for (const t of [
      { name: 'Raj Mandir Cinema', city: 'Jaipur', rows: 10, cols: 14, premiumRows: 3 },
      { name: 'Galaxy Multiplex', city: 'Jaipur', rows: 8, cols: 12, premiumRows: 2 },
    ]) theatres.push((await createTheatre(t, c)).id);

    const movies = [];
    for (const m of [
      { title: 'Monsoon Express', language: 'Hindi', durationMin: 142, certificate: 'UA', genre: 'Drama' },
      { title: 'The Last Orbit', language: 'English', durationMin: 128, certificate: 'UA', genre: 'Sci-fi' },
      { title: 'Thar Ke Rakhwale', language: 'Hindi', durationMin: 155, certificate: 'A', genre: 'Action' },
      { title: 'Paper Kites', language: 'English', durationMin: 104, certificate: 'U', genre: 'Animation' },
    ]) movies.push((await createMovie(m, c)).id);

    // Shows for the next 7 days, at fixed Indian times.
    const IST = 330 * 60_000;
    const todayIst = new Date(Date.now() + IST);
    const slots = [[12, 30], [16, 0], [19, 30], [22, 30]];
    for (let d = 0; d < 7; d++) {
      for (const [mi, movieId] of movies.entries()) {
        for (const [ti, theatreId] of theatres.entries()) {
          const [h, min] = slots[(mi + ti) % slots.length];
          const startsAt = Date.UTC(todayIst.getUTCFullYear(), todayIst.getUTCMonth(), todayIst.getUTCDate() + d, h, min) - IST;
          if (startsAt < Date.now() + 30 * 60_000) continue;
          await createShow({ movieId, theatreId, startsAt, basePrice: 180, premiumPrice: 280 }, c);
        }
      }
    }
  });
  return true;
}

module.exports = { createMovie, createTheatre, createShow, seedIfEmpty, InputError };
