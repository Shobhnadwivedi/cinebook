// tests/run-demo-tests.js
// Same safety checks, but in DEMO mode (no Razorpay keys set).
const { spawn } = require('child_process');
const { Client } = require('pg');

const DB = (process.env.TEST_DATABASE_URL || 'postgres://postgres:pg@localhost:5432/cinebook_test').replace(/[^/]+$/, 'cinebook_demo_test');
const A = 'http://localhost:3400', B = 'http://localhost:3401';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); if (!ok) failed++; };
async function call(base, path, { method = 'GET', body, token, headers = {} } = {}) {
  const res = await fetch(base + path, { method, body: body ? JSON.stringify(body) : undefined,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
function startApp(port, extra) {
  const env = { ...process.env, PORT: port, DATABASE_URL: DB, ADMIN_PASSWORD: 'admin-pass-123', ...extra };
  delete env.RAZORPAY_KEY_ID; delete env.RAZORPAY_KEY_SECRET;
  const p = spawn('node', ['src/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.log = ''; p.stdout.on('data', (d) => (p.log += d)); p.stderr.on('data', (d) => (p.log += d));
  return p;
}

(async () => {
  const admin = new Client({ connectionString: DB.replace(/\/[^/]+$/, '/postgres') });
  await admin.connect(); await admin.query('DROP DATABASE IF EXISTS cinebook_demo_test'); await admin.query('CREATE DATABASE cinebook_demo_test'); await admin.end();
  const appA = startApp(3400, {}); await sleep(2500);
  const appB = startApp(3401, { HOLD_MINUTES: '0.34', SWEEP_SECONDS: '2' }); await sleep(2000);
  try {
    check('starts in DEMO mode without Razorpay keys', /DEMO payments/.test(appA.log));
    check('site reports demo mode', (await call(A, '/api/config')).data.provider === 'demo');
    const users = [];
    for (let i = 0; i < 30; i++) users.push((await call(A, '/api/signup', { method: 'POST', body: { name: `D${i}`, email: `d${i}@t.dev`, password: 'password123' }, headers: { 'x-forwarded-for': `10.1.${i}.1` } })).data.token);
    const showId = (await call(A, '/api/movies')).data.movies[0].shows[0].id;

    const res = await Promise.all(users.map((t, i) => call(i % 2 ? B : A, '/api/holds', { method: 'POST', token: t, body: { showId, seats: ['B5'] } })));
    const wins = res.filter((r) => r.status === 201);
    check('30 users race for one seat: one winner', wins.length === 1);
    const w = wins[0].data, wt = users[res.indexOf(wins[0])];

    const order = (await call(A, `/api/bookings/${w.bookingId}/pay`, { method: 'POST', token: wt })).data;
    check('pay opens demo checkout', order.provider === 'demo' && order.amount === w.amount);
    check("someone else can't pay your order", (await call(A, '/api/payments/demo-pay', { method: 'POST', token: users[3], body: { orderId: order.orderId } })).status === 404);
    const f = await call(A, '/api/payments/demo-pay', { method: 'POST', token: wt, body: { orderId: order.orderId, outcome: 'failed' } });
    check('failed payment keeps hold', f.data.failed && (await call(A, `/api/bookings/${w.bookingId}`, { token: wt })).data.booking.status === 'HELD');
    const clicks = await Promise.all([A, B, A, B].map((base) => call(base, '/api/payments/demo-pay', { method: 'POST', token: wt, body: { orderId: order.orderId, outcome: 'pay' } })));
    const pg = new Client({ connectionString: DB }); await pg.connect();
    const paid = (await pg.query("SELECT COUNT(*)::int AS n FROM demo_payments WHERE order_id = $1 AND status = 'captured'", [order.orderId])).rows[0].n;
    check('4 simultaneous Pay clicks: confirmed, charged once', clicks.every((c) => c.status === 200) && paid === 1 &&
      (await call(A, `/api/bookings/${w.bookingId}`, { token: wt })).data.booking.status === 'CONFIRMED', `captured payments: ${paid}`);

    console.log('\n(waiting ~22s for short holds to expire...)');
    const h1 = (await call(B, '/api/holds', { method: 'POST', token: users[20], body: { showId, seats: ['C1'] } })).data;
    const o1 = (await call(B, `/api/bookings/${h1.bookingId}/pay`, { method: 'POST', token: users[20] })).data;
    const h2 = (await call(B, '/api/holds', { method: 'POST', token: users[21], body: { showId, seats: ['C2'] } })).data;
    const o2 = (await call(B, `/api/bookings/${h2.bookingId}/pay`, { method: 'POST', token: users[21] })).data;
    await sleep(22000);
    const steal = await call(A, '/api/holds', { method: 'POST', token: users[22], body: { showId, seats: ['C2'] } });
    await call(B, '/api/payments/demo-pay', { method: 'POST', token: users[20], body: { orderId: o1.orderId } });
    check('late payment, seat still free: confirmed', (await call(A, `/api/bookings/${h1.bookingId}`, { token: users[20] })).data.booking.status === 'CONFIRMED');
    await call(B, '/api/payments/demo-pay', { method: 'POST', token: users[21], body: { orderId: o2.orderId } });
    const st = (await call(A, `/api/bookings/${h2.bookingId}`, { token: users[21] })).data.booking.status;
    check('late payment, seat taken: refunded, other user keeps it', st === 'REFUNDED' && steal.status === 201, st);
    await pg.end();
  } catch (e) { console.error(e); failed++; }
  finally {
    appA.kill(); appB.kill();
    const errs = (appA.log + appB.log).split('\n').filter((l) => /Error|error/.test(l));
    if (errs.length) console.log('\nServer error lines:\n' + errs.slice(0, 10).join('\n'));
    console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.');
    process.exit(failed ? 1 : 0);
  }
})();
