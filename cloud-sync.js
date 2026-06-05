// =============================================================
// cloud-sync.js — generic cross-device sync for the dashboard
// -------------------------------------------------------------
// Mirrors the bespoke sync already living inside gym.html, but
// parameterized so finance / health / po-water / index can each
// reuse it. Each page, BEFORE loading this script, sets:
//
//   window.CLOUD_SYNC = {
//     appKey:   'finance',                    // app_state row key
//     keys:     ['finance_active_tab', ...],  // exact localStorage keys
//     prefixes: ['nw:'],                      // localStorage key prefixes
//   };
//
// Requires @supabase/supabase-js (window.supabase) to be loaded first.
//
// Data model: one Postgres row per appKey in public.app_state
//   { key text pk, data jsonb, updated_at timestamptz }
// `data` is an object mapping each synced localStorage key -> parsed value.
//
// On a remote change we re-apply to localStorage and then reload the
// page (guarded so it never fires while you're editing an input). A
// reload is heavy but guarantees the page re-renders from the new
// state without page-specific re-render hooks.
// =============================================================
(function () {
  'use strict';

  // Same project as gym.html / topbar.js. Public anon key by design —
  // this is a personal dashboard with no login; row access is governed
  // by permissive RLS for the anon role.
  const SUPABASE_URL = 'https://ygeeeplqpudlodoquwly.supabase.co';
  const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlnZWVlcGxxcHVkbG9kb3F1d2x5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA2NjQxODEsImV4cCI6MjA5NjI0MDE4MX0.wEzKsj5PFjQcioOkWJnkkkARqXdaSzWjgn4OkV2fy20';

  const cfg = window.CLOUD_SYNC;
  if (!cfg || !cfg.appKey) return;                 // page didn't opt in
  if (!window.supabase || !SUPABASE_URL || !SUPABASE_KEY) return;
  if (SUPABASE_URL.indexOf('PASTE-') === 0) return; // still a placeholder

  const APP_KEY  = cfg.appKey;
  const KEYS     = Array.isArray(cfg.keys) ? cfg.keys : [];
  const PREFIXES = Array.isArray(cfg.prefixes) ? cfg.prefixes : [];

  function matches(k) {
    if (KEYS.indexOf(k) !== -1) return true;
    for (let i = 0; i < PREFIXES.length; i++) {
      if (k.indexOf(PREFIXES[i]) === 0) return true;
    }
    return false;
  }

  let supa = null;
  let pushTimer = null;
  let suppressSync = false;
  let pendingRemote = null;
  let lastSyncedJson = null; // ignore realtime echoes of our own pushes
  let userId = null;         // owner of this device's rows (auth.uid())
  let accessToken = null;    // current session token (for the unload keepalive push)

  // Re-render after a remote change. Prefer the page's in-place resync
  // hook; fall back to a full reload if the page didn't provide one.
  function refreshUI() {
    if (typeof window.__cloudResync === 'function') {
      try { window.__cloudResync(); return; } catch (e) {}
    }
    try { window.location.reload(); } catch (e) {}
  }

  // Wrap setItem/removeItem so a sync error can NEVER block the real
  // write. The underlying call always runs; sync scheduling is in a
  // try/catch that swallows everything.
  const _origSet    = localStorage.setItem.bind(localStorage);
  const _origRemove = localStorage.removeItem.bind(localStorage);
  localStorage.setItem = function (k, v) {
    _origSet(k, v);
    try { if (!suppressSync && matches(k)) schedulePush(); } catch (e) {}
  };
  localStorage.removeItem = function (k) {
    _origRemove(k);
    try { if (!suppressSync && matches(k)) schedulePush(); } catch (e) {}
  };

  // Gather every synced localStorage key into a plain object.
  function collectState() {
    const out = {};
    // exact keys
    for (const k of KEYS) {
      const v = localStorage.getItem(k);
      if (v == null) continue;
      try { out[k] = JSON.parse(v); } catch { out[k] = v; }
    }
    // prefix keys — scan the whole store
    if (PREFIXES.length) {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k == null || k in out) continue;
        let pref = false;
        for (const p of PREFIXES) { if (k.indexOf(p) === 0) { pref = true; break; } }
        if (!pref) continue;
        const v = localStorage.getItem(k);
        if (v == null) continue;
        try { out[k] = JSON.parse(v); } catch { out[k] = v; }
      }
    }
    return out;
  }

  function isUserEditing() {
    const ae = document.activeElement;
    if (!ae) return false;
    const tag = ae.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (ae.getAttribute && ae.getAttribute('contenteditable') === 'true') return true;
    return false;
  }

  // Apply a remote blob onto localStorage. Returns whether anything
  // actually changed locally.
  function applyRemoteState(remote) {
    if (!remote || typeof remote !== 'object') return false;
    suppressSync = true;
    let changed = false;
    try {
      // upsert incoming values
      for (const k of Object.keys(remote)) {
        if (!matches(k)) continue;
        const incoming = JSON.stringify(remote[k]);
        if (localStorage.getItem(k) !== incoming) {
          try { _origSet(k, incoming); changed = true; } catch {}
        }
      }
      // remove synced keys that no longer exist remotely
      const localState = collectState();
      for (const k of Object.keys(localState)) {
        if (!(k in remote)) {
          try { _origRemove(k); changed = true; } catch {}
        }
      }
    } finally {
      suppressSync = false;
    }
    return changed;
  }

  // Reload (so the page re-renders from fresh localStorage) unless the
  // user is mid-edit — in which case stash and apply once they're done.
  function maybeApplyRemote(remote) {
    if (isUserEditing()) { pendingRemote = remote; return; }
    if (applyRemoteState(remote)) refreshUI();
  }

  function applyPendingIfReady() {
    if (pendingRemote && !isUserEditing()) {
      const r = pendingRemote;
      pendingRemote = null;
      if (applyRemoteState(r)) refreshUI();
    }
  }
  document.addEventListener('focusout', () => setTimeout(applyPendingIfReady, 0));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') applyPendingIfReady();
  });

  async function pushNow() {
    if (!supa || !userId) return;
    const state = collectState();
    const json = JSON.stringify(state);
    if (json === lastSyncedJson) return;
    try {
      const { error } = await supa
        .from('app_state')
        .upsert(
          { user_id: userId, key: APP_KEY, data: state, updated_at: new Date().toISOString() },
          { onConflict: 'user_id,key' }
        );
      if (!error) lastSyncedJson = json;
    } catch (_) {}
  }

  function schedulePush() {
    if (suppressSync) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(pushNow, 250);
  }

  // Backup push on unload via fetch keepalive so a fast refresh doesn't
  // lose the latest change before the debounced push fires.
  function flushPushOnUnload() {
    if (!userId || !accessToken) return;
    const state = collectState();
    const json = JSON.stringify(state);
    if (json === lastSyncedJson) return;
    try {
      fetch(SUPABASE_URL + '/rest/v1/app_state?on_conflict=user_id,key', {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': 'Bearer ' + accessToken,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates',
        },
        body: JSON.stringify({ user_id: userId, key: APP_KEY, data: state, updated_at: new Date().toISOString() }),
        keepalive: true,
      }).catch(() => {});
      lastSyncedJson = json;
    } catch (_) {}
  }
  window.addEventListener('pagehide', flushPushOnUnload);
  window.addEventListener('beforeunload', flushPushOnUnload);

  // Initial sync: connect, pull current state, subscribe to realtime.
  (async function init() {
    // Reuse auth.js's client so we share its session; fall back to our own.
    supa = window.__supa || window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

    // Require a signed-in user — auth.js shows the login gate otherwise.
    let session = null;
    try { session = (await supa.auth.getSession()).data.session; } catch (e) {}
    if (!session) return;
    userId = session.user.id;
    accessToken = session.access_token;
    try { supa.realtime.setAuth(accessToken); } catch (e) {}
    supa.auth.onAuthStateChange(function (_e, s) {
      if (s) { accessToken = s.access_token; userId = s.user.id; }
    });

    try {
      const { data, error } = await supa
        .from('app_state').select('data').eq('key', APP_KEY).maybeSingle();
      if (!error && data && data.data && Object.keys(data.data).length > 0) {
        lastSyncedJson = JSON.stringify(collectState());
        maybeApplyRemote(data.data);
      } else if (Object.keys(collectState()).length > 0) {
        schedulePush(); // first device to sync — seed the cloud
      }
    } catch (_) {}

    supa.channel('app_state_' + APP_KEY)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'app_state',
        filter: 'key=eq.' + APP_KEY,
      }, (payload) => {
        if (!payload.new || !payload.new.data) return;
        const incoming = JSON.stringify(payload.new.data);
        if (incoming === lastSyncedJson) return; // echo of our own push
        lastSyncedJson = incoming;
        maybeApplyRemote(payload.new.data);
      })
      .subscribe();
  })();
})();
