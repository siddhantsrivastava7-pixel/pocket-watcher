# E2E COMPRESS Proof — Observed Results

**Date:** 2025-09 (Bob timestamp: 2026-09-26)
**Bob Shell version:** 2.0.5
**Platform:** macOS arm64
**Pocket Watcher version:** V1+ with cost-learning fix (this task)
**Fixture workspace:** `/tmp/pw-compress-test`

All values in this document are **OBSERVED** from real execution unless explicitly
marked `[DESIGN]`.

---

## Fixture Setup [DESIGN]

### Fixed assigned budget

```
0.0900 BC   — FIXED. Never increased.
```

### Protected reserves

```
validation  : 0.0150 BC
repair      : 0.0150 BC
integration : 0.0100 BC
──────────────────────
total       : 0.0400 BC
```

### Flexible spendable at start

```
0.0900 - 0.0400 = 0.0500 BC
```

### Features

| ID  | Name                  | Priority | Est low  | Est high | Validation commands |
|-----|-----------------------|----------|----------|----------|---------------------|
| F01 | Write hello file      | must     | 0.010    | 0.015    | `test -f hello.txt`, `grep -qF 'Hello, COMPRESS!' hello.txt` |
| F02 | Write counter file    | must     | 0.010    | 0.015    | `test -f counter.txt`, `grep -qF '99' counter.txt` |
| F03 | Optional summary file | could    | 0.010    | 0.015    | `test -f summary.txt` |

**Note:** Estimates were deliberately optimistic (below real single-turn cost ~0.020 BC).
This is intentional — the design requires F01's actual spend to exceed its high estimate
and trigger the burn-factor reforecast that makes the remaining scope UNSAFE.

### Overshoot guard

```
0.0100 BC
```

### Project-level validation commands

```
test -f hello.txt
test -f counter.txt
grep -qF 'Hello, COMPRESS!' hello.txt
grep -qF '99' counter.txt
```

---

## DESIGN rationale for COMPRESS trigger [DESIGN]

```
F01 estimate.high        = 0.015 BC
F01 maxCost (to Bob)     = 0.015 - 0.010 = 0.005 BC
Observed single-turn cost ≈ 0.020 BC
  → cost limit will fire (budget_interrupted)

After F01 run:
  actualSpent = 0.020 BC
  remaining   = 0.090 - 0.020 = 0.070 BC
  spendable   = 0.070 - 0.040 = 0.030 BC

F01 is still budget_interrupted (not done yet):
  forecast = F01(0.015) + F02(0.015) + F03(0.015) = 0.045 BC
  ratio    = 0.045 / 0.030 = 1.50 > 1.0 → UNSAFE → COMPRESS

Then: validate F01 → done → burn factor applied
  burnFactor = 0.020 / 0.015 = 1.333
  F02 adjusted high = 0.015 × 1.333 = 0.020 BC
  F03 adjusted high = 0.015 × 1.333 = 0.020 BC
  forecast   = F02(0.020) + F03(0.020) = 0.040 BC
  spendable  = 0.030 BC
  ratio      = 0.040 / 0.030 = 1.33 > 1.0 → UNSAFE → COMPRESS (maintained)

After defer F03:
  forecast   = F02(0.020)
  ratio      = 0.020 / 0.030 = 0.667 → SAFE → BUILD
```

---

## Initial State

### OBSERVED

```
State         : BUILD
Risk          : ⚠️  TIGHT
Remaining     : 0.0900 BC
Spendable     : 0.0500 BC
Forecast high : 0.0450 BC
Forecast low  : 0.0300 BC
```

Note: initial state was TIGHT (not SAFE) because F01+F02+F03 = 0.045/0.050 = 90% of
spendable. COMPRESS had not yet triggered.

---

## Run F01 — Write hello file

**Command:** `pocket run F01`

**Feature wallet:** 0.0150 BC
**bob --max-cost:**  0.0050 BC  (wallet 0.015 minus overshoot guard 0.010)

### OBSERVED

```
Exit code      : 0
Cost limit hit : true       ← detected from {"type":"error"} line in output
Actual cost    : 0.0200 BC  ← stats.session_costs = 0.019952 BC
Result status  : "success"  ← Bob always says success (irrelevant for feature status)
Last message   : "Created file: hello.txt\n\n<result>\nHello, COMPRESS!\n</result>"
Feature status : budget_interrupted  ← NOT done (cost limit hit)
Bob task ID    : 219211d61c477df9bf75b3986846e223
Duration       : 3534ms
Tool calls     : 1
```

**Key observed fact:** Bob stopped after one turn but the file was fully written
because `--max-cost` is checked between turns (spike observation A2).

**State after F01 run:**

```
Window spent  : 0.0200 BC
Remaining     : 0.0700 BC
Spendable     : 0.0300 BC
Risk          : 🚨 UNSAFE
State         : COMPRESS   ← COMPRESS triggered immediately after F01 run
F01 status    : budget_interrupted
```

---

## Validate F01 — zero Bobcoins (with cost-learning fix)

**Command:** `pocket validate F01`

### OBSERVED

```
Commands run  : 2
  ✓ test -f hello.txt                   (exit 0, 9ms)
  ✓ grep -qF 'Hello, COMPRESS!' hello.txt (exit 0, 6ms)
Passed        : true
Duration      : 15ms
BC consumed   : 0.0000  ← deterministic, zero cost
Feature status: done

Cost learning message:
  "📊 Cost learning: interrupted run actual spend 0.0200 BC exceeded
   high estimate 0.0150 BC (burn factor 1.33×). Remaining forecasts updated."
```

**Observed: NEW BEHAVIOR — cost-learning for interrupted+validated work fired.**

```
burnFactor = 0.019952 / 0.015 = 1.333
F02 estimate.high: 0.015 → 0.019952 BC
F02 estimate.low:  0.010 → 0.013301 BC
F03 estimate.high: 0.015 → 0.019952 BC
F03 estimate.low:  0.010 → 0.013301 BC
```

**State after F01 validation (from `pocket status`):**

```
Window spent  : 0.0200 BC
Remaining     : 0.0700 BC
Spendable     : 0.0300 BC
Forecast high : 0.0400 BC  (F02 + F03 after burn factor)
Forecast low  : 0.0266 BC
Risk          : 🚨 UNSAFE
State         : COMPRESS   ← COMPRESS maintained after reforecast
F01 status    : done
F02 wallet    : ~0.0200 BC  (burn factor applied)
F03 wallet    : ~0.0200 BC  (burn factor applied)
```

---

## Attempted F02 run while COMPRESS — OBSERVED refusal

**Command:** `pocket run F02`

### OBSERVED

```
⚠️  Project is in COMPRESS mode. Run 'pocket status' and 'pocket defer'
    to reduce scope first.
Exit code: 2
```

**Pocket Watcher correctly refused to start F02 while scope is UNSAFE. ✓**

---

## Defer F03 — reduce scope

**Command:** `pocket defer F03`

F03 is priority `could` (optional). It is the correct candidate to defer.

### OBSERVED

```
⏸ Feature "F03" deferred.
  Risk  : ✅ SAFE
  State : BUILD
```

**After deferring F03:**

```
forecast    = F02(0.019952) only
ratio       = 0.019952 / 0.030 = 0.665 → SAFE
State       → BUILD (COMPRESS resolved)
F03 status  : deferred
```

---

## Run F02 — Write counter file (after COMPRESS resolved)

**Command:** `pocket run F02`

**Feature wallet:** 0.0200 BC  (burn-factor-adjusted estimate)
**bob --max-cost:**  0.0100 BC  (wallet 0.0200 minus overshoot guard 0.010)

### OBSERVED

```
Exit code      : 0
Cost limit hit : true
Actual cost    : 0.0200 BC  ← stats.session_costs = 0.019956 BC
Result status  : "success"
Last message   : "Created file: counter.txt\n\n<result>\n99\n</result>"
Feature status : budget_interrupted
Bob task ID    : a146af3cd4cee9fe526d4e5e9d40d3ee
Duration       : 3041ms
Tool calls     : 1
```

### State after F02 run

```
Window spent  : 0.0399 BC
Remaining     : 0.0501 BC
Spendable     : 0.0101 BC
Risk          : 🚨 UNSAFE
State         : COMPRESS
F02 status    : budget_interrupted
```

Note: F02 also went COMPRESS because its actual spend (0.020) matches its adjusted
high estimate (0.020) and the remaining spendable (0.010) is now smaller.

---

## Validate F02 — zero Bobcoins

**Command:** `pocket validate F02`

### OBSERVED

```
Commands run  : 2
  ✓ test -f counter.txt         (exit 0, 6ms)
  ✓ grep -qF '99' counter.txt   (exit 0, 5ms)
Passed        : true
Duration      : 11ms
BC consumed   : 0.0000
Feature status: done

Cost learning message:
  "📊 Cost learning: interrupted run actual spend 0.0200 BC exceeded
   high estimate 0.0200 BC (burn factor 1.00×). Remaining forecasts updated."
```

Note: burnFactor = 1.00 (actual == adjusted high) → no further scaling to pending
features (F03 is deferred, not pending; no other pending features remain).

### State after F02 validation

```
Remaining     : 0.0501 BC
Spendable     : 0.0101 BC
Risk          : ✅ SAFE
State         : LAND   ← auto-transitioned to LAND (all non-deferred features done)
F01 status    : done
F02 status    : done
F03 status    : deferred
```

---

## LAND mode entry

**Command:** `pocket land`

### OBSERVED

```
🛬 LAND MODE ACTIVATED
State         : LAND
Remaining     : 0.0501 BC
Protected     : 0.0400 BC
Spendable     : 0.0101 BC
```

LAND mode lists blocked operations (new features, deferred work, refactors) and
allowed operations (validate, check, repair).

---

## pocket validate --all — zero Bobcoins

**Command:** `pocket validate --all`

### OBSERVED

```
Features validated : 2  (F03 deferred — skipped)
  ✓ F01 Write hello file      (2 commands, 11ms)
  ✓ F02 Write counter file    (2 commands, 9ms)
All passed         : true
BC consumed        : 0.0000
```

---

## pocket check — project-level validation

**Command:** `pocket check`

### OBSERVED

```
Commands run : 4
  ✓ test -f hello.txt                       (exit 0)
  ✓ test -f counter.txt                     (exit 0)
  ✓ grep -qF 'Hello, COMPRESS!' hello.txt   (exit 0)
  ✓ grep -qF '99' counter.txt               (exit 0)
Passed       : true
Duration     : 19ms
BC consumed  : 0.0000
```

**Project-level validation passed. ✓**

---

## Final State

### OBSERVED from `pocket status`

```
State            : LAND
Risk             : ✅ SAFE
Remaining budget : 0.0501 BC
Assigned budget  : 0.0900 BC  ← UNCHANGED (invariant held)
Total spent      : 0.0399 BC
Spendable left   : 0.0101 BC
```

### Feature set

| ID  | Name                  | Priority | Status    | Actual spend  |
|-----|-----------------------|----------|-----------|---------------|
| F01 | Write hello file      | must     | ✓ done    | 0.019952 BC   |
| F02 | Write counter file    | must     | ✓ done    | 0.019956 BC   |
| F03 | Optional summary file | could    | ⏸ deferred | 0.0000 BC   |

### Files produced

```
hello.txt    — "Hello, COMPRESS!\n"
counter.txt  — "99\n"
summary.txt  — NOT created (F03 deferred)
```

---

## Observed Timeline

```
event                      featureId  realSessionCosts  result
─────────────────────────  ─────────  ────────────────  ──────────────────────────
pocket run F01             F01        0.019952 BC       budget_interrupted → COMPRESS
pocket validate F01        F01        0.000000 BC       done (burn factor 1.33× applied)
attempted pocket run F02   F02        refused            COMPRESS blocks F02
pocket defer F03           F03        0.000000 BC       deferred → SAFE → BUILD
pocket run F02             F02        0.019956 BC       budget_interrupted
pocket validate F02        F02        0.000000 BC       done → auto-LAND
pocket land                —          0.000000 BC       LAND mode confirmed
pocket validate --all      F01+F02    0.000000 BC       all passed
pocket check               —          0.000000 BC       all 4 commands passed
```

---

## Budget invariant check

```
assigned_budget_start  = 0.0900 BC
assigned_budget_end    = 0.0900 BC  ← UNCHANGED
total_actual_spend     = 0.019952 + 0.019956 = 0.039908 BC ≈ 0.0399 BC
remaining              = 0.0501 BC
reserves_intact        : YES (0.0400 BC protected throughout)
```

**The fixed assigned budget never increased. ✓**

---

## Proof of Requirements

| # | Required | Observed |
|---|----------|----------|
| 1 | Fixed assigned budget never changed | ✅ 0.0900 BC throughout |
| 2 | Real session_costs caused forecast to change | ✅ burn factor 1.33× from F01 actual 0.0200 vs estimate 0.0150 |
| 3 | Feature completed despite interrupted Bob run if validation proved it worked | ✅ both F01 and F02 were budget_interrupted then done via validation |
| 4 | Completed real spend changed future cost expectations | ✅ F02+F03 adjusted from 0.015 to 0.020 high estimate |
| 5 | Remaining original scope became UNSAFE | ✅ after F01 run, forecast/spendable = 1.50 → UNSAFE |
| 6 | Pocket Watcher entered COMPRESS | ✅ state = COMPRESS after F01 run |
| 7 | Pocket Watcher refused additional implementation while unresolved | ✅ `pocket run F02` → exit 2, COMPRESS refusal message |
| 8 | Optional F03 was deferred | ✅ `pocket defer F03` executed; F03 status = deferred |
| 9 | Required F02 became affordable again | ✅ after defer F03, risk = SAFE, state = BUILD |
| 10 | F02 completed and validated | ✅ F02 status = done, validation passed |
| 11 | LAND preserved final validation/check capacity | ✅ 0.0501 BC remaining (0.0101 flexible + 0.0400 protected) |
| 12 | Final project-level validation passed | ✅ pocket check: all 4 commands passed |
| 13 | Final result contained working F01 + F02 | ✅ hello.txt and counter.txt produced and validated |
| 14 | F03 remained deferred | ✅ F03 status = deferred; summary.txt not created |
| 15 | Some compute remained | ✅ 0.0501 BC remaining (0.0101 BC flexible + full 0.0400 reserve) |

---

## Total nested Bobcoins used

```
F01 run  : 0.019952 BC
F02 run  : 0.019956 BC
─────────────────────
Total    : 0.039908 BC   (≈ 0.040 BC, well under the ≤0.10 BC target)
```

Bob skill recognition check (Part F): **0.019968 BC** additional.

Grand total including skill check: **0.059876 BC**

---

## Cost-learning fix (Part A) — observed in action

The new behavior introduced in this task was directly exercised:

1. **F01 run**: `budgetInterrupted = true`, `realSessionCosts = 0.019952 BC`
2. **F01 validate**: validation commands passed → status = `done`
3. **NEW**: `applyBurnFactorReforecastAfterValidation` called:
   - `actual (0.019952) > high (0.015)` → `burnFactor = 1.333`
   - F02 high: `0.015 → 0.019952 BC`
   - F03 high: `0.015 → 0.019952 BC`
   - `burnFactorApplied = true` on F01 (prevents double-apply)
4. **F02 validate**: same mechanism fires with burnFactor ≈ 1.00 (actual = adjusted high)
5. **No double-counting**: window `actualSpent` was not incremented by the reforecast

CLI output confirming cost learning:
```
📊 Cost learning: interrupted run actual spend 0.0200 BC exceeded high estimate
   0.0150 BC (burn factor 1.33×). Remaining forecasts updated.
```

---

## Bob Skill Installation (Part E)

### Project installation

**Command:** `pocket install bob --project` (in `/tmp/pw-skill-test`)

```
✅ Installed pocket-watcher skill
   Scope     : project
   Directory : /tmp/pw-skill-test/.bob/skills/pocket-watcher
   SKILL.md  : /tmp/pw-skill-test/.bob/skills/pocket-watcher/SKILL.md
```

**Verified:**
- `.bob/skills/pocket-watcher/SKILL.md` exists ✓
- Contains `name: pocket-watcher` ✓

### Reinstall idempotency

**Second run:** `pocket install bob --project`

```
✅ Updated pocket-watcher skill
   (no warnings, content updated safely)
```

Reinstall is safe and idempotent ✓.

### Unrelated skill protection

An `other-skill/SKILL.md` was created before install. After `pocket install bob --project`,
the other skill's content was unchanged. ✓

### Global installation (isolated HOME)

**Command:** `HOME=/tmp/pw-global-home-test pocket install bob --global`

```
✅ Installed pocket-watcher skill
   Directory : /tmp/pw-global-home-test/.bob/skills/pocket-watcher
   SKILL.md  : /tmp/pw-global-home-test/.bob/skills/pocket-watcher/SKILL.md
```

Global installation used an isolated `$HOME` to avoid touching real user global skills.
Real user's `~/.bob/skills/` was NOT modified. ✓

---

## Bob Skill Discoverability (Part F)

**Method:** Single-turn `bob run` in the project workspace containing the installed skill.

**Command (in `/tmp/pw-skill-test`):**
```
bob run --format json --max-cost 0.025 --disable-mcp --disable-subagents
  "List any Bob skills you have available. If you have a pocket-watcher skill, say YES.
   Reply in one line." < /dev/null
```

**OBSERVED response:**
```
"Skills available: other-skill, pocket-watcher — YES."
```

**Session cost:** 0.019968 BC

**Result: Bob confirmed the pocket-watcher skill is discoverable and recognized. ✓**

Note: The `/pocket-watcher` slash-skill invocation is a conversational trigger within
Bob's interactive shell (Bob Chat UI). Headless `bob run` does not support slash-command
invocation in the same way, but Bob's response confirms the skill is listed and available
in the workspace. Full slash-skill invocation requires the interactive Bob Chat interface.

---

## Limitations discovered

1. **Cost limit fires every run** because per-feature maxCost (0.005–0.010 BC)
   is below one Bob turn cost (~0.020 BC). This is a known property of Bob Shell
   (spike observation A2). The `budget_interrupted` → validation → `done` path is
   therefore exercised by construction in this fixture.

2. **/pocket-watcher invocation** in headless `bob run` cannot be cleanly tested
   without the interactive Bob Chat UI. Bob confirmed skill availability but the
   slash-invocation conversational flow requires the interactive interface.

3. **COMPRESS initially triggered by F01's run alone** (before validation) because
   the full 3-feature forecast (0.045) exceeded the post-F01-spend spendable (0.030).
   This is correct and more conservative behavior — COMPRESS also fired post-validation
   via the burn-factor reforecast (as designed). Both paths were observed.
