// tests/run-tests.js
// Full automated test: starts a fake Razorpay + TWO copies of the app sharing one
// Postgres database (like running on 2 servers), then attacks it.
// Needs a local Postgres:  TEST_DATABASE_URL=postgres://... npm test
const { spawn } = require('child_process');
const crypto = require('crypto');
const { Client } = require('pg');
const startFakeRazorpay = require('./fake-razorpay');

const DB = process.env.TEST_DATABASE_URL || 'postgres://postgres:pg@localhost:5432/cinebook_test';
const KEY_ID = 'rzp_test_fake', KEY_SECRET = 'secret_fake', WH = 'wh_fake', ADMIN = 'admin-pass-123';
const A = 'http://localhost:3200', B = 'http://localhost:3201'; // B has short (20s) holds
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); if (!ok) failed++; };

async function call(base, path, { method = 'GET', body, token, headers = {} } = {}) {
  const res = await fetch(base + path, { method, body: body ? JSON.stringify(body) : undefined,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

function startApp(port, extra) {
  const p = spawn('node', ['src/server.js'], { env: { ...process.env, PORT: port, DATABASE_URL: DB,
    RAZORPAY_KEY_ID: KEY_ID, RAZORPAY_KEY_SECRET: KEY_SECRET, RAZORPAY_WEBHOOK_SECRET: WH,
    RAZORPAY_API_BASE: 'http://localhost:4100/v1', ADMIN_PASSWORD: ADMIN, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.log = ''; p.stdout.on('data', (d) => (p.log += d)); p.stderr.on('data', (d) => (p.log += d));
  return p;
}

(async () => {
  // fresh database
  const admin = new Client({ connectionString: DB.replace(/\/[^/]+$/, '/postgres') });
  await admin.connect(); await admin.query('DROP DATABASE IF EXISTS cinebook_test'); await admin.query('CREATE DATABASE cinebook_test'); await admin.end();

  const rz = await startFakeRazorpay({ port: 4100, keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: WH, webhookUrl: `${A}/api/payments/webhook` });
  const appA = startApp(3200, {});
  await sleep(2500); // let A create schema + seed first
  const appB = startApp(3201, { HOLD_MINUTES: '0.34', SWEEP_SECONDS: '2', RECONCILE_SECONDS: '3', RECONCILE_MIN_AGE_SECONDS: '1' });
  await sleep(2000);
  const pay = (order_id, extra = {}) => fetch('http://localhost:4100/test/pay', { method: 'POST', body: JSON.stringify({ order_id, ...extra }) }).then((r) => r.json());

  try {
    // ---------- accounts ----------
    const users = [];
    for (let i = 0; i < 50; i++) {
      const r = await call(A, '/api/signup', { method: 'POST', body: { name: `User ${i}`, email: `u${i}@t.dev`, password: 'password123' },
        headers: { 'x-forwarded-for': `10.0.${i}.1` } });
      users.push(r.data.token);
    }
    check('50 accounts created', users.every(Boolean));
    check('duplicate email rejected', (await call(A, '/api/signup', { method: 'POST', body: { name: 'x', email: 'u1@t.dev', password: 'password123' } })).status === 409);
    check('wrong password rejected', (await call(A, '/api/login', { method: 'POST', body: { email: 'u1@t.dev', password: 'nope-nope' } })).status === 401);
    check('correct password works', (await call(A, '/api/login', { method: 'POST', body: { email: 'u1@t.dev', password: 'password123' } })).status === 200);

    const movies = (await call(A, '/api/movies')).data.movies;
    check('sample movies and shows seeded', movies.length === 4 && movies[0].shows.length > 0, `${movies.length} movies`);
    const showId = movies[0].shows[0].id;

    // ---------- race: 50 users, one seat, two servers ----------
    const res = await Promise.all(users.map((t, i) => call(i % 2 ? B : A, '/api/holds', { method: 'POST', token: t, body: { showId, seats: ['A1'] } })));
    const wins = res.filter((r) => r.status === 201);
    check('50 users, 2 servers, 1 seat: exactly one winner', wins.length === 1, `${wins.length} winners, ${res.filter((r) => r.status === 409).length} told taken`);

    // ---------- overlapping multi-seat grabs (deadlock bait) ----------
    const pool = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'];
    const picks = users.slice(10, 30).map(() => [...pool].sort(() => Math.random() - 0.5).slice(0, 3));
    const multi = await Promise.all(users.slice(10, 30).map((t, i) => call(i % 2 ? B : A, '/api/holds', { method: 'POST', token: t, body: { showId, seats: picks[i] } })));
    const map = (await call(A, `/api/shows/${showId}`)).data.seats;
    const held = map.filter((s) => pool.includes(s.seat) && s.status === 'HELD');
    const okBookings = multi.filter((r) => r.status === 201).map((r) => r.data);
    const allOwned = okBookings.every((b) => b.seats.every((s) => held.find((h) => h.seat === s && h.bookingId === b.bookingId)));
    check('overlapping requests: no seat given twice, no partial holds', allOwned && held.length === okBookings.length * 3,
      `${okBookings.length} succeeded, ${multi.filter((r) => r.status === 409).length} rejected, none errored: ${multi.every((r) => [201, 409].includes(r.status))}`);

    // ---------- idempotency across servers ----------
    const key = crypto.randomUUID();
    const idem = await Promise.all([A, B, A, B].map((base) => call(base, '/api/holds', { method: 'POST', token: users[40], body: { showId, seats: ['D4'] }, headers: { 'Idempotency-Key': key } })));
    check('same request x4 on 2 servers creates one booking', new Set(idem.map((r) => r.data.bookingId)).size === 1 && idem.every((r) => r.status === 201));

    // ---------- payment: checkout + 2 webhooks arrive together ----------
    const winner = wins[0].data, wToken = users[res.indexOf(wins[0])];
    const order = (await call(A, `/api/bookings/${winner.bookingId}/pay`, { method: 'POST', token: wToken })).data;
    const again = (await call(A, `/api/bookings/${winner.bookingId}/pay`, { method: 'POST', token: wToken })).data;
    check('clicking Pay twice reuses one order', order.orderId === again.orderId);
    const pr = await pay(order.orderId, { webhook: 2 });
    const [v1, v2] = await Promise.all([
      call(A, '/api/payments/verify', { method: 'POST', token: wToken, body: pr }),
      call(B, '/api/payments/verify', { method: 'POST', token: wToken, body: pr })]);
    await sleep(300);
    const booked = (await call(A, `/api/bookings/${winner.bookingId}`, { token: wToken })).data.booking;
    const stats1 = await fetch('http://localhost:4100/test/stats').then((r) => r.json());
    check('browser + 2 webhooks at once: confirmed exactly once', booked.status === 'CONFIRMED' && stats1.captures === 1,
      `status ${booked.status}, captures ${stats1.captures}, webhooks ${pr.webhookStatuses}, verify ${v1.status}/${v2.status}`);
    check('seat now sold', (await call(A, `/api/shows/${showId}`)).data.seats.find((s) => s.seat === 'A1').status === 'BOOKED');
    check('sold seat cannot be held again', (await call(A, '/api/holds', { method: 'POST', token: users[5], body: { showId, seats: ['A1'] } })).status === 409);

    // ---------- attacks ----------
    const forged = await call(A, '/api/payments/verify', { method: 'POST', token: wToken, body: { ...pr, razorpay_signature: 'f'.repeat(64) } });
    check('forged payment signature rejected', forged.status === 400);
    const wh = await fetch(`${A}/api/payments/webhook`, { method: 'POST', headers: { 'x-razorpay-signature': 'bad' }, body: '{}' });
    check('forged webhook rejected', wh.status === 400);
    const other = await call(A, '/api/payments/verify', { method: 'POST', token: users[7], body: pr });
    check("can't claim someone else's payment", other.status === 404);
    const peek = await call(A, `/api/bookings/${winner.bookingId}`, { token: users[7] });
    check("can't view someone else's booking", peek.status === 404);
    // underpayment: pay 1 rupee for a real order
    const h2 = (await call(A, '/api/holds', { method: 'POST', token: users[41], body: { showId, seats: ['E1', 'E2'] } })).data;
    const o2 = (await call(A, `/api/bookings/${h2.bookingId}/pay`, { method: 'POST', token: users[41] })).data;
    const cheap = await pay(o2.orderId, { amount: 100 });
    const under = await call(A, '/api/payments/verify', { method: 'POST', token: users[41], body: cheap });
    check('underpaid payment not accepted', under.status === 400 && (await call(A, `/api/bookings/${h2.bookingId}`, { token: users[41] })).data.booking.status === 'HELD');
    // failed payment keeps hold
    const failedPay = await pay(o2.orderId, { outcome: 'failed' });
    await call(A, '/api/payments/verify', { method: 'POST', token: users[41], body: failedPay });
    check('failed payment keeps seats held for retry', (await call(A, `/api/bookings/${h2.bookingId}`, { token: users[41] })).data.booking.status === 'HELD');

    // ---------- timing edge cases on server B (20s holds) ----------
    console.log('\n(waiting ~25s for short holds to expire...)');
    const h3 = (await call(B, '/api/holds', { method: 'POST', token: users[42], body: { showId, seats: ['F1'] } })).data;
    const o3 = (await call(B, `/api/bookings/${h3.bookingId}/pay`, { method: 'POST', token: users[42] })).data;
    const h4 = (await call(B, '/api/holds', { method: 'POST', token: users[43], body: { showId, seats: ['F2'] } })).data;
    const o4 = (await call(B, `/api/bookings/${h4.bookingId}/pay`, { method: 'POST', token: users[43] })).data;
    const h5 = (await call(B, '/api/holds', { method: 'POST', token: users[45], body: { showId, seats: ['F3'] } })).data;
    await sleep(22000);
    check('expired hold frees the seat', (await call(A, `/api/shows/${showId}`)).data.seats.find((s) => s.seat === 'F1').status === 'AVAILABLE');
    check('sweeper marks expired booking', (await call(A, `/api/bookings/${h5.bookingId}`, { token: users[45] })).data.booking.status === 'EXPIRED');
    const steal = await call(A, '/api/holds', { method: 'POST', token: users[44], body: { showId, seats: ['F2'] } });
    check('another user takes the expired seat F2', steal.status === 201);
    const late1 = await pay(o3.orderId);
    await call(B, '/api/payments/verify', { method: 'POST', token: users[42], body: late1 });
    check('late payment, seat still free: confirmed', (await call(A, `/api/bookings/${h3.bookingId}`, { token: users[42] })).data.booking.status === 'CONFIRMED');
    const late2 = await pay(o4.orderId);
    await call(B, '/api/payments/verify', { method: 'POST', token: users[43], body: late2 });
    const refunded = (await call(A, `/api/bookings/${h4.bookingId}`, { token: users[43] })).data.booking.status;
    const f2 = (await call(A, `/api/shows/${showId}`)).data.seats.find((s) => s.seat === 'F2');
    check('late payment, seat taken: auto-refunded, other user keeps seat', refunded === 'REFUNDED' && f2.bookingId === steal.data.bookingId, refunded);

    // ---------- browser closed, no verify, no webhook: background check finds it ----------
    const h6 = (await call(A, '/api/holds', { method: 'POST', token: users[46], body: { showId, seats: ['G1'] } })).data;
    const o6 = (await call(A, `/api/bookings/${h6.bookingId}/pay`, { method: 'POST', token: users[46] })).data;
    await pay(o6.orderId); // paid, but nobody tells our server
    await sleep(6000);
    check('tab closed after paying: reconciled automatically', (await call(A, `/api/bookings/${h6.bookingId}`, { token: users[46] })).data.booking.status === 'CONFIRMED');

    // ---------- admin ----------
    check('admin: wrong password rejected', (await call(A, '/api/admin/overview', { headers: { 'x-admin-password': 'guess-guess' } })).status === 401);
    const ah = { 'x-admin-password': ADMIN };
    const th = await call(A, '/api/admin/theatres', { method: 'POST', headers: ah, body: { name: 'Test Hall', city: 'Jaipur', rows: 5, cols: 6, premiumRows: 1 } });
    const mv = await call(A, '/api/admin/movies', { method: 'POST', headers: ah, body: { title: 'New Film', language: 'Hindi', durationMin: 120, certificate: 'U', genre: 'Comedy' } });
    const sh = await call(A, '/api/admin/shows', { method: 'POST', headers: ah, body: { movieId: mv.data.id, theatreId: th.data.id, startsAt: Date.now() + 86400_000, basePrice: 150, premiumPrice: 250 } });
    const newShow = (await call(A, `/api/shows/${sh.data.id}`)).data;
    check('admin: new show bookable with correct seats and prices', newShow.seats.length === 30 &&
      newShow.seats.filter((s) => s.tier === 'PREMIUM').length === 6 && newShow.seats.find((s) => s.seat === 'E1').price === 25000);
    check('admin: new movie appears on home page', (await call(A, '/api/movies')).data.movies.some((m) => m.title === 'New Film'));
    const bad = await call(A, '/api/admin/shows', { method: 'POST', headers: ah, body: { movieId: mv.data.id, theatreId: th.data.id, startsAt: Date.now() - 1000, basePrice: 150, premiumPrice: 250 } });
    check('admin: show in the past rejected', bad.status === 400, bad.data.error);
    const ov = (await call(A, '/api/admin/overview', { headers: ah })).data;
    check('admin: sales overview lists paid bookings', ov.bookings.length >= 2);
  } catch (e) {
    console.error(e); failed++;
  } finally {
    appA.kill(); appB.kill(); rz.server.close();
    const errs = (appA.log + appB.log).split('\n').filter((l) => /Error|error/.test(l) && !/\[refund\]|\[webhook\] Invalid/.test(l));
    if (errs.length) console.log('\nServer error lines:\n' + errs.slice(0, 10).join('\n'));
    console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.');
    process.exit(failed ? 1 : 0);
  }
})();
