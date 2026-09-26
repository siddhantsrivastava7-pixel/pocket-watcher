/**
 * Pocket Watcher — budget engine V1
 *
 * Pure functions. No I/O. No side-effects. Fully deterministic.
 *
 * Compute budget is generic. For Bob V1 the unit is "bobcoin".
 */
import type { ShipContract, Feature, Reserves, RiskState, ProjectState, ComputeWindow, Forecast, PhaseAllocation, BudgetMode } from "./types.js";
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
 * Only counts "must" priority by default; includes all non-done features.
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
export declare function nextProjectState(contract: ShipContract, risk: RiskState): ProjectState;
/**
 * Record actual spend for a run and return an updated contract.
 * Does NOT mutate input.
 *
 * @param featureId   Feature that was run (null for planning/integration phases)
 * @param actualSpend Real session_costs from Bob
 * @param interrupted True if cost-limit event was detected
 */
export declare function recordSpend(contract: ShipContract, featureId: string | null, actualSpend: number, interrupted: boolean): ShipContract;
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
export declare function deferFeature(contract: ShipContract, featureId: string): ShipContract;
export declare function openNewWindow(contract: ShipContract, assignedBudget: number, providerRemainingAtStart: number | null, budgetMode: BudgetMode): ShipContract;
