// public/home.js — lists movies and their showtimes.
// We build DOM nodes with textContent (not innerHTML) so data can't inject HTML.

(async function () {
  const box = document.getElementById('movies');
  try {
    const { movies } = await api('/api/movies');
    box.innerHTML = '';
    if (!movies.length) { box.textContent = 'No upcoming shows. The admin can add shows at /admin.'; return; }
    for (const m of movies) {
      const row = document.createElement('section');
      row.className = 'movie';
      const left = document.createElement('div');
      const h = document.createElement('h2'); h.textContent = m.title;
      const meta = document.createElement('div'); meta.className = 'meta';
      meta.textContent = `${m.language}, ${m.genre}, ${m.certificate}, ${Math.floor(m.durationMin / 60)}h ${m.durationMin % 60}m`;
      left.append(h, meta);

      const right = document.createElement('div');
      const byTheatre = {};
      m.shows.forEach((s) => (byTheatre[s.theatre] ||= []).push(s));
      for (const [theatre, shows] of Object.entries(byTheatre)) {
        const t = document.createElement('div'); t.className = 'theatre-name'; t.textContent = theatre;
        const times = document.createElement('div'); times.className = 'times';
        shows.forEach((s) => {
          const a = document.createElement('a');
          a.className = 'time'; a.href = `/show?id=${s.id}`; a.textContent = showTime(s.startsAt);
          times.append(a);
        });
        right.append(t, times);
      }
      row.append(left, right);
      box.append(row);
    }
  } catch (e) {
    box.textContent = '';
    const err = document.getElementById('error');
    err.textContent = `Couldn't load shows: ${e.message}`;
    err.classList.remove('hidden');
  }
})();
