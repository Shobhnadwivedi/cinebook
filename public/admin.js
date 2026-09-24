// public/admin.js — admin panel: add movies, theatres and shows; see sales.

(function () {
  const msg = document.getElementById('msg');
  let password = sessionStorage.getItem('cb_admin') || '';
  const say = (text, kind = 'error') => { msg.textContent = text; msg.className = `notice ${kind}`; };
  const adminApi = (path, opts = {}) => api(`/api/admin${path}`, { ...opts, headers: { 'x-admin-password': password } });

  function fillSelect(select, items, label) {
    select.innerHTML = '';
    items.forEach((i) => select.append(el('option', { value: i.id, textContent: label(i) })));
  }

  function fillTable(table, headers, rows) {
    table.innerHTML = '';
    table.append(el('thead', {}, el('tr', {}, ...headers.map((h) => el('th', { textContent: h })))));
    const body = el('tbody');
    rows.forEach((r) => body.append(el('tr', {}, ...r.map((c) => el('td', { textContent: c })))));
    if (!rows.length) body.append(el('tr', {}, el('td', { textContent: 'Nothing yet.', colSpan: headers.length })));
    table.append(body);
  }

  async function load() {
    const data = await adminApi('/overview');
    document.getElementById('unlock').classList.add('hidden');
    document.getElementById('admin').classList.remove('hidden');
    fillSelect(document.getElementById('s-movie'), data.movies, (m) => `${m.title} (${m.language})`);
    fillSelect(document.getElementById('s-theatre'), data.theatres, (t) => `${t.name}, ${t.city} (${t.rows_count * t.cols_count} seats)`);
    fillTable(document.getElementById('showsTable'), ['Show #', 'When', 'Movie', 'Theatre', 'Sold'],
      data.shows.map((s) => [s.id, showTime(s.starts_at), s.title, s.theatre, `${s.sold} / ${s.total}`]));
    fillTable(document.getElementById('bookingsTable'), ['Booking #', 'Movie', 'Customer', 'Seats', 'Amount', 'Status'],
      data.bookings.map((b) => [b.id, b.title, b.email, b.seats.join(', '), rupees(b.amount), b.status]));
  }

  document.getElementById('unlock').onsubmit = async (e) => {
    e.preventDefault();
    password = document.getElementById('adminpw').value;
    try { await load(); sessionStorage.setItem('cb_admin', password); msg.className = 'notice hidden'; }
    catch (ex) { say(ex.message); }
  };

  function hookForm(id, path, toBody, done) {
    const form = document.getElementById(id);
    form.onsubmit = async (e) => {
      e.preventDefault();
      const btn = form.querySelector('.btn');
      btn.disabled = true;
      try {
        const body = toBody(Object.fromEntries(new FormData(form)));
        await adminApi(path, { method: 'POST', body });
        say(done, 'ok');
        if (id !== 'showForm') form.reset();
        await load();
      } catch (ex) { say(ex.message); }
      finally { btn.disabled = false; window.scrollTo({ top: 0 }); }
    };
  }
  // datetime-local gives the time in YOUR browser's timezone; convert to a timestamp.
  hookForm('showForm', '/shows', (f) => ({ ...f, startsAt: new Date(f.time).getTime() }), 'Show added. It is now bookable on the home page.');
  hookForm('movieForm', '/movies', (f) => f, 'Movie added. Now add a show for it.');
  hookForm('theatreForm', '/theatres', (f) => f, 'Theatre added.');

  if (password) load().catch(() => sessionStorage.removeItem('cb_admin'));
})();
