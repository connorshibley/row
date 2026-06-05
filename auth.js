// =============================================================
// auth.js — shared email+password login gate for the dashboard
// -------------------------------------------------------------
// Loaded on every page. Before any data is shown it:
//   1. hides the page body (no flash of another session's data),
//   2. checks for an existing Supabase session,
//   3. if signed in -> reveals the page + adds a Sign out button,
//   4. if not       -> shows a full-screen login overlay.
//
// Accounts are additionally restricted server-side to one email
// (a trigger on auth.users), and every app_state row is owned by
// auth.uid() via per-user RLS, so data is private per user.
//
// The sync code (cloud-sync.js, gym.html, topbar.js) independently
// reads the persisted session, so after a successful login we simply
// reload and every client comes up authenticated.
// =============================================================
(function () {
  'use strict';

  const SUPABASE_URL   = 'https://ygeeeplqpudlodoquwly.supabase.co';
  const SUPABASE_KEY   = 'sb_publishable_ldoSboZs6XCL7fOBbVA0-g_ZzLk2O4L';
  const ALLOWED_EMAIL  = 'connor.shibley@hws.edu';

  // Hide page content immediately so nothing renders until we know
  // whether the user is signed in. The overlay/sign-out live on <html>
  // (outside <body>) so this rule never hides them.
  const PENDING = 'auth-pending';
  document.documentElement.classList.add(PENDING);

  const style = document.createElement('style');
  style.textContent = `
    html.${PENDING} body { visibility: hidden !important; }
    .auth-overlay {
      position: fixed; inset: 0; z-index: 2147483600;
      display: flex; align-items: center; justify-content: center;
      background: #050506;
      font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
      padding: max(16px, env(safe-area-inset-top)) 16px;
    }
    .auth-card {
      width: 100%; max-width: 340px;
      display: flex; flex-direction: column; gap: 12px;
      padding: 28px 22px;
      background: #0e0e10;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 18px;
      box-shadow: 0 24px 60px rgba(0,0,0,0.55);
    }
    .auth-title { font-size: 20px; font-weight: 800; color: #FAFAFA; letter-spacing: -0.01em; }
    .auth-sub   { font-size: 13px; color: rgba(255,255,255,0.5); margin-top: -6px; margin-bottom: 4px; }
    .auth-input {
      width: 100%; box-sizing: border-box;
      padding: 12px 14px; font-size: 15px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.10);
      border-radius: 11px; color: #FAFAFA; outline: none;
      -webkit-appearance: none;
    }
    .auth-input:focus { border-color: #6ee7b7; background: rgba(255,255,255,0.06); }
    .auth-btn {
      margin-top: 4px; padding: 12px 14px;
      font-size: 15px; font-weight: 700;
      background: #6ee7b7; color: #04130d;
      border: none; border-radius: 11px; cursor: pointer;
      -webkit-tap-highlight-color: transparent;
    }
    .auth-btn:disabled { opacity: 0.6; cursor: default; }
    .auth-err { min-height: 16px; font-size: 12px; color: #ff8a8a; line-height: 1.35; }
    .auth-signout {
      position: fixed; z-index: 2147483000;
      top: max(8px, env(safe-area-inset-top)); right: 10px;
      padding: 6px 10px; font-size: 11px; font-weight: 700;
      color: rgba(255,255,255,0.65);
      background: rgba(20,20,22,0.7); backdrop-filter: blur(6px);
      border: 1px solid rgba(255,255,255,0.10); border-radius: 9px;
      cursor: pointer; -webkit-tap-highlight-color: transparent;
    }
    .auth-signout:hover { color: #FAFAFA; border-color: rgba(255,255,255,0.18); }
  `;
  document.head.appendChild(style);

  function onReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  function reveal() { document.documentElement.classList.remove(PENDING); }

  function addSignOut(supa) {
    onReady(function () {
      if (document.getElementById('authSignOut')) return;
      const b = document.createElement('button');
      b.id = 'authSignOut';
      b.className = 'auth-signout';
      b.type = 'button';
      b.textContent = 'Sign out';
      b.addEventListener('click', async function () {
        try { await supa.auth.signOut(); } catch (e) {}
        location.reload();
      });
      document.documentElement.appendChild(b);
    });
  }

  function showLogin(supa) {
    onReady(function () {
      if (document.querySelector('.auth-overlay')) return;
      const overlay = document.createElement('div');
      overlay.className = 'auth-overlay';
      overlay.innerHTML =
        '<div class="auth-card">' +
          '<div class="auth-title">Connor’s Dashboard</div>' +
          '<div class="auth-sub">Sign in to sync your data</div>' +
          '<input class="auth-input" id="authEmail" type="email" value="' + ALLOWED_EMAIL + '" autocomplete="username" autocapitalize="off" autocorrect="off" />' +
          '<input class="auth-input" id="authPass" type="password" placeholder="Password" autocomplete="current-password" />' +
          '<button class="auth-btn" id="authBtn" type="button">Enter</button>' +
          '<div class="auth-err" id="authErr"></div>' +
        '</div>';
      // Lives on <html> so the body-hiding rule never hides it.
      document.documentElement.appendChild(overlay);

      const emailEl = overlay.querySelector('#authEmail');
      const passEl  = overlay.querySelector('#authPass');
      const btn     = overlay.querySelector('#authBtn');
      const errEl   = overlay.querySelector('#authErr');
      setTimeout(function () { passEl.focus(); }, 50);

      async function submit() {
        const email = (emailEl.value || '').trim();
        const password = passEl.value || '';
        errEl.textContent = '';
        if (!email || !password) { errEl.textContent = 'Enter your email and password.'; return; }
        btn.disabled = true; btn.textContent = 'Signing in…';
        try {
          // Returning user: sign in. First-ever run: the account doesn't
          // exist yet, so a failed sign-in falls through to sign-up, which
          // (with email confirmation disabled) returns a live session.
          let r = await supa.auth.signInWithPassword({ email: email, password: password });
          if (r.error) {
            const su = await supa.auth.signUp({ email: email, password: password });
            if (su.error) throw su.error;
            if (!su.data || !su.data.session) {
              throw new Error('Email confirmation is still enabled in Supabase. Turn off "Confirm email" under Authentication → Sign In / Providers, then try again.');
            }
          }
          location.reload();
        } catch (e) {
          errEl.textContent = (e && e.message) ? e.message : 'Sign-in failed.';
          btn.disabled = false; btn.textContent = 'Enter';
        }
      }

      btn.addEventListener('click', submit);
      passEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
      emailEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
    });
  }

  function start() {
    let supa;
    try { supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY); }
    catch (e) { reveal(); return; } // lib failed to load — fail open rather than locking the user out
    window.__supa = supa;

    supa.auth.getSession().then(function (res) {
      const session = res && res.data && res.data.session;
      if (session) { reveal(); addSignOut(supa); }
      else { showLogin(supa); }
    }).catch(function () { showLogin(supa); });
  }

  // Ensure the Supabase client library is present, then start.
  if (window.supabase) {
    start();
  } else {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
    s.onload = start;
    s.onerror = function () { reveal(); }; // network blocked — don't trap the user
    document.head.appendChild(s);
  }
})();
