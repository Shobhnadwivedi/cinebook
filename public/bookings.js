// public/bookings.js — the user's tickets.

(async function () {
  const list = document.getElementById('list');
  const msg = document.getElementById('msg');
  const highlight = Number(new URLSearchParams(location.search).get('highlight'));
  const labels = { CONFIRMED: 'Confirmed', REFUND_PENDING: 'Refund being processed', REFUNDED: 'Refunded', HELD: 'Awaiting payment' };

  try { await ensureSignedIn(); } catch { list.textContent = 'Sign in to see your bookings.'; return; }

  function say(text, kind) { msg.textContent = text; msg.className = `notice ${kind}`; }

  async function load() {
    const { bookings } = await api('/api/my-bookings');
    list.innerHTML = '';
    if (!bookings.length) { list.textContent = 'No bookings yet. Pick a show from the home page.'; return bookings; }
    for (const b of bookings) {
      list.append(el('div', { className: 'ticket' + (b.id === highlight ? ' highlight' : '') },
        el('div', {},
          el('h2', { textContent: b.title }),
          el('div', { className: 'meta', textContent: `${b.theatre}, ${showTime(b.startsAt)}. Seats ${b.seats.join(', ')}` })),
        el('div', {},
          el('div', { className: `status ${b.status}`, textContent: labels[b.status] || b.status }),
          el('div', { textContent: rupees(b.amount) }),
          el('div', { className: 'meta', textContent: `Booking #${b.id}` }))));
    }
    return bookings;
  }

  // Right after paying, confirmation can take a few seconds. Keep checking.
  for (let i = 0; i < 40; i++) {
    const bookings = await load().catch(() => []);
    const b = bookings.find((x) => x.id === highlight);
    if (!highlight || !b) break;
    if (b.status === 'CONFIRMED') { say('Payment received. Your seats are confirmed. Show this booking number at the counter.', 'ok'); break; }
    if (b.status === 'REFUND_PENDING' || b.status === 'REFUNDED') {
      say('Your payment arrived after the seat hold ran out and someone else booked those seats. Your money has been refunded in full; banks take 5 to 7 working days to show it.', 'error');
      break;
    }
    say('Confirming your payment with the bank. This usually takes a few seconds…', 'ok');
    await new Promise((r) => setTimeout(r, 4000));
  }
})();
