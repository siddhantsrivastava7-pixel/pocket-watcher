# Pocket Watcher — Hackathon Evidence Index

This document indexes all primary evidence from the Pocket Watcher development and verification sessions.
All evidence is from real execution. Nothing here is fabricated or simulated.

---

## Overview

Pocket Watcher was built and verified across four distinct Bob sessions, each captured as a screenshot
in `bob_sessions/`. The evidence chain covers: architecture and planning, CLI capability spike,
V1 implementation, validation + skill, and the definitive COMPRESS proof.

---

## Evidence by session

### Session 01 — Architecture and budget control spike
**File:** `bob_sessions/01_budget_control_spike.png`

- Initial architecture design: Bob Skill → CLI → bounded Bob Shell workers
- Budget control loop feasibility investigation
- `--max-cost` behavior observed: cost check fires between turns, not mid-turn
- Single-turn task completes its first turn regardless of `--max-cost` value
- JSON output schema documented (`stats.session_costs`, cost-limit error event)
- Prototype `pocket run hello` executed and verified end-to-end

Full observations: [`tasks/max-cost-spike.md`](../tasks/max-cost-spike.md)

---

### Session 02 — V1 implementation
**File:** `bob_sessions/02_pocket_watcher_v1.png`

- Core budget module (`src/budget.ts`) — reserves, wallets, forecasts, state machine
- Runner module (`src/runner.ts`) — Bob invocation, cost-limit detection via output parsing
- Store module (`src/store.ts`) — contract persistence
- CLI V1 (`src/cli.ts`) — all commands: init, scope, run, validate, check, repair, defer, land, resume, install
- Type definitions (`src/types.ts`)
- Unit test suite created (`src/__tests__/budget.test.ts`)

---

### Session 03 — Validation, Bob Skill, and budget stress test
**File:** `bob_sessions/03_validation_skill_and_stress_test.png`

- Deterministic validation runner (`src/validation.ts`) — zero Bobcoin, shell-command proof
- Bob Skill installer (`src/install.ts`) — project and global scope, idempotent
- `generateSkillMd()` — SKILL.md content with full conversational protocol
- Full E2E budget stress test run with real Bob calls

**Stress test result:** [`tasks/e2e-budget-stress-test.md`](../tasks/e2e-budget-stress-test.md)

Key findings:
- Fixed 0.500 BC budget, 0.150 BC protected reserve, 0.350 BC flexible spendable
- F01, F02, F03 all ran with real Bob calls (~0.020 BC each)
- All 3 features `budget_interrupted` then validated to `done`
- LAND blocked new pending feature (F99 test) with exit 2
- `pocket check` passed all 4 project-level validation commands
- Budget invariant held: assigned budget unchanged throughout
- Total actual spend: 0.059920 BC

---

### Session 04 — COMPRESS proof and skill discoverability
**File:** `bob_sessions/04_compress_and_skill_proof.png`

- COMPRESS trigger verified with deliberately tight 0.090 BC budget
- Cost-learning fix: burn-factor reforecast applied when `budget_interrupted` → `done` via validation
- COMPRESS flow verified end-to-end with real Bob calls
- Bob Skill project installation verified
- Bob Skill global installation verified (isolated HOME)
- Skill discoverability confirmed (`/pocket-watcher` invocation)

**COMPRESS proof:** [`tasks/e2e-compress-proof.md`](../tasks/e2e-compress-proof.md)

Key findings:
- Budget 0.090 BC, spendable 0.050 BC
- F01 run: actual 0.019952 BC, `budget_interrupted`, file written
- F01 validate: burn factor 1.33× applied, F02/F03 estimates scaled
- COMPRESS triggered immediately after F01 run (forecast/spendable = 1.50)
- `pocket run F02` correctly refused while COMPRESS
- `pocket defer F03` restored SAFE → BUILD
- F02 run: actual 0.019956 BC, `budget_interrupted`, file written
- F02 validate: done → auto-transition to LAND
- `pocket validate --all` + `pocket check` passed (0.000 BC each)
- Assigned budget unchanged: 0.090 BC throughout
- Protected reserve intact: 0.040 BC
- Total nested Bob spend: **0.039908 BC**

---

## Proof requirements satisfied

| Requirement | Evidence location |
|-------------|-------------------|
| Fixed budget never increases | `tasks/e2e-compress-proof.md` — Budget invariant check |
| Real session_costs causes reforecast | `tasks/e2e-compress-proof.md` — Burn factor 1.33× observed |
| COMPRESS fires when forecast exceeds spendable | `tasks/e2e-compress-proof.md` — COMPRESS trigger after F01 |
| COMPRESS refuses new feature runs | `tasks/e2e-compress-proof.md` — Attempted F02 refusal |
| Deferring optional feature resolves COMPRESS | `tasks/e2e-compress-proof.md` — Defer F03 |
| Deterministic validation proves work at zero cost | `tasks/e2e-budget-stress-test.md` + compress proof |
| LAND mode blocks new features | `tasks/e2e-budget-stress-test.md` — F99 blocked |
| Bob Skill installs and is discoverable | `tasks/e2e-compress-proof.md` — Part E + F |
| `--max-cost` behavior understood | `tasks/max-cost-spike.md` — Parts A1–A7 |
| 130 unit tests pass | `src/__tests__/budget.test.ts` |

---

## Test suite

```
npm test
```

Result (baseline): **130 tests passing, 0 failures**

Coverage: budget accounting, forecasting, state machine, LAND rules,
burn factor, validation, repair, Bob Skill install, runner output parsing.

---

## Total Bobcoins spent building Pocket Watcher

The Pocket Watcher codebase was built using Bob. Exact per-session spend is not available,
but the following costs were observed in verification runs:

| Run | Spend |
|-----|-------|
| Stress test (3 features) | 0.059920 BC |
| COMPRESS proof (2 features) | 0.039908 BC |

No fabricated or simulated costs appear anywhere in the evidence files.
