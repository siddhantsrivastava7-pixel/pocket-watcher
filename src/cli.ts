#!/usr/bin/env node
/**
 * Pocket Watcher CLI — V1
 *
 * Commands:
 *   pocket init [--budget <n>]
 *   pocket scope "<request>"
 *   pocket status
 *   pocket run <feature-id>
 *   pocket defer <feature-id>
 *   pocket land
 *   pocket resume [--budget <n>]
 */

import { argv, exit, stdin, stdout } from "node:process";
import * as readline from "node:readline";
import { randomUUID } from "node:crypto";

import { loadContract, saveContract, appendHistory } from "./store.js";
import {
  totalReserve,
  spendableBudget,
  computeRiskState,
  canStartFeature,
  recordSpend,
  applyBurnFactorReforecast,
  deferFeature,
  openNewWindow,
  buildForecast,
  nextProjectState,
  bobMaxCost,
  featureWallet,
  planningWallet,
  resolveAssignedBudget,
  buildInitialPhaseAllocation,
  DEFAULT_RESERVES,
  DEFAULT_OVERSHOOT_GUARD,
} from "./budget.js";
import { runWithBudget, buildFeaturePrompt } from "./runner.js";
import type {
  ShipContract,
  ComputeWindow,
  Feature,
  HistoryEntry,
  ProjectState,
} from "./types.js";

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
    case "done":              return "✓";
    case "running":           return "▶";
    case "deferred":          return "⏸";
    case "budget_interrupted": return "⚡";
    default:                  return "○";
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
 * Future: check Bob account API here.
 */
async function getProviderRemaining(): Promise<number | null> {
  // Bob V1 does not expose remaining quota via a reliable supported API.
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

  // Attempt to get provider remaining
  let providerRemaining = await getProviderRemaining();

  // If no user budget and no provider info: ask user
  if (userBudget === null && providerRemaining === null) {
    providerRemaining = await askUserForBudget();
  }

  const resolved = resolveAssignedBudget(providerRemaining, userBudget);

  // Report capping
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

  // Determine actual mode for auto vs manually_supplied
  if (userBudget === null) {
    if (resolved.budgetMode === "auto") {
      window.budgetMode = "auto";
    } else {
      // providerRemaining was obtained via user prompt
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

  // Record planning spend
  contract = recordSpend(contract, null, planResult.actualCost, planResult.costLimitHit);

  // Append history
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

  // Parse features from planning output
  const planOutput = planResult.resultLine?.last_message ?? "";
  const candidates = parsePlanningOutput(planOutput);

  if (candidates.length === 0) {
    // Fallback: show raw output and ask user to define features manually
    console.log(`\n⚠️  Could not automatically parse features from planning output.`);
    console.log(`\nPlanning output:\n${planOutput.slice(0, 2000)}`);
    console.log(`\nAdd features manually to .pocket/ship-contract.json`);
    await saveContract(contract);
    return;
  }

  // Calculate safe feature envelope
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

  // Assign window ID to features
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
  // Try to extract a JSON array from the output
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

  console.log(`\nPOCKET WATCHER`);
  console.log(`══════════════`);
  console.log(`Provider   : Bob`);
  console.log(`Unit       : Bobcoin`);
  console.log(``);
  console.log(`Compute window #${cw.windowId}`);
  console.log(`  Mode              : ${cw.budgetMode.toUpperCase()}`);
  if (cw.providerRemainingAtStart !== null) {
    console.log(`  Provider available: ${bc(cw.providerRemainingAtStart)}`);
  }
  if (cw.budgetMode === "custom") {
    console.log(`  Project cap       : ${bc(cw.assignedBudget)}`);
    console.log(`  Project remaining : ${bc(cw.remainingAssignedBudget)}`);
  } else {
    console.log(`  Assigned          : ${bc(cw.assignedBudget)}`);
    console.log(`  Spent             : ${bc(cw.actualSpent)}`);
    console.log(`  Remaining         : ${bc(cw.remainingAssignedBudget)}`);
  }
  console.log(``);
  console.log(`  Protected landing : ${bc(reserve)}`);
  console.log(`  Flexible spendable: ${bc(spendable)}`);
  console.log(``);
  console.log(`Remaining forecast  : ${bc(forecast.remainingLowBC)}–${bc(forecast.remainingHighBC)}`);
  console.log(`Risk                : ${riskBadge(risk)}`);
  console.log(`State               : ${contract.state}`);

  if (contract.features.length > 0) {
    console.log(``);
    console.log(`Ship Contract:`);
    for (const f of contract.features) {
      if (f.status === "deferred") continue;
      const icon = featureStatusIcon(f.status);
      const spentStr = f.actualSpent > 0 ? `  actual ${bc(f.actualSpent)}` : `  wallet ~${bc(f.estimate.high)}`;
      console.log(`  ${icon} ${f.id} ${f.name}${spentStr}`);
    }

    const deferred = contract.features.filter((f) => f.status === "deferred");
    if (deferred.length > 0) {
      console.log(``);
      console.log(`Deferred:`);
      for (const f of deferred) {
        console.log(`  - ${f.id}: ${f.name}`);
      }
    }
  }

  if (contract.previousWindows.length > 0) {
    console.log(``);
    console.log(`Previous windows:`);
    for (const w of contract.previousWindows) {
      console.log(
        `  Window #${w.windowId}: assigned ${bc(w.assignedBudget)} spent ${bc(w.actualSpent)}`
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

  // Pre-flight checks
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

  if (contract.state === "LAND") {
    // LAND blocks new features but allows finishing interrupted ones
    if (feature.status !== "budget_interrupted") {
      console.error(
        `🚨 Project is in LAND mode. No new features may be started.\n` +
        `   Only budget_interrupted features can be retried. Use 'pocket land' to manage landing.`
      );
      exit(2);
    }
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

  // Record spend
  contract = recordSpend(contract, featureId, actualCost, costLimitHit);

  // Apply burn-factor reforecast if feature was completed (not interrupted)
  if (!costLimitHit) {
    contract = applyBurnFactorReforecast(contract, featureId, actualCost);
  }

  await saveContract(contract);

  const risk = computeRiskState(contract);
  const finalFeature = contract.features.find((f) => f.id === featureId);

  // Append history
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
    note: costLimitHit ? "budget interrupted" : "completed",
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
  }
  console.log();
}

// ---------------------------------------------------------------------------
// 5. pocket defer <feature-id>
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
// 6. pocket land
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
  console.log(`  - new features`);
  console.log(`  - optional refactors`);
  console.log(`  - deferred work`);
  console.log(``);
  console.log(`LAND allows:`);
  console.log(`  - finish active budget_interrupted feature`);
  console.log(`  - integration, build, typecheck`);
  console.log(`  - critical-path tests`);
  console.log(`  - final repair and checkpoint`);
  console.log();
}

// ---------------------------------------------------------------------------
// 7. pocket resume [--budget <n>]
// ---------------------------------------------------------------------------

async function cmdResume(args: string[]): Promise<void> {
  const userBudget = parseBudgetFlag(args);
  let contract = await loadContract();

  if (contract.state === "SHIPPED") {
    console.log(`Project is already SHIPPED. No resume needed.`);
    return;
  }

  // Attempt to get provider remaining for the new window
  let providerRemaining = await getProviderRemaining();

  // If no user budget and no provider info: ask user
  if (userBudget === null && providerRemaining === null) {
    console.log(`\nStarting new compute window...`);
    providerRemaining = await askUserForBudget();
  }

  const resolved = resolveAssignedBudget(providerRemaining, userBudget);

  // Report capping
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

  // If user specified budget with no provider info, update the mode
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

  const interrupted = contract.features.filter((f) => f.status === "pending");
  if (interrupted.length > 0) {
    console.log(`\n  Resumed features:`);
    for (const f of interrupted) {
      console.log(`    ○ ${f.id}: ${f.name}`);
    }
  }
  console.log();
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

const [, , command, ...rest] = argv;

async function main(): Promise<void> {
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
        console.error("Usage: pocket run <feature-id>");
        exit(1);
      }
      await cmdRun(featureId);
      break;
    }
    case "defer": {
      const featureId = rest[0];
      if (!featureId) {
        console.error("Usage: pocket defer <feature-id>");
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
    default:
      console.log("Usage:");
      console.log("  pocket init [--budget <n>]");
      console.log("  pocket scope \"<request>\"");
      console.log("  pocket status");
      console.log("  pocket run <feature-id>");
      console.log("  pocket defer <feature-id>");
      console.log("  pocket land");
      console.log("  pocket resume [--budget <n>]");
      exit(1);
  }
}

main().catch((e: Error) => {
  console.error(e.message);
  exit(1);
});
