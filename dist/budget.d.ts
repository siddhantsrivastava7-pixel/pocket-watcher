/**
 * Pocket Watcher — budget engine
 *
 * Pure functions. No I/O, no side-effects. Fully deterministic.
 */
import type { ProjectBudget, Feature, Reserves, RiskState, ProjectState } from "./types.js";
/** Total protected reserve (sum of all three reserve buckets). */
export declare function totalReserve(reserves: Reserves): number;
/** Remaining budget (starting - total spent). */
export declare function remainingBudget(budget: ProjectBudget): number;
/**
 * Spendable budget — what Bob is actually allowed to touch.
 * spendable = remaining - protected reserves
 * Clamped to 0 (never negative).
 */
export declare function spendableBudget(budget: ProjectBudget): number;
/**
 * Sum of highEstimates for all features not yet done/skipped.
 */
export declare function forecastRemaining(budget: ProjectBudget): number;
/**
 * Compute risk state for the current project.
 *
 * SAFE   — forecast < 80% of spendable
 * TIGHT  — 80% ≤ forecast ≤ 100% of spendable
 * UNSAFE — forecast > 100% of spendable
 */
export declare function computeRiskState(budget: ProjectBudget): RiskState;
/**
 * Compute the maximum Bobcoins to pass to `bob run --max-cost` for a feature.
 *
 * We never expose the full remaining budget to Bob.
 * The wallet is capped at spendable, and further capped at the feature's own
 * highEstimate to avoid Bob spending more than we modelled for this feature.
 */
export declare function featureWallet(budget: ProjectBudget, feature: Feature): number;
/**
 * Return the next project state after a feature run.
 *
 * Rules:
 * - If UNSAFE → COMPRESS (unless no more pending features → LAND)
 * - If remaining pending features exist → stay in BUILD
 * - If no more pending features → LAND
 */
export declare function nextProjectState(budget: ProjectBudget, riskAfterRun: RiskState): ProjectState;
/**
 * Record actual spend for a completed feature run and return an updated budget.
 * Does NOT mutate the input.
 */
export declare function recordFeatureSpend(budget: ProjectBudget, featureId: string, actualSpend: number): ProjectBudget;
/**
 * Returns true if the feature's highEstimate fits within spendable budget
 * without consuming the protected reserve.
 *
 * If false, caller must transition to COMPRESS or LAND instead.
 */
export declare function canStartFeature(budget: ProjectBudget, feature: Feature): boolean;
