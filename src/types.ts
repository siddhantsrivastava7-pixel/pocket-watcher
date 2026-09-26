/**
 * Pocket Watcher — core contract types
 *
 * Compute budget is provider-agnostic. For Bob V1 the unit is "bobcoin".
 * All monetary/compute values are plain numbers in the declared unit.
 */

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

/** Lifecycle state of the overall project. */
export type ProjectState =
  | "SCOPE"     // defining features, no spending yet
  | "PLAN"      // actively estimating/breaking down work
  | "BUILD"     // executing features
  | "COMPRESS"  // over budget — must cut scope
  | "LAND"      // minimal remaining — ship what we have
  | "SHIPPED";  // done

/** Risk level based on remaining forecast vs flexible spendable. */
export type RiskState = "SAFE" | "TIGHT" | "UNSAFE";

/** How the initial budget was established. */
export type BudgetMode = "auto" | "custom" | "manually_supplied";

// ---------------------------------------------------------------------------
// Compute-window model
// ---------------------------------------------------------------------------

/**
 * One compute window within a project.
 * A project may span multiple windows (e.g. across provider quota resets).
 */
export interface ComputeWindow {
  /** Sequential window number, starting at 1. */
  windowId: number;
  provider: "bob";
  unit: "bobcoin";
  budgetMode: BudgetMode;
  /** Provider remaining at the time this window was created (null if unknown). */
  providerRemainingAtStart: number | null;
  /** The budget actually assigned to this window. */
  assignedBudget: number;
  /** Total compute consumed in this window. */
  actualSpent: number;
  /** assignedBudget - actualSpent */
  remainingAssignedBudget: number;
  /** ISO timestamp when this window was opened. */
  createdAt: string;
  /** ISO timestamp when this window was closed (null if active). */
  closedAt: string | null;
}

// ---------------------------------------------------------------------------
// Protected reserves
// ---------------------------------------------------------------------------

/** Reserve floors — cannot be consumed by feature work. */
export interface Reserves {
  /** Minimum held for final critical validation (tests, typecheck). */
  validation: number;
  /** Minimum held for quick repair after validation failures. */
  repair: number;
  /** Minimum held for final integration / merge run. */
  integration: number;
}

// ---------------------------------------------------------------------------
// Phase allocation (dynamic — initial estimates only)
// ---------------------------------------------------------------------------

export interface PhaseAllocation {
  planning: number;
  implementation: number;
  integration: number;
  validation: number;
  repairLanding: number;
}

// ---------------------------------------------------------------------------
// Deterministic validation
// ---------------------------------------------------------------------------

/** Per-feature validation configuration. */
export interface ValidationConfig {
  /** Commands to run deterministically. Zero Bob cost. */
  commands: string[];
}

/** Result of running one validation command. */
export interface ValidationCommandResult {
  command: string;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  passed: boolean;
}

/** Aggregated result of running all validation commands for a feature. */
export interface ValidationResult {
  featureId: string | null;
  commands: ValidationCommandResult[];
  passed: boolean;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

export interface FeatureEstimate {
  low: number;
  high: number;
  /** "low" | "medium" | "high" */
  confidence: string;
}

/**
 * Feature status lifecycle.
 *
 * pending              — not yet run
 * running              — currently executing
 * done                 — completed + deterministic validation passed
 * deferred             — explicitly deferred by user (COMPRESS)
 * budget_interrupted   — Bob run stopped by cost limit
 * awaiting_validation  — Bob completed normally, no deterministic validation configured
 * validation_failed    — deterministic validation ran and one or more commands failed
 */
export type FeatureStatus =
  | "pending"
  | "running"
  | "done"
  | "deferred"
  | "budget_interrupted"
  | "awaiting_validation"
  | "validation_failed";

/** One candidate feature / task produced during scope. */
export interface Feature {
  id: string;
  name: string;
  goal: string;
  dependencies: string[];
  /** "must" | "should" | "could" */
  priority: string;
  estimate: FeatureEstimate;
  acceptance: string[];
  excluded: string[];
  status: FeatureStatus;
  /** Deterministic validation configuration (optional). */
  validation?: ValidationConfig;
  /** Actual compute consumed (0 until run). */
  actualSpent: number;
  /** Window in which this feature was last active. */
  windowId: number;
}

// ---------------------------------------------------------------------------
// Forecast
// ---------------------------------------------------------------------------

export interface Forecast {
  /** Sum of high estimates for unfinished must features. */
  remainingHighBC: number;
  /** Sum of low estimates for unfinished must features. */
  remainingLowBC: number;
  riskState: RiskState;
}

// ---------------------------------------------------------------------------
// Project-level validation
// ---------------------------------------------------------------------------

/** Optional project-level finishing checks (e.g. build, typecheck, tests). */
export interface ProjectValidationConfig {
  commands: string[];
}

// ---------------------------------------------------------------------------
// Ship Contract — persisted as .pocket/ship-contract.json
// ---------------------------------------------------------------------------

export interface ShipContract {
  // --- Project identity ---
  projectId: string;
  createdAt: string;
  updatedAt: string;

  // --- Current compute window ---
  currentWindow: ComputeWindow;

  /** All previous completed windows (immutable once closed). */
  previousWindows: ComputeWindow[];

  // --- Budget ---
  reserves: Reserves;
  phaseAllocation: PhaseAllocation;

  // --- Overshoot guard: subtracted from featureWallet before passing to bob --max-cost */
  overshootGuard: number;

  // --- Features ---
  features: Feature[];
  deferredFeatureIds: string[];
  activeFeatureId: string | null;

  // --- Forecast ---
  forecast: Forecast;

  // --- State ---
  state: ProjectState;

  // --- Optional project-level validation ---
  projectValidation?: ProjectValidationConfig;
}

// ---------------------------------------------------------------------------
// History (append-only .pocket/history.jsonl)
// ---------------------------------------------------------------------------

export interface HistoryEntry {
  windowId: number;
  timestamp: string;
  featureId: string | null;
  phase: string;
  predictedLow: number | null;
  predictedHigh: number | null;
  assignedWallet: number | null;
  bobMaxCost: number | null;
  realSessionCosts: number | null;
  durationMs: number | null;
  toolCalls: number | null;
  bobTaskId: string | null;
  normalCompletion: boolean;
  budgetInterrupted: boolean;
  finalFeatureStatus: string | null;
  stateBefore: ProjectState;
  stateAfter: ProjectState;
  note: string;
}

/** History entry for a deterministic validation event. */
export interface ValidationHistoryEntry {
  event: "validation";
  timestamp: string;
  featureId: string | null;
  commands: ValidationCommandResult[];
  passed: boolean;
  durationMs: number;
}

/** History entry for a repair run. */
export interface RepairHistoryEntry {
  event: "repair";
  timestamp: string;
  windowId: number;
  featureId: string;
  assignedRepairWallet: number;
  bobMaxCost: number;
  realSessionCosts: number;
  durationMs: number | null;
  toolCalls: number | null;
  bobTaskId: string | null;
  costLimitHit: boolean;
  validationPassed: boolean | null;
  finalFeatureStatus: FeatureStatus;
  note: string;
}

/** History entry for a project-level check. */
export interface ProjectCheckHistoryEntry {
  event: "project_check";
  timestamp: string;
  commands: ValidationCommandResult[];
  passed: boolean;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Bob runner types
// ---------------------------------------------------------------------------

/** The JSON result line emitted by `bob run --format json`. */
export interface BobResultLine {
  type: "result";
  timestamp: string;
  status: "success";
  stats: {
    task_id: string;
    duration_ms: number;
    /** Actual compute consumed by this session. */
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

export type BobOutputLine = BobResultLine | BobErrorLine | { type: string };

// ---------------------------------------------------------------------------
// Runner result
// ---------------------------------------------------------------------------

export interface RunResult {
  /** Actual compute consumed, from stats.session_costs. */
  actualCost: number;
  /** True if the cost-limit error event was detected in output. */
  costLimitHit: boolean;
  /** Process exit code. */
  exitCode: number;
  /** The raw result line, if present. */
  resultLine: BobResultLine | null;
  /** All parsed output lines. */
  allLines: BobOutputLine[];
}
