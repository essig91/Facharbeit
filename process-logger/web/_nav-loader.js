// Loads /_nav.html into the nav-placeholder and marks the active link.
// Usage: include <nav id="nav-placeholder" class="side-nav"></nav> in your pages.
// This script should be included with `defer` so nav is present before page scripts run.
(function(){
  const ROLE_LEVELS = {
    none: 0,
    Trend: 1,
    Beobachten: 2,
    Bediener: 3,
    Administrator: 4,
    Systemadministrator: 5
  };

  let navTimeTimer = null;
  let navTimeSyncTimer = null;
  let navBaseMs = Date.now();
  let navBasePerf = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
  let navTimezone = 'Europe/Berlin';
  let currentUser = null;

  function computeRoleLevel(roles) {
    const list = Array.isArray(roles) ? roles : [];
    let max = 0;
    for (const r of list) {
      const lvl = Number(ROLE_LEVELS[String(r)] || 0);
      if (lvl > max) max = lvl;
    }
    return max;
  }

  function minRoleForElement(el) {
    const role = String((el && el.getAttribute && el.getAttribute('data-min-role')) || 'none');
    return Number(ROLE_LEVELS[role] || 0);
  }

  function markNavReady() {
    const nav = document.querySelector('.side-nav');
    if (nav) nav.classList.add('nav-ready');
  }

  function applyRoleVisibility() {
    const navList = document.getElementById('navList');
    if (!navList) return;
    const lvl = computeRoleLevel(currentUser && currentUser.roles);
    Array.from(navList.querySelectorAll('a')).forEach((a) => {
      const li = a.closest('li');
      if (!li) return;
      const needed = minRoleForElement(a);
      li.style.display = (lvl >= needed) ? '' : 'none';
    });
  }

  function setAuthStateText() {
    const el = document.getElementById('navAuthState');
    if (!el) return;
    if (!currentUser || currentUser.anonymous) {
      el.textContent = 'Nicht angemeldet';
      return;
    }
    const roles = Array.isArray(currentUser.roles) ? currentUser.roles.join(', ') : '';
    el.textContent = `Angemeldet: ${currentUser.username}${roles ? ' | ' + roles : ''}`;
  }

  async function refreshCurrentUser() {
    try {
      const resp = await fetch('/api/auth/me', { cache: 'no-store', credentials: 'same-origin' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const data = await resp.json();
      const u = data && data.user ? data.user : null;
      currentUser = {
        username: u && u.username ? String(u.username) : 'Anonym',
        roles: u && Array.isArray(u.roles) ? u.roles : [],
        anonymous: !!(data && data.anonymous)
      };
      const userInput = document.getElementById('navLoginUser');
      const passInput = document.getElementById('navLoginPass');
      const loginBtn = document.getElementById('navLoginBtn');
      const logoutBtn = document.getElementById('navLogoutBtn');
      if (currentUser && !currentUser.anonymous) {
        if (userInput) userInput.value = currentUser.username || '';
        if (passInput) passInput.value = '';
        if (loginBtn) loginBtn.disabled = true;
        if (logoutBtn) logoutBtn.disabled = false;
      } else {
        if (loginBtn) loginBtn.disabled = false;
        if (logoutBtn) logoutBtn.disabled = true;
      }
      setAuthStateText();
      applyRoleVisibility();
      markNavReady();
    } catch (_) {
      currentUser = { username: 'Anonym', roles: [], anonymous: true };
      setAuthStateText();
      applyRoleVisibility();
      markNavReady();
    }
  }

  async function doLogin() {
    const userInput = document.getElementById('navLoginUser');
    const passInput = document.getElementById('navLoginPass');
    const username = String(userInput && userInput.value ? userInput.value : '').trim();
    const password = String(passInput && passInput.value ? passInput.value : '');
    if (!username) return;
    try {
      const resp = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data || data.ok === false) {
        const el = document.getElementById('navAuthState');
        if (el) el.textContent = 'Login fehlgeschlagen';
        return;
      }
      await refreshCurrentUser();
      window.location.reload();
    } catch (_) {
      const el = document.getElementById('navAuthState');
      if (el) el.textContent = 'Login fehlgeschlagen';
    }
  }

  async function doLogout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } catch (_) {}
    window.location.href = '/index.html';
  }

  function formatNavTime(ms, timezone) {
    try {
      return new Intl.DateTimeFormat('de-DE', {
        timeZone: timezone || 'Europe/Berlin',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      }).format(new Date(ms));
    } catch (_) {
      return new Date(ms).toLocaleString('de-DE');
    }
  }

  function renderNavTime() {
    const el = document.getElementById('navSystemTime');
    if (!el) return;
    const perfNow = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
    const deltaMs = Math.max(0, perfNow - navBasePerf);
    const effectiveMs = navBaseMs + deltaMs;
    const txt = formatNavTime(effectiveMs, navTimezone);
    el.textContent = `Systemzeit: ${txt} (${navTimezone || '-'})`;
  }

  async function updateNavTime() {
    const el = document.getElementById('navSystemTime');
    if (!el) return;
    try {
      const resp = await fetch('/api/time/status', { cache: 'no-store' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const data = await resp.json();
      navTimezone = (data && data.timezone) ? String(data.timezone) : navTimezone;
      const parsed = Date.parse((data && data.systemTimeIso) ? String(data.systemTimeIso) : '');
      navBaseMs = Number.isFinite(parsed) ? parsed : Date.now();
      navBasePerf = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
      renderNavTime();
    } catch (_) {
      el.textContent = 'Systemzeit: nicht verfügbar';
    }
  }

  async function loadNav() {
    try {
      const placeholder = document.getElementById('nav-placeholder');
      if (!placeholder) return;

      // if nav already present, do nothing
      if (document.getElementById('navList')) return;

      const resp = await fetch('/_nav.html', { cache: 'no-store' });
      if (!resp.ok) return;
      const text = await resp.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(text, 'text/html');
      const nav = doc.querySelector('nav');
      if (!nav) {
        // fallback: inject raw HTML
        placeholder.innerHTML = text;
      } else {
        // replace placeholder with parsed nav element (keeps event ordering & semantics)
        placeholder.replaceWith(nav.cloneNode(true));
      }

      // set active link
      try {
        const cur = location.pathname.split('/').pop() || 'index.html';
        const navList = document.getElementById('navList');
        if (navList) {
          Array.from(navList.querySelectorAll('a')).forEach(a => {
            const p = (a.getAttribute('data-path') || a.getAttribute('href') || '').split('/').pop();
            a.classList.toggle('active', p === cur);
          });
        }
      } catch (e) { console.warn('nav setActive failed', e); }

      try {
        const loginBtn = document.getElementById('navLoginBtn');
        const logoutBtn = document.getElementById('navLogoutBtn');
        const passInput = document.getElementById('navLoginPass');
        if (loginBtn) loginBtn.addEventListener('click', doLogin);
        if (logoutBtn) logoutBtn.addEventListener('click', doLogout);
        if (passInput) {
          passInput.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') {
              ev.preventDefault();
              doLogin();
            }
          });
        }
        await refreshCurrentUser();
      } catch (e) { console.warn('nav auth failed', e); }

      try {
        await updateNavTime();
        if (navTimeTimer) clearInterval(navTimeTimer);
        navTimeTimer = setInterval(() => { renderNavTime(); }, 1000);
        if (navTimeSyncTimer) clearInterval(navTimeSyncTimer);
        navTimeSyncTimer = setInterval(() => { updateNavTime(); }, 30000);
      } catch (e) { console.warn('nav time failed', e); }

    } catch (e) {
      console.warn('Failed to load nav', e);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadNav);
  } else {
    setTimeout(loadNav, 0);
  }
})();