# Daily Coach (AI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An AI "Daily Coach" card that fuses WHOOP recovery + today's calendar + the gym day into a verdict, per-event guidance, and a workout note, via a Claude-backed serverless endpoint.

**Architecture:** `/api/coach.js` (auth-gated, config-gated) calls Claude `claude-haiku-4-5-20251001` with a compact context and returns structured JSON; a card at the top of `health.html` gathers the context, calls the endpoint at most once/day (localStorage date cache), and renders it.

**Tech Stack:** Vanilla JS, Vercel serverless (Node, global `fetch`), Anthropic Messages API, `window.__supa`.

**Spec:** `docs/superpowers/specs/2026-06-06-daily-coach-design.md`

**Note on cache:** spec mentioned `app_state('coach')` for cross-device cache; this plan uses a **localStorage date cache** instead — simpler, no RLS write dependency, and still caps cost to ~1 call/day/device (negligible). Cross-device cache can be a later enhancement.

**Testing note:** No unit-test runner. The endpoint is verified by `node --check` + a live `curl` auth-gate check (the key itself was already smoke-tested OK). The card is verified by the inline-`<script>` parser + a browser check.

---

### Task 1: `/api/coach.js` endpoint

**Files:** Create `/Users/connorshibley/Personal Dashboard1.0/api/coach.js`

- [ ] **Step 1: Write the endpoint**
```js
// /api/coach.js — AI daily coach. Auth-gated (Supabase JWT) + config-gated (ANTHROPIC_API_KEY).
// Sends a compact recovery+calendar+workout context to Claude; returns structured JSON.
'use strict';

const SUPABASE_URL  = process.env.SUPABASE_URL || 'https://ygeeeplqpudlodoquwly.supabase.co';
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = 'claude-haiku-4-5-20251001';

function bearerFrom(req) {
  const h = req.headers.authorization || req.headers.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h); return m ? m[1] : null;
}
async function userIdFromJwt(jwt) {
  if (!jwt) return null;
  try {
    const r = await fetch(SUPABASE_URL + '/auth/v1/user', { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + jwt } });
    if (!r.ok) return null;
    const u = await r.json(); return u && u.id ? u.id : null;
  } catch { return null; }
}

const SYSTEM = [
  'You are a sharp, evidence-based strength & conditioning coach for one athlete.',
  'You receive a JSON context with: recovery (WHOOP recovery score 0-100, hrv_ms, rhr, sleep_perf, day_strain), today\'s calendar events, and the athlete\'s prescribed gym day + program week.',
  'Give a practical daily plan. Be specific and concise; no fluff, no medical claims.',
  'Recovery guide: >=67 green (push hard), 34-66 yellow (moderate, train smart), <34 red (prioritize recovery).',
  'Respond with ONLY valid minified JSON (no markdown, no prose) matching exactly:',
  '{"verdict":{"level":"green|yellow|red","headline":"<=90 chars","reasons":["short bullet",...]},"events":[{"title":"event title","guidance":"how hard / how to approach it"}],"workout":{"note":"load/intensity guidance for the prescribed session given recovery; empty string if no workout"}}',
  'Include an events[] entry for each provided calendar event (omit if none). Keep reasons to 2-4 bullets. If recovery data is missing, say so and give general guidance.',
].join(' ');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }
  if (!ANTHROPIC_KEY) { res.status(200).json({ configured: false }); return; }
  const uid = await userIdFromJwt(bearerFrom(req));
  if (!uid) { res.status(401).json({ error: 'Not signed in' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const ctx = (body && body.context) || body || {};

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 800,
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: "Today's context (JSON):\n" + JSON.stringify(ctx) + "\n\nReturn the JSON plan." }],
      }),
    });
    if (!r.ok) { res.status(502).json({ error: 'coach upstream ' + r.status }); return; }
    const j = await r.json();
    const text = (j.content && j.content[0] && j.content[0].text) || '';
    let coach;
    try { coach = JSON.parse(text); }
    catch {
      const m = text.match(/\{[\s\S]*\}/);
      try { coach = JSON.parse(m[0]); }
      catch { coach = { verdict: { level: 'yellow', headline: 'Coach', reasons: [String(text).slice(0, 300)] }, events: [], workout: { note: '' } }; }
    }
    res.status(200).json({ configured: true, coach });
  } catch (e) {
    res.status(502).json({ error: 'coach failed' });
  }
};
```

- [ ] **Step 2: Syntax check**
Run: `node --check api/coach.js`
Expected: no output.

- [ ] **Step 3: Commit**
```bash
cd "/Users/connorshibley/Personal Dashboard1.0"
git add api/coach.js
git commit -m "coach: /api/coach AI endpoint (Claude Haiku 4.5, auth+config gated)"
```

---

### Task 2: Daily Coach card in `health.html`

**Files:** Modify `/Users/connorshibley/Personal Dashboard1.0/health.html` (CSS before `</head>`, markup as the FIRST child of `<main>`, a new `<script>` before `<script src="cloud-sync.js"></script>`).

- [ ] **Step 1: Add CSS** — insert before `</head>`:
```html
<style>
  .coach-card { background: linear-gradient(180deg, rgba(224,118,88,0.06), rgba(255,255,255,0.025)); border: 1px solid var(--border-soft,transparent); border-radius: 22px; padding: 20px 22px 18px; box-shadow: 0 1px 0 0 rgba(255,255,255,0.06) inset, 0 12px 40px rgba(0,0,0,0.45); margin-bottom: 28px; }
  .coach-head { display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; }
  .coach-eye { font-size:11px; font-weight:700; letter-spacing:0.18em; text-transform:uppercase; color:var(--text-tertiary); }
  .coach-refresh { width:30px; height:30px; border-radius:50%; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); color:var(--text-secondary); cursor:pointer; display:inline-flex; align-items:center; justify-content:center; }
  .coach-refresh:hover { color:var(--text-primary); background:rgba(255,255,255,0.10); }
  .coach-verdict { display:flex; align-items:center; gap:10px; margin-bottom:8px; }
  .coach-dot { width:12px; height:12px; border-radius:50%; flex-shrink:0; }
  .coach-dot.green { background:#6BE3A4; box-shadow:0 0 10px rgba(107,227,164,0.6);} .coach-dot.yellow{background:#F2C063;box-shadow:0 0 10px rgba(242,192,99,0.6);} .coach-dot.red{background:#FF8A8A;box-shadow:0 0 10px rgba(255,138,138,0.6);}
  .coach-headline { font-size:16px; font-weight:700; color:var(--text-primary); line-height:1.35; }
  .coach-reasons { font-size:12.5px; color:var(--text-secondary); line-height:1.6; margin:6px 0 0; padding-left:16px; }
  .coach-section-t { font-size:10px; font-weight:700; letter-spacing:0.14em; text-transform:uppercase; color:var(--text-tertiary); margin:16px 0 8px; }
  .coach-evt { display:flex; gap:10px; padding:8px 0; border-top:1px solid var(--border-soft,rgba(255,255,255,0.05)); }
  .coach-evt:first-of-type { border-top:none; }
  .coach-evt-title { font-weight:600; color:var(--text-primary); font-size:13px; min-width:120px; flex-shrink:0; }
  .coach-evt-guide { font-size:12.5px; color:var(--text-secondary); line-height:1.5; }
  .coach-workout { margin-top:14px; padding:12px 14px; background:rgba(255,255,255,0.025); border-left:2px solid var(--accent,#E07658); border-radius:0 10px 10px 0; font-size:13px; color:var(--text-secondary); line-height:1.5; }
  .coach-muted { color:var(--text-tertiary); font-size:13px; }
  .coach-setup { font-size:12.5px; color:var(--text-tertiary); line-height:1.6; }
  .coach-setup code { background:rgba(255,255,255,0.06); padding:1px 6px; border-radius:4px; font-family:var(--font-mono); font-size:11.5px; }
</style>
</head>
```
(Replace the existing `</head>` with the block above ending in `</head>`.)

- [ ] **Step 2: Add markup** — find `<main>` and make the coach card its first child. Replace the line `<main>` with:
```html
<main>
  <div class="section-title">Daily Coach</div>
  <div class="coach-card" id="coachCard">
    <div class="coach-head">
      <span class="coach-eye">AI · today</span>
      <button id="coachRefresh" class="coach-refresh" type="button" aria-label="Refresh" title="Refresh"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M20.49 15A9 9 0 1 1 5.64 5.64L23 10"/></svg></button>
    </div>
    <div id="coachBody"><div class="coach-muted">Loading…</div></div>
  </div>
```

- [ ] **Step 3: Add the card script** — find `<script src="cloud-sync.js"></script>` and replace it with:
```html
<script>
// Daily Coach card — gathers recovery+calendar+workout, calls /api/coach (Claude),
// renders verdict + per-event guidance + workout note. Cached once/day in localStorage.
(function () {
  'use strict';
  var card = document.getElementById('coachCard'); if (!card) return;
  var $ = function (id) { return document.getElementById(id); };
  var CACHE_KEY = 'coach_cache_v1';
  function supa() { return window.__supa || null; }
  function todayKey() { var d = new Date(); return d.getFullYear() + '-' + (d.getMonth()+1) + '-' + d.getDate(); }
  async function token() {
    try { var s = supa(); if (!s) return null; var r = await s.auth.getSession();
      return r && r.data && r.data.session ? r.data.session.access_token : null; } catch (e) { return null; }
  }
  function esc(s){ return String(s==null?'':s).replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];}); }

  async function gatherContext(t) {
    var ctx = { recovery: null, events: [], workout: null };
    // recovery from app_state.whoop
    try {
      var s = supa();
      if (s) {
        var r = await s.from('app_state').select('data').eq('key','whoop').maybeSingle();
        if (r && r.data && r.data.data) {
          var w = r.data.data;
          ctx.recovery = {
            score: w.recovery && w.recovery.score, hrv_ms: w.recovery && w.recovery.hrv_ms,
            rhr: w.recovery && w.recovery.rhr, sleep_perf: w.sleep && w.sleep.performance,
            day_strain: w.strain && w.strain.day_strain,
          };
        }
      }
    } catch (e) {}
    // today's events
    try {
      var er = await fetch('/api/calendar/events', { headers: { Authorization: 'Bearer ' + t } });
      var ej = await er.json();
      if (ej && ej.connected && ej.events) {
        var now = new Date(); var t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        var t1 = t0 + 86400000;
        ctx.events = ej.events.filter(function (e) {
          var d = /Z$/.test(e.start) ? new Date(e.start) : new Date(e.start.replace('Z',''));
          var ms = d.getTime(); return ms >= t0 - 6*3600000 && ms < t1;
        }).map(function (e) { return { title: e.title, start: e.start, allDay: !!e.allDay }; });
      }
    } catch (e) {}
    // workout day + week from po_coach_v1
    try {
      var raw = localStorage.getItem('po_coach_v1');
      if (raw) {
        var st = JSON.parse(raw);
        var dayId = st.filterDay, day = (st.days || []).find(function (d) { return d.id === dayId; });
        ctx.workout = { dayName: day ? day.name : null, week: st.programWeek || 1 };
      }
    } catch (e) {}
    return ctx;
  }

  function renderCoach(c) {
    if (!c || !c.verdict) { $('coachBody').innerHTML = '<div class="coach-muted">No plan yet — tap refresh.</div>'; return; }
    var v = c.verdict, lvl = (v.level === 'green' || v.level === 'red') ? v.level : 'yellow';
    var html = '<div class="coach-verdict"><span class="coach-dot ' + lvl + '"></span><span class="coach-headline">' + esc(v.headline) + '</span></div>';
    if (v.reasons && v.reasons.length) html += '<ul class="coach-reasons">' + v.reasons.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>';
    if (c.events && c.events.length) {
      html += '<div class="coach-section-t">Today\'s events</div>';
      html += c.events.map(function (e) { return '<div class="coach-evt"><div class="coach-evt-title">' + esc(e.title) + '</div><div class="coach-evt-guide">' + esc(e.guidance) + '</div></div>'; }).join('');
    }
    if (c.workout && c.workout.note) html += '<div class="coach-workout"><b>Today\'s session:</b> ' + esc(c.workout.note) + '</div>';
    $('coachBody').innerHTML = html;
  }

  function showSetup() {
    $('coachBody').innerHTML = '<div class="coach-setup">AI coach not configured. Add an <code>ANTHROPIC_API_KEY</code> to Vercel env to enable it.</div>';
  }

  async function load(force) {
    if (!force) {
      try { var cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
        if (cached && cached.date === todayKey() && cached.coach) { renderCoach(cached.coach); return; }
      } catch (e) {}
    }
    var t = await token();
    if (!t) { $('coachBody').innerHTML = '<div class="coach-muted">Sign in to get your daily plan.</div>'; return; }
    $('coachBody').innerHTML = '<div class="coach-muted">Thinking…</div>';
    try {
      var ctx = await gatherContext(t);
      var r = await fetch('/api/coach', { method: 'POST', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: JSON.stringify({ context: ctx }) });
      var j = await r.json();
      if (j.configured === false) { showSetup(); return; }
      if (!r.ok || !j.coach) { $('coachBody').innerHTML = '<div class="coach-muted">Coach unavailable — try refresh.</div>'; return; }
      renderCoach(j.coach);
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ date: todayKey(), coach: j.coach })); } catch (e) {}
    } catch (e) {
      $('coachBody').innerHTML = '<div class="coach-muted">Coach error — try refresh.</div>';
    }
  }

  $('coachRefresh').addEventListener('click', function () { load(true); });
  var tries = 0;
  (function boot() { if (supa()) { load(false); return; } if (tries++ > 100) { $('coachBody').innerHTML = '<div class="coach-muted">Coach unavailable (offline).</div>'; return; } setTimeout(boot, 100); })();
})();
</script>

<script src="cloud-sync.js"></script>
```

- [ ] **Step 4: Verify** — inline-script parser MUST print `OK 6 scripts`:
```bash
cd "/Users/connorshibley/Personal Dashboard1.0"
node -e "const fs=require('fs');const h=fs.readFileSync('health.html','utf8');let i=0;for(const m of h.matchAll(/<script>([\s\S]*?)<\/script>/g)){i++;try{new Function(m[1])}catch(e){console.log('SCRIPT '+i+' ERR:',e.message);process.exit(1)}}console.log('OK '+i+' scripts')"
```
Expected: `OK 6 scripts`. Also confirm `coachCard`, `coachBody`, `coachRefresh` each appear once.

- [ ] **Step 5: Commit**
```bash
git add health.html
git commit -m "coach: Daily Coach card on health.html (verdict + per-event + workout note)"
```

---

### Task 3: Deploy + verify

**Files:** none.

- [ ] **Step 1: Final syntax pass**
```bash
cd "/Users/connorshibley/Personal Dashboard1.0"
node --check api/coach.js && node -e "const fs=require('fs');const h=fs.readFileSync('health.html','utf8');let i=0;for(const m of h.matchAll(/<script>([\s\S]*?)<\/script>/g)){i++;try{new Function(m[1])}catch(e){console.log('ERR',i,e.message);process.exit(1)}}console.log('OK',i)"
```
Expected: `OK 6`.

- [ ] **Step 2: Push + deploy**
```bash
git push && vercel --prod --yes 2>&1 | grep -iE "Production|ready|Error" | tail -3
```

- [ ] **Step 3: Verify endpoint config + auth gate** (ANTHROPIC_API_KEY is already set in Vercel, so config passes and auth should fail without a token):
```bash
curl -s -X POST https://row-pied.vercel.app/api/coach -H "Content-Type: application/json" -d '{}'
```
Expected: `{"error":"Not signed in"}` (proves it's deployed, configured, and auth-gated — NOT `{"configured":false}`).

- [ ] **Step 4: Browser check (user).** Open `row-pied.vercel.app/health.html` (hard refresh). The Daily Coach card at the top should show a verdict + reasons, per-event guidance for today's calendar events, and a workout note. Tap refresh to force a new plan.

---

## Self-Review

**Spec coverage:** `/api/coach` auth+config gated, Claude Haiku 4.5, structured JSON (Task 1) ✓ · verdict + per-event + workout note (Task 1 schema + Task 2 render) ✓ · card top of health.html gathering recovery+calendar+workout (Task 2 gatherContext) ✓ · once/day cache + refresh (Task 2 load/CACHE_KEY) ✓ · key server-only, not-configured/error/no-data states (Task 1 + Task 2) ✓. **Deviation:** cache is localStorage (date-keyed), not `app_state('coach')` — noted at top; same cost-control outcome.

**Placeholder scan:** none — complete code in every step.

**Type/name consistency:** endpoint returns `{configured, coach:{verdict:{level,headline,reasons},events:[{title,guidance}],workout:{note}}}` — consumed exactly by `renderCoach` (Task 2) ✓; `gatherContext` builds `{recovery,events,workout:{dayName,week}}` posted as `{context}` and read server-side as `body.context` ✓; IDs `coachCard`/`coachBody`/`coachRefresh` defined in markup (T2 S2) and used in script (T2 S3) ✓; model `claude-haiku-4-5-20251001` matches the verified spec ✓.
