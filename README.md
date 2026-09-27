# Pocket Watcher

**Make your coding agent finish before your compute budget does.**

---

## The problem

Coding agents can consume a large usage window planning, investigating, refactoring,
or starting too much scope — leaving users with unfinished work when their compute quota expires.

An agent that starts five features and finishes two is worse than an agent that starts
two features and ships both. But without budget awareness, agents have no way to know
when to stop starting and start finishing.

---

## What Pocket Watcher does

Pocket Watcher treats compute like a project budget.

It:

- **Works from available compute or a custom user-defined budget**
- **Scopes the largest useful version that safely fits**
- **Protects finishing / validation / repair reserves** — so there is always capacity to land
- **Gives each feature a bounded wallet** — Bob runs under `--max-cost`
- **Records real Bobcoin consumption** from Bob's actual session output
- **Dynamically reforecasts** after each feature's actual spend is observed
- **Enters COMPRESS** when the original scope no longer fits the remaining budget
- **Enters LAND** before the finishing reserve is exhausted

> **Important:** Pocket Watcher does NOT "compress tokens."
>
> It compresses **scope** — optional work, agent tangents, and unnecessary planning —
> while preserving the most important outcome.

---

## Install

### Prerequisites

- [Node.js](https://nodejs.org/) >=22.15
- [Bob](https://www.ibm.com/products/watsonx-ai) CLI; `BOB_API_KEY` is required for `scope`, `run`, and `repair`

### Install globally from a local build

```sh
git clone https://github.com/siddhantsrivastava7-pixel/pocket-watcher.git
cd pocket-watcher
npm install
npm run build
npm install -g .
```

### Verify

```sh
pocket --help
```

---

## Bob Skill

The Bob Skill is the conversational front door for Pocket Watcher.
Once installed, it activates automatically when you invoke `/pocket-watcher` in any Bob workspace.

### Install for all workspaces

```sh
pocket install bob --global
```

### Install for this workspace only

```sh
pocket install bob --project
```

### Use it

Open any Bob workspace and type:

```
/pocket-watcher

I want to build a REST API with authentication and a health check.
```

Pocket Watcher will:
1. Ask for your current Bobcoin balance (once, if not known)
2. Initialize a compute window with a protected reserve
3. Scope the request into budgeted features
4. Run each feature within its wallet
5. Dynamically adjust forecasts as actual spend is observed
6. Enter COMPRESS if scope becomes unsafe
7. Enter LAND before the finishing reserve is exhausted
8. Validate and ship what was completed

---

## Quick Start

```sh
# 1. Initialize a compute window (custom 10 BC budget)
pocket init --budget 10

# 2. Scope your project
pocket scope "Build a user auth module with signup, login, and JWT tokens"

# 3. Check the plan
pocket status

# 4. Add trusted, portable validation commands to .pocket/ship-contract.json
#    for each feature before relying on `pocket validate`.

# 5. Execute features one at a time
pocket run F01
pocket validate F01

pocket run F02
pocket validate F02

# 6. If COMPRESS fires: defer optional features
pocket defer F03

# 7. Run project-level finishing checks
pocket check

# 8. Enter LAND when finishing
pocket land
```

---

## How budgeting works

```
USER BUDGET IS FIXED
SCOPE IS VARIABLE
SHIPPING RESERVE IS PROTECTED
```

When you run `pocket init --budget 10`:

- **10 BC** is assigned to this project. It never increases automatically.
- A **protected reserve** is set aside immediately (default: 1.0 BC total: 0.5 validation, 0.25 repair, 0.25 integration).
- The remainder is the **flexible spendable** envelope for feature work.

Each feature receives a **wallet** equal to its high estimate (or remaining spendable, whichever is lower).
Bob is invoked with `--max-cost` set to the wallet minus a small overshoot guard.

After each run, the **actual spend** from Bob's `session_costs` output is recorded.
Forecasts for remaining features are updated using a burn-factor — if features are
costing more than estimated, future estimates are scaled accordingly.

### Custom budgets vs. full account balance

Your account may have 100 Bobcoins while one task is limited to 10:

```sh
pocket init --budget 10
```

The 10 BC cap is enforced against all Pocket Watcher runs in this project.
Your account balance above 10 BC is untouched.

With the default reserve and 0.01 BC overshoot guard, a new project budget must
exceed 1.01 BC. The smaller budgets in the evidence fixtures use explicitly
configured smaller reserves in their checked-in ship contracts.

---

## COMPRESS

COMPRESS is triggered when the remaining forecast (adjusted for actual spend) exceeds
the flexible spendable budget.

In COMPRESS, Pocket Watcher:

1. **Refuses to start new features** — `pocket run` exits with code 2
2. **Shows which features are at risk**
3. **Waits for the user to defer optional features** via `pocket defer <id>`
4. **Returns to BUILD** once the remaining scope fits the remaining budget

COMPRESS compresses **scope**, not tokens. It drops optional work to protect must-ship outcomes.

---

## LAND

LAND is the final phase before shipping.

In LAND mode:

- **No new features may be started**
- The protected reserve is held for validation and repair only
- `pocket validate`, `pocket check`, and `pocket repair` are still allowed
- Critical build / typecheck / test fixes are still allowed

LAND is entered:
- Automatically when all non-deferred features are done
- Manually via `pocket land`

---

## Commands

| Command | What it does |
|---------|-------------|
| `pocket init [--budget <n>]` | Start a compute window |
| `pocket scope "<request>"` | Decompose request into budgeted features |
| `pocket status` | Show budget, risk, state, and all features |
| `pocket run <id>` | Execute one feature within its wallet |
| `pocket validate <id>` | Check acceptance criteria (zero cost) |
| `pocket validate --all` | Validate all eligible features |
| `pocket check` | Project-level finishing validation (zero cost) |
| `pocket repair <id>` | Re-run a failed feature using the repair reserve |
| `pocket defer <id>` | Drop a feature from scope to free budget |
| `pocket land` | Enter finishing mode |
| `pocket resume [--budget <n>]` | Continue after a quota reset |
| `pocket install bob [--global\|--project]` | Install the Bob Skill |

---

## Evidence

The following is an experimentally observed product-behavior proof from a real Pocket Watcher run.
It is not a benchmark. It demonstrates that the COMPRESS flow works as designed.

### COMPRESS proof — observed run (`tasks/e2e-compress-proof.md`)

**Setup:**

| Parameter | Value |
|-----------|-------|
| Fixed assigned budget | **0.0900 BC** |
| Protected reserve | 0.0400 BC |
| Flexible spendable | **0.0500 BC** |
| Feature F01 | Write hello file (est 0.015 BC, priority: must) |
| Feature F02 | Write counter file (est 0.015 BC, priority: must) |
| Feature F03 | Optional summary file (est 0.015 BC, priority: could) |

**Observed results:**

| Step | Observed |
|------|----------|
| F01 run | actual 0.019952 BC → budget_interrupted → file written |
| F01 validate | passed (0.000 BC) → done, burn factor 1.33× applied |
| F02 run (during COMPRESS) | **refused** — exit 2, COMPRESS message |
| pocket defer F03 | state → SAFE → BUILD |
| F02 run (after defer) | actual 0.019956 BC → budget_interrupted → file written |
| F02 validate | passed (0.000 BC) → done → auto-LAND |
| pocket check | all 4 commands passed (0.000 BC) |
| **Total Bob spend** | **0.039908 BC** |
| **Assigned budget** | **0.0900 BC — UNCHANGED** |
| **Protected reserve** | **0.0400 BC — intact** |
| F01 + F02 | **shipped** |
| F03 | **deferred** |

**Key observations:**

- The fixed budget never increased
- Real session_costs triggered reforecast and COMPRESS
- `pocket run` refused to start new work while COMPRESS was unresolved
- Deferring the optional `could` feature restored SAFE state
- Deterministic validation (zero cost) proved both features done
- Project-level `pocket check` passed after COMPRESS

Full details: [`tasks/e2e-compress-proof.md`](tasks/e2e-compress-proof.md)

---

## Architecture

```
Bob Skill (/pocket-watcher)
       ↓
Pocket Watcher CLI (pocket)
  - budget accounting
  - forecast and risk
  - state machine (SCOPE → BUILD / COMPRESS → LAND)
  - deterministic validation
  - repair reserve management
       ↓
Bob Shell (bounded by --max-cost)
  - executes feature prompts
  - reports real session_costs
       ↓
Deterministic validation
  - shell commands only
  - zero Bobcoin cost
  - authoritative proof of feature completion
```

The Bob Skill is a conversational interface. It does not contain budget logic.
All economics are delegated to the CLI.

---

## Current limitations

- **Bob has no reliable remaining-balance API in the current observed V1,** so Pocket Watcher
  asks the user once for their current balance when necessary. Use `--budget` to avoid the question.
- **Bob `--max-cost` checks between turns** and can overshoot by one turn. A single-turn task
  that exceeds its wallet will still complete its first turn before the cost limit fires.
  This is a known Bob Shell property, not a Pocket Watcher bug.
- **Automatic provider support beyond Bob is not implemented.** Pocket Watcher V1 targets Bob only.
- **Custom budgets are enforced against managed Pocket Watcher runs only.** Running Bob directly
  outside of `pocket run` is not tracked.
- **Validation commands are trusted project configuration.** `pocket validate` and `pocket check`
  execute the configured strings with the platform shell; review untrusted ship contracts before running them.
- **`pocket scope` does not generate executable validation commands.** It produces acceptance text,
  estimates, and dependencies; add trusted `feature.validation.commands` and
  `projectValidation.commands` to the ship contract before relying on deterministic completion evidence.
- **Exact future cost prediction is intentionally conservative, not magic.** The burn-factor
  reforecast scales estimates based on observed overruns, but it cannot predict arbitrary future costs.

---

## Roadmap

- Provider adapters (beyond Bob)
- Multi-project portfolio management
- Multiple coding agent support
- History-informed cost estimation
- Optional always-on compute guard

---

## Project files

| Path | Contents |
|------|---------|
| `src/cli.ts` | CLI entrypoint and all commands |
| `src/budget.ts` | Budget accounting, forecasting, state machine |
| `src/runner.ts` | Bob invocation wrapper |
| `src/validation.ts` | Deterministic validation runner |
| `src/install.ts` | Bob Skill installer |
| `src/store.ts` | Contract persistence |
| `src/types.ts` | Core type definitions |
| `src/__tests__/budget.test.ts` | 150 automated tests |
| `tasks/e2e-compress-proof.md` | Real observed COMPRESS proof |
| `tasks/e2e-budget-stress-test.md` | Real observed budget stress test |
| `tasks/max-cost-spike.md` | Bob --max-cost behavior observations |
| `examples/compress-demo/` | Self-contained demo fixture |
| `docs/hackathon-evidence.md` | Evidence index |
