# Workout Coach — seed the program into gym.html, reuse the existing engine

**Date:** 2026-06-06 (revised after deeper gym.html review)
**Status:** Approved (revised design) — pending spec review
**Sub-project:** ③ of 4 (①WHOOP+ ✅ → ②Calendar ✅ → **③Workout coach** → ④Daily coach)

## Context (what already exists)

`gym.html` ("po_coach") already has the machinery we need:
- **Exercise model:** `state.exercises` = `[{ id, name, gym, day, repMin, repMax, step,
  startWeight, bw? }]`; logs in `state.logs[exId]` = `[{weight, reps}]`. Days
  (`state.days`) and gyms (`state.gyms`) are first-class; the list filters by
  `state.filterDay` / `state.filterGym`.
- **Recommendation engine:** `getRx(ex, logs)` already returns Add-weight / Add-a-rep /
  Repeat / Deload using `repMin/repMax/step`, `CONFIG.upgradeAtReps`, stuck-detection,
  and bodyweight handling. It's rendered in the existing prescription UI.
- Synced via `PC_SYNCED_KEYS` (`po_coach_v1`, …).

So we do **not** build a new engine. ③ = get Connor's *Extended Eccentrics – Phase 2*
program into this model and surface the program's structure (supersets, tempo, W1–W4
rep wave) that the generic model doesn't yet express.

## Goals
1. Seed the program as **days + exercises** in the existing model (so `getRx` recommends
   loads for them automatically).
2. Add three backward-compatible exercise fields: **`tempo`**, **`group`** (superset
   label, e.g. "A1"), and **`weeks`** (the W1–W4 rep wave).
3. Add a **week selector (W1–W4)** so the prescribed rep target — and thus `getRx` —
   follows the wave. Day is chosen with the existing day filter.

## Non-goals
A new recommendation engine (reuse `getRx`), AI, recovery-aware adjustment (④),
auto-advancing weeks, deleting/altering the user's existing exercises or logs.

## Architecture (all in `gym.html`)

### 1. Program seed data — `SEED_PROGRAM` const
Reconstructed from the PDF and **user-verified before reliance** (Task 1 gate). Shape:
```js
const SEED_PROGRAM = {
  gymId: 'gym_main',                 // a gym entry to ensure exists
  days: [{ id: 'ee_fb1', name: 'EE · Full Body 1' }, /* strongman, fb4, fb5 */],
  exercises: [
    { id: 'ee_fb1_ffe_split_squat', name: 'FFE Split Squat', gym: 'gym_main',
      day: 'ee_fb1', group: 'A1', tempo: '4-3-3', step: 5, startWeight: 60, bw: false,
      // W1–W4 rep wave (repMin=repMax for prescribed singles like 3×3):
      weeks: [ {repMin:3,repMax:3}, {repMin:3,repMax:3}, {repMin:3,repMax:3}, {repMin:3,repMax:3} ],
      repMin: 3, repMax: 3,          // fallback when no week chosen
      notes: 'full ROM; rest 10s between legs' },
    // …each block A1/A2/B1/B2/C1/C2 across the 4 days…
  ],
};
```
`weeks[i]` carries that week's `{repMin, repMax}`. Exercises with a true wave (e.g.
8→5→3) differ per entry; constant ones repeat. `bw:true` for chin-ups/push-ups/etc.

### 2. Idempotent seeding (no data loss)
On state load, after `normalize`:
- Ensure `SEED_PROGRAM.gymId` exists in `state.gyms`; if not, add `{id,name}`.
- For each `SEED_PROGRAM.days`, add to `state.days` if that `id` is absent.
- For each `SEED_PROGRAM.exercises`, add to `state.exercises` if that `id` is absent.
Match strictly by stable `id` so re-runs are no-ops and the user's existing
exercises/logs are never touched or removed. (A `seededProgramV` marker can gate it.)

### 3. Week selector + `exForWeek`
- New `state.programWeek` (1–4, default 1), persisted + added to `PC_SYNCED_KEYS`.
- A small **W1–W4 control** in the gym UI near the day filter.
- `exForWeek(ex, week)` → if `ex.weeks?.[week-1]`, return `{...ex, repMin:
  ex.weeks[week-1].repMin, repMax: ex.weeks[week-1].repMax}`; else return `ex`.
- Pass `exForWeek(ex, state.programWeek)` into `getRx` and the rendered rep target for
  program exercises, so recommendations + prescription follow the selected week.

### 4. Display (tempo + superset group)
Where the exercise/prescription row renders, show `group` (e.g. "A1") and `tempo`/notes
when present (purely additive; non-program exercises are unaffected since the fields are
absent).

## Data flow
`SEED_PROGRAM` (static) seeds days/exercises once → user picks day (existing filter) +
week (new selector) → list shows prescribed blocks with tempo/group → `getRx(exForWeek(
ex, week), logs)` gives the load rec → user logs via the existing flow → recs update.
No backend, no API.

## Error handling / edge cases
- Re-seeding is a no-op (id match) — safe on every load.
- Exercise with no logs → existing `getRx` returns null → existing "establish baseline"
  copy shows (unchanged behavior).
- `weeks` absent → `exForWeek` returns the exercise unchanged (generic exercises keep
  working).
- kg/lb: `step`/`startWeight` are in `state.units`; reconstruction uses the user's unit.

## Success criteria
1. After load, the new EE days appear; picking a day shows its exercises with superset
   labels + tempo, and `getRx` recommends loads.
2. Changing the W1–W4 selector changes the prescribed reps (and the recommendation) for
   exercises that wave.
3. Existing exercises, logs, 1RM, history, photos, and sync are untouched (idempotent
   seed verified).
4. JS parses; seeding doesn't corrupt `state`.

## Verification step (pre-build, Task 1 gate)
Reconstruct the full `SEED_PROGRAM` (days, exercises, tempos, `step`, `bw`, and the
W1–W4 `weeks`) from the PDF and present it to the user to confirm before building the
seeding/UI. Build only once confirmed.

## Out of scope / future (④)
Fold WHOOP recovery into the recommendation ("push hard / back off today"), AI
explanations, calendar-aware planning, auto week-advance.
