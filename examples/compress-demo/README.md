# Pocket Watcher COMPRESS Demo

**Make your coding agent finish before your compute budget does.**

This demo shows Pocket Watcher's core behavior:
a fixed budget → real Bob spend → forecast becomes UNSAFE → COMPRESS → optional feature deferred → required work completes → LAND → deterministic validation passes.

---

## What this demo shows

```
fixed budget (0.090 BC)
       ↓
feature F01 runs, real spend (0.020 BC) exceeds estimate (0.015 BC)
       ↓
burn-factor reforecast → remaining scope no longer fits
       ↓
COMPRESS  (Pocket Watcher refuses to start F02)
       ↓
user defers F03 (optional "could" feature)
       ↓
forecast fits again → state returns to BUILD
       ↓
F02 runs and completes
       ↓
auto-transition to LAND (all non-deferred features done)
       ↓
pocket check → all project validation passes
       ↓
SHIPPED: hello.txt + counter.txt delivered, summary.txt deferred
```

---

## Demo fixture

### Budget

| Parameter | Value |
|-----------|-------|
| Assigned budget | **0.090 BC** (fixed, never increases) |
| Protected reserve | 0.040 BC (validation 0.015 + repair 0.015 + integration 0.010) |
| Flexible spendable | **0.050 BC** |

### Features

| ID  | Name                  | Priority | Est high | Validation |
|-----|-----------------------|----------|----------|------------|
| F01 | Write hello file      | must     | 0.015 BC | `test -f hello.txt` + `grep -qF 'Hello, COMPRESS!' hello.txt` |
| F02 | Write counter file    | must     | 0.015 BC | `test -f counter.txt` + `grep -qF '99' counter.txt` |
| F03 | Optional summary file | could    | 0.015 BC | `test -f summary.txt` |

Estimates are deliberately below actual Bob turn cost (~0.020 BC).
This is by design — it forces the budget-exceeded path and COMPRESS behavior.

### Project-level validation

```
test -f hello.txt
test -f counter.txt
grep -qF 'Hello, COMPRESS!' hello.txt
grep -qF '99' counter.txt
```

---

## Ship contract

The demo uses [`ship-contract.json`](./ship-contract.json) — a pre-built Pocket Watcher
contract that matches the observed COMPRESS proof exactly.

You can load this into a fresh workspace to reproduce the scenario:

```sh
mkdir /tmp/compress-demo && cd /tmp/compress-demo
cp /path/to/pocket-watcher/examples/compress-demo/ship-contract.json .pocket/ship-contract.json
BOB_API_KEY=your_key pocket run F01
pocket validate F01
pocket run F02          # ← will be blocked: COMPRESS
pocket defer F03
pocket run F02
pocket validate F02
pocket land
pocket check
```

**Important:** Running `pocket run F01` and `pocket run F02` will consume real Bobcoins
(approximately 0.020 BC each). Only run these if you are prepared to spend ~0.040 BC total.

---

## Observed results (do not re-run to verify)

The actual COMPRESS proof with real Bob runs is preserved in:

    tasks/e2e-compress-proof.md

Key observed facts from that run:

| Step | Observed |
|------|----------|
| F01 run | actual 0.019952 BC, budget_interrupted, file written |
| F01 validate | passed (0.000 BC), burn factor 1.33× applied |
| F02 run (during COMPRESS) | **refused** — exit 2 |
| pocket defer F03 | state → SAFE → BUILD |
| F02 run (after defer) | actual 0.019956 BC, budget_interrupted, file written |
| F02 validate | passed (0.000 BC), auto-LAND |
| pocket check | all 4 commands passed (0.000 BC) |
| **Total Bob spend** | **0.039908 BC** (well within 0.090 BC budget) |
| Assigned budget | **0.0900 BC — UNCHANGED** |
| Protected reserve | **0.0400 BC — intact** |

---

## Why the estimates are deliberately low

Real Bob single-turn cost ≈ 0.020 BC.
Feature estimate.high = 0.015 BC → `bob --max-cost` = 0.005 BC.

Bob's cost limit fires between turns, not mid-turn (observed in `tasks/max-cost-spike.md`).
A single-turn task always completes its first turn. So:

- Bob writes the file (one tool call, one turn)
- Cost limit fires after the turn: `budget_interrupted`
- File exists on disk → deterministic validation proves it done → status: `done`

This is the intended path. COMPRESS fires because:

```
spendable remaining after F01 = 0.050 - 0.020 = 0.030 BC
forecast remaining (F01+F02+F03) = 0.015+0.015+0.015 = 0.045 BC
ratio = 0.045 / 0.030 = 1.50 > 1.0 → UNSAFE → COMPRESS
```

---

## COMPRESS does NOT mean "compress tokens"

Pocket Watcher COMPRESS compresses:
- **scope** (optional features deferred)
- **unnecessary planning** (no new planning runs)
- **optional work** (could-priority features dropped first)
- **agent tangents** (blocked from starting new features)

It does NOT:
- alter Bob's token budget mid-turn
- truncate responses
- reduce context
- modify the prompt passed to Bob

---

## Demo files

| File | Purpose |
|------|---------|
| `README.md` | This file |
| `ship-contract.json` | Pre-configured Pocket Watcher contract for this demo |

The contract is identical to the fixture used in the real COMPRESS proof run.
Feature actual spend values are set to 0 so you can re-run from a fresh state.
