#!/usr/bin/env node
/**
 * Pocket Watcher CLI
 *
 * Commands:
 *   pocket status              — show project budget & risk
 *   pocket run <feature-id>    — run a feature within its wallet
 */

import { argv, exit } from "node:process";
import { loadBudget, saveBudget } from "./store.js";
import {
  spendableBudget,
  remainingBudget,
  featureWallet,
  computeRiskState,
  canStartFeature,
  recordFeatureSpend,
  forecastRemaining,
  totalReserve,
} from "./budget.js";
import { runWithBudget } from "./runner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bc(n: number): string {
  return `${n.toFixed(4)} BC`;
}

function riskBadge(r: "SAFE" | "TIGHT" | "UNSAFE"): string {
  if (r === "SAFE") return "✅ SAFE";
  if (r === "TIGHT") return "⚠️  TIGHT";
  return "🚨 UNSAFE";
}

// ---------------------------------------------------------------------------
// pocket status
// ---------------------------------------------------------------------------

async function cmdStatus(): Promise<void> {
  const budget = await loadBudget();
  const remaining = remainingBudget(budget);
  const spendable = spendableBudget(budget);
  const forecast = forecastRemaining(budget);
  const risk = computeRiskState(budget);
  const reserve = totalReserve(budget.reserves);

  console.log(`\nPocket Watcher — Project Status`);
  console.log(`═══════════════════════════════`);
  console.log(`State          : ${budget.state}`);
  console.log(`Risk           : ${riskBadge(risk)}`);
  console.log(`Starting budget: ${bc(budget.startingBudget)}`);
  console.log(`Total spent    : ${bc(budget.totalSpent)}`);
  console.log(`Remaining      : ${bc(remaining)}`);
  console.log(`  − Reserves   : ${bc(reserve)} (validation + repair + integration)`);
  console.log(`  = Spendable  : ${bc(spendable)}`);
  console.log(`Forecast (rem) : ${bc(forecast)}`);
  console.log(``);
  console.log(`Features:`);
  for (const f of budget.features) {
    const tag =
      f.state === "done"
        ? "✓"
        : f.state === "running"
        ? "▶"
        : f.state === "skipped"
        ? "✗"
        : "○";
    const spentStr = f.spent > 0 ? ` (spent ${bc(f.spent)})` : "";
    console.log(
      `  ${tag} [${f.id}] ${f.title}  est: ${bc(f.highEstimate)}${spentStr}`
    );
  }
  console.log();
}

// ---------------------------------------------------------------------------
// pocket run <feature-id>
// ---------------------------------------------------------------------------

async function cmdRun(featureId: string): Promise<void> {
  let budget = await loadBudget();

  const feature = budget.features.find((f) => f.id === featureId);
  if (!feature) {
    console.error(`Error: feature "${featureId}" not found in pocket.json`);
    exit(1);
  }

  if (feature.state === "done") {
    console.error(`Error: feature "${featureId}" is already done`);
    exit(1);
  }

  if (!canStartFeature(budget, feature)) {
    const spendable = spendableBudget(budget);
    console.error(
      `🚨 UNSAFE: Cannot start "${featureId}". ` +
        `High estimate ${bc(feature.highEstimate)} exceeds spendable ${bc(spendable)}. ` +
        `Transition to COMPRESS or LAND.`
    );
    // Mark project as COMPRESS/LAND
    budget = {
      ...budget,
      state: budget.features.some((f) => f.state === "pending")
        ? "COMPRESS"
        : "LAND",
    };
    await saveBudget(budget);
    exit(2);
  }

  const wallet = featureWallet(budget, feature);
  console.log(`\n▶ Running feature: [${feature.id}] ${feature.title}`);
  console.log(`  Wallet (max-cost): ${bc(wallet)}`);
  console.log(`  High estimate    : ${bc(feature.highEstimate)}`);
  console.log(`  Spendable budget : ${bc(spendableBudget(budget))}\n`);

  // Mark feature as running
  budget = {
    ...budget,
    activeFeatureId: featureId,
    features: budget.features.map((f) =>
      f.id === featureId ? { ...f, state: "running" as const } : f
    ),
  };
  await saveBudget(budget);

  // The prompt for the spike is a small controlled task
  const prompt = `Feature: ${feature.title}. This is a spike demo. Write a file named "${featureId}-done.txt" with the content "feature ${featureId} complete". Then read the file back to confirm.`;

  let runResult;
  try {
    runResult = await runWithBudget(prompt, wallet);
  } catch (err) {
    console.error(`Error running bob: ${(err as Error).message}`);
    exit(1);
  }

  const { actualCost, costLimitHit, exitCode, resultLine } = runResult;

  console.log(`\nBob run complete:`);
  console.log(`  Exit code        : ${exitCode}`);
  console.log(`  Cost limit hit   : ${costLimitHit}`);
  console.log(`  Actual cost      : ${bc(actualCost)}`);
  console.log(`  Result status    : ${resultLine?.status ?? "unknown"}`);
  if (resultLine?.last_message) {
    console.log(`  Last message     : ${resultLine.last_message.slice(0, 120)}`);
  }

  // Record actual spend and transition state
  budget = recordFeatureSpend(budget, featureId, actualCost);
  await saveBudget(budget);

  const risk = computeRiskState(budget);
  console.log(`\nBudget updated:`);
  console.log(`  Total spent    : ${bc(budget.totalSpent)}`);
  console.log(`  Spendable left : ${bc(spendableBudget(budget))}`);
  console.log(`  Risk           : ${riskBadge(risk)}`);
  console.log(`  Project state  : ${budget.state}`);

  if (costLimitHit) {
    console.log(`\n⚠️  Cost limit was hit — partial work may exist in workspace.`);
  }
  console.log();
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

const [, , command, ...rest] = argv;

if (command === "status") {
  cmdStatus().catch((e: Error) => { console.error(e.message); exit(1); });
} else if (command === "run") {
  const featureId = rest[0];
  if (!featureId) {
    console.error("Usage: pocket run <feature-id>");
    exit(1);
  }
  cmdRun(featureId).catch((e: Error) => { console.error(e.message); exit(1); });
} else {
  console.log("Usage:");
  console.log("  pocket status");
  console.log("  pocket run <feature-id>");
  exit(1);
}
