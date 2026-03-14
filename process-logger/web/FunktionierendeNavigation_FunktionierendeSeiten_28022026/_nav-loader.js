// Loads /_nav.html into the nav-placeholder and marks the active link.
// Usage: include <nav id="nav-placeholder" class="side-nav"></nav> in your pages.
// This script should be included with `defer` so nav is present before page scripts run.
(function(){
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