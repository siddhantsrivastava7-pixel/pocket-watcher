/**
 * Pocket Watcher — budget engine
 *
 * Pure functions. No I/O, no side-effects. Fully deterministic.
 */

import type {
  ProjectBudget,
  Feature,
  Reserves,
  RiskState,
  ProjectState,
} from "./types.js";

// ---------------------------------------------------------------------------
// Derived values
// ---------------------------------------------------------------------------

/** Total protected reserve (sum of all three reserve buckets). */
export function totalReserve(reserves: Reserves): number {
  return reserves.validation + reserves.repair + reserves.integration;
}

/** Remaining budget (starting - total spent). */
export function remainingBudget(budget: ProjectBudget): number {
  return budget.startingBudget - budget.totalSpent;
}

/**
 * Spendable budget — what Bob is actually allowed to touch.
 * spendable = remaining - protected reserves
 * Clamped to 0 (never negative).
 */
export function spendableBudget(budget: ProjectBudget): number {
  return Math.max(0, remainingBudget(budget) - totalReserve(budget.reserves));
}

/**
 * Sum of highEstimates for all features not yet done/skipped.
 */
export function forecastRemaining(budget: ProjectBudget): number {
  return budget.features
    .filter((f) => f.state === "pending" || f.state === "running")
    .reduce((sum, f) => sum + f.highEstimate, 0);
}

// ---------------------------------------------------------------------------
// Risk state
// ---------------------------------------------------------------------------

/**
 * Compute risk state for the current project.
 *
 * SAFE   — forecast < 80% of spendable
 * TIGHT  — 80% ≤ forecast ≤ 100% of spendable
 * UNSAFE — forecast > 100% of spendable
 */
export function computeRiskState(budget: ProjectBudget): RiskState {
  const spendable = spendableBudget(budget);
  if (spendable <= 0) return "UNSAFE";
  const forecast = forecastRemaining(budget);
  const ratio = forecast / spendable;
  if (ratio > 1.0) return "UNSAFE";
  if (ratio >= 0.8) return "TIGHT";
  return "SAFE";
}

// ---------------------------------------------------------------------------
// Feature wallet
// ---------------------------------------------------------------------------

/**
 * Compute the maximum Bobcoins to pass to `bob run --max-cost` for a feature.
 *
 * We never expose the full remaining budget to Bob.
 * The wallet is capped at spendable, and further capped at the feature's own
 * highEstimate to avoid Bob spending more than we modelled for this feature.
 */
export function featureWallet(
  budget: ProjectBudget,
  feature: Feature
): number {
  const spendable = spendableBudget(budget);
  return Math.min(spendable, feature.highEstimate);
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

/**
 * Return the next project state after a feature run.
 *
 * Rules:
 * - If UNSAFE → COMPRESS (unless no more pending features → LAND)
 * - If remaining pending features exist → stay in BUILD
 * - If no more pending features → LAND
 */
export function nextProjectState(
  budget: ProjectBudget,
  riskAfterRun: RiskState
): ProjectState {
  const hasPending = budget.features.some((f) => f.state === "pending");

  if (riskAfterRun === "UNSAFE") {
    return hasPending ? "COMPRESS" : "LAND";
  }
  return hasPending ? "BUILD" : "LAND";
}

/**
 * Record actual spend for a completed feature run and return an updated budget.
 * Does NOT mutate the input.
 */
export function recordFeatureSpend(
  budget: ProjectBudget,
  featureId: string,
  actualSpend: number
): ProjectBudget {
  const features = budget.features.map((f) =>
    f.id === featureId
      ? { ...f, spent: f.spent + actualSpend, state: "done" as const }
      : f
  );
  const updated: ProjectBudget = {
    ...budget,
    totalSpent: budget.totalSpent + actualSpend,
    features,
    activeFeatureId: null,
  };
  const risk = computeRiskState(updated);
  return {
    ...updated,
    state: nextProjectState(updated, risk),
  };
}

// ---------------------------------------------------------------------------
// Guard: can we start a feature?
// ---------------------------------------------------------------------------

/**
 * Returns true if the feature's highEstimate fits within spendable budget
 * without consuming the protected reserve.
 *
 * If false, caller must transition to COMPRESS or LAND instead.
 */
export function canStartFeature(
  budget: ProjectBudget,
  feature: Feature
): boolean {
  return feature.highEstimate <= spendableBudget(budget);
}
