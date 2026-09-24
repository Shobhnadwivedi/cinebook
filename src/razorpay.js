// src/razorpay.js
// Talks to Razorpay's servers. Docs: https://razorpay.com/docs/api/
// Test keys (rzp_test_...) = fake money, real flow. Live keys (rzp_live_...) = real money.

const crypto = require('crypto');

const KEY_ID = process.env.RAZORPAY_KEY_ID;
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || '';
const API = process.env.RAZORPAY_API_BASE || 'https://api.razorpay.com/v1';

if (!KEY_ID || !KEY_SECRET) {
  console.error('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set. Add them in Render > Environment.');
  process.exit(1);
}

async function call(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      authorization: 'Basic ' + Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64'),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000), // never hang forever on a slow network
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Razorpay ${method} ${path} failed: ${data?.error?.description || res.status}`);
    err.status = 502;
    throw err;
  }
  return data;
}

const createOrder = (amount, receipt, notes) =>
  call('POST', '/orders', { amount, currency: 'INR', receipt, notes });
const fetchOrderPayments = (orderId) => call('GET', `/orders/${encodeURIComponent(orderId)}/payments`);
const fetchPayment = (paymentId) => call('GET', `/payments/${encodeURIComponent(paymentId)}`);
const capturePayment = (paymentId, amount) =>
  call('POST', `/payments/${encodeURIComponent(paymentId)}/capture`, { amount, currency: 'INR' });
const refundPayment = (paymentId, amount, notes) =>
  call('POST', `/payments/${encodeURIComponent(paymentId)}/refund`, { amount, notes });

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// After checkout, the browser gets (order_id, payment_id, signature).
// Only Razorpay knows our secret, so only Razorpay can produce a valid signature.
function verifyCheckoutSignature(orderId, paymentId, signature) {
  const expected = crypto.createHmac('sha256', KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
  return safeEqualHex(expected, signature);
}

// Webhooks are signed over the raw request body with the webhook secret.
function verifyWebhookSignature(rawBody, signature) {
  if (!WEBHOOK_SECRET) return false;
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
  return safeEqualHex(expected, signature);
}

module.exports = {
  KEY_ID, createOrder, fetchPayment, fetchOrderPayments, capturePayment, refundPayment,
  verifyCheckoutSignature, verifyWebhookSignature, webhookEnabled: Boolean(WEBHOOK_SECRET),
  isLive: KEY_ID.startsWith('rzp_live_'),
};
