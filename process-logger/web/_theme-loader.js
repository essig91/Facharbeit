// Loads theme from /api/settings and applies CSS variables to :root.
// Also caches theme in localStorage so subsequent loads are instant.
// Safe: silent on any failure.
(function(){
  const STORAGE_KEY = '__APP_SHELL_THEME_CACHE_v1';

  function applyThemeObject(theme) {
    if (!theme || typeof theme !== 'object') return;
    try {
      for (const k in theme) {
        if (!k.startsWith('--')) continue;
        try {
          document.documentElement.style.setProperty(k, theme[k]);
        } catch(e){}
      }
      // quick UI adjustments for body/background/card
      if (theme['--bg']) {
        try { document.body.style.background = theme['--bg']; } catch(e){}
      }
      if (theme['--card-bg']) {
        document.querySelectorAll('.panel, .card').forEach(el => {
          try { el.style.background = theme['--card-bg']; } catch(e){}
        });
      }
      // Optionally update shell font family if provided
      if (theme['--shell-font']) {
        try { document.documentElement.style.setProperty('--shell-font', theme['--shell-font']); } catch(e){}
      }
    } catch (e) {
      console.warn('applyThemeObject failed', e);
    }
  }

  async function fetchTheme() {
    try {
      const res = await fetch('/api/settings', { cache: 'no-store' });
      if (!res.ok) return null;
      const json = await res.json().catch(()=>null);
      if (!json) return null;
      return json.theme || null;
    } catch(e){
      return null;
    }
  }

  async function init() {
    // 1) Try from cache first for instant render
    try {
      const cached = localStorage.getItem(STORAGE_KEY);
      if (cached) {
        try { applyThemeObject(JSON.parse(cached)); } catch(e){}
      }
    } catch(e){}

    // 2) Fetch server-side settings and apply (overrides cache)
    try {
      const theme = await fetchTheme();
      if (theme && typeof theme === 'object') {
        try { applyThemeObject(theme); } catch(e){}
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(theme)); } catch(e){}
      }
    } catch(e){}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 0);
  }
})();