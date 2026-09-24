// public/show.js — the seat map page.
// Flow: pick seats -> "Hold seats" (server locks them for 8 min) -> "Pay" -> Razorpay popup.

(async function () {
  const params = new URLSearchParams(location.search);
  const showId = Number(params.get('id'));
  const $ = (id) => document.getElementById(id);
  const grid = $('grid'), msg = $('msg'), summary = $('summary'), countdown = $('countdown');
  const holdBtn = $('holdBtn'), payBtn = $('payBtn'), changeBtn = $('changeBtn');

  const HOLD_KEY = `cb_hold_${showId}`;   // remembers your hold if you refresh the page
  let seats = [];                         // latest seat map from server
  let selected = new Set();               // seats you clicked (before holding)
  let hold = null;                        // { bookingId, seats, amount, holdExpiresAt }
  let clockOffset = 0;                    // serverTime - browserTime
  let timer = null;

  function notify(text, kind = 'error') {
    msg.textContent = text; msg.className = `notice ${kind}`;
    if (!text) msg.classList.add('hidden');
  }

  // ---------- drawing ----------
  function render(show) {
    const byLabel = new Map(seats.map((s) => [s.seat, s]));
    grid.style.gridTemplateColumns = `auto repeat(${show.cols + 1}, auto)`;
    grid.innerHTML = '';
    for (let r = 0; r < show.rows; r++) {
      const row = String.fromCharCode(65 + r);
      if (show.premiumRows > 0 && show.premiumRows < show.rows && r === show.rows - show.premiumRows) { const g = document.createElement('div'); g.className = 'gap-row'; g.style.gridColumn = '1 / -1'; grid.append(g); }
      const lab = document.createElement('div'); lab.className = 'rowlabel'; lab.textContent = row; grid.append(lab);
      for (let c = 1; c <= show.cols; c++) {
        if (c === Math.floor(show.cols / 2) + 1) grid.append(Object.assign(document.createElement('div'), { className: 'aisle' }));
        const s = byLabel.get(`${row}${c}`);
        const b = document.createElement('button');
        b.className = 'seat' + (s.tier === 'PREMIUM' ? ' premium' : '');
        b.textContent = c;
        b.setAttribute('aria-label', `Seat ${s.seat}, ${s.tier.toLowerCase()}, ${rupees(s.price)}`);
        const isMine = hold && s.bookingId === hold.bookingId;
        if (isMine) { b.classList.add('mine'); b.disabled = true; }
        else if (s.status === 'BOOKED') { b.classList.add('booked'); b.disabled = true; }
        else if (s.status === 'HELD') { b.classList.add('held'); b.disabled = true; }
        else if (hold) { b.disabled = true; } // while you hold, the map is read-only
        else {
          if (selected.has(s.seat)) b.classList.add('selected');
          b.setAttribute('aria-pressed', selected.has(s.seat));
          b.onclick = () => toggle(s.seat);
        }
        grid.append(b);
      }
    }
    renderBar();
  }

  function toggle(label) {
    if (selected.has(label)) selected.delete(label);
    else if (selected.size >= 10) return notify('You can pick up to 10 seats.');
    else selected.add(label);
    notify('');
    render(currentShow);
  }

  function renderBar() {
    if (hold) {
      summary.innerHTML = '';
      const strong = document.createElement('strong'); strong.textContent = rupees(hold.amount);
      summary.append(`Seats ${hold.seats.join(', ')} held. Total `, strong);
      holdBtn.classList.add('hidden'); payBtn.classList.remove('hidden'); changeBtn.classList.remove('hidden');
      payBtn.textContent = `Pay ${rupees(hold.amount)}`;
      countdown.classList.remove('hidden');
    } else {
      const byLabel = new Map(seats.map((s) => [s.seat, s]));
      const total = [...selected].reduce((sum, l) => sum + (byLabel.get(l)?.price || 0), 0);
      summary.textContent = selected.size
        ? `${selected.size} seat${selected.size > 1 ? 's' : ''}: ${[...selected].sort().join(', ')}. ${rupees(total)}`
        : 'Select up to 10 seats';
      holdBtn.classList.remove('hidden'); payBtn.classList.add('hidden'); changeBtn.classList.add('hidden');
      holdBtn.disabled = selected.size === 0;
      countdown.classList.add('hidden');
    }
  }

  // ---------- countdown ----------
  function startCountdown() {
    clearInterval(timer);
    const tick = () => {
      const left = hold.holdExpiresAt - (Date.now() + clockOffset);
      if (left <= 0) {
        clearInterval(timer);
        hold = null; sessionStorage.removeItem(HOLD_KEY);
        notify('Your hold time ran out, so the seats were released. Pick seats again to continue.');
        refresh();
        return;
      }
      const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
      countdown.textContent = `${m}:${String(s).padStart(2, '0')}`;
      countdown.classList.toggle('low', left < 60000);
    };
    tick();
    timer = setInterval(tick, 500);
  }

  // ---------- server calls ----------
  let currentShow = null;
  async function refresh() {
    try {
      const data = await api(`/api/shows/${showId}`);
      currentShow = data.show; seats = data.seats;
      // If someone else grabbed a seat you had clicked, drop it from your picks.
      for (const l of [...selected]) {
        const s = seats.find((x) => x.seat === l);
        if (!s || s.status !== 'AVAILABLE') { selected.delete(l); notify(`${l} was just taken by someone else.`); }
      }
      render(currentShow);
    } catch (e) { notify(`Couldn't refresh seats: ${e.message}`); }
  }

  holdBtn.onclick = async () => {
    try { await ensureSignedIn(); } catch { return; }
    holdBtn.disabled = true; holdBtn.textContent = 'Holding…';
    // Same key for retries of THIS click -> server never creates two holds.
    const idemKey = crypto.randomUUID();
    try {
      const res = await api('/api/holds', { method: 'POST', body: { showId, seats: [...selected] },
        headers: { 'Idempotency-Key': idemKey } });
      clockOffset = res.serverNow - Date.now();
      hold = res; selected.clear();
      sessionStorage.setItem(HOLD_KEY, String(res.bookingId));
      notify('Seats held. Complete payment before the timer runs out.', 'ok');
      startCountdown();
    } catch (e) {
      if (e.data?.taken) e.data.taken.forEach((l) => selected.delete(l));
      notify(e.message);
    } finally {
      holdBtn.textContent = 'Hold seats';
      await refresh();
    }
  };

  changeBtn.onclick = async () => {
    if (!hold) return;
    changeBtn.disabled = true;
    try { await api(`/api/bookings/${hold.bookingId}`, { method: 'DELETE' }); } catch {}
    clearInterval(timer); hold = null; sessionStorage.removeItem(HOLD_KEY);
    changeBtn.disabled = false; notify('');
    refresh();
  };

  // Opens Razorpay's payment popup. Razorpay handles the card/UPI details;
  // our server never sees them. We only get a signed "paid" result back.
  payBtn.onclick = async () => {
    if (typeof Razorpay === 'undefined') return notify('The payment window could not load. Check your internet and refresh the page.');
    payBtn.disabled = true; payBtn.textContent = 'Opening payment…';
    let order;
    try {
      order = await api(`/api/bookings/${hold.bookingId}/pay`, { method: 'POST' });
    } catch (e) {
      notify(e.message); payBtn.disabled = false; renderBar(); return;
    }
    const secondsLeft = Math.floor((order.holdExpiresAt - (Date.now() + clockOffset)) / 1000);
    const bookingId = hold.bookingId;
    const rz = new Razorpay({
      key: order.keyId,
      order_id: order.orderId,
      amount: order.amount,
      currency: 'INR',
      name: 'CineBook',
      description: `${currentShow.title}, seats ${hold.seats.join(', ')}`,
      prefill: order.prefill,
      theme: { color: '#f5b83d' },
      timeout: Math.max(60, secondsLeft), // popup closes itself when the hold runs out
      handler: async (resp) => {
        notify('Payment received. Confirming your seats…', 'ok');
        try { await api('/api/payments/verify', { method: 'POST', body: resp }); } catch {}
        // Even if that call failed, the webhook or background check will confirm it.
        sessionStorage.removeItem(HOLD_KEY);
        location.href = `/bookings?highlight=${bookingId}`;
      },
      modal: {
        ondismiss: () => {
          payBtn.disabled = false; renderBar();
          if (hold) notify('Payment window closed. Your seats are still held until the timer ends.');
        },
      },
    });
    rz.on('payment.failed', (r) => {
      notify(`Payment failed: ${r.error?.description || 'unknown reason'}. Your seats are still held, so you can try again.`);
    });
    rz.open();
  };

  // ---------- start ----------
  if (!showId) { notify('No show selected.'); return; }
  const data = await api(`/api/shows/${showId}`).catch((e) => { notify(`${e.message} Go back to the home page to pick a show.`); return null; });
  if (!data) { $('title').textContent = 'Show not found'; document.querySelector('.bar').classList.add('hidden'); return; }
  currentShow = data.show; seats = data.seats;
  $('title').textContent = data.show.title;
  $('subtitle').textContent = `${data.show.theatre}, ${showTime(data.show.startsAt)}. ${data.show.language}, ${data.show.certificate}`;
  document.title = `${data.show.title} — CineBook`;
  const reg = seats.find((x) => x.tier === 'REGULAR'), prem = seats.find((x) => x.tier === 'PREMIUM');
  $('prices').textContent = [reg && `Regular ${rupees(reg.price)}`, prem && `Premium (back rows) ${rupees(prem.price)}`].filter(Boolean).join('. ');

  // Restore an active hold after refresh or after a failed payment.
  const savedId = sessionStorage.getItem(HOLD_KEY);
  if (savedId && Auth.token) {
    try {
      const { booking, serverNow } = await api(`/api/bookings/${savedId}`);
      if (booking.status === 'HELD' && booking.holdExpiresAt > serverNow) {
        clockOffset = serverNow - Date.now();
        hold = { bookingId: booking.id, seats: booking.seats, amount: booking.amount, holdExpiresAt: booking.holdExpiresAt };
        startCountdown();
      } else sessionStorage.removeItem(HOLD_KEY);
    } catch { sessionStorage.removeItem(HOLD_KEY); }
  }
  render(currentShow);

  // Live updates: re-check seats every 3s, but only while the tab is visible.
  setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 3000);
})();
