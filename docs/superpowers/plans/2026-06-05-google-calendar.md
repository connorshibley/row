# Google Calendar (ICS) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show today's Google Calendar events on the dashboard via a read-only secret-iCal feed — no OAuth.

**Architecture:** A server-only `calendar_feeds` table stores the user's ICS URL; a zero-dep `lib/calendar-lib.js` fetches + parses the ICS (with daily/weekly recurrence expansion in a ±2-day window); three serverless endpoints (`save`/`events`/`disconnect`) sit in front; a "Today" card in `health.html` (below WHOOP) reads `events` and filters to local today.

**Tech Stack:** Vanilla JS, Supabase (Postgres + PostgREST + RLS), Vercel serverless (Node, global `fetch`), `window.__supa`.

**Spec:** `docs/superpowers/specs/2026-06-05-google-calendar-design.md`

**Testing note:** No unit-test runner in this repo. The ICS parser (Task 2) gets a standalone node assertion script (real TDD). Other tasks verify via `node --check`, the inline-`<script>` parser, SQL, and `curl`.

---

### Task 1: Create `calendar_feeds` table + RLS

**Files:** Supabase migration (MCP `apply_migration`), project `ygeeeplqpudlodoquwly`.

- [ ] **Step 1: Apply migration** `create_calendar_feeds`:
```sql
create table if not exists public.calendar_feeds (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  ics_url    text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.calendar_feeds enable row level security;
revoke all on public.calendar_feeds from anon, authenticated;
```

- [ ] **Step 2: Verify** — SQL:
```sql
select c.relrowsecurity,
  (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
from pg_class c where c.oid = 'public.calendar_feeds'::regclass;
```
Expected: `relrowsecurity = true`, `policies = 0` (server-only; the client never reads this table).

---

### Task 2: `lib/calendar-lib.js` (ICS fetch + parse + recurrence) with test

**Files:**
- Create: `/Users/connorshibley/Personal Dashboard1.0/lib/calendar-lib.js`
- Test (temporary): `/tmp/test-ics.js`

- [ ] **Step 1: Write the failing test** at `/tmp/test-ics.js`:
```js
const lib = require('/Users/connorshibley/Personal Dashboard1.0/lib/calendar-lib');
const assert = require('assert');

// Window: 2026-06-05 .. 2026-06-08 (UTC)
const winStart = Date.UTC(2026, 5, 5, 0, 0, 0);
const winEnd   = Date.UTC(2026, 5, 8, 0, 0, 0);

const ics = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'UID:one',
  'SUMMARY:Single Timed',
  'DTSTART:20260605T140000Z',
  'DTEND:20260605T150000Z',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:allday',
  'SUMMARY:All Day Thing',
  'DTSTART;VALUE=DATE:20260606',
  'DTEND;VALUE=DATE:20260607',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:weekly',
  'SUMMARY:Weekly Standup',
  'DTSTART:20260601T090000Z',
  'DTEND:20260601T093000Z',
  'RRULE:FREQ=WEEKLY;BYDAY=MO,FR',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const events = lib.expandWindow(lib.parseIcs(ics), winStart, winEnd);
const titles = events.map(e => e.title);

// Single timed event present
assert(events.some(e => e.title === 'Single Timed' && e.start === '2026-06-05T14:00:00Z'), 'single timed');
// All-day present, allDay flag set
assert(events.some(e => e.title === 'All Day Thing' && e.allDay === true && e.start === '2026-06-06'), 'all day');
// Weekly MO/FR: in window 6/5(Fri) and 6/8(Mon) -> 2 occurrences
const weekly = events.filter(e => e.title === 'Weekly Standup');
assert(weekly.length === 2, 'weekly count = 2, got ' + weekly.length);
assert(weekly.some(e => e.start.startsWith('2026-06-05')), 'weekly fri');
assert(weekly.some(e => e.start.startsWith('2026-06-08')), 'weekly mon');
// Sorted ascending by start
for (let i = 1; i < events.length; i++) assert(events[i-1].start <= events[i].start, 'sorted');

console.log('ALL ICS TESTS PASS (' + events.length + ' occurrences)');
```

- [ ] **Step 2: Run it, verify it fails**
Run: `node /tmp/test-ics.js`
Expected: FAIL — `Cannot find module '.../lib/calendar-lib'`.

- [ ] **Step 3: Implement** `/Users/connorshibley/Personal Dashboard1.0/lib/calendar-lib.js`:
```js
// lib/calendar-lib.js — zero-dep ICS fetch + parse for the calendar card.
'use strict';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ygeeeplqpudlodoquwly.supabase.co';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

function supaHeaders(extra) {
  return Object.assign({
    apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json',
  }, extra || {});
}
function bearerFrom(req) {
  const h = req.headers.authorization || req.headers.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h); return m ? m[1] : null;
}
function configError() { return SERVICE_KEY ? null : 'Missing env: SUPABASE_SERVICE_ROLE_KEY'; }

async function userIdFromJwt(jwt) {
  if (!jwt) return null;
  try {
    const r = await fetch(SUPABASE_URL + '/auth/v1/user', { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + jwt } });
    if (!r.ok) return null;
    const u = await r.json(); return u && u.id ? u.id : null;
  } catch { return null; }
}
async function getFeed(userId) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/calendar_feeds?user_id=eq.' + encodeURIComponent(userId) + '&select=ics_url', { headers: supaHeaders() });
  if (!r.ok) return null;
  const rows = await r.json();
  return Array.isArray(rows) && rows.length ? rows[0].ics_url : null;
}
async function saveFeed(userId, icsUrl) {
  await fetch(SUPABASE_URL + '/rest/v1/calendar_feeds?on_conflict=user_id', {
    method: 'POST', headers: supaHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify({ user_id: userId, ics_url: icsUrl, updated_at: new Date().toISOString() }),
  });
}
async function deleteFeed(userId) {
  await fetch(SUPABASE_URL + '/rest/v1/calendar_feeds?user_id=eq.' + encodeURIComponent(userId), {
    method: 'DELETE', headers: supaHeaders({ Prefer: 'return=minimal' }),
  });
}
async function fetchIcs(url) {
  const r = await fetch(url, { headers: { Accept: 'text/calendar' } });
  if (!r.ok) throw new Error('ICS fetch ' + r.status);
  return r.text();
}

// ---- ICS parsing ----
function pad(n) { return (n < 10 ? '0' : '') + n; }
function unfold(text) { return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, ''); }

function parseDt(value, params) {
  if ((params && params.VALUE === 'DATE') || /^\d{8}$/.test(value)) {
    const y = +value.slice(0, 4), mo = +value.slice(4, 6), d = +value.slice(6, 8);
    return { allDay: true, floating: false, y, mo, d, hh: 0, mi: 0, ss: 0, ms: Date.UTC(y, mo - 1, d) };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(value);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3], hh = +m[4], mi = +m[5], ss = +m[6], utc = !!m[7];
  return { allDay: false, floating: !utc, y, mo, d, hh, mi, ss, ms: Date.UTC(y, mo - 1, d, hh, mi, ss) };
}
function fmtDt(dt) {
  if (dt.allDay) return dt.y + '-' + pad(dt.mo) + '-' + pad(dt.d);
  return dt.y + '-' + pad(dt.mo) + '-' + pad(dt.d) + 'T' + pad(dt.hh) + ':' + pad(dt.mi) + ':' + pad(dt.ss) + (dt.floating ? '' : 'Z');
}
function fmtInstant(ms, floating) {
  const d = new Date(ms);
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + 'T' +
    pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) + (floating ? '' : 'Z');
}
function shiftDays(dt, n) {
  const b = new Date(Date.UTC(dt.y, dt.mo - 1, dt.d, dt.hh, dt.mi, dt.ss));
  b.setUTCDate(b.getUTCDate() + n);
  const y = b.getUTCFullYear(), mo = b.getUTCMonth() + 1, d = b.getUTCDate();
  return { allDay: dt.allDay, floating: dt.floating, y, mo, d, hh: dt.hh, mi: dt.mi, ss: dt.ss, ms: Date.UTC(y, mo - 1, d, dt.hh, dt.mi, dt.ss) };
}

function parseIcs(text) {
  const lines = unfold(text).split('\n');
  const events = []; let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const ci = line.indexOf(':'); if (ci < 0) continue;
    const left = line.slice(0, ci), value = line.slice(ci + 1);
    const parts = left.split(';'); const name = parts[0].toUpperCase();
    const params = {};
    for (let p = 1; p < parts.length; p++) { const kv = parts[p].split('='); if (kv.length === 2) params[kv[0].toUpperCase()] = kv[1]; }
    if (name === 'SUMMARY') cur.summary = value;
    else if (name === 'UID') cur.uid = value;
    else if (name === 'DTSTART') cur.start = parseDt(value, params);
    else if (name === 'DTEND') cur.end = parseDt(value, params);
    else if (name === 'RRULE') cur.rrule = value;
  }
  return events.filter(e => e.start);
}

const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
function weekdayOf(dt) { return new Date(Date.UTC(dt.y, dt.mo - 1, dt.d)).getUTCDay(); }

function expandWindow(events, winStart, winEnd) {
  const out = [];
  for (const ev of events) {
    const s = ev.start; if (!s) continue;
    const durMs = ev.end ? Math.max(0, ev.end.ms - s.ms) : (s.allDay ? 86400000 : 3600000);
    let occ = [];
    if (!ev.rrule) {
      occ.push(s);
    } else {
      const r = {};
      ev.rrule.split(';').forEach(kv => { const x = kv.split('='); if (x.length === 2) r[x[0].toUpperCase()] = x[1]; });
      const freq = r.FREQ, interval = Math.max(1, parseInt(r.INTERVAL || '1', 10) || 1);
      const count = r.COUNT ? parseInt(r.COUNT, 10) : null;
      let untilMs = null;
      if (r.UNTIL) { const u = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?/.exec(r.UNTIL); if (u) untilMs = Date.UTC(+u[1], +u[2] - 1, +u[3], u[4] ? +u[4] : 23, u[5] ? +u[5] : 59, u[6] ? +u[6] : 59); }
      const byday = r.BYDAY ? r.BYDAY.split(',').map(x => WD[x.replace(/^[+-]?\d*/, '')]).filter(v => v != null) : null;
      if (freq !== 'DAILY' && freq !== 'WEEKLY') { occ.push(s); }
      else {
        const s0 = Date.UTC(s.y, s.mo - 1, s.d); let made = 0, cur = s, guard = 0;
        while (guard++ < 1500) {
          if (cur.ms > winEnd) break;
          if (untilMs != null && cur.ms > untilMs) break;
          const dd = Math.round((Date.UTC(cur.y, cur.mo - 1, cur.d) - s0) / 86400000);
          let include = false;
          if (freq === 'DAILY') include = (dd % interval === 0);
          else { const weekOk = (Math.floor(dd / 7) % interval === 0); const wd = weekdayOf(cur); include = weekOk && (byday ? byday.indexOf(wd) >= 0 : wd === weekdayOf(s)); }
          if (include) { made++; if (cur.ms + durMs >= winStart && cur.ms <= winEnd) occ.push(cur); if (count != null && made >= count) break; }
          cur = shiftDays(cur, 1);
        }
      }
    }
    for (const o of occ) {
      if (o.ms + durMs < winStart || o.ms > winEnd) continue;
      out.push({ title: ev.summary || '(busy)', allDay: !!o.allDay, start: fmtDt(o), end: o.allDay ? null : fmtInstant(o.ms + durMs, o.floating) });
    }
  }
  out.sort((a, b) => (a.start < b.start ? -1 : (a.start > b.start ? 1 : 0)));
  return out;
}

module.exports = {
  configError, bearerFrom, userIdFromJwt,
  getFeed, saveFeed, deleteFeed, fetchIcs,
  parseIcs, expandWindow,
};
```

- [ ] **Step 4: Run the test, verify it passes**
Run: `node /tmp/test-ics.js`
Expected: `ALL ICS TESTS PASS (...)`. If any assertion fails, fix `calendar-lib.js` until it passes.

- [ ] **Step 5: Syntax check + commit**
```bash
cd "/Users/connorshibley/Personal Dashboard1.0"
node --check lib/calendar-lib.js
git add lib/calendar-lib.js
git commit -m "calendar: zero-dep ICS fetch/parse/recurrence lib"
```
(Do not commit `/tmp/test-ics.js`.)

---

### Task 3: Endpoints — save / events / disconnect

**Files:** Create `api/calendar/save.js`, `api/calendar/events.js`, `api/calendar/disconnect.js`.

- [ ] **Step 1: Create `api/calendar/save.js`**
```js
const lib = require('../../lib/calendar-lib');
module.exports = async (req, res) => {
  const cfg = lib.configError(); if (cfg) { res.status(500).json({ error: cfg }); return; }
  const uid = await lib.userIdFromJwt(lib.bearerFrom(req));
  if (!uid) { res.status(401).json({ error: 'Not signed in' }); return; }
  let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const url = ((body && body.ics_url) || '').trim();
  if (!/^https:\/\//i.test(url) || !(/\.ics(\?|$)/i.test(url) || /ical/i.test(url))) {
    res.status(400).json({ error: "That doesn't look like an iCal URL" }); return;
  }
  try { await lib.saveFeed(uid, url); res.status(200).json({ ok: true }); }
  catch (e) { res.status(500).json({ error: 'Save failed' }); }
};
```

- [ ] **Step 2: Create `api/calendar/events.js`**
```js
const lib = require('../../lib/calendar-lib');
module.exports = async (req, res) => {
  const cfg = lib.configError(); if (cfg) { res.status(500).json({ error: cfg }); return; }
  const uid = await lib.userIdFromJwt(lib.bearerFrom(req));
  if (!uid) { res.status(401).json({ error: 'Not signed in' }); return; }
  try {
    const url = await lib.getFeed(uid);
    if (!url) { res.status(200).json({ connected: false }); return; }
    const text = await lib.fetchIcs(url);
    const now = Date.now();
    const events = lib.expandWindow(lib.parseIcs(text), now - 86400000, now + 2 * 86400000);
    res.status(200).json({ connected: true, events });
  } catch (e) { res.status(502).json({ error: 'Could not load calendar' }); }
};
```

- [ ] **Step 3: Create `api/calendar/disconnect.js`**
```js
const lib = require('../../lib/calendar-lib');
module.exports = async (req, res) => {
  const cfg = lib.configError(); if (cfg) { res.status(500).json({ error: cfg }); return; }
  const uid = await lib.userIdFromJwt(lib.bearerFrom(req));
  if (!uid) { res.status(401).json({ error: 'Not signed in' }); return; }
  try { await lib.deleteFeed(uid); res.status(200).json({ ok: true }); }
  catch (e) { res.status(500).json({ error: 'Disconnect failed' }); }
};
```

- [ ] **Step 4: Verify + commit**
```bash
cd "/Users/connorshibley/Personal Dashboard1.0"
for f in api/calendar/save.js api/calendar/events.js api/calendar/disconnect.js; do node --check "$f"; done
git add api/calendar
git commit -m "calendar: save/events/disconnect endpoints"
```
Expected: `node --check` prints nothing for all three.

---

### Task 4: "Today" calendar card in `health.html`

**Files:** Modify `/Users/connorshibley/Personal Dashboard1.0/health.html` (CSS in `<head>`, markup below the WHOOP section, a new `<script>` before `<script src="cloud-sync.js"></script>`).

- [ ] **Step 1: Add CSS** — insert immediately before `</head>`:
```html
<style>
  .cal-card { background: rgba(255,255,255,0.025); border: 1px solid var(--border-soft,transparent); border-radius: 22px; padding: 20px 22px 18px; box-shadow: 0 1px 0 0 rgba(255,255,255,0.06) inset, 0 12px 40px rgba(0,0,0,0.45); }
  .cal-head { display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; }
  .cal-eye { font-size:11px; font-weight:700; letter-spacing:0.18em; text-transform:uppercase; color:var(--text-tertiary); }
  .cal-actions { display:flex; gap:8px; }
  .cal-btn { width:30px; height:30px; border-radius:50%; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); color:var(--text-secondary); cursor:pointer; display:inline-flex; align-items:center; justify-content:center; }
  .cal-btn:hover { color:var(--text-primary); background:rgba(255,255,255,0.10); }
  .cal-row { display:flex; gap:12px; padding:10px 0; border-top:1px solid var(--border-soft,rgba(255,255,255,0.05)); }
  .cal-row:first-child { border-top:none; }
  .cal-time { width:74px; flex-shrink:0; font-family:var(--font-mono); font-size:12px; color:var(--text-secondary); font-variant-numeric:tabular-nums; }
  .cal-title { font-size:13.5px; color:var(--text-primary); font-weight:600; }
  .cal-dur { font-size:11px; color:var(--text-tertiary); margin-top:2px; }
  .cal-empty { color:var(--text-tertiary); font-size:13px; padding:8px 0; }
  .cal-connect { text-align:center; padding:8px 4px; }
  .cal-connect p { color:var(--text-tertiary); font-size:13px; margin:0 0 12px; }
  .cal-settings { display:none; margin-top:12px; }
  .cal-settings.open { display:block; }
  .cal-settings input { width:100%; box-sizing:border-box; background:rgba(0,0,0,0.28); border:1px solid rgba(255,255,255,0.10); border-radius:8px; color:var(--text-primary); font:inherit; font-size:12px; padding:9px 10px; margin-bottom:8px; font-family:var(--font-mono); }
  .cal-save { background:var(--accent,#1D9E75); color:#fff; border:none; border-radius:8px; padding:9px 16px; font:inherit; font-weight:600; font-size:12px; cursor:pointer; }
  .cal-err { background:rgba(255,107,107,0.08); border:1px solid rgba(255,107,107,0.28); color:#FF8A8A; padding:9px 11px; border-radius:9px; font-size:11.5px; margin-bottom:10px; }
  .cal-hint { font-size:11px; color:var(--text-tertiary); margin-top:6px; line-height:1.5; }
</style>
</head>
```
(Replace the existing `</head>` with the block above ending in `</head>`.)

- [ ] **Step 2: Add markup** — find `  <div class="section-title">Daily Stack</div>` and replace with:
```html
  <div class="section-title">Today</div>
  <div class="cal-card" id="calCard">
    <div class="cal-head">
      <span class="cal-eye">Calendar</span>
      <div class="cal-actions">
        <button id="calRefresh" class="cal-btn" type="button" aria-label="Refresh" style="display:none"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M20.49 15A9 9 0 1 1 5.64 5.64L23 10"/></svg></button>
        <button id="calGear" class="cal-btn" type="button" aria-label="Settings"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
      </div>
    </div>
    <div id="calErr" class="cal-err" style="display:none"></div>
    <div id="calBody"><div class="cal-empty">Loading…</div></div>
    <div id="calSettings" class="cal-settings">
      <input id="calUrl" type="text" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" autocomplete="off" spellcheck="false" />
      <button id="calSave" class="cal-save" type="button">Save</button>
      <div class="cal-hint">Google Calendar → Settings → your calendar → "Secret address in iCal format" → copy that URL here.</div>
    </div>
  </div>

  <div class="section-title">Daily Stack</div>
```

- [ ] **Step 3: Add the card script** — find `<script src="cloud-sync.js"></script>` and replace with:
```html
<script>
// Calendar (Today) card — reads /api/calendar/events; ICS URL stored server-side.
(function () {
  'use strict';
  var card = document.getElementById('calCard'); if (!card) return;
  var $ = function (id) { return document.getElementById(id); };
  function supa() { return window.__supa || null; }
  async function token() {
    try { var s = supa(); if (!s) return null; var r = await s.auth.getSession();
      return r && r.data && r.data.session ? r.data.session.access_token : null; } catch (e) { return null; }
  }
  function authH(t) { return { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }; }
  function showErr(m) { var e = $('calErr'); e.textContent = m || ''; e.style.display = m ? 'block' : 'none'; }
  function fmtTime(iso) {
    var d = (/Z$/.test(iso)) ? new Date(iso) : (function () {
      var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
      return m ? new Date(+m[1], +m[2]-1, +m[3], +m[4], +m[5]) : new Date(iso);
    })();
    var h = d.getHours(), mi = d.getMinutes(), ap = h < 12 ? 'AM' : 'PM', hh = h % 12 || 12;
    return hh + ':' + (mi < 10 ? '0' : '') + mi + ' ' + ap;
  }
  function localDay(iso) {
    if (!/T/.test(iso)) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso); return m ? new Date(+m[1], +m[2]-1, +m[3]) : null; }
    var d = (/Z$/.test(iso)) ? new Date(iso) : (function () {
      var p = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso); return new Date(+p[1], +p[2]-1, +p[3], +p[4], +p[5]);
    })();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }
  function isToday(iso) {
    var d = localDay(iso); if (!d) return false;
    var n = new Date(); var t0 = new Date(n.getFullYear(), n.getMonth(), n.getDate());
    return d.getTime() === t0.getTime();
  }
  function durLabel(s, e) {
    if (!e) return ''; var a = new Date(s.replace(/Z$/, '')), b = new Date(e.replace(/Z$/, ''));
    var mins = Math.round((b - a) / 60000); if (mins <= 0 || mins > 1440) return '';
    var h = Math.floor(mins / 60), m = mins % 60; return (h ? h + 'h ' : '') + (m ? m + 'm' : '').trim();
  }
  function renderEvents(events) {
    var today = (events || []).filter(function (e) { return e.allDay ? isToday(e.start) : isToday(e.start); });
    today.sort(function (a, b) { return (a.allDay ? 0 : 1) - (b.allDay ? 0 : 1) || (a.start < b.start ? -1 : 1); });
    $('calRefresh').style.display = '';
    if (!today.length) { $('calBody').innerHTML = '<div class="cal-empty">Nothing scheduled today.</div>'; return; }
    $('calBody').innerHTML = today.map(function (e) {
      var time = e.allDay ? 'All day' : fmtTime(e.start);
      var dur = e.allDay ? '' : durLabel(e.start, e.end);
      return '<div class="cal-row"><div class="cal-time">' + time + '</div><div><div class="cal-title">' +
        (e.title || '(busy)').replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }) +
        '</div>' + (dur ? '<div class="cal-dur">' + dur + '</div>' : '') + '</div></div>';
    }).join('');
  }
  function showConnect() { $('calRefresh').style.display = 'none'; $('calBody').innerHTML = '<div class="cal-connect"><p>Connect your Google Calendar to see today\'s schedule.</p></div>'; $('calSettings').classList.add('open'); }
  async function load() {
    var t = await token(); if (!t) { $('calBody').innerHTML = '<div class="cal-empty">Sign in to see your calendar.</div>'; return; }
    showErr('');
    try {
      var r = await fetch('/api/calendar/events', { headers: authH(t) });
      var j = await r.json();
      if (!r.ok) { showErr(j.error || 'Calendar error'); return; }
      if (!j.connected) { showConnect(); return; }
      $('calSettings').classList.remove('open');
      renderEvents(j.events || []);
    } catch (e) { showErr('Network error loading calendar'); }
  }
  $('calGear').addEventListener('click', function () { $('calSettings').classList.toggle('open'); });
  $('calRefresh').addEventListener('click', load);
  $('calSave').addEventListener('click', async function () {
    var url = ($('calUrl').value || '').trim(); if (!url) return;
    var btn = $('calSave'); btn.disabled = true; btn.textContent = 'Saving…';
    var t = await token();
    try {
      var r = await fetch('/api/calendar/save', { method: 'POST', headers: authH(t), body: JSON.stringify({ ics_url: url }) });
      var j = await r.json();
      if (!r.ok) { showErr(j.error || 'Save failed'); }
      else { showErr(''); $('calUrl').value = ''; await load(); }
    } catch (e) { showErr('Save failed'); }
    finally { btn.disabled = false; btn.textContent = 'Save'; }
  });
  var tries = 0;
  (function boot() { if (supa()) { load(); return; } if (tries++ > 100) { $('calBody').innerHTML = '<div class="cal-empty">Calendar unavailable.</div>'; return; } setTimeout(boot, 100); })();
})();
</script>

<script src="cloud-sync.js"></script>
```

- [ ] **Step 4: Verify** — inline-script parser MUST print `OK 5 scripts`:
```bash
cd "/Users/connorshibley/Personal Dashboard1.0"
node -e "const fs=require('fs');const h=fs.readFileSync('health.html','utf8');let i=0;for(const m of h.matchAll(/<script>([\s\S]*?)<\/script>/g)){i++;try{new Function(m[1])}catch(e){console.log('SCRIPT '+i+' ERR:',e.message);process.exit(1)}}console.log('OK '+i+' scripts')"
```
Expected: `OK 5 scripts`.

- [ ] **Step 5: Commit**
```bash
cd "/Users/connorshibley/Personal Dashboard1.0"
git add health.html
git commit -m "calendar: Today card on health.html (connect, events, refresh)"
```

---

### Task 5: Deploy + end-to-end verification

**Files:** none.

- [ ] **Step 1: Final syntax pass**
```bash
cd "/Users/connorshibley/Personal Dashboard1.0"
node --check lib/calendar-lib.js && for f in api/calendar/*.js; do node --check "$f"; done && \
node -e "const fs=require('fs');const h=fs.readFileSync('health.html','utf8');let i=0;for(const m of h.matchAll(/<script>([\s\S]*?)<\/script>/g)){i++;try{new Function(m[1])}catch(e){console.log('ERR',i,e.message);process.exit(1)}}console.log('OK',i)"
```
Expected: `OK 5`.

- [ ] **Step 2: Push + deploy**
```bash
cd "/Users/connorshibley/Personal Dashboard1.0"
git push && vercel --prod --yes 2>&1 | grep -iE "Production|ready|Error" | tail -3
```

- [ ] **Step 3: Verify endpoint auth** (no token → 401)
```bash
curl -s https://row-pied.vercel.app/api/calendar/events
```
Expected: `{"error":"Not signed in"}`.

- [ ] **Step 4: Confirm the URL never leaks to clients** — SQL:
```sql
select count(*) from pg_policy p where p.polrelid = 'public.calendar_feeds'::regclass;
```
Expected: `0` (no client-readable policies; only the service role reads `ics_url`).

- [ ] **Step 5: Browser check (user)** — open `row-pied.vercel.app/health.html` (hard refresh), open the calendar ⚙, paste the Google secret-iCal URL, Save. Confirm today's events render (or "Nothing scheduled today" if empty). Toggle refresh.

---

## Self-Review

**Spec coverage:** `calendar_feeds` server-only table (T1) ✓ · `lib/calendar-lib.js` fetch/parse/expand (T2) ✓ · save/events/disconnect endpoints (T3) ✓ · Today card below WHOOP with paste-URL connect + timeline + refresh + (disconnect via re-saving / gear) ✓ · timezone filtered client-side (`isToday`/`localDay`) ✓ · ICS URL never returned to client (T4 reads only events; T5 Step 4 confirms 0 policies) ✓ · recurrence daily/weekly (T2 test) ✓ · empty/error states ✓.

**Note on Disconnect:** The card UI exposes connect (save) + refresh + gear; a Disconnect button was specced. The `disconnect` endpoint exists (T3). If the user wants a visible Disconnect control, add a small button in the gear panel calling `/api/calendar/disconnect` — kept out of the minimal card to avoid clutter, endpoint is ready. (Acceptable scope trim; flag to user.)

**Placeholder scan:** none — all steps have concrete code/commands.

**Type/name consistency:** lib exports (`configError`, `bearerFrom`, `userIdFromJwt`, `getFeed`, `saveFeed`, `deleteFeed`, `fetchIcs`, `parseIcs`, `expandWindow`) match every endpoint's usage ✓; client IDs (`calCard`, `calRefresh`, `calGear`, `calErr`, `calBody`, `calSettings`, `calUrl`, `calSave`) defined in markup (T4 S2) and referenced in script (T4 S3) ✓; endpoints return `{connected, events}` / `{error}` shapes the client handles ✓; event object `{title, allDay, start, end}` consistent between `expandWindow` (T2) and `renderEvents` (T4) ✓.
