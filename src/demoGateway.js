// src/demoGateway.js
// Built-in DEMO payment gateway. Used automatically when no Razorpay keys are set.
// No signup, no KYC, no real money. It has the same functions as razorpay.js,
// so the rest of the app (holds, late payments, refunds) works exactly the same.
// Payments are stored in the demo_payments table.

const crypto = require('crypto');
const { query } = require('./db');

const rand = () => crypto.randomBytes(9).toString('hex');
const row = (r) => r && { id: r.id, order_id: r.order_id, amount: r.amount, currency: 'INR', status: r.status };

async function createOrder(amount) {
  return { id: 'demo_order_' + rand(), amount, currency: 'INR', status: 'created' };
}

// The "customer pays" step. Called by our own server when the demo checkout's Pay button is clicked.
// If this order was already paid (e.g. a double click), return that payment instead of charging twice.
async function pay(orderId, amount, outcome) {
  const id = 'demo_pay_' + rand();
  try {
    await query('INSERT INTO demo_payments (id, order_id, amount, status, created_at) VALUES ($1,$2,$3,$4,$5)',
      [id, orderId, amount, outcome === 'failed' ? 'failed' : 'authorized', Date.now()]);
    return id;
  } catch (e) {
    if (e.code !== '23505') throw e; // 23505 = unique rule broken: already paid
    return (await query("SELECT id FROM demo_payments WHERE order_id = $1 AND status <> 'failed'", [orderId])).rows[0].id;
  }
}

async function fetchPayment(paymentId) {
  const r = (await query('SELECT * FROM demo_payments WHERE id = $1', [paymentId])).rows[0];
  if (!r) throw Object.assign(new Error('Demo payment not found'), { status: 404 });
  return row(r);
}

async function fetchOrderPayments(orderId) {
  return { items: (await query('SELECT * FROM demo_payments WHERE order_id = $1', [orderId])).rows.map(row) };
}

// Atomic, like a real gateway: only the first capture succeeds.
async function capturePayment(paymentId) {
  const r = (await query(
    "UPDATE demo_payments SET status = 'captured' WHERE id = $1 AND status = 'authorized' RETURNING *", [paymentId])).rows[0];
  if (!r) throw Object.assign(new Error('Already captured or invalid'), { status: 400 });
  return row(r);
}

async function refundPayment(paymentId) {
  await query("UPDATE demo_payments SET status = 'refunded' WHERE id = $1", [paymentId]);
  return { id: 'demo_refund_' + rand() };
}

module.exports = {
  name: 'demo', configured: true, KEY_ID: 'demo', isLive: false, webhookEnabled: false,
  createOrder, pay, fetchPayment, fetchOrderPayments, capturePayment, refundPayment,
  verifyCheckoutSignature: () => false, // demo payments never come from the browser directly
  verifyWebhookSignature: () => false,
};
