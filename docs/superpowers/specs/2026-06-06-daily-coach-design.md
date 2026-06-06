# Daily Coach (AI) — fuse recovery + calendar + workout into "how hard today"

**Date:** 2026-06-06
**Status:** Approved (design) — pending spec review
**Sub-project:** ④ of 4, the finale (①WHOOP+ ✅ → ②Calendar ✅ → ③Workout coach ✅ → **④Daily coach**)

## Context

All three inputs are live: WHOOP recovery in `app_state.whoop` (score, sleep, strain,
HRV, RHR; already has a rules-based "Today's call"), today's calendar via
`/api/calendar/events`, and the gym program/day/week in `po_coach_v1` (localStorage,
synced, same origin). ④ is the AI layer that fuses them into a daily plan. Mirrors the
existing serverless + secure-config patterns (`lib/whoop-lib.js`, the WHOOP config gate).

## Goals
A "Daily Coach" card (top of `health.html`) that each day produces, via Claude:
1. A **verdict** — level (green/yellow/red) + headline + reasons.
2. **Per-event guidance** — for each of today's calendar events, how hard to push.
3. A **workout load note** — for today's prescribed lifting session, given recovery.

## Non-goals
Any auto-actions (it only advises — never edits the calendar/workout/logs), historical
coaching trends, streaming, multi-turn chat. One structured call per day.

## Architecture

### 1. Endpoint `/api/coach.js` (Node serverless, zero-dep `fetch`)
- **Auth:** `Authorization: Bearer <supabase jwt>` → verify via `/auth/v1/user` (reuse the
  whoop-lib/calendar-lib pattern; small duplicated helper to keep modules independent).
  401 if not signed in — gates cost to the owner.
- **Config gate:** if `process.env.ANTHROPIC_API_KEY` is missing → 200
  `{ configured:false }` (card shows a setup hint). Mirrors the WHOOP config gate.
- **Input (POST body):** compact context assembled by the client —
  `{ recovery:{score,hrv_ms,rhr,sleep_perf,day_strain}, events:[{title,start,allDay}],
     workout:{dayName, week, lifts:[{name,group,sets,reps,tempo}] | null} }`.
- **Claude call:** `POST https://api.anthropic.com/v1/messages`, headers `x-api-key`,
  `anthropic-version: 2023-06-01`, JSON body with the model
  **`claude-haiku-4-5-20251001`** (Haiku 4.5 — verified available + working on this
  account's key), a cached **system prompt**
  (coaching persona + the required output JSON schema + "respond with JSON only"), and a
  user message containing the context. `max_tokens` ~700. Use prompt caching
  (`cache_control`) on the system block.
- **Output:** parse Claude's JSON and return
  `{ configured:true, coach:{ verdict:{level, headline, reasons:[]},
     events:[{title, guidance}], workout:{note} } }`. On Claude error → 502
  `{ error }`. On unparseable model output → wrap the raw text as a single reason so the
  card still shows something.

### 2. Client "Daily Coach" card (top of `health.html`)
- **Gather context:** recovery from `app_state.whoop`; events from `/api/calendar/events`
  (today, local-filtered); workout day/week from `po_coach_v1` (`filterDay`,
  `programWeek`) + the day's name (no need for full lift details cross-page — send the
  day name + week; the load note is recovery-driven).
- **Cache (cost control):** store the result in `app_state('coach') = { date:'YYYY-MM-DD'
  (local), coach:{…} }` (client upsert, own-row RLS). On load: if `coach.date === today`,
  render from cache; else POST `/api/coach` once and store. A **Refresh** button forces a
  re-run. → ~1 Claude call/day, shared across devices via the synced row.
- **Render:** verdict badge (🟢/🟡/🔴) + headline + reason bullets; a per-event list
  (`title — guidance`); a "Today's session" load note. Loading + error + not-configured
  states. Auth token via `window.__supa` (same as the other cards).

### 3. Config — `ANTHROPIC_API_KEY` (Vercel env, Production)
Server-only. Card shows a one-line setup hint until it's set. (User adds it; assistant
can add via CLI if the key is provided, with the chat-exposure caveat.)

## Data flow
Card gathers recovery+events+workout → if cache stale, POST `/api/coach` → server prompts
Claude → returns structured JSON → card renders + caches in `app_state('coach')` for the
day. No secrets on the client; the API key stays server-side.

## Error handling / edge cases
- Not configured → `{configured:false}` → setup hint, no crash.
- No recovery / no events / no workout selected → still call; the prompt tolerates nulls
  and the coach adapts ("no recovery data yet — general guidance").
- Claude/network error → 502 → card shows "coach unavailable, try Refresh," keeps cache.
- Unparseable model JSON → degrade to showing the raw text as the headline/reason.
- Stale cache only refreshes on new local day or manual Refresh (cost cap).

## Success criteria
1. With `ANTHROPIC_API_KEY` set, the card shows a verdict + per-event guidance + a workout
   note derived from real recovery/calendar/workout context.
2. At most one Claude call per day (cache verified by date); Refresh forces a new one.
3. API key never reaches the client; endpoint 401s without a valid session.
4. JS parses; existing cards (WHOOP, calendar) unaffected.

## Out of scope / future
Auto-scheduling, multi-turn chat, coaching history/trends, streaming responses, and
feeding full per-exercise prescription detail cross-page (day name + week suffice for v1).
