// App Shell router + loader (stable, conservative)
// - injects scoped styles from fetched doc
// - inserts fragment into #app-content, then executes scripts (resolving src against response.url)
// - avoids duplicate script execution (external and identical inline)
// - heuristically falls back to full navigation when inline scripts contain top-level declarations,
//   except for white-listed pages which are always loaded dynamically.
// - dispatches synthetic DOMContentLoaded/readystatechange and custom 'app:page-loaded'
// - calls known init functions as best-effort (e.g. renderAllLogpoints, loadConnections)
(function(){
  const CONTENT_ID = 'app-content';
  const TITLE_ID = 'pageTitle';
  const LOADER_ID = 'loader';
  const API_SETTINGS = '/api/settings';

  // Pages that should always be loaded dynamically (do NOT fallback to full navigation)
  const ALWAYS_DYNAMIC = new Set([
    'logpoints-config.html'
  ]);

  // prefer manual scroll restoration
  try { if ('scrollRestoration' in history) history.scrollRestoration = 'manual'; } catch(e){}

  const navList = document.getElementById('navList');
  const contentEl = document.getElementById(CONTENT_ID);
  const titleEl = document.getElementById(TITLE_ID);
  const loaderEl = document.getElementById(LOADER_ID);

  // global set to track executed inline script bodies (avoid redeclaration)
  if (!window.__APP_SHELL_EXECUTED_INLINE) window.__APP_SHELL_EXECUTED_INLINE = new Set();

  function log(...args){ try { console.log('[app-shell]', ...args); } catch(e) {} }
  function showLoader(on=true){ if(loaderEl) loaderEl.style.display = on ? 'inline-block' : 'none'; }
  function setActiveNav(path){
    if (!navList) return;
    const links = navList.querySelectorAll('a[data-path], a[href]');
    const cur = (path||location.pathname.split('/').pop()||'index.html');
    links.forEach(a=>{
      const p = (a.getAttribute('data-path')||a.getAttribute('href')||'').split('/').pop();
      a.classList.toggle('active', p === cur);
    });
  }

  async function applyThemeFromSettings(){
    try {
      const res = await fetch(API_SETTINGS, { cache:'no-store' });
      if (!res.ok) return;
      const j = await res.json().catch(()=>null);
      if (!j || !j.theme) return;
      for (const k in j.theme) {
        try { document.documentElement.style.setProperty(k, j.theme[k]); } catch(e){}
      }
    } catch(e){}
  }

  function extractFragmentFromHtml(htmlText){
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlText, 'text/html');
    let root = doc.querySelector('#page-root') || doc.querySelector('main#page-root') || doc.querySelector('main.main-area') || doc.querySelector('main');
    if (!root) root = doc.body;
    const title = (doc.querySelector('title') && doc.querySelector('title').textContent) || null;
    return { fragment: root, title: title, doc: doc };
  }

  function removeAutofocusAttributes(doc) {
    try {
      const nodes = Array.from(doc.querySelectorAll('[autofocus]'));
      nodes.forEach(n => n.removeAttribute('autofocus'));
      if (nodes.length) log('removed autofocus attributes:', nodes.length);
    } catch(e){ /* ignore */ }
  }

  // Simple heuristic: scope inline style text by replacing html/body selectors with #app-content
  function scopeInlineStyleText(styleText) {
    if (!styleText || typeof styleText !== 'string') return styleText;
    let t = styleText;
    // conservative replacements
    t = t.replace(/\bhtml\b/g, '#app-content');
    t = t.replace(/\bbody\b/g, '#app-content');
    return t;
  }

  function injectStylesFromDoc(doc, baseHref) {
    try {
      const head = document.head || document.getElementsByTagName('head')[0];
      const existingHrefs = new Set(Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map(l => l.href));

      // link rel=stylesheet
      Array.from(doc.querySelectorAll('link[rel="stylesheet"]')).forEach(l => {
        const hrefAttr = l.getAttribute('href');
        if (!hrefAttr) return;
        let resolved;
        try { resolved = (new URL(hrefAttr, baseHref)).href; } catch (e) { resolved = hrefAttr; }
        if (existingHrefs.has(resolved)) return;
        existingHrefs.add(resolved);
        const nl = document.createElement('link');
        nl.rel = 'stylesheet';
        nl.href = resolved;
        if (l.media) nl.media = l.media;
        head.appendChild(nl);
        log('injected stylesheet', resolved);
      });

      // style blocks (scoped)
      const existingStyleTexts = new Set(Array.from(document.querySelectorAll('style')).map(s => s.textContent.trim()).filter(Boolean));
      Array.from(doc.querySelectorAll('style')).forEach(s => {
        const raw = (s.textContent || '').trim();
        if (!raw) return;
        const scoped = scopeInlineStyleText(raw);
        if (!scoped) return;
        if (existingStyleTexts.has(scoped)) return;
        existingStyleTexts.add(scoped);
        const ns = document.createElement('style');
        if (s.type) ns.type = s.type;
        ns.textContent = scoped;
        head.appendChild(ns);
        log('injected scoped inline style (len)', scoped.length);
      });
    } catch (e) {
      console.warn('injectStylesFromDoc failed', e);
    }
  }

  // detect unsafe inline script: top-level declarations like const/let/var/class/export
  function inlineScriptLooksUnsafe(text) {
    if (!text || typeof text !== 'string') return false;
    // examine first N chars/lines to avoid heavy regex on very large files
    const sample = text.slice(0, 1200);
    const unsafeRegex = /^\s*(?:\/\/.*\n|\s*\/\*[\s\S]*?\*\/\s*\n|\s*)*(?:const|let|var|class|export)\s+[A-Za-z_$][\w$]*\b/m;
    return unsafeRegex.test(sample);
  }

  function hasScriptSrcInDocument(resolvedSrc) {
    try {
      return !!document.querySelector('script[src="'+resolvedSrc+'"]');
    } catch(e) {
      return Array.from(document.scripts).some(s => s.src === resolvedSrc);
    }
  }

  // Execute scripts after fragment insertion. Return {fallbackFullNavigation: bool}
  async function executeAllScriptsFromDocAfterInsert(doc, baseHref, pageName) {
    const scripts = Array.from(doc.querySelectorAll('script'));
    log('executeAllScriptsFromDocAfterInsert: scripts count', scripts.length, 'baseHref', baseHref);

    // If any inline script looks unsafe and page is NOT in ALWAYS_DYNAMIC -> fallback full navigation
    for (const s of scripts) {
      if (!s.src) {
        const raw = (s.textContent || '').trim();
        if (inlineScriptLooksUnsafe(raw) && !ALWAYS_DYNAMIC.has(pageName)) {
          log('detected unsafe inline script and page not whitelisted -> fallback full navigation for', pageName);
          return { fallbackFullNavigation: true };
        }
      }
    }

    // Execute scripts, skipping duplicates
    for (const s of scripts) {
      if (s.src) {
        let resolved;
        try { resolved = (new URL(s.getAttribute('src'), baseHref)).href; } catch(e){ resolved = s.getAttribute('src'); }
        if (hasScriptSrcInDocument(resolved)) {
          log('skipping external script (already present):', resolved);
          continue;
        }
        const newScript = document.createElement('script');
        if (s.type) newScript.type = s.type;
        if (s.hasAttribute('nonce')) newScript.setAttribute('nonce', s.getAttribute('nonce'));
        newScript.src = resolved;
        if (s.hasAttribute('async')) newScript.async = true;
        if (s.hasAttribute('defer')) newScript.defer = true;

        const isModule = (newScript.type === 'module');
        const isBlocking = !newScript.async && !newScript.defer && !isModule;
        log('loading external script', newScript.src, 'blocking=', isBlocking, 'module=', isModule);
        if (isBlocking) {
          await new Promise((res) => {
            newScript.onload = () => { log('loaded', newScript.src); res(); };
            newScript.onerror = () => { log('error loading', newScript.src); res(); };
            document.body.appendChild(newScript);
          });
        } else {
          document.body.appendChild(newScript);
          if (isModule && !newScript.async) {
            await new Promise((res) => {
              newScript.onload = () => { log('module loaded', newScript.src); res(); };
              newScript.onerror = () => { log('module error', newScript.src); res(); };
            });
          } else {
            log('appended async/defer external script', newScript.src);
          }
        }
      } else {
        const raw = (s.textContent || '').trim();
        if (!raw) { log('skipping empty inline script'); continue; }
        if (window.__APP_SHELL_EXECUTED_INLINE.has(raw)) {
          log('skipping inline script (already executed)');
          continue;
        }
        try {
          const newScript = document.createElement('script');
          if (s.type) newScript.type = s.type;
          if (s.hasAttribute('nonce')) newScript.setAttribute('nonce', s.getAttribute('nonce'));
          newScript.textContent = raw;
          document.body.appendChild(newScript);
          window.__APP_SHELL_EXECUTED_INLINE.add(raw);
          log('executed inline script and recorded key (len)', raw.length);
        } catch (e) {
          try { eval(raw); window.__APP_SHELL_EXECUTED_INLINE.add(raw); log('eval inline fallback executed'); } catch(ee){ console.error('inline script eval error', ee); }
        }
      }
    }
    log('executeAllScriptsFromDocAfterInsert done');
    return { fallbackFullNavigation: false };
  }

  function ensureTopScrollAndBlur() {
    try { if (document.activeElement && typeof document.activeElement.blur === 'function') document.activeElement.blur(); } catch(e){}
    try {
      const prev = document.documentElement.style.scrollBehavior;
      document.documentElement.style.scrollBehavior = 'auto';
      window.scrollTo(0, 0);
      document.documentElement.style.scrollBehavior = prev || '';
    } catch(e){}
  }
  function scheduleStabilizeScroll() {
    ensureTopScrollAndBlur();
    setTimeout(ensureTopScrollAndBlur, 50);
    setTimeout(ensureTopScrollAndBlur, 250);
    requestAnimationFrame(() => setTimeout(ensureTopScrollAndBlur, 0));
  }

  async function callPageInits(url) {
    const pageName = String((url || '').split('/').pop() || '');
    if (typeof window.pageInit === 'function') {
      try { log('calling window.pageInit()'); await Promise.resolve(window.pageInit({ url: url, page: pageName })); } catch (e) { console.warn('window.pageInit failed', e); }
    }
    const tryCall = async (fnName) => {
      try { if (typeof window[fnName] === 'function') { log('calling', fnName); await Promise.resolve(window[fnName]()); return true; } } catch (e) { console.warn(fnName, 'failed', e); }
      return false;
    };
    if (pageName === 'logpoints-config.html') {
      await tryCall('loadConnections');
      await tryCall('renderAllLogpoints');
    }
    if (pageName) {
      const base = pageName.replace(/\.[^/.]+$/, '');
      const parts = base.split(/[-_\.]+/).map((p,i) => i===0 ? p : p.charAt(0).toUpperCase()+p.slice(1));
      const camel = parts.join('');
      await tryCall('render' + camel);
      await tryCall('init' + camel);
    }
  }

  async function loadPage(url, addToHistory = true){
    if (!url) url = 'index.html';
    log('loadPage start', url);
    showLoader(true);
    const prevOverflowAnchor = document.documentElement.style.overflowAnchor || '';
    try { document.documentElement.style.overflowAnchor = 'none'; } catch(e){}

    contentEl && contentEl.classList.add('content-hidden');

    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) { log('fetch failed', res.status); window.location.href = url; return; }
      const txt = await res.text();
      const extracted = extractFragmentFromHtml(txt);
      const pageName = (url || '').split('/').pop() || '';

      try { removeAutofocusAttributes(extracted.doc); } catch(e){}

      const baseHrefForStyles = res.url || (extracted.doc && extracted.doc.baseURI) || url;
      injectStylesFromDoc(extracted.doc, baseHrefForStyles);

      if (extracted.title) titleEl && (titleEl.textContent = extracted.title);
      else titleEl && (titleEl.textContent = (url.split('/').pop()) || 'Seite');

      if (!contentEl) { window.location.href = url; return; }

      // Insert fragment first (so scripts run against actual DOM)
      contentEl.innerHTML = '';
      const fragChildren = Array.from(extracted.fragment.childNodes);
      fragChildren.forEach(node => {
        const adopted = document.importNode(node, true);
        contentEl.appendChild(adopted);
      });

      // Execute scripts AFTER insertion
      const baseHref = res.url || (extracted.doc && extracted.doc.baseURI) || url;
      const execResult = await executeAllScriptsFromDocAfterInsert(extracted.doc, baseHref, pageName);
      if (execResult && execResult.fallbackFullNavigation) {
        // restore loader state and perform full navigation
        showLoader(false);
        document.documentElement.style.overflowAnchor = prevOverflowAnchor || '';
        log('performing full navigation to', url);
        window.location.href = url;
        return;
      }

      // Stabilize and dispatch events
      scheduleStabilizeScroll();
      try {
        document.dispatchEvent(new Event('DOMContentLoaded', { bubbles:true }));
        document.dispatchEvent(new Event('readystatechange', { bubbles:true }));
        log('dispatched synthetic DOMContentLoaded/readystatechange');
      } catch(e){ log('dispatch synthetic events failed', e); }

      if (contentEl) {
        try {
          const pageLoadedEvent = new CustomEvent('app:page-loaded', { detail: { url: url, page: pageName } });
          contentEl.dispatchEvent(pageLoadedEvent);
          log('dispatched app:page-loaded on #app-content');
        } catch (e) { log('dispatch app:page-loaded failed', e); }
      }

      try { await callPageInits(url); } catch (e) { log('callPageInits error', e); }

      setActiveNav(pageName);

      if (addToHistory){
        try { history.pushState({ path: url }, '', url); } catch(e){}
      }
      log('loadPage done', url);
    } catch(err){
      console.error('loadPage error', err);
      window.location.href = url;
      return;
    } finally {
      try { document.documentElement.style.overflowAnchor = prevOverflowAnchor || ''; } catch(e){}
      contentEl && contentEl.classList.remove('content-hidden');
      showLoader(false);
    }
  }

  function onDocumentClick(e){
    try {
      if (e.defaultPrevented) return;
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      let a = e.target;
      while (a && a.tagName !== 'A') a = a.parentElement;
      if (!a || !a.href) return;
      const origin = location.origin;
      if (a.href && a.href.indexOf(origin) !== 0) return;
      if (a.target && a.target === '_blank') return;
      const href = a.getAttribute('href') || a.href;
      const path = href.split('/').pop();
      if (!path || path.match(/\.(png|jpg|jpeg|gif|svg|pdf|zip|mp3|mp4)$/i)) return;
      log('intercepted click for', href);
      e.preventDefault();
      loadPage(href, true);
    } catch(e){ console.error('onDocumentClick error', e); }
  }

  function onNavListClick(e){
    try {
      if (e.defaultPrevented) return;
      if (e.button !== 0) return;
      let a = e.target;
      while (a && a.tagName !== 'A') a = a.parentElement;
      if (!a || !a.href) return;
      const href = a.getAttribute('href') || a.href;
      const path = href.split('/').pop();
      if (!path) return;
      log('navList click', href);
      e.preventDefault();
      loadPage(href, true);
    } catch(e){ console.error('onNavListClick error', e); }
  }

  window.addEventListener('popstate', (ev) => {
    const path = (ev.state && ev.state.path) || location.pathname.split('/').pop() || 'index.html';
    log('popstate ->', path);
    loadPage(path, false);
  });

  async function init(){
    log('init start');
    await applyThemeFromSettings();
    setActiveNav(location.pathname.split('/').pop() || 'index.html');

    document.addEventListener('click', onDocumentClick);
    if (navList) navList.addEventListener('click', onNavListClick);

    const initial = location.pathname.split('/').pop();
    if (initial && initial !== '' && initial !== 'index.html'){
      await loadPage(initial, false);
    } else {
      titleEl && (titleEl.textContent = 'Übersicht');
    }
    log('init done, app-shell ready');
    try { window.__APP_SHELL_LOADED = true; } catch(e){}
  }

  init().catch(e => console.error('app-shell init failed', e));
})();