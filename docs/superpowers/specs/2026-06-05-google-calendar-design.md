# Google Calendar (ICS) — Today's events on the dashboard

**Date:** 2026-06-05
**Status:** Approved (design) — pending spec review
**Sub-project:** ② of 4 in the smart-health-coach roadmap (①WHOOP+ ✅ → **②Calendar** → ③Workout coach → ④Daily coach)

## Context

The dashboard (`/Users/connorshibley/Personal Dashboard1.0`, static HTML on
Vercel + Supabase + serverless `api/*` functions) already has a secure WHOOP
integration we mirror here. This sub-project adds **read-only Google Calendar
display** via a **secret iCal (ICS) feed** — deliberately *not* OAuth, because
the calendar is read-only and personal, and the ICS path needs no Google Cloud
project, consent screen, or token refresh.

## Goals

1. Let the user connect their calendar by pasting their Google "secret iCal
   address" once.
2. Show **today's events** (time · title · duration) in a card on
   `health.html`, just below the WHOOP card.
3. Keep the ICS URL server-side only (it grants calendar read access).

## Non-goals

OAuth, write access, multiple calendars, exotic recurrence (monthly/yearly,
EXDATE), and any recovery/push **recommendations** (those are sub-project ④,
which will reuse this sub-project's event parser server-side).

## Architecture

### 1. New table: `public.calendar_feeds`
```sql
create table if not exists public.calendar_feeds (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  ics_url    text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.calendar_feeds enable row level security;
revoke all on public.calendar_feeds from anon, authenticated;
-- No policies for authenticated: the ICS URL is a read-secret, touched only by
-- the service role from api/calendar/* (which bypasses RLS).
```

### 2. Shared lib: `lib/calendar-lib.js` (zero-dep, CommonJS)
Mirrors `whoop-lib.js` conventions. Contains:
- Config: `SUPABASE_URL` (env or known default), `SERVICE_KEY` (env).
- `supaHeaders(extra)`, `userIdFromJwt(jwt)` — small duplications of the
  whoop-lib helpers to keep the modules independent (a few lines; acceptable
  over coupling calendar functions to whoop-lib).
- `getFeed(userId)`, `saveFeed(userId, icsUrl)`, `deleteFeed(userId)` —
  PostgREST against `calendar_feeds` with the service-role key.
- `fetchIcs(url)` — `fetch` the URL, return text; throw on non-2xx.
- `parseIcs(text)` — unfold RFC-5545 folded lines (continuation lines begin
  with space/tab), split `BEGIN:VEVENT`…`END:VEVENT`, extract `SUMMARY`,
  `DTSTART`, `DTEND`, `RRULE`, `UID`. Decode `DATE` (all-day) vs `DATE-TIME`
  (with `Z`=UTC or `TZID=`; if TZID present, treat the wall-clock time as-is
  and let the client localize). Return `[{uid, summary, start, end, allDay,
  rrule}]` with `start`/`end` as JS Date (UTC instant for timed, date-only for
  all-day).
- `expandWindow(events, winStart, winEnd)` — for non-recurring events, include
  if they intersect the window. For recurring (`RRULE`), expand only within the
  window; support `FREQ=DAILY` and `FREQ=WEEKLY` (with `BYDAY`), honoring
  `UNTIL` and `COUNT`. Other FREQ values: include the base occurrence only and
  skip expansion (documented limitation). Return concrete occurrences
  `{title, start, end, allDay}` (ISO strings).
- `bearerFrom(req)`, `configError()` (checks `SUPABASE_SERVICE_ROLE_KEY`).

### 3. Endpoints
- `POST /api/calendar/save.js` — `Authorization: Bearer <supabase jwt>` →
  `userIdFromJwt`; read `{ ics_url }` from body; validate it `startsWith
  'https://'` and contains `ical` or ends `.ics`; `saveFeed`; return
  `{ ok: true }`. 400 on bad URL, 401 if not signed in.
- `GET /api/calendar/events.js` — auth → `getFeed`; if none → `{ connected:
  false }`. Else `fetchIcs` → `parseIcs` → `expandWindow(now−1d, now+2d)` →
  `{ connected: true, events: [...] }` sorted by start. On fetch/parse error →
  502 `{ error }`.
- `POST /api/calendar/disconnect.js` — auth → `deleteFeed` → `{ ok: true }`.

### 4. Client card (`health.html`, below the WHOOP card)
A new `<section>` "Today" with its own `<style>` (reuse `.wh-*`-style tokens)
and an IIFE script:
- **Not connected:** brand + "Connect your calendar" + a ⚙ panel with one
  field (paste secret iCal URL) and a Save button → `POST /api/calendar/save`
  with the session JWT; on success, load events. The browser does **not**
  persist the URL.
- **Connected:** a timeline of **today's** events — each row `H:MM AM/PM ·
  Title · (duration)`; all-day events pinned at top as "All day · Title".
  "Nothing scheduled today" when empty. A refresh button re-calls `events`. A
  Disconnect button → `POST /api/calendar/disconnect`.
- **Timezone:** the events endpoint returns a ±2-day ISO window; the client
  filters to its **local** "today" (`new Date()` day bounds) and renders in
  local time — avoids server-tz bugs.
- Auth token via `window.__supa` session (same as the WHOOP card).

## Data flow
User pastes ICS URL → `save` (stored server-side) → card calls `events` →
server fetches+parses+expands → client filters to local today → renders. No
client storage of the URL; no cron (calendar is fetched on card load + manual
refresh).

## Error handling / edge cases
- No feed → "Connect your calendar" state.
- Bad URL on save → inline error, not stored.
- ICS fetch/parse failure → "Couldn't load calendar — check the URL" + keep
  Disconnect available.
- Empty today → "Nothing scheduled today."
- Unsupported recurrence → base occurrence shown; documented limitation.
- Folded lines, all-day events, UTC and TZID times all handled by the parser.

## Success criteria
1. Pasting a valid Google secret-iCal URL connects and shows today's events.
2. The ICS URL is never returned to the client (server-only table, no client
   RLS policies; anon/authenticated denied).
3. Recurring daily/weekly events appear on the correct day; all-day events show
   correctly; empty days show the empty state.
4. JS parses (inline-script check); existing WHOOP card unaffected.

## Out of scope / future
OAuth upgrade for live precision, write access, multiple calendars, richer
recurrence, and the ④ daily coach that combines these events with WHOOP
recovery for per-event push recommendations.
