// public/app.js — shared by every page: API calls, login state, sign-in dialog.

const Auth = {
  get token() { return localStorage.getItem('cb_token'); },
  get user() { try { return JSON.parse(localStorage.getItem('cb_user')); } catch { return null; } },
  save(token, user) { localStorage.setItem('cb_token', token); localStorage.setItem('cb_user', JSON.stringify(user)); },
  clear() { localStorage.removeItem('cb_token'); localStorage.removeItem('cb_user'); },
};

async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(Auth.token ? { authorization: `Bearer ${Auth.token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-cache',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && Auth.token && !path.startsWith('/api/admin')) { Auth.clear(); renderUserbox(); }
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, data });
  return data;
}

const rupees = (paise) => '₹' + (paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const showTime = (ms) => new Date(ms).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const el = (tag, props = {}, ...children) => { const e = Object.assign(document.createElement(tag), props); e.append(...children); return e; };

function renderUserbox() {
  const box = document.getElementById('userbox');
  if (!box) return;
  box.innerHTML = '';
  const u = Auth.user;
  if (u) {
    const out = el('button', { className: 'btn ghost', textContent: 'Sign out' });
    out.onclick = async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); Auth.clear(); location.href = '/'; };
    box.append(el('span', { textContent: u.name }), el('a', { href: '/bookings', textContent: 'My bookings' }), out);
  } else {
    const btn = el('button', { className: 'btn ghost', textContent: 'Sign in' });
    btn.onclick = () => signIn().then(() => location.reload()).catch(() => {});
    box.append(btn);
  }
}

// Sign-in dialog with two tabs: "Sign in" and "Create account".
function signIn() {
  return new Promise((resolve, reject) => {
    const dlg = document.getElementById('signin');
    const form = dlg.querySelector('form');
    const err = dlg.querySelector('.notice');
    const nameRow = dlg.querySelector('.name-row');
    const tabs = dlg.querySelectorAll('.tabs button');
    const submit = dlg.querySelector('[data-submit]');
    let mode = 'login';
    const setMode = (m) => {
      mode = m;
      tabs.forEach((t) => t.setAttribute('aria-selected', t.dataset.mode === m));
      nameRow.classList.toggle('hidden', m === 'login');
      form.fullname.required = m === 'signup';
      form.password.autocomplete = m === 'signup' ? 'new-password' : 'current-password';
      submit.textContent = m === 'signup' ? 'Create account' : 'Sign in';
      err.classList.add('hidden');
    };
    tabs.forEach((t) => (t.onclick = () => setMode(t.dataset.mode)));
    setMode('login');

    form.onsubmit = async (e) => {
      e.preventDefault();
      submit.disabled = true;
      try {
        const body = { name: form.fullname.value, email: form.email.value, password: form.password.value };
        const { token, user } = await api(mode === 'signup' ? '/api/signup' : '/api/login', { method: 'POST', body });
        Auth.save(token, user);
        form.password.value = '';
        dlg.close();
        renderUserbox();
        resolve(user);
      } catch (ex) {
        err.textContent = ex.message;
        err.classList.remove('hidden');
      } finally { submit.disabled = false; }
    };
    dlg.querySelector('[data-cancel]').onclick = () => { dlg.close(); reject(new Error('cancelled')); };
    dlg.showModal();
  });
}

async function ensureSignedIn() {
  if (Auth.token) return Auth.user;
  return signIn();
}

async function showTestBanner() {
  try {
    const { testMode } = await api('/api/config');
    if (testMode) {
      document.body.prepend(el('div', { className: 'testbar',
        textContent: 'Test mode: no real money is charged. At checkout pick UPI and enter success@razorpay, or use a Razorpay test card.' }));
    }
  } catch {}
}

document.addEventListener('DOMContentLoaded', () => { renderUserbox(); showTestBanner(); });
