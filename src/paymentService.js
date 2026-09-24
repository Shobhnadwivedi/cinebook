// src/paymentService.js
// Payment flow with Razorpay:
//   1. startPayment: we create a Razorpay order for the exact amount in our DB.
//   2. The Razorpay popup opens in the browser; the customer pays (card/UPI/netbanking).
//   3. We learn the result in up to THREE ways, whichever comes first:
//        a. the browser sends us the signed result (verifyCheckout)
//        b. Razorpay's server calls our webhook (handleWebhook)
//        c. our background job asks Razorpay directly (reconcile) - covers
//           the case where the customer closed the tab and no webhook is set up
//   4. settle() processes it exactly once, no matter how many of a/b/c arrive.

const { query, tx } = require('./db');
const rzp = require('./razorpay');
const { BookingError, confirmBooking } = require('./bookingService');

async function startPayment(user, bookingId) {
  const b = (await query('SELECT * FROM bookings WHERE id = $1', [bookingId])).rows[0];
  if (!b || b.user_id !== user.id) throw new BookingError(404, 'Booking not found.');
  if (b.status !== 'HELD') throw new BookingError(409, `This booking is ${b.status.toLowerCase().replace('_', ' ')}.`);
  if (b.hold_expires_at <= Date.now() + 15_000) throw new BookingError(409, 'Your seat hold has run out. Please pick seats again.');

  // Clicking Pay twice reuses the same order instead of creating a new one.
  let orderId = (await query(
    "SELECT gateway_order_id FROM payments WHERE booking_id = $1 AND status = 'CREATED' ORDER BY id DESC LIMIT 1",
    [bookingId])).rows[0]?.gateway_order_id;
  if (!orderId) {
    const order = await rzp.createOrder(b.amount, `booking_${b.id}`, { booking_id: String(b.id) });
    orderId = order.id;
    const now = Date.now();
    await query(`INSERT INTO payments (booking_id, gateway_order_id, amount, status, created_at, updated_at)
                 VALUES ($1,$2,$3,'CREATED',$4,$4)`, [b.id, orderId, b.amount, now]);
  }
  return { keyId: rzp.KEY_ID, orderId, amount: b.amount, holdExpiresAt: b.hold_expires_at,
    prefill: { name: user.name, email: user.email } };
}

// Make sure Razorpay really has the money for this order, capturing it if needed.
async function ensureCaptured(orderId, paymentId, expectedAmount) {
  let p = await rzp.fetchPayment(paymentId);
  if (p.order_id !== orderId) throw new BookingError(400, 'Payment does not belong to this order.');
  if (p.amount !== expectedAmount || p.currency !== 'INR') throw new BookingError(400, 'Payment amount mismatch.');
  if (p.status === 'authorized') {
    try { p = await rzp.capturePayment(paymentId, expectedAmount); }
    catch (e) { p = await rzp.fetchPayment(paymentId); } // maybe captured by a parallel call
  }
  return p.status === 'captured';
}

async function settle(orderId, paymentId) {
  const payment = (await query('SELECT * FROM payments WHERE gateway_order_id = $1', [orderId])).rows[0];
  if (!payment) throw new BookingError(404, 'Unknown order.');
  if (payment.status === 'SUCCESS') return bookingStatus(payment.booking_id);

  const captured = await ensureCaptured(orderId, paymentId, payment.amount);
  if (!captured) return bookingStatus(payment.booking_id); // not paid (yet); hold stays so they can retry

  const outcome = await tx(async (c) => {
    // Lock this payment row: if the webhook and the browser arrive together,
    // the second one waits here, then sees SUCCESS and does nothing.
    const p = (await c.query('SELECT * FROM payments WHERE gateway_order_id = $1 FOR UPDATE', [orderId])).rows[0];
    if (p.status === 'SUCCESS') return { status: null };
    await c.query(`UPDATE payments SET status = 'SUCCESS', gateway_payment_id = $1, updated_at = $2
                   WHERE id = $3`, [paymentId, Date.now(), p.id]);
    return { status: await confirmBooking(c, p.booking_id) };
  });

  if (outcome.status === 'REFUND_PENDING') await refundBooking(payment.booking_id).catch((e) =>
    console.error('[refund] will retry later:', e.message));
  return bookingStatus(payment.booking_id);
}

async function bookingStatus(bookingId) {
  return { bookingId, status: (await query('SELECT status FROM bookings WHERE id = $1', [bookingId])).rows[0].status };
}

async function refundBooking(bookingId) {
  const p = (await query(`SELECT * FROM payments WHERE booking_id = $1 AND status = 'SUCCESS' AND refund_id IS NULL`,
    [bookingId])).rows[0];
  if (!p) return;
  const refund = await rzp.refundPayment(p.gateway_payment_id, p.amount, { reason: 'Seats no longer available' });
  await tx(async (c) => {
    await c.query('UPDATE payments SET refund_id = $1, updated_at = $2 WHERE id = $3', [refund.id, Date.now(), p.id]);
    await c.query("UPDATE bookings SET status = 'REFUNDED' WHERE id = $1 AND status = 'REFUND_PENDING'", [bookingId]);
  });
  console.log(`[refund] booking ${bookingId} refunded (${refund.id})`);
}

// (a) Browser says "paid" - we trust it only if the signature checks out.
async function verifyCheckout(user, body) {
  const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: sig } = body;
  if (!rzp.verifyCheckoutSignature(orderId, paymentId, sig)) throw new BookingError(400, 'Payment signature is invalid.');
  const owner = (await query(
    'SELECT b.user_id FROM payments p JOIN bookings b ON b.id = p.booking_id WHERE p.gateway_order_id = $1', [orderId])).rows[0];
  if (!owner || owner.user_id !== user.id) throw new BookingError(404, 'Order not found.');
  return settle(orderId, paymentId);
}

// (b) Razorpay's server calls us.
async function handleWebhook(rawBody, signature) {
  if (!rzp.verifyWebhookSignature(rawBody, signature)) throw new BookingError(400, 'Invalid webhook signature.');
  const event = JSON.parse(rawBody.toString('utf8'));
  const p = event?.payload?.payment?.entity;
  if (!p || !['payment.captured', 'payment.authorized', 'order.paid'].includes(event.event)) return { ignored: true };
  const known = (await query('SELECT 1 FROM payments WHERE gateway_order_id = $1', [p.order_id])).rows[0];
  if (!known) return { ignored: true };
  return settle(p.order_id, p.id);
}

// (c) Background safety net, every 2 minutes. Looks at orders older than 90s
// that we still haven't heard about.
const MIN_AGE_MS = Number(process.env.RECONCILE_MIN_AGE_SECONDS || 90) * 1000;
async function reconcile() {
  const now = Date.now();
  const pending = (await query(
    `SELECT gateway_order_id FROM payments WHERE status = 'CREATED' AND created_at < $1 AND created_at > $2
     ORDER BY id LIMIT 20`, [now - MIN_AGE_MS, now - 6 * 3600_000])).rows;
  for (const { gateway_order_id: orderId } of pending) {
    try {
      const list = await rzp.fetchOrderPayments(orderId);
      const paid = (list.items || []).find((x) => x.status === 'captured' || x.status === 'authorized');
      if (paid) { await settle(orderId, paid.id); console.log(`[reconcile] settled ${orderId}`); }
    } catch (e) { console.error('[reconcile]', orderId, e.message); }
  }
  // Retry refunds that failed earlier (e.g. Razorpay was briefly down).
  const refunds = (await query("SELECT id FROM bookings WHERE status = 'REFUND_PENDING' LIMIT 20")).rows;
  for (const { id } of refunds) await refundBooking(id).catch((e) => console.error('[refund]', id, e.message));
}

module.exports = { startPayment, verifyCheckout, handleWebhook, reconcile, settle };
