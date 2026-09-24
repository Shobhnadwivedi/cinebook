// tests/fake-razorpay.js
// A stand-in for Razorpay's API, for automated tests only (never used in production).
// Same endpoints and signature rules as the real one.
const http = require('http');
const crypto = require('crypto');

module.exports = function startFakeRazorpay({ port, keyId, keySecret, webhookSecret, webhookUrl }) {
  const orders = new Map(), payments = new Map();
  const rand = () => crypto.randomBytes(7).toString('hex');
  const stats = { captures: 0, refunds: 0 };

  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(obj)); };
    const url = req.url;

    if (url === '/test/pay') {
      const o = orders.get(body.order_id);
      if (!o) return send(404, {});
      const p = { id: 'pay_' + rand(), order_id: o.id, amount: body.amount ?? o.amount, currency: 'INR',
        status: body.outcome === 'failed' ? 'failed' : 'authorized' };
      payments.set(p.id, p);
      const signature = crypto.createHmac('sha256', keySecret).update(`${o.id}|${p.id}`).digest('hex');
      if (body.webhook && p.status !== 'failed') {
        const event = JSON.stringify({ event: 'payment.authorized', payload: { payment: { entity: p } } });
        const sig = crypto.createHmac('sha256', webhookSecret).update(event).digest('hex');
        const sends = Array.from({ length: body.webhook }, () => fetch(webhookUrl, { method: 'POST',
          headers: { 'content-type': 'application/json', 'x-razorpay-signature': sig }, body: event }).then((r) => r.status));
        body.webhookStatuses = await Promise.all(sends);
      }
      return send(200, { razorpay_order_id: o.id, razorpay_payment_id: p.id, razorpay_signature: signature, webhookStatuses: body.webhookStatuses });
    }
    if (url === '/test/stats') return send(200, stats);

    const auth = Buffer.from((req.headers.authorization || '').replace('Basic ', ''), 'base64').toString();
    if (auth !== `${keyId}:${keySecret}`) return send(401, { error: { description: 'Authentication failed' } });

    let m;
    if (req.method === 'POST' && url === '/v1/orders') {
      const o = { id: 'order_' + rand(), amount: body.amount, currency: body.currency, receipt: body.receipt, status: 'created' };
      orders.set(o.id, o); return send(200, o);
    }
    if ((m = url.match(/^\/v1\/orders\/([^/]+)\/payments$/))) return send(200, { items: [...payments.values()].filter((p) => p.order_id === m[1]) });
    if ((m = url.match(/^\/v1\/payments\/([^/]+)\/capture$/))) {
      const p = payments.get(m[1]);
      if (!p || p.status !== 'authorized') return send(400, { error: { description: 'already captured or invalid' } });
      p.status = 'captured'; stats.captures++; // atomic, like the real API
      await new Promise((r) => setTimeout(r, 30));
      return send(200, p);
    }
    if ((m = url.match(/^\/v1\/payments\/([^/]+)\/refund$/))) { stats.refunds++; return send(200, { id: 'rfnd_' + rand(), amount: body.amount }); }
    if ((m = url.match(/^\/v1\/payments\/([^/]+)$/))) { const p = payments.get(m[1]); return p ? send(200, p) : send(404, { error: { description: 'not found' } }); }
    send(404, { error: { description: 'no route' } });
  });
  return new Promise((r) => server.listen(port, () => r({ server, stats })));
};
