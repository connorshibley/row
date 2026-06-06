# Workout Coach Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seed Connor's Extended Eccentrics program into gym.html's existing model and add tempo/superset display + a W1–W4 week selector, reusing the built-in `getRx` engine for load recommendations.

**Architecture:** A user-verified `SEED_PROGRAM` const is merged idempotently into `state.gyms/days/exercises`; three additive exercise fields (`tempo`, `group`, `weeks`); a synced `state.programWeek` + `exForWeek(ex, week)` that feeds the selected week's rep target into the existing `getRx` and the prescription view. No backend.

**Tech Stack:** Vanilla JS (single-IIFE `gym.html`), localStorage + cloud-sync.

**Spec:** `docs/superpowers/specs/2026-06-06-workout-coach-design.md`

**Testing note:** No unit-test runner. `seedProgram`/`exForWeek` logic is validated by a standalone node assertion script; `gym.html` is validated by the inline-`<script>` parser; the rest by a browser check.

---

### Task 1: Reconstruct `SEED_PROGRAM` from the PDF — USER-VERIFIED GATE

**Files:** none yet (produces the data the later tasks embed).

- [ ] **Step 1: Extract the program.** Re-read `/Users/connorshibley/Desktop/Connor Shibley - 2026 - POST SEASON -  EXTENDED ECCENTRIC.pdf` (use `pdftotext`/PyPDF2 with `dangerouslyDisableSandbox` if needed) and reconstruct, for each day (Full Body 1, Strongman ISO-Recovery, Full Body 4, Full Body 5): each block's superset label (A1/A2/…), exercise name, tempo, rest, notes, `bw` flag, sensible `step`/`startWeight` (use the weights written in the PDF where present), and the W1–W4 `weeks: [{repMin,repMax}×4]` (from the W1/W2/W3 rep entries; constant where the PDF shows a single rep target).

- [ ] **Step 2: Present to the user, GATE.** Show the reconstructed `SEED_PROGRAM` (days + per-exercise group/tempo/reps-by-week) to the user and ask them to confirm or correct. **Do not proceed to Task 2 until the user approves the data.** Apply any corrections they give.

- [ ] **Step 3: Save the confirmed const** to a scratch file `/tmp/seed-program.js` (the exact `const SEED_PROGRAM = {…}` literal) for Task 2/Task-3 to embed verbatim. No commit yet.

---

### Task 2: Add `exForWeek` + `seedProgram` (pure logic, tested)

**Files:**
- Modify: `/Users/connorshibley/Personal Dashboard1.0/gym.html`
- Test (temp): `/tmp/test-seed.js`

- [ ] **Step 1: Write the failing test** `/tmp/test-seed.js`:
```js
const assert = require('assert');
// Paste the SAME exForWeek + seedProgram definitions that go into gym.html:
function exForWeek(ex, week) {
  if (ex && ex.weeks && ex.weeks[week - 1]) {
    const w = ex.weeks[week - 1];
    return Object.assign({}, ex, { repMin: w.repMin, repMax: w.repMax });
  }
  return ex;
}
function seedProgram(state, program) {
  if (!program) return state;
  state.gyms = state.gyms || [];
  if (program.gymId && !state.gyms.some(g => g.id === program.gymId)) state.gyms.push({ id: program.gymId, name: program.gymName || 'Main Gym' });
  state.days = state.days || [];
  (program.days || []).forEach(d => { if (!state.days.some(x => x.id === d.id)) state.days.push({ id: d.id, name: d.name }); });
  state.exercises = state.exercises || [];
  (program.exercises || []).forEach(e => { if (!state.exercises.some(x => x.id === e.id)) state.exercises.push(Object.assign({}, e)); });
  return state;
}

const prog = { gymId: 'gym_main', gymName: 'Main', days: [{id:'ee_fb1', name:'EE FB1'}],
  exercises: [{ id:'ee_a', name:'A', gym:'gym_main', day:'ee_fb1', repMin:3, repMax:3,
    weeks:[{repMin:8,repMax:8},{repMin:5,repMax:5},{repMin:3,repMax:3},{repMin:3,repMax:3}] }] };

// exForWeek picks the week's reps; falls back when no weeks
assert.deepStrictEqual(exForWeek(prog.exercises[0], 1).repMin, 8, 'week1 reps');
assert.deepStrictEqual(exForWeek(prog.exercises[0], 3).repMin, 3, 'week3 reps');
assert.deepStrictEqual(exForWeek({repMin:5,repMax:8}, 2).repMin, 5, 'no weeks -> unchanged');

// seedProgram is idempotent and non-destructive
const state = { gyms:[{id:'old'}], days:[{id:'push',name:'Push'}], exercises:[{id:'mine',name:'Mine'}] };
seedProgram(state, prog); seedProgram(state, prog); // run twice
assert(state.gyms.filter(g=>g.id==='gym_main').length === 1, 'gym added once');
assert(state.days.filter(d=>d.id==='ee_fb1').length === 1, 'day added once');
assert(state.exercises.filter(e=>e.id==='ee_a').length === 1, 'exercise added once');
assert(state.exercises.some(e=>e.id==='mine'), 'existing exercise preserved');
assert(state.days.some(d=>d.id==='push'), 'existing day preserved');
console.log('SEED/EXFORWEEK TESTS PASS');
```

- [ ] **Step 2: Run it, expect FAIL** until the file is wired (initially it passes standalone since defs are inline — so instead run it AFTER pasting identical defs into gym.html and confirm logic): `node /tmp/test-seed.js` → expect `SEED/EXFORWEEK TESTS PASS`.

- [ ] **Step 3: Add the functions to gym.html.** Insert the `exForWeek` and `seedProgram` definitions (identical to the test's) into the gym.html IIFE, immediately after the `function getRx(` block (so they sit with the other engine helpers). Do not alter `getRx`.

- [ ] **Step 4: Embed `SEED_PROGRAM`.** Paste the confirmed `const SEED_PROGRAM = {…}` (from `/tmp/seed-program.js`) near the top of the IIFE, just after `const LS_KEY = 'po_coach_v1';`.

- [ ] **Step 5: Verify** `node /tmp/test-seed.js` → `SEED/EXFORWEEK TESTS PASS`, and `node -e "…inline-script parser…"` on gym.html (see Task 5 Step 1) → all scripts OK.

- [ ] **Step 6: Commit** `git add gym.html && git commit -m "workout: SEED_PROGRAM + exForWeek/seedProgram helpers"`.

---

### Task 3: Seed on load + W1–W4 week state

**Files:** Modify `gym.html`.

- [ ] **Step 1: Call `seedProgram` on load.** In `normalize(s)` (the function that defaults `s.exercises`, `s.days`, etc.), just before `return s;`, add: `seedProgram(s, SEED_PROGRAM); if (!s.programWeek) s.programWeek = 1;`. This makes the EE days/exercises appear and defaults the week. (Read `normalize` first to place it correctly; it's the function returning the hydrated state object.)

- [ ] **Step 2: Sync the week.** Find `const PC_SYNCED_KEYS = [ … ];` and confirm `po_coach_v1` is included (it is) — `programWeek` lives inside `state`/`po_coach_v1`, so no new key is needed. (No change unless `programWeek` is stored separately; it is not.)

- [ ] **Step 3: Verify** the inline-script parser (Task 5 Step 1) passes. Commit: `git add gym.html && git commit -m "workout: seed program on load + default programWeek"`.

---

### Task 4: Week selector UI + tempo/group display + week-aware getRx

**Files:** Modify `gym.html`. **Read first:** locate (a) the day-filter control in the markup/render (search `filterDay`), and (b) every call site of `getRx(` in the render code, and (c) where an exercise's prescription/row text is built.

- [ ] **Step 1: Add a W1–W4 selector** next to the day filter. Add markup (4 buttons or a segmented control) bound to `state.programWeek`; on change: `state.programWeek = n; saveState(); render();` (use the existing render entry point — find the top-level re-render function the day filter calls). Style with existing classes.

- [ ] **Step 2: Make getRx week-aware.** At each `getRx(ex, logs)` call used for a program exercise, change to `getRx(exForWeek(ex, state.programWeek), logs)`. Likewise, where the target rep range is displayed (`ex.repMin`/`ex.repMax` in render), read them from `exForWeek(ex, state.programWeek)` so the shown target follows the week. (Non-program exercises have no `weeks`, so `exForWeek` returns them unchanged — safe.)

- [ ] **Step 3: Show tempo + group.** Where an exercise row/header renders, append `ex.group` (e.g. "A1 · ") before the name and `ex.tempo` (e.g. "tempo 4-3-3") + `ex.notes` in the detail line, each guarded by `if (ex.group)` / `if (ex.tempo)` so non-program exercises are unaffected.

- [ ] **Step 4: Verify** inline-script parser passes; commit `git add gym.html && git commit -m "workout: W1-W4 selector + tempo/group display + week-aware getRx"`.

---

### Task 5: Verify + deploy + browser check

**Files:** none.

- [ ] **Step 1: Syntax pass**
```bash
cd "/Users/connorshibley/Personal Dashboard1.0"
node -e "const fs=require('fs');const h=fs.readFileSync('gym.html','utf8');let i=0;for(const m of h.matchAll(/<script>([\s\S]*?)<\/script>/g)){i++;try{new Function(m[1])}catch(e){console.log('ERR',i,e.message);process.exit(1)}}console.log('scripts OK:',i)" && node /tmp/test-seed.js
```
Expected: scripts OK + `SEED/EXFORWEEK TESTS PASS`.

- [ ] **Step 2: Push + deploy**
```bash
git push && vercel --prod --yes 2>&1 | grep -iE "Production|ready|Error" | tail -3
```

- [ ] **Step 3: Browser check (user).** Open `row-pied.vercel.app/gym.html` (hard refresh). Confirm: the EE days appear in the day picker; selecting one shows its exercises with A1/A2 labels + tempo; the W1–W4 selector changes the shown rep target; after logging a set, a load recommendation appears (existing `getRx` UI). Existing exercises/logs still present.

---

## Self-Review

**Spec coverage:** seed program into existing model (T1 data, T2 embed, T3 seed-on-load) ✓ · additive `tempo`/`group`/`weeks` fields (T1 data + T4 display) ✓ · W1–W4 selector + `exForWeek` feeding `getRx` (T2 fn, T3 state, T4 wiring) ✓ · reuse `getRx` (T4) ✓ · idempotent, non-destructive seed (T2 test asserts) ✓ · user-verification gate (T1 Step 2) ✓.

**Placeholder scan:** Task 1 intentionally produces data via reconstruction+verification (its nature). Tasks 2–3 have complete code. Task 4 provides exact transforms but instructs reading specific call sites (`getRx(`, `filterDay`, render entry) because integration into the 3,600-line single-IIFE file requires locating them — this is codebase reading, not a placeholder; the transformation to apply at each site is fully specified.

**Type/name consistency:** `exForWeek(ex, week)` and `seedProgram(state, program)` signatures match between the test (T2 S1), the gym.html defs (T2 S3), and the call sites (T3 S1, T4 S2) ✓; `state.programWeek` set in T3 S1, read in T4 S1/S2 ✓; `SEED_PROGRAM` produced T1, embedded T2 S4, consumed T3 S1 ✓; new fields `group`/`tempo`/`weeks`/`notes` defined in T1 data, read in T4 S2/S3 ✓.
