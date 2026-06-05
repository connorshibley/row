# WHOOP+ — Deeper metrics, bedtime coach, trends & fitness-age proxy

**Date:** 2026-06-05
**Status:** Approved (design) — pending spec review
**Sub-project:** ① of 4 in the "smart health coach" roadmap

## Context

The dashboard already has a working, secure WHOOP integration (server-side
OAuth in `api/whoop/*`, tokens in `whoop_accounts`, daily cron, summary in
`app_state(key='whoop')`, rich card v2 in `health.html`). This sub-project
*extends* that — it does not replace any of it.

This is the first of four planned sub-projects (each its own spec → plan →
build):
1. **WHOOP+** (this doc)
2. Google Calendar integration
3. Workout coach (plan upload + load recommendations)
4. Daily coach (combines recovery + calendar + goals)

"Pace of aging" (WHOOP Age / Healthspan) is **not exposed by the WHOOP v2
developer API**, so it cannot be shown as a real WHOOP number. This spec
includes a clearly-labeled *proxy* "fitness age" computed by us instead.

## Goals

Add to the existing WHOOP card, with **no AI** (pure data + formulas):
1. **Bedtime coach** — "go to bed by X" from WHOOP sleep-need.
2. **Deeper sleep detail** — efficiency, consistency, debt, disturbances, cycles.
3. **Trends** — 14–30 day sparklines for recovery, HRV, RHR, strain.
4. **Fitness-age proxy** — labeled estimate from RHR/HRV vs the user's age.
5. **Settings** — a ⚙ for the two user inputs (wake time, age).

## Non-goals

Google Calendar, workout-plan parsing, weight recommendations, any combined
"daily coach" logic, and any AI/LLM calls — all deferred to later
sub-projects. Real WHOOP Age (API doesn't expose it).

## Architecture

### 1. New table: `public.whoop_history` (trend storage)
Today's `app_state.whoop` row holds only the latest snapshot (overwritten each
sync). Trends need time-series, so add a dedicated table — avoids
read-modify-write races on the realtime row and keeps that row small.

```sql
create table public.whoop_history (
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
create policy "own history select" on public.whoop_history
  for select to authenticated using (auth.uid() = user_id);
revoke all on public.whoop_history from anon, authenticated;
grant select on public.whoop_history to authenticated; -- read-only for client
-- writes are service-role only (bypasses RLS), from the cron/sync.
```

### 2. Server changes (`lib/whoop-lib.js`)
- **Extend `buildSummary`** — add to the `sleep` object:
  `efficiency` (sleep_efficiency_percentage), `consistency`
  (sleep_consistency_percentage), `debt_hours`
  (msToHours of need_from_sleep_debt_milli), `disturbances`
  (stage_summary.disturbance_count), `cycles`
  (stage_summary.sleep_cycle_count).
- **`syncAccount`** — after `upsertAppState`, also upsert one
  `whoop_history` row for "today" (date from recovery `created_at`, else
  now, UTC) with recovery/hrv/rhr/strain/sleep_perf. Upsert on
  `(user_id, day)` so multiple same-day syncs replace, not duplicate.
- Add `upsertHistory(userId, day, point)` helper using PostgREST
  `on_conflict=user_id,day`.

### 3. Client: bedtime coach
`bedtime = wakeTime − (needHours ÷ (efficiency/100)) − 15min`
- `needHours` = existing `sleep.needed_hours`.
- `efficiency` = `sleep.efficiency` (default 90 if absent).
- `wakeTime` = user setting (default `07:00`).
- Render: `Go to bed by 10:40 PM · needs 8.2h · wake 7:00 AM`. If sleep-need
  data is absent, hide the line.

### 4. Client: deeper sleep detail
Small stat tiles beneath the stages bar: Efficiency %, Consistency %, Sleep
debt (h), Disturbances. Each hidden if its value is null. Reuse `.wh-bio`
styling.

### 5. Client: trends sparklines
- On card load, `select day, recovery, hrv, rhr, strain from whoop_history
  where user_id = auth.uid() order by day desc limit 30` via `window.__supa`.
- Render four tiny inline-SVG sparklines (Recovery, HRV, RHR, Strain), each
  with current value + ▲/▼ delta vs the window start. Hidden until ≥2 days of
  history exist (shows "collecting…" until then).

### 6. Client: fitness-age proxy
- Inputs: `age` setting + latest `rhr`, `hrv_ms`.
- `fitnessAge = age + rhrAdj + hrvAdj`, where
  `rhrAdj = clamp((rhr − 60) × 0.5, −10, 10)` and
  `hrvAdj = clamp((55 − hrv_ms) × 0.15, −8, 8)`; total capped at age ±15.
  (Lower RHR / higher HRV → younger.) Constants are tunable; documented in code.
- Render a tile: big number + "estimated fitness age" + a sub-label
  **"our estimate · not a WHOOP metric."** Hidden if `age` unset or RHR/HRV
  missing. Not medical advice (noted in UI copy).

### 7. Client: settings (⚙)
- A gear button in the card header opens a small inline panel: **Wake time**
  (time input) and **Age** (number). Saved to `localStorage`
  (`whoop_wake_time`, `whoop_age`) and added to `health.html`'s existing
  `CLOUD_SYNC.keys` so they sync cross-device. No secrets involved.

## Data flow
Daily cron → `syncAccount` → WHOOP API → `buildSummary` (now richer) →
`upsertAppState('whoop')` + `upsertHistory(today)`. Client card reads
`app_state.whoop` (realtime) for today's numbers + bedtime + sleep detail +
fitness age, and reads `whoop_history` (once on load) for sparklines.
Settings are local + synced via the page's cloud-sync.

## Error handling / edge cases
- Missing fields → each UI piece hides independently (no crashes).
- `<2` days history → sparklines show "collecting…".
- Age unset → fitness-age tile hidden.
- Efficiency absent → bedtime uses 90% default.
- Multiple same-day syncs → history upsert replaces the day's row.

## Success criteria
1. After connect + a sync, the card shows bedtime, sleep-detail tiles, and (if
   age set) a fitness-age tile.
2. `whoop_history` gains one row/day; sparklines render once ≥2 days exist.
3. Existing connect / sync / disconnect / realtime continue to work unchanged.
4. JS parses; no console errors; private bucket/table RLS intact (anon denied).

## Out of scope / future
Calendar-driven wake time (sub-project 2), AI reasoning, weight
recommendations (sub-project 3), combined daily verdict (sub-project 4).
