#!/usr/bin/env node
/**
 * Pocket Watcher CLI
 *
 * Make your coding agent finish before your compute budget does.
 *
 * Commands:
 *   pocket init [--budget <n>]
 *   pocket scope "<request>"
 *   pocket status
 *   pocket run <feature-id>
 *   pocket validate <feature-id>
 *   pocket validate --all
 *   pocket check
 *   pocket repair <feature-id>
 *   pocket defer <feature-id>
 *   pocket land
 *   pocket resume [--budget <n>]
 *   pocket install bob [--global|--project]
 */

import { argv, exit, stdin, stdout } from "node:process";
import * as readline from "node:readline";
import { randomUUID } from "node:crypto";

import { loadContract, saveContract, appendHistory, appendValidationHistory, appendRepairHistory, appendProjectCheckHistory } from "./store.js";
import {
  totalReserve,
  spendableBudget,
  computeRiskState,
  canStartFeature,
  canRepairFeature,
  recordSpend,
  recordRepairSpend,
  setFeatureStatus,
  applyBurnFactorReforecast,
  applyBurnFactorReforecastAfterValidation,
  deferFeature,
  openNewWindow,
  buildForecast,
  nextProjectState,
  bobMaxCost,
  featureWallet,
  repairWallet,
  planningWallet,
  resolveAssignedBudget,
  buildInitialPhaseAllocation,
  DEFAULT_RESERVES,
  DEFAULT_OVERSHOOT_GUARD,
} from "./budget.js";
import { runWithBudget, buildFeaturePrompt, buildRepairPrompt } from "./runner.js";
import { validateFeature, validateProject } from "./validation.js";
import { installSkill } from "./install.js";
import type {
  ShipContract,
  ComputeWindow,
  Feature,
  HistoryEntry,
  ProjectState,
  ValidationHistoryEntry,
  RepairHistoryEntry,
  ProjectCheckHistoryEntry,
} from "./types.js";

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log(`
Pocket Watcher — Make your coding agent finish before your compute budget does.

USAGE
  pocket <command> [options]

COMMANDS
  init [--budget <n>]          Start a compute window using your available Bob usage.
                               --budget <n>  Give this project a custom <n>-Bobcoin envelope.
                               Example: pocket init --budget 10

  scope "<request>"            Decompose your request into budgeted features.
                               Runs a single Bob planning call, then presents the feature list.
                               Scope that does not fit is flagged immediately.

  status                       See what can still safely ship inside the current envelope.
                               Shows: assigned compute, spent, remaining, risk, state, features.

  run <feature-id>             Execute one feature within its allocated wallet.
                               Bob is bounded by --max-cost. Actual cost recorded on completion.

  validate <feature-id>        Check that a feature's acceptance criteria pass (zero Bobcoins).
                               Runs shell commands — no AI calls, no cost.
  validate --all               Validate every eligible feature at once.

  check                        Run project-level finishing validation (zero Bobcoins).
                               Confirms the whole project meets its acceptance criteria.

  repair <feature-id>          Re-run a failed or interrupted feature using the repair reserve.
                               Funded from the protected repair budget, not feature wallets.

  defer <feature-id>           Drop a feature from the active scope to free budget.
                               Use during COMPRESS to restore SAFE state.

  land                         Enter LAND mode: ship what exists, no new features.
                               Protects the finishing reserve for validation and repair only.

  resume [--budget <n>]        Open a new compute window after a quota reset.
                               Carries forward all feature state from the previous window.

  install bob [--global|--project]
                               Install the /pocket-watcher Bob Skill.
                               --global   Available in all workspaces (writes to ~/.bob/skills)
                               --project  Available in this workspace only (writes to .bob/skills)

STATES
  SCOPE     Defining features, no spending yet.
  BUILD     Executing features within budget.
  COMPRESS  Over budget — defer optional features before continuing.
  LAND      Finishing reserve is low — validate and repair only, no new scope.
  SHIPPED   Done.

RISK
  ✅ SAFE    Remaining forecast < 80% of spendable.
  ⚠️  TIGHT   80–100% of spendable.
  🚨 UNSAFE  Forecast exceeds spendable budget.

QUICK START
  pocket init --budget 10
  pocket scope "Build a CLI tool that does X"
  pocket status
  pocket run F01
  pocket validate F01
  pocket check
  pocket land
`);
}

function printCommandHelp(cmd: string): void {
  switch (cmd) {
    case "init":
      console.log(`
pocket init [--budget <n>]

  Start a compute window using your available Bob usage.

  Without --budget, Pocket Watcher will ask how many Bobcoins you have remaining.
  With --budget, you set a fixed project cap regardless of your total account balance.
  The budget cap is enforced — it will never increase automatically.

  After init, a protected finishing reserve is set aside. Feature wallets come from
  the remainder (spendable budget).

  Examples:
    pocket init                 Ask for your current balance, use it all
    pocket init --budget 10     Cap this project at 10 Bobcoins
    pocket init --budget 0.5    Cap this project at 0.5 Bobcoins (useful for demos)
`);
      break;
    case "scope":
      console.log(`
pocket scope "<request>"

  Decompose your request into budgeted features.

  Runs a single Bob planning call, then presents the candidate feature list with
  priority, estimates, and acceptance criteria. Features that do not fit in the
  safe envelope are flagged at once — you choose which outcomes are essential.

  Features are assigned: must / should / could priority.
  Deferred features are tracked but not budgeted.

  Example:
    pocket scope "Build a REST API with auth and a health check endpoint"
`);
      break;
    case "status":
      console.log(`
pocket status

  Show what can still safely ship inside the current compute envelope.

  Displays:
    - Assigned compute and how much is left
    - Protected reserve (for validation, repair, integration)
    - Flexible spendable remaining
    - Remaining forecast (low–high)
    - Risk: SAFE / TIGHT / UNSAFE
    - Project state: BUILD / COMPRESS / LAND
    - Each feature with status and actual spend

  No Bobcoins consumed. Safe to run at any time.
`);
      break;
    case "run":
      console.log(`
pocket run <feature-id>

  Execute one feature within its allocated wallet.

  Bob is invoked with --max-cost set to the feature wallet minus the overshoot guard.
  Actual cost is recorded from Bob's session_costs output. The budget is updated
  immediately. Deterministic validation runs automatically after a normal completion.

  Cost limit hit ≠ feature complete. Pocket Watcher only marks a feature done
  after its acceptance criteria pass — not from Bob's exit code.

  Example:
    pocket run F01
`);
      break;
    case "validate":
      console.log(`
pocket validate <feature-id>
pocket validate --all

  Check that a feature's acceptance criteria pass. Zero Bobcoins consumed.

  Runs the shell commands configured in the feature's validation block.
  No AI calls. No compute cost. Results are deterministic.

  If validation passes, the feature is marked done.
  If validation fails, the feature is marked validation_failed.
  Use 'pocket repair <id>' to fix failures.

  Examples:
    pocket validate F01
    pocket validate --all
`);
      break;
    case "check":
      console.log(`
pocket check

  Run project-level finishing validation. Zero Bobcoins consumed.

  Runs the shell commands configured in projectValidation.commands.
  Confirms the whole project meets its acceptance criteria (e.g. build passes,
  key files exist, tests pass).

  No AI calls. Deterministic. Safe to run multiple times.
`);
      break;
    case "repair":
      console.log(`
pocket repair <feature-id>

  Re-run a failed or interrupted feature using the protected repair reserve.

  Eligible statuses: validation_failed, budget_interrupted, awaiting_validation.

  Repair spend is charged to the repair reserve — not to the feature's wallet
  and not to the flexible spendable budget. The reserve is fixed at init time.
  Repair cannot exceed the remaining repair reserve.

  After the repair run, deterministic validation is re-attempted automatically.

  Example:
    pocket repair F01
`);
      break;
    case "defer":
      console.log(`
pocket defer <feature-id>

  Drop a feature from active scope to free budget. Use during COMPRESS.

  Deferred features are not removed — they are tracked for potential revival
  in a future compute window. Deferring an optional feature can restore SAFE
  state and allow remaining must-ship features to proceed.

  Example:
    pocket defer F03
`);
      break;
    case "land":
      console.log(`
pocket land

  Enter LAND mode: finish what exists, no new features.

  LAND is the final phase before shipping. It protects the finishing reserve
  for validation and repair only. No new pending features may be started.

  LAND allows:
    pocket validate / pocket validate --all
    pocket check
    pocket repair <id>   (for failed must-ship features)
    Critical build / typecheck / test fixes

  LAND blocks:
    New pending product features
    Optional or deferred features
    Speculative refactors and cleanup
`);
      break;
    case "resume":
      console.log(`
pocket resume [--budget <n>]

  Open a new compute window after a quota reset.

  Carries forward all feature state (done/pending/deferred) from previous windows.
  Previous window data is preserved as immutable history.

  Without --budget, asks for your new balance.
  With --budget, sets a fixed cap for the new window.

  Example:
    pocket resume
    pocket resume --budget 5
`);
      break;
    case "install":
      console.log(`
pocket install bob [--global|--project]

  Install the /pocket-watcher Bob Skill.

  The Bob Skill is the conversational front door for Pocket Watcher.
  Once installed, invoke it from any Bob workspace with:

    /pocket-watcher

  --global   Install for all Bob workspaces (writes to ~/.bob/skills/pocket-watcher/)
  --project  Install for this workspace only (writes to .bob/skills/pocket-watcher/)

  Safe to re-run — reinstall updates SKILL.md to the latest version.
  Will not overwrite an unrelated skill file.

  Examples:
    pocket install bob --global
    pocket install bob --project
`);
      break;
    default:
      printHelp();
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function bc(n: number): string {
  return `${n.toFixed(4)} BC`;
}

function riskBadge(r: "SAFE" | "TIGHT" | "UNSAFE"): string {
  if (r === "SAFE") return "✅ SAFE";
  if (r === "TIGHT") return "⚠️  TIGHT";
  return "🚨 UNSAFE";
}

function featureStatusIcon(s: Feature["status"]): string {
  switch (s) {
    case "done":               return "✓";
    case "running":            return "▶";
    case "deferred":           return "⏸";
    case "budget_interrupted": return "⚡";
    case "awaiting_validation":return "?";
    case "validation_failed":  return "✗";
    default:                   return "○";
  }
}

// ---------------------------------------------------------------------------
// Prompt helper (asks user a question on stdin)
// ---------------------------------------------------------------------------

function askQuestion(question: string): Promise<string> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ---------------------------------------------------------------------------
// Parse CLI flags
// ---------------------------------------------------------------------------

function parseBudgetFlag(args: string[]): number | null {
  const idx = args.indexOf("--budget");
  if (idx === -1) return null;
  const val = parseFloat(args[idx + 1]);
  if (isNaN(val) || val <= 0) {
    console.error(`Error: --budget must be a positive number`);
    exit(1);
  }
  return val;
}

// ---------------------------------------------------------------------------
// Provider budget acquisition (Bob V1)
// ---------------------------------------------------------------------------

/**
 * Attempt to get provider remaining quota.
 * Bob V1: no reliable API for remaining balance → returns null.
 */
async function getProviderRemaining(): Promise<number | null> {
  return null;
}

/**
 * Ask the user once how much compute they have remaining.
 */
async function askUserForBudget(): Promise<number> {
  console.log(`\nPocket Watcher cannot determine your remaining provider quota automatically.`);
  const answer = await askQuestion(
    `How much usage do you currently have left in this window (in Bobcoins)? `
  );
  const val = parseFloat(answer);
  if (isNaN(val) || val <= 0) {
    console.error(`Error: Please enter a positive number.`);
    exit(1);
  }
  return val;
}

// ---------------------------------------------------------------------------
// 1. pocket init [--budget <n>]
// ---------------------------------------------------------------------------

async function cmdInit(args: string[]): Promise<void> {
  const userBudget = parseBudgetFlag(args);

  let providerRemaining = await getProviderRemaining();

  if (userBudget === null && providerRemaining === null) {
    providerRemaining = await askUserForBudget();
  }

  const resolved = resolveAssignedBudget(providerRemaining, userBudget);

  if (resolved.capped && userBudget !== null && providerRemaining !== null) {
    console.log(`\n⚠️  Budget capped:`);
    console.log(`   Requested budget       ${bc(userBudget)}`);
    console.log(`   Available this window  ${bc(providerRemaining)}`);
    console.log(`   Maximum assignable     ${bc(providerRemaining)}`);
  }

  const reserves = DEFAULT_RESERVES;
  const phaseAllocation = buildInitialPhaseAllocation(
    resolved.assignedBudget,
    reserves
  );

  const now = new Date().toISOString();

  const window: ComputeWindow = {
    windowId: 1,
    provider: "bob",
    unit: "bobcoin",
    budgetMode: userBudget === null ? resolved.budgetMode : "custom",
    providerRemainingAtStart: resolved.providerRemainingAtStart,
    assignedBudget: resolved.assignedBudget,
    actualSpent: 0,
    remainingAssignedBudget: resolved.assignedBudget,
    createdAt: now,
    closedAt: null,
  };

  if (userBudget === null) {
    if (resolved.budgetMode === "auto") {
      window.budgetMode = "auto";
    } else {
      window.budgetMode = "manually_supplied";
    }
  }

  const contract: ShipContract = {
    projectId: randomUUID(),
    createdAt: now,
    updatedAt: now,
    currentWindow: window,
    previousWindows: [],
    reserves,
    phaseAllocation,
    overshootGuard: DEFAULT_OVERSHOOT_GUARD,
    features: [],
    deferredFeatureIds: [],
    activeFeatureId: null,
    forecast: {
      remainingHighBC: 0,
      remainingLowBC: 0,
      riskState: "SAFE",
    },
    state: "SCOPE",
  };

  await saveContract(contract);

  console.log(`\n✅ Pocket Watcher initialized`);
  console.log(`   Provider        : Bob`);
  console.log(`   Unit            : Bobcoin`);
  console.log(`   Budget mode     : ${window.budgetMode}`);
  if (window.providerRemainingAtStart !== null) {
    console.log(`   Provider quota  : ${bc(window.providerRemainingAtStart)}`);
  }
  console.log(`   Assigned budget : ${bc(window.assignedBudget)}`);
  console.log(`   Protected floor : ${bc(totalReserve(reserves))}`);
  console.log(`   Spendable       : ${bc(window.assignedBudget - totalReserve(reserves))}`);
  console.log(`\n   Run: pocket scope "<your request>"`);
}

// ---------------------------------------------------------------------------
// 2. pocket scope "<request>"
// ---------------------------------------------------------------------------

async function cmdScope(args: string[]): Promise<void> {
  const request = args.join(" ").replace(/^"|"$/g, "");
  if (!request) {
    console.error(`Usage: pocket scope "<product or task request>"`);
    exit(1);
  }

  let contract = await loadContract();

  const spendable = spendableBudget(contract);
  const pWallet = planningWallet(contract);

  console.log(`\nPOCKET WATCHER — Planning`);
  console.log(`═════════════════════════`);
  console.log(`Request   : ${request}`);
  console.log(`Spendable : ${bc(spendable)}`);
  console.log(`Plan wallet: ${bc(pWallet)}`);

  if (pWallet <= contract.overshootGuard) {
    console.error(`🚨 Planning wallet too small (${bc(pWallet)}). Check budget.`);
    exit(1);
  }

  const apiKey = process.env.BOB_API_KEY;
  if (!apiKey) {
    console.error(`Error: BOB_API_KEY is required for pocket scope`);
    exit(1);
  }

  const planningPrompt = buildPlanningPrompt(request, spendable);
  const planMaxCost = Math.max(0.001, pWallet - contract.overshootGuard);

  console.log(`\nRunning planning with max-cost: ${bc(planMaxCost)} ...`);

  let planResult;
  try {
    planResult = await runWithBudget(planningPrompt, planMaxCost);
  } catch (err) {
    console.error(`Error during planning: ${(err as Error).message}`);
    exit(1);
  }

  const stateBefore = contract.state;

  contract = recordSpend(contract, null, planResult.actualCost, planResult.costLimitHit);

  const histEntry: HistoryEntry = {
    windowId: contract.currentWindow.windowId,
    timestamp: new Date().toISOString(),
    featureId: null,
    phase: "planning",
    predictedLow: null,
    predictedHigh: pWallet,
    assignedWallet: pWallet,
    bobMaxCost: planMaxCost,
    realSessionCosts: planResult.actualCost,
    durationMs: planResult.resultLine?.stats.duration_ms ?? null,
    toolCalls: planResult.resultLine?.stats.tool_calls ?? null,
    bobTaskId: planResult.resultLine?.stats.task_id ?? null,
    normalCompletion: !planResult.costLimitHit,
    budgetInterrupted: planResult.costLimitHit,
    finalFeatureStatus: null,
    stateBefore,
    stateAfter: contract.state,
    note: "planning run",
  };
  await appendHistory(histEntry);

  const planOutput = planResult.resultLine?.last_message ?? "";
  const candidates = parsePlanningOutput(planOutput);

  if (candidates.length === 0) {
    console.log(`\n⚠️  Could not automatically parse features from planning output.`);
    console.log(`\nPlanning output:\n${planOutput.slice(0, 2000)}`);
    console.log(`\nAdd features manually to .pocket/ship-contract.json`);
    await saveContract(contract);
    return;
  }

  const newSpendable = spendableBudget(contract);
  const totalHighEstimate = candidates.reduce((s, f) => s + f.estimate.high, 0);

  console.log(`\nCandidate features (${candidates.length}):`);
  for (const f of candidates) {
    console.log(
      `  [${f.id}] ${f.name}  est: ${bc(f.estimate.low)}–${bc(f.estimate.high)}  priority: ${f.priority}`
    );
  }

  console.log(`\nTotal estimate  : ${bc(totalHighEstimate)}`);
  console.log(`Safe envelope   : ${bc(newSpendable)}`);

  let selectedFeatures = candidates;

  if (totalHighEstimate > newSpendable) {
    console.log(`\n⚠️  Full request does not fit safely in this compute window.`);
    console.log(`\nPOCKET WATCHER`);
    console.log(`Available project budget   ${bc(newSpendable)}`);
    console.log(`Protected finish reserve   ${bc(totalReserve(contract.reserves))}`);
    console.log(`\nWhich outcomes are essential? (Enter IDs separated by commas, or "all")`);
    for (const f of candidates) {
      console.log(`  [ ] ${f.id}: ${f.name}  (est ${bc(f.estimate.low)}–${bc(f.estimate.high)})`);
    }

    const answer = await askQuestion(`\nEssential feature IDs: `);
    if (answer.toLowerCase() !== "all") {
      const essentialIds = answer.split(",").map((s) => s.trim()).filter(Boolean);
      selectedFeatures = candidates.filter((f) => essentialIds.includes(f.id));
      const deferred = candidates.filter((f) => !essentialIds.includes(f.id));

      if (deferred.length > 0) {
        console.log(`\nDeferred: ${deferred.map((f) => f.id).join(", ")}`);
      }
    }
  }

  const deferredIds = candidates
    .filter((f) => !selectedFeatures.some((s) => s.id === f.id))
    .map((f) => f.id);

  const featuresWithWindow: Feature[] = [
    ...selectedFeatures.map((f) => ({
      ...f,
      status: "pending" as const,
      actualSpent: 0,
      windowId: contract.currentWindow.windowId,
    })),
    ...candidates
      .filter((f) => deferredIds.includes(f.id))
      .map((f) => ({
        ...f,
        status: "deferred" as const,
        actualSpent: 0,
        windowId: contract.currentWindow.windowId,
      })),
  ];

  contract = {
    ...contract,
    features: featuresWithWindow,
    deferredFeatureIds: deferredIds,
    state: "BUILD",
    updatedAt: new Date().toISOString(),
  };
  const forecast = buildForecast(contract);
  contract = {
    ...contract,
    forecast,
    state: nextProjectState(contract, forecast.riskState),
  };

  await saveContract(contract);

  console.log(`\n✅ Ship Contract created`);
  console.log(`   Active features : ${selectedFeatures.length}`);
  console.log(`   Deferred        : ${deferredIds.length}`);
  console.log(`\n   Run: pocket status`);
}

function buildPlanningPrompt(request: string, spendableBudgetBC: number): string {
  return [
    `You are a planning assistant. Your ONLY job is to decompose the following request into a compact, structured JSON list of candidate features.`,
    ``,
    `Request: "${request}"`,
    ``,
    `Available compute budget (Bobcoins): ${spendableBudgetBC.toFixed(4)}`,
    ``,
    `RULES:`,
    `- Respond ONLY with a valid JSON array. No prose, no markdown fences.`,
    `- Each feature must have: id (string), name (string), goal (string), dependencies (string[]), priority ("must"|"should"|"could"), estimate ({low: number, high: number, confidence: "low"|"medium"|"high"}), acceptance (string[]), excluded (string[])`,
    `- Estimate costs in Bobcoins. Be conservative — do NOT underestimate.`,
    `- Keep features small and independently shippable where possible.`,
    `- Do NOT produce architecture essays, speculative systems, or implementation plans for deferred features.`,
    `- If the full scope exceeds the budget, list lower-priority items as "could" priority.`,
    ``,
    `Respond with ONLY the JSON array.`,
  ].join("\n");
}

interface CandidateFeature {
  id: string;
  name: string;
  goal: string;
  dependencies: string[];
  priority: string;
  estimate: { low: number; high: number; confidence: string };
  acceptance: string[];
  excluded: string[];
}

function parsePlanningOutput(output: string): CandidateFeature[] {
  const match = output.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]) as unknown[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidCandidate);
  } catch {
    return [];
  }
}

function isValidCandidate(obj: unknown): obj is CandidateFeature {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.name === "string" &&
    typeof o.goal === "string" &&
    Array.isArray(o.dependencies) &&
    typeof o.priority === "string" &&
    typeof o.estimate === "object" &&
    o.estimate !== null &&
    typeof (o.estimate as Record<string, unknown>).low === "number" &&
    typeof (o.estimate as Record<string, unknown>).high === "number" &&
    Array.isArray(o.acceptance) &&
    Array.isArray(o.excluded)
  );
}

// ---------------------------------------------------------------------------
// 3. pocket status
// ---------------------------------------------------------------------------

async function cmdStatus(): Promise<void> {
  const contract = await loadContract();
  const cw = contract.currentWindow;
  const spendable = spendableBudget(contract);
  const reserve = totalReserve(contract.reserves);
  const risk = computeRiskState(contract);
  const forecast = contract.forecast;

  const stateLabel = (s: string): string => {
    switch (s) {
      case "BUILD":    return "BUILD     — executing features";
      case "COMPRESS": return "COMPRESS  — scope reduction required";
      case "LAND":     return "LAND      — finishing only, no new features";
      case "SCOPE":    return "SCOPE     — defining features";
      case "SHIPPED":  return "SHIPPED   — done";
      default:         return s;
    }
  };

  console.log(`\nPOCKET WATCHER`);
  console.log(`══════════════════════════════════════`);
  console.log(`  State    : ${stateLabel(contract.state)}`);
  console.log(`  Risk     : ${riskBadge(risk)}`);
  console.log();

  console.log(`  BUDGET (Window #${cw.windowId}${cw.budgetMode === "custom" ? " — custom cap" : ""})`);
  console.log(`  ──────────────────────────────────`);
  console.log(`  Assigned compute    : ${bc(cw.assignedBudget)}`);
  console.log(`  Actual spent        : ${bc(cw.actualSpent)}`);
  console.log(`  Remaining           : ${bc(cw.remainingAssignedBudget)}`);
  console.log(`  Protected reserve   : ${bc(reserve)}  (validation + repair + integration)`);
  console.log(`  Flexible spendable  : ${bc(spendable)}`);
  console.log(`  Remaining forecast  : ${bc(forecast.remainingLowBC)}–${bc(forecast.remainingHighBC)}`);

  if (contract.features.length > 0) {
    const done     = contract.features.filter((f) => f.status === "done");
    const active   = contract.features.filter((f) => f.id === contract.activeFeatureId && f.status === "running");
    const pending  = contract.features.filter((f) => f.status === "pending");
    const problem  = contract.features.filter((f) =>
      f.status === "validation_failed" || f.status === "budget_interrupted" || f.status === "awaiting_validation"
    );
    const deferred = contract.features.filter((f) => f.status === "deferred");

    console.log();
    console.log(`  FEATURES`);
    console.log(`  ──────────────────────────────────`);

    if (done.length > 0) {
      for (const f of done) {
        console.log(`  ✓  ${f.id.padEnd(6)} ${f.name}  (${bc(f.actualSpent)})`);
      }
    }
    if (active.length > 0) {
      for (const f of active) {
        console.log(`  ▶  ${f.id.padEnd(6)} ${f.name}  (running)`);
      }
    }
    if (pending.length > 0) {
      for (const f of pending) {
        console.log(`  ○  ${f.id.padEnd(6)} ${f.name}  (est ~${bc(f.estimate.high)})`);
      }
    }
    if (problem.length > 0) {
      for (const f of problem) {
        const icon = featureStatusIcon(f.status);
        const hint = f.status === "awaiting_validation"
          ? "needs validation"
          : f.status === "budget_interrupted"
          ? "budget hit — run validate or repair"
          : "failed — run repair";
        console.log(`  ${icon}  ${f.id.padEnd(6)} ${f.name}  (${hint})`);
      }
    }

    if (deferred.length > 0) {
      console.log();
      console.log(`  DEFERRED (out of scope)`);
      for (const f of deferred) {
        console.log(`  ⏸  ${f.id.padEnd(6)} ${f.name}`);
      }
    }
  }

  if (contract.previousWindows.length > 0) {
    console.log();
    console.log(`  PREVIOUS WINDOWS`);
    for (const w of contract.previousWindows) {
      console.log(
        `  Window #${w.windowId}: assigned ${bc(w.assignedBudget)}  spent ${bc(w.actualSpent)}`
      );
    }
  }

  console.log();
}

// ---------------------------------------------------------------------------
// 4. pocket run <feature-id>
// ---------------------------------------------------------------------------

async function cmdRun(featureId: string): Promise<void> {
  let contract = await loadContract();

  const feature = contract.features.find((f) => f.id === featureId);
  if (!feature) {
    console.error(`Error: feature "${featureId}" not found`);
    exit(1);
  }

  if (feature.status === "done") {
    console.error(`Error: feature "${featureId}" is already done`);
    exit(1);
  }

  if (feature.status === "deferred") {
    console.error(`Error: feature "${featureId}" is deferred. Use 'pocket defer' to manage.`);
    exit(1);
  }

  // LAND mode: block ALL new pending features.
  // Only allows validation, check, and repair (handled by separate commands).
  if (contract.state === "LAND") {
    console.error(
      `🚨 Project is in LAND mode. No new features may be started.\n` +
      `   LAND allows: pocket validate, pocket check, pocket repair <id> for failed features.\n` +
      `   Use 'pocket status' to review the current state.`
    );
    exit(2);
  }

  if (contract.state === "COMPRESS") {
    console.error(
      `⚠️  Project is in COMPRESS mode. Run 'pocket status' and 'pocket defer' to reduce scope first.`
    );
    exit(2);
  }

  // Check dependencies
  for (const depId of feature.dependencies) {
    const dep = contract.features.find((f) => f.id === depId);
    if (!dep || dep.status !== "done") {
      console.error(`Error: dependency "${depId}" of feature "${featureId}" is not done yet.`);
      exit(1);
    }
  }

  if (!canStartFeature(contract, feature)) {
    const spendable = spendableBudget(contract);
    console.error(
      `🚨 Cannot start "${featureId}". ` +
      `Estimate ${bc(feature.estimate.high)} exceeds safe spendable ${bc(spendable)}. ` +
      `Transitioning to COMPRESS.`
    );
    const risk = computeRiskState(contract);
    contract = {
      ...contract,
      state: nextProjectState(contract, risk),
      updatedAt: new Date().toISOString(),
    };
    await saveContract(contract);
    exit(2);
  }

  const maxCost = bobMaxCost(contract, feature);
  if (maxCost === null || maxCost <= 0) {
    console.error(`🚨 Feature wallet after overshoot guard is zero or negative. Transitioning to LAND.`);
    contract = { ...contract, state: "LAND", updatedAt: new Date().toISOString() };
    await saveContract(contract);
    exit(2);
  }

  const wallet = featureWallet(contract, feature);
  console.log(`\n▶ Running feature: [${feature.id}] ${feature.name}`);
  console.log(`  Wallet (estimate) : ${bc(wallet)}`);
  console.log(`  bob --max-cost    : ${bc(maxCost)}`);
  console.log(`  Spendable budget  : ${bc(spendableBudget(contract))}`);
  console.log();

  const stateBefore = contract.state;
  contract = {
    ...contract,
    activeFeatureId: featureId,
    features: contract.features.map((f) =>
      f.id === featureId ? { ...f, status: "running" as const } : f
    ),
    updatedAt: new Date().toISOString(),
  };
  await saveContract(contract);

  const prompt = buildFeaturePrompt(feature, contract.deferredFeatureIds);

  let runResult;
  try {
    runResult = await runWithBudget(prompt, maxCost);
  } catch (err) {
    console.error(`Error running bob: ${(err as Error).message}`);
    exit(1);
  }

  const { actualCost, costLimitHit, exitCode, resultLine } = runResult;

  console.log(`\nBob run complete:`);
  console.log(`  Exit code         : ${exitCode}`);
  console.log(`  Cost limit hit    : ${costLimitHit}`);
  console.log(`  Actual cost       : ${bc(actualCost)}`);
  console.log(`  Result status     : ${resultLine?.status ?? "unknown"}`);
  if (resultLine?.last_message) {
    console.log(`  Last message      : ${resultLine.last_message.slice(0, 120)}`);
  }

  // recordSpend: non-interrupted run → awaiting_validation (NOT done)
  contract = recordSpend(contract, featureId, actualCost, costLimitHit);

  if (!costLimitHit) {
    contract = applyBurnFactorReforecast(contract, featureId, actualCost);
  }

  await saveContract(contract);

  const risk = computeRiskState(contract);
  const finalFeature = contract.features.find((f) => f.id === featureId);

  const histEntry: HistoryEntry = {
    windowId: contract.currentWindow.windowId,
    timestamp: new Date().toISOString(),
    featureId,
    phase: "implementation",
    predictedLow: feature.estimate.low,
    predictedHigh: feature.estimate.high,
    assignedWallet: wallet,
    bobMaxCost: maxCost,
    realSessionCosts: actualCost,
    durationMs: resultLine?.stats.duration_ms ?? null,
    toolCalls: resultLine?.stats.tool_calls ?? null,
    bobTaskId: resultLine?.stats.task_id ?? null,
    normalCompletion: !costLimitHit,
    budgetInterrupted: costLimitHit,
    finalFeatureStatus: finalFeature?.status ?? null,
    stateBefore,
    stateAfter: contract.state,
    note: costLimitHit ? "budget interrupted" : "completed — awaiting validation",
  };
  await appendHistory(histEntry);

  console.log(`\nBudget updated:`);
  console.log(`  Window spent  : ${bc(contract.currentWindow.actualSpent)}`);
  console.log(`  Remaining     : ${bc(contract.currentWindow.remainingAssignedBudget)}`);
  console.log(`  Spendable     : ${bc(spendableBudget(contract))}`);
  console.log(`  Risk          : ${riskBadge(risk)}`);
  console.log(`  Project state : ${contract.state}`);

  if (costLimitHit) {
    console.log(`\n⚡ Cost limit hit — feature marked budget_interrupted.`);
    console.log(`   Partial workspace changes may exist.`);
    console.log(`   Feature is NOT considered completed.`);
    console.log(`   Use: pocket repair ${featureId}`);
  } else {
    // Run deterministic validation immediately after a normal completion
    console.log(`\n🔍 Running deterministic validation for ${featureId}...`);
    await runAndReportValidation(contract, feature);
  }
  console.log();
}

// ---------------------------------------------------------------------------
// Shared validation runner (used by cmdRun and cmdValidate)
// ---------------------------------------------------------------------------

async function runAndReportValidation(
  contract: ShipContract,
  feature: Feature
): Promise<void> {
  // Capture pre-validation status — needed to decide whether to apply cost learning.
  const preValidationStatus = feature.status;
  const valResult = await validateFeature(feature);

  if (valResult === null) {
    // No deterministic validation configured
    contract = setFeatureStatus(contract, feature.id, "awaiting_validation");
    await saveContract(contract);

    const valHistEntry: ValidationHistoryEntry = {
      event: "validation",
      timestamp: new Date().toISOString(),
      featureId: feature.id,
      commands: [],
      passed: false,
      durationMs: 0,
    };
    await appendValidationHistory(valHistEntry);

    console.log(`\n⚠️  No deterministic validation configured for ${feature.id}.`);
    console.log(`   Feature status: awaiting_validation`);
    console.log(`   Deterministic acceptance evidence is unavailable.`);
    console.log(`   Configure feature.validation.commands in .pocket/ship-contract.json`);
    console.log(`   or manually verify and update status to done.`);
    return;
  }

  const valHistEntry: ValidationHistoryEntry = {
    event: "validation",
    timestamp: new Date().toISOString(),
    featureId: feature.id,
    commands: valResult.commands,
    passed: valResult.passed,
    durationMs: valResult.durationMs,
  };
  await appendValidationHistory(valHistEntry);

  if (valResult.passed) {
    contract = setFeatureStatus(contract, feature.id, "done");

    // Cost-learning for interrupted-but-validated work:
    // If the run was budget_interrupted and validation now proves it done,
    // the actual spend is legitimate historical evidence. Apply burn factor
    // reforecast exactly once (guarded by burnFactorApplied flag).
    if (preValidationStatus === "budget_interrupted") {
      const completedFeature = contract.features.find((f) => f.id === feature.id);
      if (completedFeature && completedFeature.actualSpent > 0) {
        contract = applyBurnFactorReforecastAfterValidation(contract, feature.id);
        const bf = completedFeature.actualSpent / feature.estimate.high;
        if (bf > 1.0) {
          console.log(
            `\n📊 Cost learning: interrupted run actual spend ${bc(completedFeature.actualSpent)} ` +
            `exceeded high estimate ${bc(feature.estimate.high)} ` +
            `(burn factor ${bf.toFixed(2)}×). Remaining forecasts updated.`
          );
        }
      }
    }

    await saveContract(contract);
    console.log(`\n✅ Validation PASSED — feature ${feature.id} marked done.`);
    console.log(`   Ran ${valResult.commands.length} command(s) in ${valResult.durationMs}ms`);
  } else {
    contract = setFeatureStatus(contract, feature.id, "validation_failed");
    await saveContract(contract);
    console.log(`\n❌ Validation FAILED — feature ${feature.id} marked validation_failed.`);
    for (const cmd of valResult.commands) {
      const mark = cmd.passed ? "✓" : "✗";
      console.log(`  ${mark} ${cmd.command}  (exit ${cmd.exitCode})`);
      if (!cmd.passed && cmd.stderr) {
        console.log(`     stderr: ${cmd.stderr.trim().slice(0, 200)}`);
      }
    }
    console.log(`\n   Use: pocket repair ${feature.id}`);
  }
}

// ---------------------------------------------------------------------------
// 5. pocket validate <feature-id> | --all
// ---------------------------------------------------------------------------

async function cmdValidate(args: string[]): Promise<void> {
  const contract = await loadContract();

  if (args[0] === "--all") {
    await cmdValidateAll(contract);
    return;
  }

  const featureId = args[0];
  if (!featureId) {
    console.error("Usage: pocket validate <feature-id> | --all");
    exit(1);
  }

  const feature = contract.features.find((f) => f.id === featureId);
  if (!feature) {
    console.error(`Error: feature "${featureId}" not found`);
    exit(1);
  }

  if (feature.status === "deferred") {
    console.error(`Error: feature "${featureId}" is deferred — skipping validation.`);
    exit(1);
  }

  console.log(`\n🔍 Validating ${featureId}: ${feature.name}`);
  console.log(`   (zero Bobcoins consumed)`);
  await runAndReportValidation(contract, feature);
  console.log();
}

async function cmdValidateAll(contract: ShipContract): Promise<void> {
  const eligible = contract.features.filter(
    (f) =>
      f.status !== "deferred" &&
      f.status !== "pending" &&
      f.validation &&
      f.validation.commands.length > 0
  );

  if (eligible.length === 0) {
    console.log(`\nNo features with deterministic validation configured (or none are eligible).`);
    return;
  }

  console.log(`\n🔍 Validating ${eligible.length} feature(s) — zero Bobcoins consumed`);
  console.log(`═══════════════════════════════════════════`);

  for (const feature of eligible) {
    console.log(`\n  [${feature.id}] ${feature.name}`);
    await runAndReportValidation(contract, feature);
    // Re-load after each save
    contract = await loadContract();
    const updated = contract.features.find((f) => f.id === feature.id);
    if (updated) {
      console.log(`  Status: ${updated.status}`);
    }
  }
  console.log();
}

// ---------------------------------------------------------------------------
// 6. pocket check — project-level validation
// ---------------------------------------------------------------------------

async function cmdCheck(): Promise<void> {
  const contract = await loadContract();

  if (!contract.projectValidation || contract.projectValidation.commands.length === 0) {
    console.log(`\nNo project-level validation configured.`);
    console.log(`Add "projectValidation": {"commands": [...]} to .pocket/ship-contract.json`);
    return;
  }

  console.log(`\n🔍 Project validation check — zero Bobcoins consumed`);
  console.log(`═══════════════════════════════════════════`);
  for (const cmd of contract.projectValidation.commands) {
    console.log(`  → ${cmd}`);
  }
  console.log();

  const result = await validateProject(contract.projectValidation);
  if (result === null) {
    console.log(`No project validation commands to run.`);
    return;
  }

  const histEntry: ProjectCheckHistoryEntry = {
    event: "project_check",
    timestamp: new Date().toISOString(),
    commands: result.commands,
    passed: result.passed,
    durationMs: result.durationMs,
  };
  await appendProjectCheckHistory(histEntry);

  if (result.passed) {
    console.log(`✅ Project check PASSED in ${result.durationMs}ms`);
    for (const cmd of result.commands) {
      console.log(`  ✓ ${cmd.command}`);
    }
  } else {
    console.log(`❌ Project check FAILED in ${result.durationMs}ms`);
    for (const cmd of result.commands) {
      const mark = cmd.passed ? "✓" : "✗";
      console.log(`  ${mark} ${cmd.command}  (exit ${cmd.exitCode})`);
      if (!cmd.passed && cmd.stderr) {
        console.log(`     stderr: ${cmd.stderr.trim().slice(0, 300)}`);
      }
    }
    console.log(`\nResult NOT fabricated. Fix the failures above.`);
  }
  console.log();
}

// ---------------------------------------------------------------------------
// 7. pocket repair <feature-id>
// ---------------------------------------------------------------------------

async function cmdRepair(featureId: string): Promise<void> {
  let contract = await loadContract();

  const feature = contract.features.find((f) => f.id === featureId);
  if (!feature) {
    console.error(`Error: feature "${featureId}" not found`);
    exit(1);
  }

  // Repair eligibility check
  const eligibleStatuses = ["validation_failed", "budget_interrupted", "awaiting_validation"];
  if (!eligibleStatuses.includes(feature.status)) {
    console.error(
      `Error: feature "${featureId}" is not eligible for repair.\n` +
      `  Current status: ${feature.status}\n` +
      `  Eligible:       ${eligibleStatuses.join(", ")}`
    );
    exit(1);
  }

  // LAND mode allows repair of failed must-ship features
  // COMPRESS mode also allows repair

  if (!canRepairFeature(contract, feature)) {
    const repairReserve = contract.reserves.repair;
    console.error(
      `🚨 LANDING BUDGET TOO LOW FOR REPAIR\n` +
      `   Repair reserve : ${bc(repairReserve)}\n` +
      `   Overshoot guard: ${bc(contract.overshootGuard)}\n` +
      `   Safe repair amt: ${bc(repairReserve - contract.overshootGuard)}\n` +
      `   Workspace preserved. Cannot launch Bob for repair.`
    );
    exit(2);
  }

  const rWallet = repairWallet(contract);
  if (rWallet === null || rWallet <= 0) {
    console.error(`🚨 LANDING BUDGET TOO LOW FOR REPAIR. Workspace preserved.`);
    exit(2);
  }

  // Get failed commands for the repair prompt
  const failedCommands = feature.validation
    ? (await validateFeature(feature))?.commands.filter((c) => !c.passed) ?? []
    : [];

  console.log(`\n🔧 Repair: [${feature.id}] ${feature.name}`);
  console.log(`  Status         : ${feature.status}`);
  console.log(`  Repair wallet  : ${bc(rWallet)}`);
  console.log(`  (funded from repair reserve only)`);
  console.log();

  // Build repair prompt
  const repairPrompt = buildRepairPrompt(feature, failedCommands, contract.deferredFeatureIds);

  // Mark as running
  const stateBefore = contract.state;
  contract = {
    ...contract,
    activeFeatureId: featureId,
    features: contract.features.map((f) =>
      f.id === featureId ? { ...f, status: "running" as const } : f
    ),
    updatedAt: new Date().toISOString(),
  };
  await saveContract(contract);

  let runResult;
  try {
    runResult = await runWithBudget(repairPrompt, rWallet);
  } catch (err) {
    console.error(`Error running bob repair: ${(err as Error).message}`);
    exit(1);
  }

  const { actualCost, costLimitHit, exitCode, resultLine } = runResult;

  console.log(`\nRepair run complete:`);
  console.log(`  Exit code         : ${exitCode}`);
  console.log(`  Cost limit hit    : ${costLimitHit}`);
  console.log(`  Actual cost       : ${bc(actualCost)}`);

  // Record repair spend from repair reserve
  contract = recordRepairSpend(contract, featureId, actualCost, costLimitHit);
  await saveContract(contract);

  // Run validation after repair
  const updatedFeature = contract.features.find((f) => f.id === featureId);
  let validationPassed: boolean | null = null;

  if (!costLimitHit && updatedFeature) {
    console.log(`\n🔍 Running deterministic validation after repair...`);
    const valResult = await validateFeature(updatedFeature);

    if (valResult !== null) {
      validationPassed = valResult.passed;

      const valHistEntry: ValidationHistoryEntry = {
        event: "validation",
        timestamp: new Date().toISOString(),
        featureId,
        commands: valResult.commands,
        passed: valResult.passed,
        durationMs: valResult.durationMs,
      };
      await appendValidationHistory(valHistEntry);

      if (valResult.passed) {
        contract = setFeatureStatus(contract, featureId, "done");
        await saveContract(contract);
        console.log(`\n✅ Repair + validation PASSED — ${featureId} marked done.`);
      } else {
        contract = setFeatureStatus(contract, featureId, "validation_failed");
        await saveContract(contract);
        console.log(`\n❌ Repair completed but validation still FAILED — ${featureId} remains validation_failed.`);
        for (const cmd of valResult.commands) {
          const mark = cmd.passed ? "✓" : "✗";
          console.log(`  ${mark} ${cmd.command}  (exit ${cmd.exitCode})`);
        }
      }
    } else {
      contract = setFeatureStatus(contract, featureId, "awaiting_validation");
      await saveContract(contract);
      console.log(`\n⚠️  No deterministic validation configured. Status: awaiting_validation`);
    }
  }

  const finalFeature = contract.features.find((f) => f.id === featureId);

  const repairHistEntry: RepairHistoryEntry = {
    event: "repair",
    timestamp: new Date().toISOString(),
    windowId: contract.currentWindow.windowId,
    featureId,
    assignedRepairWallet: rWallet,
    bobMaxCost: rWallet,
    realSessionCosts: actualCost,
    durationMs: resultLine?.stats.duration_ms ?? null,
    toolCalls: resultLine?.stats.tool_calls ?? null,
    bobTaskId: resultLine?.stats.task_id ?? null,
    costLimitHit,
    validationPassed,
    finalFeatureStatus: finalFeature?.status ?? "validation_failed",
    note: costLimitHit ? "repair budget interrupted" : "repair completed",
  };
  await appendRepairHistory(repairHistEntry);

  console.log(`\nRepair reserve remaining: ${bc(contract.reserves.repair)}`);
  console.log(`Project state: ${contract.state}`);
  console.log();
}

// ---------------------------------------------------------------------------
// 8. pocket defer <feature-id>
// ---------------------------------------------------------------------------

async function cmdDefer(featureId: string): Promise<void> {
  let contract = await loadContract();

  const feature = contract.features.find((f) => f.id === featureId);
  if (!feature) {
    console.error(`Error: feature "${featureId}" not found`);
    exit(1);
  }

  if (feature.status === "done") {
    console.error(`Error: feature "${featureId}" is already done — cannot defer.`);
    exit(1);
  }

  contract = deferFeature(contract, featureId);
  await saveContract(contract);

  console.log(`\n⏸ Feature "${featureId}" deferred.`);
  console.log(`  Risk  : ${riskBadge(contract.forecast.riskState)}`);
  console.log(`  State : ${contract.state}`);
  console.log();
}

// ---------------------------------------------------------------------------
// 9. pocket land
// ---------------------------------------------------------------------------

async function cmdLand(): Promise<void> {
  let contract = await loadContract();

  if (contract.state === "SHIPPED") {
    console.log(`Project is already SHIPPED.`);
    return;
  }

  contract = {
    ...contract,
    state: "LAND",
    updatedAt: new Date().toISOString(),
  };

  await saveContract(contract);

  const spendable = spendableBudget(contract);
  const reserve = totalReserve(contract.reserves);

  console.log(`\n🛬 LAND MODE ACTIVATED`);
  console.log(`═══════════════════════`);
  console.log(`  Remaining   : ${bc(contract.currentWindow.remainingAssignedBudget)}`);
  console.log(`  Protected   : ${bc(reserve)}`);
  console.log(`  Spendable   : ${bc(spendable)}`);
  console.log(``);
  console.log(`LAND blocks:`);
  console.log(`  - new pending product features`);
  console.log(`  - optional features`);
  console.log(`  - deferred work`);
  console.log(`  - speculative refactors`);
  console.log(`  - architecture cleanup`);
  console.log(``);
  console.log(`LAND allows:`);
  console.log(`  - pocket validate <id>`);
  console.log(`  - pocket validate --all`);
  console.log(`  - pocket check`);
  console.log(`  - pocket repair <id>  (for validation_failed / budget_interrupted features)`);
  console.log(`  - critical build/typecheck/test fixes`);
  console.log(`  - final checkpoint/handoff`);
  console.log();
}

// ---------------------------------------------------------------------------
// 10. pocket resume [--budget <n>]
// ---------------------------------------------------------------------------

async function cmdResume(args: string[]): Promise<void> {
  const userBudget = parseBudgetFlag(args);
  let contract = await loadContract();

  if (contract.state === "SHIPPED") {
    console.log(`Project is already SHIPPED. No resume needed.`);
    return;
  }

  let providerRemaining = await getProviderRemaining();

  if (userBudget === null && providerRemaining === null) {
    console.log(`\nStarting new compute window...`);
    providerRemaining = await askUserForBudget();
  }

  const resolved = resolveAssignedBudget(providerRemaining, userBudget);

  if (resolved.capped && userBudget !== null && providerRemaining !== null) {
    console.log(`\n⚠️  Budget capped for new window:`);
    console.log(`   Requested              ${bc(userBudget)}`);
    console.log(`   Provider available     ${bc(providerRemaining)}`);
    console.log(`   Maximum assignable     ${bc(providerRemaining)}`);
  }

  contract = openNewWindow(
    contract,
    resolved.assignedBudget,
    resolved.providerRemainingAtStart,
    resolved.budgetMode
  );

  if (userBudget !== null && providerRemaining === null) {
    contract = {
      ...contract,
      currentWindow: { ...contract.currentWindow, budgetMode: "custom" },
    };
  }

  await saveContract(contract);

  const cw = contract.currentWindow;
  console.log(`\n▶ New compute window opened: #${cw.windowId}`);
  console.log(`  Budget mode     : ${cw.budgetMode}`);
  if (cw.providerRemainingAtStart !== null) {
    console.log(`  Provider quota  : ${bc(cw.providerRemainingAtStart)}`);
  }
  console.log(`  Assigned budget : ${bc(cw.assignedBudget)}`);
  console.log(`  Previous windows preserved: ${contract.previousWindows.length}`);

  const resumed = contract.features.filter((f) => f.status === "pending");
  if (resumed.length > 0) {
    console.log(`\n  Resumed features:`);
    for (const f of resumed) {
      console.log(`    ○ ${f.id}: ${f.name}`);
    }
  }
  console.log();
}

// ---------------------------------------------------------------------------
// 11. pocket install bob [--global|--project]
// ---------------------------------------------------------------------------

async function cmdInstall(args: string[]): Promise<void> {
  const target = args[0];
  if (target !== "bob") {
    console.error(`Usage: pocket install bob [--global|--project]`);
    console.error(`  bob    Install as a Bob Skill`);
    exit(1);
  }

  const hasGlobal = args.includes("--global");
  const hasProject = args.includes("--project");

  // Default: project scope (safer — doesn't touch user home dir without flag)
  const scope = hasGlobal ? "global" : "project";

  if (!hasGlobal && !hasProject) {
    console.log(`\n⚠️  No scope flag provided. Defaulting to --project (safer).`);
    console.log(`   Use --global to install for all workspaces.`);
  }

  console.log(`\n📦 Installing pocket-watcher Bob Skill (${scope})...`);

  try {
    const result = await installSkill(scope);

    if (result.warnings.length > 0) {
      for (const w of result.warnings) {
        console.error(`  ⚠️  ${w}`);
      }
      exit(1);
    }

    const action = result.created ? "Installed" : "Updated";
    console.log(`\n✅ ${action} pocket-watcher skill`);
    console.log(`   Scope     : ${scope}`);
    console.log(`   Directory : ${result.skillDir}`);
    console.log(`   SKILL.md  : ${result.skillMdPath}`);
    console.log(``);
    if (scope === "global") {
      console.log(`   Open any Bob workspace and invoke: /pocket-watcher`);
    } else {
      console.log(`   In this project, invoke: /pocket-watcher`);
    }
    console.log();
  } catch (err) {
    console.error(`Error installing skill: ${(err as Error).message}`);
    exit(1);
  }
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

const [, , command, ...rest] = argv;

async function main(): Promise<void> {
  // Global --help / -h
  if (command === "--help" || command === "-h" || command === "help") {
    printHelp();
    return;
  }
  // Per-command --help (handles both `pocket status --help` and `pocket install bob --help`)
  if (rest.includes("--help") || rest.includes("-h")) {
    printCommandHelp(command ?? "");
    return;
  }

  switch (command) {
    case "init":
      await cmdInit(rest);
      break;
    case "scope":
      await cmdScope(rest);
      break;
    case "status":
      await cmdStatus();
      break;
    case "run": {
      const featureId = rest[0];
      if (!featureId) {
        printCommandHelp("run");
        exit(1);
      }
      await cmdRun(featureId);
      break;
    }
    case "validate":
      await cmdValidate(rest);
      break;
    case "check":
      await cmdCheck();
      break;
    case "repair": {
      const featureId = rest[0];
      if (!featureId) {
        printCommandHelp("repair");
        exit(1);
      }
      await cmdRepair(featureId);
      break;
    }
    case "defer": {
      const featureId = rest[0];
      if (!featureId) {
        printCommandHelp("defer");
        exit(1);
      }
      await cmdDefer(featureId);
      break;
    }
    case "land":
      await cmdLand();
      break;
    case "resume":
      await cmdResume(rest);
      break;
    case "install":
      await cmdInstall(rest);
      break;
    default:
      printHelp();
      exit(1);
  }
}

main().catch((e: Error) => {
  console.error(e.message);
  exit(1);
});
