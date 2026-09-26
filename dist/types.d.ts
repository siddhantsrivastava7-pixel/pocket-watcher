/**
 * Pocket Watcher — core contract types
 *
 * All monetary values are in Bobcoins (floating-point).
 */
/** Lifecycle state of the overall project. */
export type ProjectState = "SCOPE" | "PLAN" | "BUILD" | "COMPRESS" | "LAND" | "SHIPPED";
/** Risk level for the active feature. */
export type RiskState = "SAFE" | "TIGHT" | "UNSAFE";
/** The reserves that are always protected from Bob. */
export interface Reserves {
    /** Bobcoins held for final validation pass (tests, type-check). */
    validation: number;
    /** Bobcoins held for quick fix after validation failures. */
    repair: number;
    /** Bobcoins held for final integration / merge run. */
    integration: number;
}
/** One feature entry in the project. */
export interface Feature {
    id: string;
    title: string;
    /** Conservative high estimate in Bobcoins. */
    highEstimate: number;
    /** Actual Bobcoins spent on this feature (0 until run). */
    spent: number;
    state: "pending" | "running" | "done" | "skipped";
}
/** Top-level project budget contract — stored as pocket.json. */
export interface ProjectBudget {
    /** Total Bobcoins the user started with. */
    startingBudget: number;
    /** Total Bobcoins consumed so far across all features. */
    totalSpent: number;
    reserves: Reserves;
    /** All features in priority order. */
    features: Feature[];
    /** Current lifecycle state. */
    state: ProjectState;
    /** ID of the feature currently being executed, or null. */
    activeFeatureId: string | null;
}
/** The JSON lines emitted by `bob run --format json`. */
export interface BobResultLine {
    type: "result";
    timestamp: string;
    status: "success";
    stats: {
        task_id: string;
        duration_ms: number;
        /** Actual Bobcoins consumed by this session. */
        session_costs: number;
        max_cost: number;
        tool_calls: number;
    };
    last_message: string | null;
}
export interface BobErrorLine {
    type: "error";
    timestamp: string;
    severity: string;
    message: string;
}
export type BobOutputLine = BobResultLine | BobErrorLine | {
    type: string;
};
