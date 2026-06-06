# Workout Coach — prescribed program + rules-based load recommendations

**Date:** 2026-06-06
**Status:** Approved (design) — pending spec review
**Sub-project:** ③ of 4 (①WHOOP+ ✅ → ②Calendar ✅ → **③Workout coach** → ④Daily coach)

## Context

`gym.html` is the existing "po_coach" tracker: `state.exercises` (each with logs of
`{weight, reps}`, a `bw` bodyweight flag), `estimate1RM` (Epley), today's-workout +
history views, bodyweight + progress-photo logs, all synced via `PC_SYNCED_KEYS`
(`po_coach_v1`, `po_coach_workout_done`, `po_coach_weights`, `po_coach_photos`).

It does **not** know the user's actual program (Connor's *Extended Eccentrics –
Phase 2*: named days, A1/A2 supersets, tempos, W1–W4 rep waves) and gives **no load
recommendations**. This sub-project adds both, reusing the existing logging so 1RM/
history/trends keep working.

## Goals
1. Encode the Extended Eccentrics program as structured data (user-verified).
2. A "today's prescription" UI: pick day + week → see prescribed blocks (sets × reps
   for that week, tempo, rest, notes) with a **recommended load** per exercise.
3. Rules-based progressive-overload load suggestions that respect the rep wave.

## Non-goals
AI, recovery-aware load adjustment (④), auto-advancing weeks, a full in-app program
editor, and goal-based periodization. "Goal" here = progress the prescribed program.

## Architecture (all in `gym.html`)

### 1. Program data — `DEFAULT_PROGRAM` const
Reconstructed from the PDF and **shown to the user to verify/correct before reliance**
(maintained as code; corrections = quick edits).
```js
const DEFAULT_PROGRAM = {
  name: 'Extended Eccentrics – Phase 2',
  weeks: 4,
  days: [
    { id: 'fb1', name: 'Full Body 1', blocks: [
      { group: 'A1', exId: 'ffe_split_squat', name: 'FFE Split Squat',
        tempo: '4-3-3', rest: '10s', inc: 10, notes: 'full ROM; rest 10s between legs',
        perWeek: [ {sets:3, reps:3}, {sets:3, reps:3}, {sets:3, reps:3}, {sets:3, reps:3} ] },
      // …A2, B1, B2, C1, C2…
    ]},
    { id: 'strongman', name: 'Strongman ISO-Recovery', blocks: [ /* … */ ] },
    { id: 'fb4', name: 'Full Body 4 (One Down Two Up)', blocks: [ /* … */ ] },
    { id: 'fb5', name: 'Full Body 5 (Inside/Outside Leg)', blocks: [ /* … */ ] },
  ],
};
```
Per block: `group` (superset label), `exId` (maps to a `state.exercises` entry),
`name`, `tempo`, `rest`, `notes`, `inc` (load increment in the user's unit; lower-body
~10, upper ~5), `perWeek[4]` of `{sets, reps}` (and optional per-week `note`/`load`
hint for vest/sled). Bodyweight blocks carry `bw: true`.

### 2. Exercise mapping
On load, ensure every program `exId` exists in `state.exercises`; if missing, add
`{ id: exId, name, bw }` so the existing logging/1RM/history work unchanged. (A merge
step in the state init, not a rewrite of `buildDefaultExercises`.)

### 3. Selection state — `po_coach_session`
New synced object `{ dayId, week }` (week 1–4), persisted to `localStorage` and added
to `PC_SYNCED_KEYS`. Week defaults to the last choice; day defaults to first.

### 4. UI — "Today's Prescription" section
- **Day picker** (program day names) + **Week picker** (W1–W4).
- For the selected day/week, render blocks in order, grouped by superset label, each row:
  `A1 · FFE Split Squat — 3×3 · tempo 4-3-3 · rest 10s` + notes + **Recommended: <load>**.
- Each row has a **Log** affordance that opens the existing set-logging flow for that
  `exId` (weight × reps) → writes to `state.exercises` logs (existing path).

### 5. Recommendation rule — `recommendLoad(ex, targetReps, inc)`
Using the most recent log for `ex`:
- No prior log → `null` → render "establish a baseline".
- `bw` exercise → suggest rep progression ("aim {targetReps}; +1 rep when easy") or
  "add vest" — no barbell number.
- `last.reps >= targetReps` → suggest `last.weight + inc` (cleanly hit target → progress).
- `last.reps <  targetReps` → suggest `last.weight` (hold/repeat).
Loads shown in `unit()` (existing lb/kg). Tempo note reminds that eccentric work is
intentionally submaximal.

## Data flow
`DEFAULT_PROGRAM` (static) + `po_coach_session` (synced) drive the prescription view.
Logging a prescribed exercise goes through the existing logger → `state.exercises`
(`po_coach_v1`, synced). Recommendations are computed live from those logs. No new
backend, no API, no cron.

## Error handling / edge cases
- Missing/empty program day → "No exercises for this day."
- Exercise with no history → baseline prompt (no crash).
- kg users → increments still apply in their unit (values defined as numbers; documented
  as lb-oriented defaults the user can adjust).
- Program/exId mismatch → the merge step guarantees the exercise exists.

## Success criteria
1. User picks a day + week and sees the correct prescribed blocks (sets×reps for that
   week, tempo, rest, notes) for the verified program.
2. Each exercise shows a sensible recommended load per the rule; logging updates it.
3. Existing gym tracking (1RM, history, bodyweight, photos, sync) is unaffected.
4. JS parses (inline-script check); state init merge doesn't corrupt existing logs.

## Verification step (pre-build)
Before implementation, reconstruct the full `DEFAULT_PROGRAM` from the PDF and present
it to the user to confirm exercises, tempos, rest, and the W1–W4 rep waves are correct.
Only build once the program data is confirmed.

## Out of scope / future (④)
Folding WHOOP recovery into load/intensity ("push hard / back off today"), AI
explanations, calendar-aware session planning, and auto-progression.
