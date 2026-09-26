/**
 * Pocket Watcher — budget engine V1
 *
 * Pure functions. No I/O. No side-effects. Fully deterministic.
 *
 * Compute budget is generic. For Bob V1 the unit is "bobcoin".
 */
import type { ShipContract, Feature, Reserves, RiskState, ProjectState, ComputeWindow, Forecast, PhaseAllocation, BudgetMode, FeatureStatus } from "./types.js";
/** Default overshoot guard subtracted from featureWallet before --max-cost. */
export declare const DEFAULT_OVERSHOOT_GUARD = 0.01;
/** Planning cap as a fraction of flexible spendable budget. */
export declare const PLANNING_BUDGET_FRACTION = 0.05;
/** Maximum planning budget regardless of window size. */
export declare const PLANNING_BUDGET_MAX = 1;
/** Default reserve floors. */
export declare const DEFAULT_RESERVES: Reserves;
/** Sum of all protected reserve floors. */
export declare function totalReserve(reserves: Reserves): number;
/** Remaining assigned budget for the current window. */
export declare function windowRemaining(w: ComputeWindow): number;
/**
 * Flexible spendable budget — remaining minus protected reserves.
 * Clamped to 0.
 */
export declare function spendableBudget(contract: ShipContract): number;
/**
 * Sum of high estimates for features that are not done/deferred.
 */
export declare function forecastHighRemaining(contract: ShipContract): number;
export declare function forecastLowRemaining(contract: ShipContract): number;
/**
 * Compute risk state.
 *
 * SAFE   — high forecast < 80% of spendable
 * TIGHT  — 80% ≤ forecast ≤ 100% of spendable
 * UNSAFE — forecast > 100% of spendable
 */
export declare function computeRiskState(contract: ShipContract): RiskState;
/** Build a fresh Forecast object from the current contract. */
export declare function buildForecast(contract: ShipContract): Forecast;
/**
 * Calculate the amount to pass to `bob run --max-cost`.
 *
 * featureWallet = min(feature.estimate.high, spendable)
 * bobMaxCost    = featureWallet - overshootGuard
 *
 * Never returns <= 0. Returns null if the safe wallet is too small.
 */
export declare function featureWallet(contract: ShipContract, feature: Feature): number;
export declare function bobMaxCost(contract: ShipContract, feature: Feature): number | null;
/**
 * Calculate the repair wallet available for a single repair run.
 *
 * Repair is funded ONLY from the repair reserve, not from feature spendable.
 * repairWallet = repair reserve - overshootGuard
 *
 * Returns null if the remaining reserve is too small to justify a repair run.
 */
export declare function repairWallet(contract: ShipContract): number | null;
export declare function planningWallet(contract: ShipContract): number;
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
export declare function resolveAssignedBudget(providerRemaining: number | null, userBudget: number | null): {
    assignedBudget: number;
    budgetMode: BudgetMode;
    capped: boolean;
    providerRemainingAtStart: number | null;
};
/**
 * Build the initial phase allocation given an assigned budget.
 * These are starting estimates only — not permanent buckets.
 */
export declare function buildInitialPhaseAllocation(assignedBudget: number, reserves: Reserves): PhaseAllocation;
/**
 * Returns true if a feature has a safe execution wallet.
 * bobMaxCost must be > 0 after subtracting overshoot guard.
 */
export declare function canStartFeature(contract: ShipContract, feature: Feature): boolean;
/**
 * Returns true if a feature is eligible for repair.
 *
 * Eligible statuses: validation_failed, budget_interrupted, awaiting_validation
 * The repair wallet must be > 0 after overshoot guard.
 */
export declare function canRepairFeature(contract: ShipContract, feature: Feature): boolean;
export declare function nextProjectState(contract: ShipContract, risk: RiskState): ProjectState;
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
export declare function recordSpend(contract: ShipContract, featureId: string | null, actualSpend: number, interrupted: boolean): ShipContract;
/**
 * Record actual spend from a repair run.
 * Repair budget comes from the repair reserve — does not affect feature spendable.
 * After repair spend is recorded, caller must run validation to finalize status.
 */
export declare function recordRepairSpend(contract: ShipContract, featureId: string, actualSpend: number, interrupted: boolean): ShipContract;
/**
 * Update a single feature's status (e.g., after validation runs).
 * Does NOT mutate input.
 */
export declare function setFeatureStatus(contract: ShipContract, featureId: string, status: FeatureStatus): ShipContract;
/**
 * If a feature overran its high estimate, apply a burn factor to all
 * remaining unfinished features of the same priority tier.
 *
 * burnFactor = actualSpend / highEstimate  (only when > 1.0)
 *
 * V1 implementation: simple deterministic adjustment.
 * Does NOT mutate input.
 */
export declare function applyBurnFactorReforecast(contract: ShipContract, completedFeatureId: string, actualSpend: number): ShipContract;
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
export declare function applyBurnFactorReforecastAfterValidation(contract: ShipContract, completedFeatureId: string): ShipContract;
export declare function deferFeature(contract: ShipContract, featureId: string): ShipContract;
export declare function openNewWindow(contract: ShipContract, assignedBudget: number, providerRemainingAtStart: number | null, budgetMode: BudgetMode): ShipContract;
