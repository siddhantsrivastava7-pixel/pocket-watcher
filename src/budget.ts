/**
 * Pocket Watcher — budget engine V1
 *
 * Pure functions. No I/O. No side-effects. Fully deterministic.
 *
 * Compute budget is generic. For Bob V1 the unit is "bobcoin".
 */

import type {
  ShipContract,
  Feature,
  Reserves,
  RiskState,
  ProjectState,
  ComputeWindow,
  Forecast,
  PhaseAllocation,
  BudgetMode,
  FeatureStatus,
} from "./types.js";

// ---------------------------------------------------------------------------
// Default configuration constants
// ---------------------------------------------------------------------------

/** Default overshoot guard subtracted from featureWallet before --max-cost. */
export const DEFAULT_OVERSHOOT_GUARD = 0.01;

/** Planning cap as a fraction of flexible spendable budget. */
export const PLANNING_BUDGET_FRACTION = 0.05;

/** Maximum planning budget regardless of window size. */
export const PLANNING_BUDGET_MAX = 1.0;

/** Default reserve floors. */
export const DEFAULT_RESERVES: Reserves = {
  validation: 0.5,
  repair: 0.25,
  integration: 0.25,
};

// ---------------------------------------------------------------------------
// Compute-window helpers
// ---------------------------------------------------------------------------

/** Sum of all protected reserve floors. */
export function totalReserve(reserves: Reserves): number {
  return reserves.validation + reserves.repair + reserves.integration;
}

/** Remaining assigned budget for the current window. */
export function windowRemaining(w: ComputeWindow): number {
  return w.assignedBudget - w.actualSpent;
}

/**
 * Flexible spendable budget — remaining minus protected reserves.
 * Clamped to 0.
 */
export function spendableBudget(contract: ShipContract): number {
  const rem = windowRemaining(contract.currentWindow);
  return Math.max(0, rem - totalReserve(contract.reserves));
}

// ---------------------------------------------------------------------------
// Forecast
// ---------------------------------------------------------------------------

/**
 * Statuses that count as "still needing work" for forecast purposes.
 * awaiting_validation and validation_failed are not fully done.
 */
const UNFINISHED_STATUSES: FeatureStatus[] = [
  "pending",
  "running",
  "budget_interrupted",
  "awaiting_validation",
  "validation_failed",
];

/**
 * Sum of high estimates for features that are not done/deferred.
 */
export function forecastHighRemaining(contract: ShipContract): number {
  return contract.features
    .filter((f) => UNFINISHED_STATUSES.includes(f.status))
    .reduce((sum, f) => sum + f.estimate.high, 0);
}

export function forecastLowRemaining(contract: ShipContract): number {
  return contract.features
    .filter((f) => UNFINISHED_STATUSES.includes(f.status))
    .reduce((sum, f) => sum + f.estimate.low, 0);
}

// ---------------------------------------------------------------------------
// Risk state
// ---------------------------------------------------------------------------

/**
 * Compute risk state.
 *
 * SAFE   — high forecast < 80% of spendable
 * TIGHT  — 80% ≤ forecast ≤ 100% of spendable
 * UNSAFE — forecast > 100% of spendable
 */
export function computeRiskState(contract: ShipContract): RiskState {
  const spendable = spendableBudget(contract);
  if (spendable <= 0) return "UNSAFE";
  const forecast = forecastHighRemaining(contract);
  const ratio = forecast / spendable;
  if (ratio > 1.0) return "UNSAFE";
  if (ratio >= 0.8) return "TIGHT";
  return "SAFE";
}

/** Build a fresh Forecast object from the current contract. */
export function buildForecast(contract: ShipContract): Forecast {
  return {
    remainingHighBC: forecastHighRemaining(contract),
    remainingLowBC: forecastLowRemaining(contract),
    riskState: computeRiskState(contract),
  };
}

// ---------------------------------------------------------------------------
// Feature wallet
// ---------------------------------------------------------------------------

/**
 * Calculate the amount to pass to `bob run --max-cost`.
 *
 * featureWallet = min(feature.estimate.high, spendable)
 * bobMaxCost    = featureWallet - overshootGuard
 *
 * Never returns <= 0. Returns null if the safe wallet is too small.
 */
export function featureWallet(
  contract: ShipContract,
  feature: Feature
): number {
  const spendable = spendableBudget(contract);
  return Math.min(spendable, feature.estimate.high);
}

export function bobMaxCost(
  contract: ShipContract,
  feature: Feature
): number | null {
  const wallet = featureWallet(contract, feature);
  const safe = wallet - contract.overshootGuard;
  if (safe <= 0) return null;
  return safe;
}

// ---------------------------------------------------------------------------
// Repair wallet (from repair reserve only)
// ---------------------------------------------------------------------------

/**
 * Calculate the repair wallet available for a single repair run.
 *
 * Repair is funded ONLY from the repair reserve, not from feature spendable.
 * repairWallet = repair reserve - overshootGuard
 *
 * Returns null if the remaining reserve is too small to justify a repair run.
 */
export function repairWallet(
  contract: ShipContract
): number | null {
  const available = Math.min(
    contract.reserves.repair,
    Math.max(0, windowRemaining(contract.currentWindow))
  );
  const safe = available - contract.overshootGuard;
  if (safe <= 0) return null;
  return safe;
}

// ---------------------------------------------------------------------------
// Planning wallet
// ---------------------------------------------------------------------------

export function planningWallet(contract: ShipContract): number {
  const spendable = spendableBudget(contract);
  const pct = PLANNING_BUDGET_FRACTION * spendable;
  return Math.min(pct, PLANNING_BUDGET_MAX);
}

// ---------------------------------------------------------------------------
// Budget acquisition helpers
// ---------------------------------------------------------------------------

/**
 * Determine assigned budget given provider remaining and optional user cap.
 *
 * Rules:
 * - If userBudget is null: use providerRemaining (auto mode)
 * - If userBudget <= providerRemaining: use userBudget (custom mode)
 * - If userBudget >  providerRemaining: clamp to providerRemaining
 *
 * Returns { assignedBudget, budgetMode, capped }
 */
export function resolveAssignedBudget(
  providerRemaining: number | null,
  userBudget: number | null
): {
  assignedBudget: number;
  budgetMode: BudgetMode;
  capped: boolean;
  providerRemainingAtStart: number | null;
} {
  if (
    providerRemaining !== null &&
    (!Number.isFinite(providerRemaining) || providerRemaining <= 0)
  ) {
    throw new Error("providerRemaining must be a positive finite number");
  }
  if (
    userBudget !== null &&
    (!Number.isFinite(userBudget) || userBudget <= 0)
  ) {
    throw new Error("userBudget must be a positive finite number");
  }

  if (userBudget === null) {
    // auto mode
    if (providerRemaining === null) {
      throw new Error("providerRemaining is required for auto mode");
    }
    return {
      assignedBudget: providerRemaining,
      budgetMode: "auto",
      capped: false,
      providerRemainingAtStart: providerRemaining,
    };
  }

  if (providerRemaining === null) {
    // user budget, no provider info — trust user budget directly
    return {
      assignedBudget: userBudget,
      budgetMode: "custom",
      capped: false,
      providerRemainingAtStart: null,
    };
  }

  // custom: cap at provider remaining
  const capped = userBudget > providerRemaining;
  return {
    assignedBudget: Math.min(userBudget, providerRemaining),
    budgetMode: "custom",
    capped,
    providerRemainingAtStart: providerRemaining,
  };
}

/**
 * Build the initial phase allocation given an assigned budget.
 * These are starting estimates only — not permanent buckets.
 */
export function buildInitialPhaseAllocation(
  assignedBudget: number,
  reserves: Reserves
): PhaseAllocation {
  const flexTotal = Math.max(0, assignedBudget - totalReserve(reserves));
  return {
    planning: Math.min(PLANNING_BUDGET_MAX, PLANNING_BUDGET_FRACTION * flexTotal),
    implementation: flexTotal * 0.7,
    integration: reserves.integration,
    validation: reserves.validation,
    repairLanding: reserves.repair,
  };
}

// ---------------------------------------------------------------------------
// canStartFeature
// ---------------------------------------------------------------------------

/**
 * Returns true if a feature has a safe execution wallet.
 * bobMaxCost must be > 0 after subtracting overshoot guard.
 */
export function canStartFeature(
  contract: ShipContract,
  feature: Feature
): boolean {
  const maxCost = bobMaxCost(contract, feature);
  return maxCost !== null && maxCost > 0;
}

// ---------------------------------------------------------------------------
// canRepairFeature
// ---------------------------------------------------------------------------

/**
 * Returns true if a feature is eligible for repair.
 *
 * Eligible statuses: validation_failed, budget_interrupted, awaiting_validation
 * The repair wallet must be > 0 after overshoot guard.
 */
export function canRepairFeature(
  contract: ShipContract,
  feature: Feature
): boolean {
  const eligibleStatuses: FeatureStatus[] = [
    "validation_failed",
    "budget_interrupted",
    "awaiting_validation",
  ];
  if (!eligibleStatuses.includes(feature.status)) return false;
  const wallet = repairWallet(contract);
  return wallet !== null && wallet > 0;
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

export function nextProjectState(
  contract: ShipContract,
  risk: RiskState
): ProjectState {
  // LAND is an explicit one-way finishing decision within a compute window.
  // Validation and repair may update risk, but must never reopen feature work.
  if (contract.state === "LAND" || contract.state === "SHIPPED") {
    return contract.state;
  }

  const hasPending = contract.features.some(
    (f) =>
      f.status === "pending" ||
      f.status === "budget_interrupted" ||
      f.status === "awaiting_validation" ||
      f.status === "validation_failed"
  );
  if (risk === "UNSAFE") {
    return hasPending ? "COMPRESS" : "LAND";
  }
  return hasPending ? "BUILD" : "LAND";
}

// ---------------------------------------------------------------------------
// Record spend + reforecast (after a Bob run)
// ---------------------------------------------------------------------------

/**
 * Record actual spend for a run and return an updated contract.
 * Does NOT mutate input.
 *
 * After a non-interrupted Bob run, the feature is NOT marked done.
 * It is set to awaiting_validation (no deterministic validation configured)
 * or left for the caller to update after running validation.
 *
 * @param featureId   Feature that was run (null for planning/integration phases)
 * @param actualSpend Real session_costs from Bob
 * @param interrupted True if cost-limit event was detected
 */
export function recordSpend(
  contract: ShipContract,
  featureId: string | null,
  actualSpend: number,
  interrupted: boolean
): ShipContract {
  if (!Number.isFinite(actualSpend) || actualSpend < 0) {
    throw new Error("actualSpend must be a non-negative finite number");
  }
  // Update window spend
  const updatedWindow: ComputeWindow = {
    ...contract.currentWindow,
    actualSpent: contract.currentWindow.actualSpent + actualSpend,
    remainingAssignedBudget:
      contract.currentWindow.remainingAssignedBudget - actualSpend,
  };

  // Update feature
  let updatedFeatures = contract.features;
  if (featureId !== null) {
    updatedFeatures = contract.features.map((f) => {
      if (f.id !== featureId) return f;
      if (interrupted) {
        return { ...f, actualSpent: f.actualSpent + actualSpend, status: "budget_interrupted" as const };
      }
      // Not interrupted — do NOT mark done. Set awaiting_validation so
      // the caller must run deterministic validation before done.
      return { ...f, actualSpent: f.actualSpent + actualSpend, status: "awaiting_validation" as const };
    });
  }

  const partialContract: ShipContract = {
    ...contract,
    currentWindow: updatedWindow,
    features: updatedFeatures,
    activeFeatureId: null,
    updatedAt: new Date().toISOString(),
  };

  // Reforecast and risk
  const forecast = buildForecast(partialContract);
  const risk = forecast.riskState;
  const state = nextProjectState(partialContract, risk);

  return {
    ...partialContract,
    forecast,
    state,
  };
}

/**
 * Record actual spend from a repair run.
 * Repair budget comes from the repair reserve — does not affect feature spendable.
 * After repair spend is recorded, caller must run validation to finalize status.
 */
export function recordRepairSpend(
  contract: ShipContract,
  featureId: string,
  actualSpend: number,
  interrupted: boolean
): ShipContract {
  if (!Number.isFinite(actualSpend) || actualSpend < 0) {
    throw new Error("actualSpend must be a non-negative finite number");
  }
  // Deduct from the repair reserve
  const newRepairReserve = Math.max(0, contract.reserves.repair - actualSpend);
  const updatedReserves: typeof contract.reserves = {
    ...contract.reserves,
    repair: newRepairReserve,
  };

  // Update window spend (repair still consumes real compute)
  const updatedWindow: ComputeWindow = {
    ...contract.currentWindow,
    actualSpent: contract.currentWindow.actualSpent + actualSpend,
    remainingAssignedBudget:
      contract.currentWindow.remainingAssignedBudget - actualSpend,
  };

  // Update feature spend but leave status for validation to determine
  const updatedFeatures = contract.features.map((f) => {
    if (f.id !== featureId) return f;
    if (interrupted) {
      return { ...f, actualSpent: f.actualSpent + actualSpend, status: "budget_interrupted" as const };
    }
    return { ...f, actualSpent: f.actualSpent + actualSpend, status: "awaiting_validation" as const };
  });

  const partialContract: ShipContract = {
    ...contract,
    currentWindow: updatedWindow,
    reserves: updatedReserves,
    features: updatedFeatures,
    activeFeatureId: null,
    updatedAt: new Date().toISOString(),
  };

  const forecast = buildForecast(partialContract);
  return {
    ...partialContract,
    forecast,
    state: nextProjectState(partialContract, forecast.riskState),
  };
}

/**
 * Update a single feature's status (e.g., after validation runs).
 * Does NOT mutate input.
 */
export function setFeatureStatus(
  contract: ShipContract,
  featureId: string,
  status: FeatureStatus
): ShipContract {
  const updatedFeatures = contract.features.map((f) =>
    f.id === featureId ? { ...f, status } : f
  );
  const partialContract: ShipContract = {
    ...contract,
    features: updatedFeatures,
    updatedAt: new Date().toISOString(),
  };
  const forecast = buildForecast(partialContract);
  return {
    ...partialContract,
    forecast,
    state: nextProjectState(partialContract, forecast.riskState),
  };
}

// ---------------------------------------------------------------------------
// Burn-factor reforecast
// ---------------------------------------------------------------------------

/**
 * If a feature overran its high estimate, apply a burn factor to all
 * remaining unfinished features of the same priority tier.
 *
 * burnFactor = actualSpend / highEstimate  (only when > 1.0)
 *
 * V1 implementation: simple deterministic adjustment.
 * Does NOT mutate input.
 */
export function applyBurnFactorReforecast(
  contract: ShipContract,
  completedFeatureId: string,
  actualSpend: number
): ShipContract {
  const completed = contract.features.find((f) => f.id === completedFeatureId);
  if (!completed) return contract;

  // Guard: never apply the burn factor for this feature twice.
  // burnFactorApplied is set true the first time we apply; subsequent calls are no-ops.
  if (completed.burnFactorApplied) return contract;

  const burnFactor = actualSpend / completed.estimate.high;
  if (burnFactor <= 1.0) {
    // Underrun — no adjustment to other features, but still mark as applied
    // so that re-validation cannot trigger the check again.
    const updatedFeatures = contract.features.map((f) =>
      f.id === completedFeatureId ? { ...f, burnFactorApplied: true } : f
    );
    return { ...contract, features: updatedFeatures };
  }

  const updatedFeatures = contract.features.map((f) => {
    if (f.id === completedFeatureId) return { ...f, burnFactorApplied: true };
    if (f.status !== "pending") return f;
    return {
      ...f,
      estimate: {
        ...f.estimate,
        high: f.estimate.high * burnFactor,
        low: f.estimate.low * burnFactor,
      },
    };
  });

  const partialContract = { ...contract, features: updatedFeatures };
  const forecast = buildForecast(partialContract);
  return {
    ...partialContract,
    forecast,
    state: nextProjectState(partialContract, forecast.riskState),
  };
}

/**
 * Apply burn-factor reforecast after an interrupted run is later proven done
 * by deterministic validation.
 *
 * Call this when:
 *   1. A managed feature run recorded real `stats.session_costs`
 *   2. The run was budget_interrupted
 *   3. Deterministic validation subsequently proves the feature is done
 *
 * Uses the feature's accumulated actualSpent as the authoritative cost evidence.
 * Guards against double-counting: if burnFactorApplied is already true, no-op.
 * Does NOT mutate input.
 */
export function applyBurnFactorReforecastAfterValidation(
  contract: ShipContract,
  completedFeatureId: string
): ShipContract {
  const completed = contract.features.find((f) => f.id === completedFeatureId);
  if (!completed) return contract;

  // Only applies when the feature was previously budget_interrupted and is now done.
  if (completed.status !== "done") return contract;

  // Use the feature's accumulated actual spend as the cost evidence.
  const actualSpend = completed.actualSpent;
  if (actualSpend <= 0) return contract;

  // Delegate to the main function (which includes the double-apply guard).
  return applyBurnFactorReforecast(contract, completedFeatureId, actualSpend);
}

// ---------------------------------------------------------------------------
// Defer a feature
// ---------------------------------------------------------------------------

export function deferFeature(
  contract: ShipContract,
  featureId: string
): ShipContract {
  const updatedFeatures = contract.features.map((f) =>
    f.id === featureId ? { ...f, status: "deferred" as const } : f
  );
  const deferredIds = contract.deferredFeatureIds.includes(featureId)
    ? contract.deferredFeatureIds
    : [...contract.deferredFeatureIds, featureId];

  const partialContract: ShipContract = {
    ...contract,
    features: updatedFeatures,
    deferredFeatureIds: deferredIds,
    updatedAt: new Date().toISOString(),
  };
  const forecast = buildForecast(partialContract);
  return {
    ...partialContract,
    forecast,
    state: nextProjectState(partialContract, forecast.riskState),
  };
}

// ---------------------------------------------------------------------------
// Create a new compute window (for pocket resume)
// ---------------------------------------------------------------------------

export function openNewWindow(
  contract: ShipContract,
  assignedBudget: number,
  providerRemainingAtStart: number | null,
  budgetMode: BudgetMode
): ShipContract {
  if (!Number.isFinite(assignedBudget) || assignedBudget <= 0) {
    throw new Error("assignedBudget must be a positive finite number");
  }
  const closedWindow: ComputeWindow = {
    ...contract.currentWindow,
    closedAt: new Date().toISOString(),
  };

  const newWindow: ComputeWindow = {
    windowId: contract.currentWindow.windowId + 1,
    provider: "bob",
    unit: "bobcoin",
    budgetMode,
    providerRemainingAtStart,
    assignedBudget,
    actualSpent: 0,
    remainingAssignedBudget: assignedBudget,
    createdAt: new Date().toISOString(),
    closedAt: null,
  };

  // Reset interrupted features back to pending for the new window
  const updatedFeatures = contract.features.map((f) =>
    f.status === "budget_interrupted"
      ? { ...f, status: "pending" as const, windowId: newWindow.windowId }
      : f
  );

  const partialContract: ShipContract = {
    ...contract,
    currentWindow: newWindow,
    previousWindows: [...contract.previousWindows, closedWindow],
    features: updatedFeatures,
    updatedAt: new Date().toISOString(),
  };

  const forecast = buildForecast(partialContract);
  return {
    ...partialContract,
    forecast,
    state: "BUILD",
  };
}
