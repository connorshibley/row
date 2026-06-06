// =============================================================
// lib/whoop-lib.js — shared helpers for the /api/whoop/* functions
// -------------------------------------------------------------
// Zero-dependency (uses global fetch + node:crypto). Bundled into
// each serverless function by Vercel's file tracing.
//
// Responsibilities:
//   • Read config from env (with the project's known Supabase URL as a
//     non-secret default).
//   • Talk to Supabase via PostgREST using the SERVICE ROLE key, which
//     bypasses RLS — this is the ONLY place WHOOP tokens are read/written.
//   • Sign/verify the OAuth `state` param (HMAC) so the callback can
//     trust which user started the flow.
//   • Exchange / refresh WHOOP OAuth tokens.
//   • Pull the latest recovery / sleep / cycle and write a compact
//     summary into app_state(key='whoop') for the dashboard to render.
// =============================================================
'use strict';

const crypto = require('crypto');

// ---- config ----
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ygeeeplqpudlodoquwly.supabase.co';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const STATE_SECRET = process.env.STATE_SECRET || '';
const CRON_SECRET  = process.env.CRON_SECRET || '';

const WHOOP = {
  clientId:     process.env.WHOOP_CLIENT_ID || '',
  clientSecret: process.env.WHOOP_CLIENT_SECRET || '',
  redirectUri:  process.env.WHOOP_REDIRECT_URI || '',
  authUrl:  'https://api.prod.whoop.com/oauth/oauth2/auth',
  tokenUrl: 'https://api.prod.whoop.com/oauth/oauth2/token',
  api:      'https://api.prod.whoop.com/developer',
  scopes:   'offline read:recovery read:sleep read:cycles read:workout read:profile',
};

const APP_STATE_KEY = 'whoop';

// ---- small utils ----
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

// ---- OAuth state signing (HMAC over a small JSON payload) ----
function signState(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', STATE_SECRET).update(body).digest());
  return body + '.' + sig;
}
function verifyState(state) {
  if (!state || typeof state !== 'string' || state.indexOf('.') === -1) return null;
  const [body, sig] = state.split('.');
  const expect = b64url(crypto.createHmac('sha256', STATE_SECRET).update(body).digest());
  // constant-time compare
  if (sig.length !== expect.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  let payload;
  try { payload = JSON.parse(b64urlDecode(body).toString('utf8')); } catch { return null; }
  if (!payload || !payload.exp || Date.now() > payload.exp) return null;
  return payload;
}

// ---- Supabase (service role) ----
function supaHeaders(extra) {
  return Object.assign({
    apikey: SERVICE_KEY,
    Authorization: 'Bearer ' + SERVICE_KEY,
    'Content-Type': 'application/json',
  }, extra || {});
}

// Verify a user's Supabase JWT and return their user id (or null).
async function userIdFromJwt(jwt) {
  if (!jwt) return null;
  try {
    const r = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + jwt },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? u.id : null;
  } catch { return null; }
}

async function getAccount(userId) {
  const r = await fetch(
    SUPABASE_URL + '/rest/v1/whoop_accounts?user_id=eq.' + encodeURIComponent(userId) + '&select=*',
    { headers: supaHeaders() }
  );
  if (!r.ok) return null;
  const rows = await r.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function getAllAccounts() {
  const r = await fetch(SUPABASE_URL + '/rest/v1/whoop_accounts?select=*', { headers: supaHeaders() });
  if (!r.ok) return [];
  const rows = await r.json();
  return Array.isArray(rows) ? rows : [];
}

async function upsertAccount(row) {
  row.updated_at = new Date().toISOString();
  await fetch(SUPABASE_URL + '/rest/v1/whoop_accounts?on_conflict=user_id', {
    method: 'POST',
    headers: supaHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(row),
  });
}

async function deleteAccount(userId) {
  await fetch(SUPABASE_URL + '/rest/v1/whoop_accounts?user_id=eq.' + encodeURIComponent(userId), {
    method: 'DELETE', headers: supaHeaders({ Prefer: 'return=minimal' }),
  });
}

async function upsertAppState(userId, data) {
  await fetch(SUPABASE_URL + '/rest/v1/app_state?on_conflict=user_id,key', {
    method: 'POST',
    headers: supaHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify({
      user_id: userId, key: APP_STATE_KEY, data, updated_at: new Date().toISOString(),
    }),
  });
}

async function upsertHistory(userId, point) {
  await fetch(SUPABASE_URL + '/rest/v1/whoop_history?on_conflict=user_id,day', {
    method: 'POST',
    headers: supaHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(Object.assign(
      { user_id: userId, updated_at: new Date().toISOString() }, point)),
  });
}

async function deleteAppState(userId) {
  await fetch(
    SUPABASE_URL + '/rest/v1/app_state?user_id=eq.' + encodeURIComponent(userId) + '&key=eq.' + APP_STATE_KEY,
    { method: 'DELETE', headers: supaHeaders({ Prefer: 'return=minimal' }) }
  );
}

// ---- WHOOP OAuth ----
async function exchangeCode(code) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: WHOOP.clientId,
    client_secret: WHOOP.clientSecret,
    redirect_uri: WHOOP.redirectUri,
  });
  const r = await fetch(WHOOP.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) throw new Error('WHOOP token exchange failed: ' + r.status + ' ' + (await r.text()));
  return r.json();
}

async function refreshTokens(refreshToken) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: WHOOP.clientId,
    client_secret: WHOOP.clientSecret,
    scope: 'offline',
  });
  const r = await fetch(WHOOP.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) throw new Error('WHOOP token refresh failed: ' + r.status + ' ' + (await r.text()));
  return r.json();
}

// Make sure the account has a non-expired access token; refresh + persist
// if needed (WHOOP rotates the refresh token on every refresh).
async function ensureAccessToken(acct) {
  const soon = Date.now() + 60_000; // 60s skew
  const exp = acct.expires_at ? new Date(acct.expires_at).getTime() : 0;
  if (acct.access_token && exp > soon) return acct.access_token;

  const tok = await refreshTokens(acct.refresh_token);
  acct.access_token = tok.access_token;
  if (tok.refresh_token) acct.refresh_token = tok.refresh_token; // rotate
  acct.expires_at = new Date(Date.now() + (tok.expires_in || 3600) * 1000).toISOString();
  await upsertAccount({
    user_id: acct.user_id,
    refresh_token: acct.refresh_token,
    access_token: acct.access_token,
    expires_at: acct.expires_at,
  });
  return acct.access_token;
}

async function whoopGet(path, accessToken) {
  const r = await fetch(WHOOP.api + path, { headers: { Authorization: 'Bearer ' + accessToken } });
  if (!r.ok) throw new Error('WHOOP GET ' + path + ' -> ' + r.status);
  return r.json();
}

// ---- data shaping ----
function firstRecord(payload) {
  if (!payload) return null;
  if (Array.isArray(payload.records) && payload.records.length) return payload.records[0];
  return null;
}
function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }

// hrv_rmssd_milli is reported in SECONDS despite the name (e.g. 0.065 = 65ms).
// Normalise to milliseconds for display; tolerate either convention.
function hrvToMs(v) {
  if (typeof v !== 'number' || !isFinite(v)) return null;
  return Math.round(v < 1 ? v * 1000 : v);
}
function msToHours(ms) {
  if (typeof ms !== 'number' || !isFinite(ms)) return null;
  return Math.round((ms / 3_600_000) * 10) / 10;
}

// Pull latest recovery / sleep / cycle and return the compact summary
// object stored in app_state. Missing sections are null (not fatal).
async function buildSummary(accessToken) {
  const out = { updated_at: new Date().toISOString(), recovery: null, sleep: null, strain: null };

  try {
    const rec = firstRecord(await whoopGet('/v2/recovery?limit=1', accessToken));
    const s = rec && rec.score;
    if (s) {
      out.recovery = {
        score: num(s.recovery_score),
        hrv_ms: hrvToMs(s.hrv_rmssd_milli),
        rhr: num(s.resting_heart_rate),
        skin_temp_c: num(s.skin_temp_celsius),
        spo2: num(s.spo2_percentage),
        at: rec.created_at || null,
      };
    }
  } catch (e) { /* leave null */ }

  try {
    const slp = firstRecord(await whoopGet('/v2/activity/sleep?limit=1', accessToken));
    const s = slp && slp.score;
    if (s) {
      const ss = s.stage_summary || {};
      const stages = {
        rem_ms: num(ss.total_rem_sleep_time_milli) || 0,
        deep_ms: num(ss.total_slow_wave_sleep_time_milli) || 0,
        light_ms: num(ss.total_light_sleep_time_milli) || 0,
        awake_ms: num(ss.total_awake_time_milli) || 0,
        in_bed_ms: num(ss.total_in_bed_time_milli) || 0,
      };
      const asleepMs = stages.rem_ms + stages.deep_ms + stages.light_ms;
      const need = s.sleep_needed || {};
      const neededMs = (num(need.baseline_milli) || 0)
        + (num(need.need_from_sleep_debt_milli) || 0)
        + (num(need.need_from_recent_strain_milli) || 0)
        + (num(need.need_from_recent_nap_milli) || 0);
      out.sleep = {
        performance: num(s.sleep_performance_percentage),
        efficiency: num(s.sleep_efficiency_percentage),
        consistency: num(s.sleep_consistency_percentage),
        asleep_hours: msToHours(asleepMs),
        needed_hours: neededMs > 0 ? msToHours(neededMs) : null,
        debt_hours: msToHours(num(need.need_from_sleep_debt_milli) || 0),
        disturbances: num(ss.disturbance_count),
        cycles: num(ss.sleep_cycle_count),
        resp_rate: num(s.respiratory_rate),
        stages,
        start: slp.start || null,
        end: slp.end || null,
        at: slp.end || slp.start || null,
      };
    }
  } catch (e) { /* leave null */ }

  try {
    const cyc = firstRecord(await whoopGet('/v2/cycle?limit=1', accessToken));
    const s = cyc && cyc.score;
    if (s) {
      out.strain = {
        day_strain: num(s.strain) != null ? Math.round(s.strain * 10) / 10 : null,
        kilojoule: num(s.kilojoule),
        at: cyc.start || null,
      };
    }
  } catch (e) { /* leave null */ }

  return out;
}

// Full sync for one account: ensure token, build summary, write app_state.
async function syncAccount(acct) {
  const accessToken = await ensureAccessToken(acct);
  const summary = await buildSummary(accessToken);
  await upsertAppState(acct.user_id, summary);
  try {
    const day = (summary.recovery && summary.recovery.at
      ? new Date(summary.recovery.at) : new Date()).toISOString().slice(0, 10);
    await upsertHistory(acct.user_id, {
      day,
      recovery: summary.recovery ? summary.recovery.score : null,
      hrv: summary.recovery ? summary.recovery.hrv_ms : null,
      rhr: summary.recovery ? summary.recovery.rhr : null,
      strain: summary.strain ? summary.strain.day_strain : null,
      sleep_perf: summary.sleep ? summary.sleep.performance : null,
    });
  } catch (e) { /* history is non-fatal */ }
  return summary;
}

// ---- request helpers ----
function bearerFrom(req) {
  const h = req.headers.authorization || req.headers.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : null;
}

function configError() {
  const missing = [];
  if (!SERVICE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!STATE_SECRET) missing.push('STATE_SECRET');
  if (!WHOOP.clientId) missing.push('WHOOP_CLIENT_ID');
  if (!WHOOP.clientSecret) missing.push('WHOOP_CLIENT_SECRET');
  if (!WHOOP.redirectUri) missing.push('WHOOP_REDIRECT_URI');
  return missing.length ? ('Missing env: ' + missing.join(', ')) : null;
}

module.exports = {
  WHOOP, CRON_SECRET, APP_STATE_KEY,
  signState, verifyState,
  userIdFromJwt, getAccount, getAllAccounts, upsertAccount, deleteAccount,
  deleteAppState, exchangeCode, syncAccount,
  bearerFrom, configError,
};
