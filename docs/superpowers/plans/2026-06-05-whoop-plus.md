# WHOOP+ Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the live WHOOP card with a bedtime coach, deeper sleep metrics, 30-day trend sparklines, and a labeled fitness-age proxy — all from existing data + formulas, no AI.

**Architecture:** Server (`lib/whoop-lib.js`) captures more sleep fields and writes a daily row to a new `whoop_history` table on each sync; the client card (`health.html`) reads today's `app_state.whoop` for bedtime / sleep-detail / fitness-age and reads `whoop_history` for sparklines. A ⚙ panel stores two synced settings (wake time, age).

**Tech Stack:** Vanilla JS, Supabase (Postgres + PostgREST + RLS), Vercel serverless (Node), `window.__supa` client.

**Spec:** `docs/superpowers/specs/2026-06-05-whoop-plus-design.md`

**Testing note:** This repo has no unit-test runner. Verification uses the project's established tools: `node --check` (functions), an inline-`<script>` parser (health.html), Supabase SQL, `curl`, and a browser check. Each task ends with the appropriate verification.

---

### Task 1: Create `whoop_history` table + RLS

**Files:** Supabase migration (via MCP `apply_migration`), project `ygeeeplqpudlodoquwly`.

- [ ] **Step 1: Apply the migration**

Apply migration name `create_whoop_history` with:

```sql
create table if not exists public.whoop_history (
  user_id    uuid not null references auth.users(id) on delete cascade,
  day        date not null,
  recovery   int,
  hrv        int,
  rhr        int,
  strain     numeric,
  sleep_perf int,
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);
alter table public.whoop_history enable row level security;
revoke all on public.whoop_history from anon, authenticated;
grant select on public.whoop_history to authenticated;
drop policy if exists "own history select" on public.whoop_history;
create policy "own history select" on public.whoop_history
  for select to authenticated using (auth.uid() = user_id);
```

- [ ] **Step 2: Verify table + RLS**

Run SQL:
```sql
select c.relrowsecurity,
  (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
from pg_class c where c.oid = 'public.whoop_history'::regclass;
```
Expected: `relrowsecurity = true`, `policies = 1`.

---

### Task 2: Capture deeper sleep fields in `buildSummary`

**Files:** Modify `lib/whoop-lib.js` (the `out.sleep = { ... }` object inside `buildSummary`).

- [ ] **Step 1: Replace the sleep object**

Find:
```js
      out.sleep = {
        performance: num(s.sleep_performance_percentage),
        asleep_hours: msToHours(asleepMs),
        needed_hours: neededMs > 0 ? msToHours(neededMs) : null,
        resp_rate: num(s.respiratory_rate),
        stages,
        at: slp.end || slp.start || null,
      };
```
Replace with:
```js
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
        at: slp.end || slp.start || null,
      };
```
(`need` and `ss` are already in scope in this block.)

- [ ] **Step 2: Verify**

Run: `node --check lib/whoop-lib.js`
Expected: no output (exit 0).

---

### Task 3: Write a daily `whoop_history` row on each sync

**Files:** Modify `lib/whoop-lib.js` (add `upsertHistory`, call it from `syncAccount`).

- [ ] **Step 1: Add `upsertHistory` helper** (place right after the existing `upsertAppState` function)

```js
async function upsertHistory(userId, point) {
  await fetch(SUPABASE_URL + '/rest/v1/whoop_history?on_conflict=user_id,day', {
    method: 'POST',
    headers: supaHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(Object.assign(
      { user_id: userId, updated_at: new Date().toISOString() }, point)),
  });
}
```

- [ ] **Step 2: Call it from `syncAccount`**

Find:
```js
async function syncAccount(acct) {
  const accessToken = await ensureAccessToken(acct);
  const summary = await buildSummary(accessToken);
  await upsertAppState(acct.user_id, summary);
  return summary;
}
```
Replace with:
```js
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
```

- [ ] **Step 3: Verify**

Run: `node --check lib/whoop-lib.js`
Expected: no output (exit 0).

---

### Task 4: Settings panel (⚙) — wake time + age, synced

**Files:** Modify `health.html` (CSS block, card header markup, card script, CLOUD_SYNC keys).

- [ ] **Step 1: Add CSS** (append inside the WHOOP `<style>` block, before its closing `</style>` — i.e. right after the `.wh-err { ... }` rule)

```css
    /* WHOOP+ additions */
    .wh-gear { width:32px; height:32px; border-radius:50%; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.06); color:var(--text-secondary); cursor:pointer; display:flex; align-items:center; justify-content:center; }
    .wh-gear:hover { background:rgba(255,255,255,0.10); color:var(--text-primary); }
    .wh-settings { display:none; gap:12px; margin-bottom:16px; padding:14px; background:rgba(255,255,255,0.025); border:1px solid var(--border-soft); border-radius:12px; flex-wrap:wrap; }
    .wh-settings.open { display:flex; }
    .wh-settings label { font-size:10px; letter-spacing:0.12em; text-transform:uppercase; color:var(--text-tertiary); font-weight:700; display:block; margin-bottom:5px; }
    .wh-settings input { background:var(--bg-input,rgba(0,0,0,0.28)); border:1px solid rgba(255,255,255,0.10); border-radius:8px; color:var(--text-primary); font:inherit; font-size:13px; padding:7px 9px; width:120px; }
    .wh-bedtime { margin:0 auto 22px; text-align:center; font-size:13.5px; color:var(--text-secondary); }
    .wh-bedtime b { color:var(--text-primary); font-weight:700; }
    .wh-fitage { margin-top:12px; text-align:center; padding:14px; background:rgba(255,255,255,0.025); border:1px solid var(--border-soft); border-radius:12px; }
    .wh-fitage-num { font-size:30px; font-weight:700; color:var(--text-primary); line-height:1; font-variant-numeric:tabular-nums; }
    .wh-fitage-cap { font-size:10px; color:var(--text-tertiary); margin-top:6px; letter-spacing:0.04em; }
    .wh-trends { margin-top:18px; padding-top:18px; border-top:1px solid var(--border-soft); }
    .wh-trends-eye { font-size:10px; font-weight:700; letter-spacing:0.18em; text-transform:uppercase; color:var(--text-tertiary); margin-bottom:10px; display:block; }
    .wh-spark-grid { display:grid; grid-template-columns:repeat(2,1fr); gap:8px; }
    .wh-spark { background:rgba(255,255,255,0.025); border:1px solid var(--border-soft); border-radius:12px; padding:10px 12px; }
    .wh-spark-head { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:4px; }
    .wh-spark-label { font-size:10px; color:var(--text-tertiary); text-transform:uppercase; letter-spacing:0.12em; font-weight:700; }
    .wh-spark-val { font-size:13px; font-weight:700; color:var(--text-primary); font-variant-numeric:tabular-nums; }
    .wh-spark-val .d-up { color:#6BE3A4; } .wh-spark-val .d-dn { color:#FF8A8A; }
    .wh-spark svg { display:block; width:100%; height:28px; }
    .wh-collecting { font-size:11px; color:var(--text-tertiary); }
```

- [ ] **Step 2: Add the gear button** to the header. Find:
```html
            <button id="whRefresh" class="wh-refresh" type="button" aria-label="Refresh"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M20.49 15A9 9 0 1 1 5.64 5.64L23 10"/></svg></button>
```
Replace with (same line + a gear button after it):
```html
            <button id="whRefresh" class="wh-refresh" type="button" aria-label="Refresh"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M20.49 15A9 9 0 1 1 5.64 5.64L23 10"/></svg></button>
            <button id="whGear" class="wh-gear" type="button" aria-label="Settings"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
```

- [ ] **Step 3: Add the settings panel markup** directly after the `<div id="whErr" class="wh-err" style="display:none"></div>` line:
```html
        <div id="whSettings" class="wh-settings">
          <div><label>Wake time</label><input id="whWake" type="time" /></div>
          <div><label>Age</label><input id="whAge" type="number" min="10" max="100" placeholder="e.g. 22" /></div>
        </div>
```

- [ ] **Step 4: Add settings JS** inside the card IIFE, right after the `function showErr(...)` line:
```js
  function getWake() { return localStorage.getItem('whoop_wake_time') || '07:00'; }
  function getAge() { var a = parseInt(localStorage.getItem('whoop_age'), 10); return isFinite(a) && a > 0 ? a : null; }
  (function wireSettings() {
    var gear = $('whGear'), panel = $('whSettings'), wake = $('whWake'), age = $('whAge');
    if (!gear) return;
    wake.value = getWake(); if (getAge() != null) age.value = String(getAge());
    gear.addEventListener('click', function () { panel.classList.toggle('open'); });
    wake.addEventListener('change', function () { localStorage.setItem('whoop_wake_time', wake.value || '07:00'); loadAndRender(); });
    age.addEventListener('change', function () { localStorage.setItem('whoop_age', String(parseInt(age.value, 10) || '')); loadAndRender(); });
  })();
```

- [ ] **Step 5: Sync the settings** — find the CLOUD_SYNC config:
```js
  window.CLOUD_SYNC = {
    appKey: 'health-stack',
    keys: [],
    prefixes: ['stack:'],
  };
```
Replace `keys: [],` with:
```js
    keys: ['whoop_wake_time', 'whoop_age'],
```

- [ ] **Step 6: Verify** — Run the inline-script parser:
```bash
node -e "const fs=require('fs');const h=fs.readFileSync('health.html','utf8');let i=0;for(const m of h.matchAll(/<script>([\s\S]*?)<\/script>/g)){i++;try{new Function(m[1])}catch(e){console.log('SCRIPT '+i+' ERR:',e.message);process.exit(1)}}console.log('OK '+i+' scripts')"
```
Expected: `OK 4 scripts`.

---

### Task 5: Bedtime coach

**Files:** Modify `health.html` (markup after the ring, render logic in the card script).

- [ ] **Step 1: Add the bedtime line** directly after the `.wh-ring-wrap` closing `</div>` (the `</div>` that closes the block containing `id="whRingFill"`), before `<div id="whStages"`:
```html
        <div id="whBedtime" class="wh-bedtime" style="display:none"></div>
```

- [ ] **Step 2: Add bedtime helpers** inside the IIFE (after `getAge`):
```js
  function fmtClockMin(mins) {
    mins = ((Math.round(mins) % 1440) + 1440) % 1440;
    var h = Math.floor(mins / 60), m = mins % 60, ap = h < 12 ? 'AM' : 'PM', hh = h % 12 || 12;
    return hh + ':' + String(m).padStart(2, '0') + ' ' + ap;
  }
  function renderBedtime(d) {
    var el = $('whBedtime'); var slp = d.sleep || {};
    if (slp.needed_hours == null) { el.style.display = 'none'; return; }
    var eff = (slp.efficiency != null ? slp.efficiency : 90) / 100; if (eff <= 0) eff = 0.9;
    var wake = getWake(); var p = wake.split(':');
    var wakeMin = (parseInt(p[0], 10) || 7) * 60 + (parseInt(p[1], 10) || 0);
    var inBedMin = (slp.needed_hours / eff) * 60;
    var bedMin = wakeMin - inBedMin - 15;
    el.style.display = '';
    el.innerHTML = 'Go to bed by <b>' + fmtClockMin(bedMin) + '</b> · needs ' +
      slp.needed_hours.toFixed(1) + 'h · wake ' + fmtClockMin(wakeMin);
  }
```

- [ ] **Step 3: Call it** — inside `function renderData(d)`, add `renderBedtime(d);` immediately before the final line `$('whUpdated').textContent = relTime(d.updated_at);`.

- [ ] **Step 4: Verify** — run the inline-script parser from Task 4 Step 6. Expected: `OK 4 scripts`.

---

### Task 6: Deeper sleep-detail tiles

**Files:** Modify `health.html` (markup after the stats grid, render logic).

- [ ] **Step 1: Add the tiles** directly after the `<div id="whBio" ...>...</div>` block's closing `</div>` (the biomarker block), before `<div class="wh-legend">`:
```html
        <div id="whSleepDetail" class="wh-bio" style="display:none">
          <div class="wh-bio-item"><span class="wh-bio-label">Efficiency</span><span class="wh-bio-val" id="whEff">—</span></div>
          <div class="wh-bio-item"><span class="wh-bio-label">Consistency</span><span class="wh-bio-val" id="whCons">—</span></div>
          <div class="wh-bio-item"><span class="wh-bio-label">Sleep debt</span><span class="wh-bio-val" id="whDebt">—</span></div>
        </div>
```

- [ ] **Step 2: Add render helper** inside the IIFE (after `renderBedtime`):
```js
  function renderSleepDetail(d) {
    var slp = d.sleep || {}, box = $('whSleepDetail');
    var has = slp.efficiency != null || slp.consistency != null || slp.debt_hours != null;
    if (!has) { box.style.display = 'none'; return; }
    box.style.display = '';
    $('whEff').textContent = slp.efficiency != null ? Math.round(slp.efficiency) + '%' : '—';
    $('whCons').textContent = slp.consistency != null ? Math.round(slp.consistency) + '%' : '—';
    $('whDebt').textContent = slp.debt_hours != null ? slp.debt_hours.toFixed(1) + 'h' : '—';
  }
```

- [ ] **Step 3: Call it** — in `renderData`, add `renderSleepDetail(d);` right after the `renderBedtime(d);` line.

- [ ] **Step 4: Verify** — inline-script parser. Expected: `OK 4 scripts`.

---

### Task 7: Fitness-age proxy

**Files:** Modify `health.html` (markup near stats, render logic).

- [ ] **Step 1: Add the tile** directly after the `<div id="whSleepDetail" ...>...</div>` block (before `<div class="wh-legend">`):
```html
        <div id="whFitAge" class="wh-fitage" style="display:none">
          <div class="wh-fitage-num" id="whFitAgeNum">—</div>
          <div class="wh-fitage-cap">estimated fitness age · our estimate, not a WHOOP metric</div>
        </div>
```

- [ ] **Step 2: Add render helper** inside the IIFE (after `renderSleepDetail`):
```js
  function clampN(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function renderFitAge(d) {
    var box = $('whFitAge'); var age = getAge(); var rec = d.recovery || {};
    var rhr = rec.rhr, hrv = rec.hrv_ms;
    if (age == null || (rhr == null && hrv == null)) { box.style.display = 'none'; return; }
    var rhrAdj = rhr != null ? clampN((rhr - 60) * 0.5, -10, 10) : 0;
    var hrvAdj = hrv != null ? clampN((55 - hrv) * 0.15, -8, 8) : 0;
    var fa = Math.round(clampN(age + rhrAdj + hrvAdj, age - 15, age + 15));
    box.style.display = '';
    $('whFitAgeNum').textContent = fa + ' yrs';
  }
```

- [ ] **Step 3: Call it** — in `renderData`, add `renderFitAge(d);` right after the `renderSleepDetail(d);` line.

- [ ] **Step 4: Verify** — inline-script parser. Expected: `OK 4 scripts`.

---

### Task 8: Trend sparklines

**Files:** Modify `health.html` (markup before the verdict, fetch + render in the card script, call on boot).

- [ ] **Step 1: Add the trends strip** directly before `<div id="whVerdict"`:
```html
        <div id="whTrends" class="wh-trends" style="display:none">
          <span class="wh-trends-eye">Trends · last 30 days</span>
          <div id="whSparkGrid" class="wh-spark-grid"></div>
        </div>
```

- [ ] **Step 2: Add sparkline builders** inside the IIFE (after `renderFitAge`):
```js
  function sparkPath(vals, w, h) {
    var nums = vals.filter(function (v) { return v != null; });
    if (nums.length < 2) return null;
    var min = Math.min.apply(null, nums), max = Math.max.apply(null, nums);
    var span = (max - min) || 1, n = vals.length, pts = [];
    for (var i = 0; i < n; i++) {
      if (vals[i] == null) continue;
      var x = (n === 1 ? 0 : (i / (n - 1)) * w);
      var y = h - ((vals[i] - min) / span) * h;
      pts.push((pts.length ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1));
    }
    return pts.join(' ');
  }
  function renderSparks(rows) {
    var grid = $('whSparkGrid'); if (!grid) return;
    var metrics = [
      { key: 'recovery', label: 'Recovery', suffix: '%' },
      { key: 'hrv', label: 'HRV', suffix: 'ms' },
      { key: 'rhr', label: 'RHR', suffix: '' },
      { key: 'strain', label: 'Strain', suffix: '' },
    ];
    var html = '';
    metrics.forEach(function (m) {
      var vals = rows.map(function (r) { return r[m.key] != null ? Number(r[m.key]) : null; });
      var path = sparkPath(vals, 100, 28);
      if (!path) return;
      var nums = vals.filter(function (v) { return v != null; });
      var first = nums[0], last = nums[nums.length - 1];
      var delta = last - first;
      var arrow = delta > 0 ? '<span class="d-up">▲</span>' : (delta < 0 ? '<span class="d-dn">▼</span>' : '');
      var cur = (m.key === 'strain') ? last.toFixed(1) : Math.round(last);
      html += '<div class="wh-spark"><div class="wh-spark-head"><span class="wh-spark-label">' + m.label +
        '</span><span class="wh-spark-val">' + cur + m.suffix + ' ' + arrow + '</span></div>' +
        '<svg viewBox="0 0 100 28" preserveAspectRatio="none"><path d="' + path +
        '" fill="none" stroke="#FFFFFF" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/></svg></div>';
    });
    if (!html) return;
    grid.innerHTML = html;
    $('whTrends').style.display = '';
  }
  async function loadTrends() {
    var s = supa(); if (!s) return;
    try {
      var res = await s.from('whoop_history').select('day,recovery,hrv,rhr,strain').order('day', { ascending: true }).limit(30);
      if (!res.error && res.data && res.data.length >= 2) renderSparks(res.data);
    } catch (e) {}
  }
```

- [ ] **Step 3: Call `loadTrends()` on boot** — find the boot block:
```js
    if (supa()) { loadAndRender(); subscribe(); return; }
```
Replace with:
```js
    if (supa()) { loadAndRender(); loadTrends(); subscribe(); return; }
```

- [ ] **Step 4: Refresh trends after a manual sync** — in `syncNow`, after the `renderData(j.summary)` / `loadAndRender()` branch resolves, add `loadTrends();` at the end of the `try` block (right before the `catch`).

- [ ] **Step 5: Verify** — inline-script parser. Expected: `OK 4 scripts`.

---

### Task 9: Deploy + end-to-end verification

**Files:** none (git + Vercel + checks).

- [ ] **Step 1: Final syntax pass**
```bash
node --check lib/whoop-lib.js && \
node -e "const fs=require('fs');const h=fs.readFileSync('health.html','utf8');let i=0;for(const m of h.matchAll(/<script>([\s\S]*?)<\/script>/g)){i++;try{new Function(m[1])}catch(e){console.log('ERR',i,e.message);process.exit(1)}}console.log('OK',i)"
```
Expected: `OK 4`.

- [ ] **Step 2: Commit**
```bash
git add lib/whoop-lib.js health.html
git commit -m "WHOOP+: bedtime coach, sleep detail, trends, fitness-age proxy"
```

- [ ] **Step 3: Deploy**
```bash
git push && vercel --prod --yes
```

- [ ] **Step 4: Verify backend still healthy**
```bash
curl -s https://row-pied.vercel.app/api/whoop/start
```
Expected: `{"error":"Not signed in"}`.

- [ ] **Step 5: Verify history accrues** — after the next sync (or tap Refresh on the card while signed in), run SQL:
```sql
select day, recovery, hrv, rhr, strain, sleep_perf from public.whoop_history order by day desc limit 5;
```
Expected: at least one row for today with a recovery value.

- [ ] **Step 6: Browser check** — open `row-pied.vercel.app/health.html` (hard refresh), open the ⚙, set wake time + age. Confirm: bedtime line shows, sleep-detail tiles show, fitness-age tile shows. Sparklines show once ≥2 days of history exist (until then, the Trends strip stays hidden).

---

## Self-Review

**Spec coverage:** bedtime (T5) ✓ · deeper sleep detail (T2 server, T6 client) ✓ · trends + `whoop_history` (T1, T3, T8) ✓ · fitness-age proxy (T7) ✓ · settings ⚙ + synced (T4) ✓ · daily cron writes history (T3) ✓ · no-AI ✓.

**Placeholder scan:** none — every step has concrete code/commands.

**Type/name consistency:** helpers `getWake`/`getAge` defined in T4 and used in T5/T7 ✓; `loadAndRender`/`renderData`/`subscribe`/`supa`/`$` are existing card functions ✓; `loadTrends` defined T8, called T8 ✓; new IDs (`whBedtime`, `whSleepDetail`/`whEff`/`whCons`/`whDebt`, `whFitAge`/`whFitAgeNum`, `whTrends`/`whSparkGrid`, `whGear`/`whSettings`/`whWake`/`whAge`) each created in markup and referenced in JS ✓; `whoop_history` columns match between T1 (schema), T3 (write), T8 (read) ✓.
