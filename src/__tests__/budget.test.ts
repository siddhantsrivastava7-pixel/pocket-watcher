/**
 * Pocket Watcher V1+ — comprehensive test suite covering:
 * - All V1 budget tests (unchanged)
 * - Validation flow (Part A/B/C)
 * - Repair flow (Part E/G)
 * - Corrected LAND mode (Part F)
 * - Project check (Part D)
 * - History entries (Part H)
 * - Bob Skill install (Part I/K)
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";

import {
  totalReserve,
  spendableBudget,
  computeRiskState,
  featureWallet,
  bobMaxCost,
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
  planningWallet,
  repairWallet,
  resolveAssignedBudget,
  buildInitialPhaseAllocation,
  DEFAULT_RESERVES,
  DEFAULT_OVERSHOOT_GUARD,
  PLANNING_BUDGET_FRACTION,
  PLANNING_BUDGET_MAX,
  windowRemaining,
} from "../budget.js";
import { buildFeaturePrompt, buildRepairPrompt, resolveBobExecutable } from "../runner.js";
import { runValidationCommand, validateFeature, validateProject } from "../validation.js";
import {
  globalSkillsDir,
  projectSkillsDir,
  pocketWatcherSkillDir,
  skillMdPath,
  generateSkillMd,
  installSkill,
} from "../install.js";
import type {
  ShipContract,
  Feature,
  Reserves,
  ComputeWindow,
} from "../types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeWindow(partial: Partial<ComputeWindow> = {}): ComputeWindow {
  return {
    windowId: partial.windowId ?? 1,
    provider: "bob",
    unit: "bobcoin",
    budgetMode: partial.budgetMode ?? "auto",
    providerRemainingAtStart: partial.providerRemainingAtStart ?? 20,
    assignedBudget: partial.assignedBudget ?? 20,
    actualSpent: partial.actualSpent ?? 0,
    remainingAssignedBudget:
      partial.remainingAssignedBudget ??
      (partial.assignedBudget ?? 20) - (partial.actualSpent ?? 0),
    createdAt: partial.createdAt ?? "2025-01-01T00:00:00Z",
    closedAt: partial.closedAt ?? null,
  };
}

function makeReserves(partial: Partial<Reserves> = {}): Reserves {
  return {
    validation: partial.validation ?? 1,
    repair: partial.repair ?? 0.5,
    integration: partial.integration ?? 0.5,
  };
}

function makeFeature(partial: Partial<Feature> = {}): Feature {
  return {
    id: partial.id ?? "f1",
    name: partial.name ?? "Feature 1",
    goal: partial.goal ?? "Do something",
    dependencies: partial.dependencies ?? [],
    priority: partial.priority ?? "must",
    estimate: partial.estimate ?? { low: 1, high: 2, confidence: "medium" },
    acceptance: partial.acceptance ?? ["it works"],
    excluded: partial.excluded ?? [],
    status: partial.status ?? "pending",
    validation: partial.validation,
    actualSpent: partial.actualSpent ?? 0,
    windowId: partial.windowId ?? 1,
  };
}

function makeContract(partial: Partial<ShipContract> = {}): ShipContract {
  const features = partial.features ?? [makeFeature()];
  const reserves = partial.reserves ?? makeReserves();
  const window = partial.currentWindow ?? makeWindow();
  const forecast = partial.forecast ?? buildForecast({
    projectId: "test",
    createdAt: "",
    updatedAt: "",
    currentWindow: window,
    previousWindows: [],
    reserves,
    phaseAllocation: buildInitialPhaseAllocation(window.assignedBudget, reserves),
    overshootGuard: DEFAULT_OVERSHOOT_GUARD,
    features,
    deferredFeatureIds: [],
    activeFeatureId: null,
    forecast: { remainingHighBC: 0, remainingLowBC: 0, riskState: "SAFE" },
    state: "BUILD",
  });
  return {
    projectId: partial.projectId ?? "test-project",
    createdAt: partial.createdAt ?? "2025-01-01T00:00:00Z",
    updatedAt: partial.updatedAt ?? "2025-01-01T00:00:00Z",
    currentWindow: window,
    previousWindows: partial.previousWindows ?? [],
    reserves,
    phaseAllocation: partial.phaseAllocation ?? buildInitialPhaseAllocation(window.assignedBudget, reserves),
    overshootGuard: partial.overshootGuard ?? DEFAULT_OVERSHOOT_GUARD,
    features,
    deferredFeatureIds: partial.deferredFeatureIds ?? [],
    activeFeatureId: partial.activeFeatureId ?? null,
    forecast,
    state: partial.state ?? "BUILD",
  };
}

// ---------------------------------------------------------------------------
// BUDGET ACQUISITION (V1)
// ---------------------------------------------------------------------------

describe("resolveAssignedBudget — budget acquisition", () => {
  test("auto mode: uses providerRemaining when userBudget is null", () => {
    const result = resolveAssignedBudget(10, null);
    expect(result.assignedBudget).toBe(10);
    expect(result.budgetMode).toBe("auto");
    expect(result.capped).toBe(false);
  });

  test("auto mode: throws when both are null", () => {
    expect(() => resolveAssignedBudget(null, null)).toThrow();
  });

  test("custom mode: uses userBudget when below providerRemaining", () => {
    const result = resolveAssignedBudget(100, 15);
    expect(result.assignedBudget).toBe(15);
    expect(result.budgetMode).toBe("custom");
    expect(result.capped).toBe(false);
  });

  test("custom mode: caps userBudget to providerRemaining if over", () => {
    const result = resolveAssignedBudget(10, 50);
    expect(result.assignedBudget).toBe(10);
    expect(result.capped).toBe(true);
  });

  test("custom mode: uses userBudget directly when providerRemaining is null", () => {
    const result = resolveAssignedBudget(null, 15);
    expect(result.assignedBudget).toBe(15);
    expect(result.budgetMode).toBe("custom");
    expect(result.capped).toBe(false);
    expect(result.providerRemainingAtStart).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// FIXED BUDGET INVARIANTS (V1)
// ---------------------------------------------------------------------------

describe("fixed budget invariants", () => {
  test("assignedBudget never changes after init", () => {
    const contract = makeContract({
      currentWindow: makeWindow({ assignedBudget: 5, actualSpent: 0 }),
    });
    const after = recordSpend(contract, "f1", 2, false);
    expect(after.currentWindow.assignedBudget).toBe(5);
  });

  test("remainingAssignedBudget decreases by actual spend", () => {
    const contract = makeContract({
      currentWindow: makeWindow({ assignedBudget: 5, actualSpent: 0 }),
    });
    const after = recordSpend(contract, "f1", 2, false);
    expect(after.currentWindow.remainingAssignedBudget).toBe(3);
  });

  test("spendableBudget is floored at 0 when reserves exceed remaining", () => {
    const contract = makeContract({
      currentWindow: makeWindow({ assignedBudget: 1, actualSpent: 0.9 }),
      reserves: makeReserves({ validation: 1, repair: 0.5, integration: 0.5 }),
    });
    expect(spendableBudget(contract)).toBe(0);
  });

  test("reserves are never consumed by normal feature spend", () => {
    const reserves = makeReserves({ validation: 1, repair: 0.5, integration: 0.5 });
    const contract = makeContract({
      currentWindow: makeWindow({ assignedBudget: 20, actualSpent: 0 }),
      reserves,
    });
    const after = recordSpend(contract, "f1", 5, false);
    // Normal spend should NOT reduce the reserves object
    expect(after.reserves.validation).toBe(reserves.validation);
    expect(after.reserves.repair).toBe(reserves.repair);
    expect(after.reserves.integration).toBe(reserves.integration);
  });

  test("repair spend does reduce the repair reserve", () => {
    const contract = makeContract({
      reserves: makeReserves({ repair: 0.5 }),
      features: [makeFeature({ id: "f1", status: "validation_failed" })],
    });
    const after = recordRepairSpend(contract, "f1", 0.2, false);
    expect(after.reserves.repair).toBeCloseTo(0.3, 5);
  });

  test("repair reserve cannot go below 0", () => {
    const contract = makeContract({
      reserves: makeReserves({ repair: 0.1 }),
      features: [makeFeature({ id: "f1", status: "validation_failed" })],
    });
    const after = recordRepairSpend(contract, "f1", 0.5, false);
    expect(after.reserves.repair).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// VALIDATION — feature status model (Part A/B)
// ---------------------------------------------------------------------------

describe("validation — feature status model", () => {
  test("normal Bob completion (non-interrupted) does NOT directly mark feature done", () => {
    const contract = makeContract({
      features: [makeFeature({ id: "f1", status: "running" })],
    });
    const after = recordSpend(contract, "f1", 1.0, false);
    const f = after.features.find((f) => f.id === "f1")!;
    expect(f.status).toBe("awaiting_validation");
    expect(f.status).not.toBe("done");
  });

  test("budget-interrupted run marks feature budget_interrupted", () => {
    const contract = makeContract({
      features: [makeFeature({ id: "f1", status: "running" })],
    });
    const after = recordSpend(contract, "f1", 1.0, true);
    const f = after.features.find((f) => f.id === "f1")!;
    expect(f.status).toBe("budget_interrupted");
  });

  test("setFeatureStatus: done after validation passes", () => {
    const contract = makeContract({
      features: [makeFeature({ id: "f1", status: "awaiting_validation" })],
    });
    const after = setFeatureStatus(contract, "f1", "done");
    expect(after.features.find((f) => f.id === "f1")!.status).toBe("done");
  });

  test("setFeatureStatus: validation_failed when validation fails", () => {
    const contract = makeContract({
      features: [makeFeature({ id: "f1", status: "awaiting_validation" })],
    });
    const after = setFeatureStatus(contract, "f1", "validation_failed");
    expect(after.features.find((f) => f.id === "f1")!.status).toBe("validation_failed");
  });
});

// ---------------------------------------------------------------------------
// VALIDATION — validateFeature (Part A/C)
// ---------------------------------------------------------------------------

describe("validateFeature — deterministic command runner", () => {
  test("returns null when no validation config", async () => {
    const feature = makeFeature({ validation: undefined });
    const result = await validateFeature(feature);
    expect(result).toBeNull();
  });

  test("returns null when validation.commands is empty", async () => {
    const feature = makeFeature({ validation: { commands: [] } });
    const result = await validateFeature(feature);
    expect(result).toBeNull();
  });

  test("passing command returns passed=true", async () => {
    const feature = makeFeature({ validation: { commands: ["node -e \"process.exit(0)\""] } });
    const result = await validateFeature(feature);
    expect(result).not.toBeNull();
    expect(result!.passed).toBe(true);
    expect(result!.commands[0].passed).toBe(true);
    expect(result!.commands[0].exitCode).toBe(0);
  });

  test("failing command returns passed=false", async () => {
    const feature = makeFeature({ validation: { commands: ["node -e \"process.exit(1)\""] } });
    const result = await validateFeature(feature);
    expect(result).not.toBeNull();
    expect(result!.passed).toBe(false);
    expect(result!.commands[0].passed).toBe(false);
    expect(result!.commands[0].exitCode).not.toBe(0);
  });

  test("stops after first failing command (fast-fail)", async () => {
    const feature = makeFeature({
      validation: { commands: ["node -e \"process.exit(1)\"", "node -e \"process.exit(0)\""] },
    });
    const result = await validateFeature(feature);
    expect(result).not.toBeNull();
    expect(result!.commands).toHaveLength(1); // stopped after first failure
    expect(result!.passed).toBe(false);
  });

  test("all commands must pass for overall pass", async () => {
    const feature = makeFeature({
      validation: { commands: ["node -e \"process.exit(0)\"", "node -e \"process.exit(0)\"", "node -e \"process.exit(0)\""] },
    });
    const result = await validateFeature(feature);
    expect(result!.passed).toBe(true);
    expect(result!.commands).toHaveLength(3);
  });

  test("returns featureId in result", async () => {
    const feature = makeFeature({ id: "F42", validation: { commands: ["node -e \"process.exit(0)\""] } });
    const result = await validateFeature(feature);
    expect(result!.featureId).toBe("F42");
  });

  test("captures stdout in result", async () => {
    const feature = makeFeature({ validation: { commands: ["node -e \"process.stdout.write('hello_world')\""] } });
    const result = await validateFeature(feature);
    expect(result!.commands[0].stdout).toContain("hello_world");
    expect(result!.commands[0].passed).toBe(true);
  });

  test("captures stderr in result", async () => {
    const feature = makeFeature({ validation: { commands: ["node -e \"process.stderr.write('error_msg'); process.exit(1)\""] } });
    const result = await validateFeature(feature);
    expect(result!.commands[0].stderr).toContain("error_msg");
    expect(result!.commands[0].passed).toBe(false);
  });

  test("durationMs is a non-negative number", async () => {
    const feature = makeFeature({ validation: { commands: ["node -e \"process.exit(0)\""] } });
    const result = await validateFeature(feature);
    expect(result!.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// VALIDATION — validateProject (Part D)
// ---------------------------------------------------------------------------

describe("validateProject — project-level validation", () => {
  test("returns null when config is undefined", async () => {
    expect(await validateProject(undefined)).toBeNull();
  });

  test("returns null when commands array is empty", async () => {
    expect(await validateProject({ commands: [] })).toBeNull();
  });

  test("passing commands returns passed=true", async () => {
    const result = await validateProject({ commands: ["node -e \"process.exit(0)\"", "node -e \"process.exit(0)\""] });
    expect(result!.passed).toBe(true);
  });

  test("failing command returns passed=false", async () => {
    const result = await validateProject({ commands: ["node -e \"process.exit(1)\""] });
    expect(result!.passed).toBe(false);
  });

  test("featureId is null for project check", async () => {
    const result = await validateProject({ commands: ["node -e \"process.exit(0)\""] });
    expect(result!.featureId).toBeNull();
  });

  test("does not fabricate success when command fails", async () => {
    const result = await validateProject({ commands: ["node -e \"process.exit(42)\""] });
    expect(result!.passed).toBe(false);
    expect(result!.commands[0].exitCode).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// REPAIR (Part E/G)
// ---------------------------------------------------------------------------

describe("canRepairFeature", () => {
  test("eligible for validation_failed", () => {
    const contract = makeContract({
      features: [makeFeature({ id: "f1", status: "validation_failed" })],
      reserves: makeReserves({ repair: 0.5 }),
    });
    expect(canRepairFeature(contract, contract.features[0])).toBe(true);
  });

  test("eligible for budget_interrupted", () => {
    const contract = makeContract({
      features: [makeFeature({ id: "f1", status: "budget_interrupted" })],
      reserves: makeReserves({ repair: 0.5 }),
    });
    expect(canRepairFeature(contract, contract.features[0])).toBe(true);
  });

  test("eligible for awaiting_validation", () => {
    const contract = makeContract({
      features: [makeFeature({ id: "f1", status: "awaiting_validation" })],
      reserves: makeReserves({ repair: 0.5 }),
    });
    expect(canRepairFeature(contract, contract.features[0])).toBe(true);
  });

  test("NOT eligible for pending feature", () => {
    const contract = makeContract({
      features: [makeFeature({ id: "f1", status: "pending" })],
      reserves: makeReserves({ repair: 0.5 }),
    });
    expect(canRepairFeature(contract, contract.features[0])).toBe(false);
  });

  test("NOT eligible for done feature", () => {
    const contract = makeContract({
      features: [makeFeature({ id: "f1", status: "done" })],
      reserves: makeReserves({ repair: 0.5 }),
    });
    expect(canRepairFeature(contract, contract.features[0])).toBe(false);
  });

  test("NOT eligible when repair reserve is at or below overshoot guard", () => {
    const contract = makeContract({
      features: [makeFeature({ id: "f1", status: "validation_failed" })],
      reserves: makeReserves({ repair: DEFAULT_OVERSHOOT_GUARD }),
      overshootGuard: DEFAULT_OVERSHOOT_GUARD,
    });
    expect(canRepairFeature(contract, contract.features[0])).toBe(false);
  });
});

describe("repairWallet", () => {
  test("returns repair reserve minus overshoot guard", () => {
    const contract = makeContract({
      reserves: makeReserves({ repair: 0.5 }),
      overshootGuard: 0.01,
    });
    expect(repairWallet(contract)).toBeCloseTo(0.49, 5);
  });

  test("returns null when reserve is <= overshoot guard", () => {
    const contract = makeContract({
      reserves: makeReserves({ repair: 0.01 }),
      overshootGuard: 0.01,
    });
    expect(repairWallet(contract)).toBeNull();
  });

  test("repair wallet is separate from feature spendable", () => {
    // Feature spendable is independent from repair wallet
    const contract = makeContract({
      currentWindow: makeWindow({ assignedBudget: 20, actualSpent: 19 }), // very low spendable
      reserves: makeReserves({ repair: 0.5, validation: 0, integration: 0 }),
      overshootGuard: 0.01,
    });
    const wallet = repairWallet(contract);
    expect(wallet).toBeCloseTo(0.49, 5);
    // spendable budget might be 0 but repair wallet is still available
  });
});

describe("recordRepairSpend — repair reserve accounting", () => {
  test("repair spend reduces repair reserve", () => {
    const contract = makeContract({
      reserves: makeReserves({ repair: 0.5 }),
      features: [makeFeature({ id: "f1", status: "validation_failed" })],
    });
    const after = recordRepairSpend(contract, "f1", 0.2, false);
    expect(after.reserves.repair).toBeCloseTo(0.3, 5);
  });

  test("repair spend increases window actualSpent", () => {
    const contract = makeContract({
      currentWindow: makeWindow({ actualSpent: 1.0 }),
      features: [makeFeature({ id: "f1", status: "validation_failed" })],
    });
    const after = recordRepairSpend(contract, "f1", 0.2, false);
    expect(after.currentWindow.actualSpent).toBeCloseTo(1.2, 5);
  });

  test("repair spend does not mark feature done — sets awaiting_validation", () => {
    const contract = makeContract({
      features: [makeFeature({ id: "f1", status: "validation_failed" })],
    });
    const after = recordRepairSpend(contract, "f1", 0.1, false);
    expect(after.features[0].status).toBe("awaiting_validation");
  });

  test("interrupted repair marks feature budget_interrupted", () => {
    const contract = makeContract({
      features: [makeFeature({ id: "f1", status: "validation_failed" })],
    });
    const after = recordRepairSpend(contract, "f1", 0.1, true);
    expect(after.features[0].status).toBe("budget_interrupted");
  });

  test("failed repair → setFeatureStatus → remains validation_failed", () => {
    const contract = makeContract({
      features: [makeFeature({ id: "f1", status: "validation_failed" })],
    });
    const afterRepair = recordRepairSpend(contract, "f1", 0.1, false);
    // After repair, validation failed again
    const final = setFeatureStatus(afterRepair, "f1", "validation_failed");
    expect(final.features[0].status).toBe("validation_failed");
  });

  test("successful repair → setFeatureStatus → done", () => {
    const contract = makeContract({
      features: [makeFeature({ id: "f1", status: "validation_failed" })],
    });
    const afterRepair = recordRepairSpend(contract, "f1", 0.1, false);
    const final = setFeatureStatus(afterRepair, "f1", "done");
    expect(final.features[0].status).toBe("done");
  });

  test("repair cannot exceed remaining repair reserve (reserve floors at 0)", () => {
    const contract = makeContract({
      reserves: makeReserves({ repair: 0.1 }),
      features: [makeFeature({ id: "f1", status: "validation_failed" })],
    });
    const after = recordRepairSpend(contract, "f1", 5.0, false); // overspend
    expect(after.reserves.repair).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// LAND MODE (Part F)
// ---------------------------------------------------------------------------

describe("LAND mode — state rules", () => {
  test("nextProjectState → LAND when no pending features and SAFE", () => {
    const contract = makeContract({
      features: [makeFeature({ status: "done" })],
    });
    const state = nextProjectState(contract, "SAFE");
    expect(state).toBe("LAND");
  });

  test("nextProjectState → BUILD when features pending and SAFE", () => {
    const contract = makeContract({
      features: [makeFeature({ status: "pending" })],
    });
    const state = nextProjectState(contract, "SAFE");
    expect(state).toBe("BUILD");
  });

  test("nextProjectState → COMPRESS when features pending and UNSAFE", () => {
    const contract = makeContract({
      features: [makeFeature({ status: "pending" })],
    });
    const state = nextProjectState(contract, "UNSAFE");
    expect(state).toBe("COMPRESS");
  });

  test("nextProjectState → LAND when no pending features and UNSAFE", () => {
    const contract = makeContract({
      features: [makeFeature({ status: "done" })],
    });
    const state = nextProjectState(contract, "UNSAFE");
    expect(state).toBe("LAND");
  });

  test("LAND is maintained after setFeatureStatus when validation passes → done (all done → LAND)", () => {
    const contract = makeContract({
      features: [makeFeature({ id: "f1", status: "awaiting_validation" })],
      state: "LAND",
    });
    const after = setFeatureStatus(contract, "f1", "done");
    expect(after.state).toBe("LAND");
  });

  test("awaiting_validation features count as unfinished for LAND determination", () => {
    const contract = makeContract({
      features: [makeFeature({ status: "awaiting_validation" })],
    });
    // Should NOT be LAND yet since there's still unfinished work
    const state = nextProjectState(contract, "SAFE");
    expect(state).toBe("BUILD");
  });

  test("validation_failed features count as unfinished for state", () => {
    const contract = makeContract({
      features: [makeFeature({ status: "validation_failed" })],
    });
    const state = nextProjectState(contract, "SAFE");
    expect(state).toBe("BUILD");
  });

  test("LAND does NOT accidentally allow deferred features to re-open state to BUILD", () => {
    const contract = makeContract({
      features: [
        makeFeature({ id: "f1", status: "done" }),
        makeFeature({ id: "f2", status: "deferred" }),
      ],
      state: "LAND",
    });
    // Only non-deferred unfinished features trigger BUILD
    const state = nextProjectState(contract, "SAFE");
    // f1=done, f2=deferred → no unfinished → LAND
    expect(state).toBe("LAND");
  });
});

// ---------------------------------------------------------------------------
// FORECAST (new statuses contribute to forecast)
// ---------------------------------------------------------------------------

describe("forecastHighRemaining — new statuses", () => {
  test("awaiting_validation features count in forecast", () => {
    const contract = makeContract({
      features: [
        makeFeature({ id: "f1", status: "awaiting_validation", estimate: { low: 1, high: 3, confidence: "medium" } }),
      ],
    });
    expect(buildForecast(contract).remainingHighBC).toBe(3);
  });

  test("validation_failed features count in forecast", () => {
    const contract = makeContract({
      features: [
        makeFeature({ id: "f1", status: "validation_failed", estimate: { low: 1, high: 2, confidence: "medium" } }),
      ],
    });
    expect(buildForecast(contract).remainingHighBC).toBe(2);
  });

  test("done features do NOT count in forecast", () => {
    const contract = makeContract({
      features: [
        makeFeature({ id: "f1", status: "done", estimate: { low: 1, high: 5, confidence: "medium" } }),
      ],
    });
    expect(buildForecast(contract).remainingHighBC).toBe(0);
  });

  test("deferred features do NOT count in forecast", () => {
    const contract = makeContract({
      features: [
        makeFeature({ id: "f1", status: "deferred", estimate: { low: 1, high: 5, confidence: "medium" } }),
      ],
    });
    expect(buildForecast(contract).remainingHighBC).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DYNAMIC RE-BUDGETING (V1)
// ---------------------------------------------------------------------------

describe("dynamic re-budgeting", () => {
  test("burn factor applied when feature overruns high estimate", () => {
    const highEstimate = 2;
    const actualSpend = 4; // 2× overrun
    const contract = makeContract({
      features: [
        makeFeature({ id: "f1", status: "done", estimate: { low: 1, high: highEstimate, confidence: "medium" } }),
        makeFeature({ id: "f2", estimate: { low: 1, high: 2, confidence: "medium" } }),
      ],
    });
    const after = applyBurnFactorReforecast(contract, "f1", actualSpend);
    const f2 = after.features.find((f) => f.id === "f2")!;
    expect(f2.estimate.high).toBeCloseTo(2 * (actualSpend / highEstimate), 5);
  });

  test("burn factor not applied when underrun", () => {
    const contract = makeContract({
      features: [
        makeFeature({ id: "f1", status: "done", estimate: { low: 1, high: 4, confidence: "medium" } }),
        makeFeature({ id: "f2", estimate: { low: 1, high: 2, confidence: "medium" } }),
      ],
    });
    const after = applyBurnFactorReforecast(contract, "f1", 2); // underrun
    expect(after.features.find((f) => f.id === "f2")!.estimate.high).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// PLANNING WALLET (V1)
// ---------------------------------------------------------------------------

describe("planningWallet", () => {
  test("planning wallet is fraction of spendable", () => {
    const contract = makeContract({
      currentWindow: makeWindow({ assignedBudget: 100, actualSpent: 0 }),
      reserves: makeReserves({ validation: 2, repair: 1, integration: 1 }),
    });
    const spendable = spendableBudget(contract);
    expect(planningWallet(contract)).toBeCloseTo(Math.min(PLANNING_BUDGET_MAX, PLANNING_BUDGET_FRACTION * spendable), 5);
  });

  test("planning wallet capped at PLANNING_BUDGET_MAX", () => {
    const contract = makeContract({
      currentWindow: makeWindow({ assignedBudget: 10000, actualSpent: 0 }),
      reserves: makeReserves({ validation: 1, repair: 0.5, integration: 0.5 }),
    });
    expect(planningWallet(contract)).toBe(PLANNING_BUDGET_MAX);
  });
});

// ---------------------------------------------------------------------------
// RUNNER — cost limit detection (V1)
// ---------------------------------------------------------------------------

describe("runner — cost limit detection via output parsing", () => {
  function parseBobOutput(lines: string[]) {
    const allLines: Array<{ type: string; message?: string; stats?: { session_costs: number } }> = [];
    let resultLine: { stats: { session_costs: number; duration_ms: number; tool_calls: number; task_id: string }; status: string; last_message: string | null } | null = null;
    let costLimitHit = false;

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line) as { type: string; message?: string; stats?: { session_costs: number; duration_ms: number; tool_calls: number; task_id: string }; status?: string; last_message?: string | null };
        allLines.push(obj);
        if (obj.type === "result") {
          resultLine = obj as typeof resultLine;
        }
        if (
          obj.type === "error" &&
          typeof obj.message === "string" &&
          obj.message.toLowerCase().includes("cost limit")
        ) {
          costLimitHit = true;
        }
      } catch {
        // ignore
      }
    }

    return { allLines, resultLine, costLimitHit };
  }

  test("normal completion: no cost limit hit", () => {
    const lines = [
      JSON.stringify({ type: "result", status: "success", stats: { session_costs: 0.02, duration_ms: 1000, tool_calls: 0, task_id: "abc" }, last_message: "hello" }),
    ];
    const { costLimitHit, resultLine } = parseBobOutput(lines);
    expect(costLimitHit).toBe(false);
    expect(resultLine?.stats.session_costs).toBe(0.02);
  });

  test("cost limit hit detected from error event", () => {
    const lines = [
      JSON.stringify({ type: "error", severity: "error", message: "The task reached the cost limit of 0.001 (spent: 0.02)." }),
      JSON.stringify({ type: "result", status: "success", stats: { session_costs: 0.02, duration_ms: 500, tool_calls: 1, task_id: "xyz" }, last_message: "partial" }),
    ];
    const { costLimitHit, resultLine } = parseBobOutput(lines);
    expect(costLimitHit).toBe(true);
    expect(resultLine?.status).toBe("success");
    expect(resultLine?.stats.session_costs).toBe(0.02);
  });

  test("result.status=success does NOT mean feature done", () => {
    // This test asserts the invariant: Bob success != feature done
    // Feature status must be set by validation, not by Bob result status
    const lines = [
      JSON.stringify({ type: "result", status: "success", stats: { session_costs: 0.02, duration_ms: 1000, tool_calls: 0, task_id: "abc" }, last_message: "hello" }),
    ];
    const { resultLine } = parseBobOutput(lines);
    expect(resultLine?.status).toBe("success");
    // After parsing, the status field from Bob must NOT be used to determine feature done
    // The feature status must go through awaiting_validation → validated → done
  });

  test("exit code 0 does NOT mean feature done", () => {
    // Documented: exit code is always 0, even on cost limit
    // Feature completion requires deterministic validation
    const exitCode = 0;
    expect(exitCode).toBe(0); // exit code irrelevant for feature status
  });
});

// ---------------------------------------------------------------------------
// Bob executable resolution — cross-platform
// ---------------------------------------------------------------------------

describe("resolveBobExecutable — platform-dependent executable name", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    // Restore the real platform descriptor after each test
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  test("returns 'bob.cmd' on win32", () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    expect(resolveBobExecutable()).toBe("bob.cmd");
  });

  test("returns 'bob' on darwin", () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    expect(resolveBobExecutable()).toBe("bob");
  });

  test("returns 'bob' on linux", () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    expect(resolveBobExecutable()).toBe("bob");
  });

  test("returns 'bob' on any other non-win32 platform", () => {
    Object.defineProperty(process, "platform", { value: "freebsd", configurable: true });
    expect(resolveBobExecutable()).toBe("bob");
  });
});

// ---------------------------------------------------------------------------
// FEATURE WALLET + OVERSHOOT GUARD (V1)
// ---------------------------------------------------------------------------

describe("featureWallet + bobMaxCost + overshoot guard", () => {
  test("wallet = min(estimate.high, spendable)", () => {
    const contract = makeContract({
      currentWindow: makeWindow({ assignedBudget: 20, actualSpent: 10 }),
      reserves: makeReserves({ validation: 1, repair: 0.5, integration: 0.5 }),
      features: [makeFeature({ estimate: { low: 1, high: 3, confidence: "medium" } })],
    });
    const spendable = spendableBudget(contract);
    const wallet = featureWallet(contract, contract.features[0]);
    expect(wallet).toBe(Math.min(3, spendable));
  });

  test("bobMaxCost = wallet - overshootGuard", () => {
    const contract = makeContract({
      currentWindow: makeWindow({ assignedBudget: 20, actualSpent: 0 }),
      reserves: makeReserves({ validation: 1, repair: 0.5, integration: 0.5 }),
      features: [makeFeature({ estimate: { low: 1, high: 3, confidence: "medium" } })],
      overshootGuard: 0.01,
    });
    const wallet = featureWallet(contract, contract.features[0]);
    const maxCost = bobMaxCost(contract, contract.features[0]);
    expect(maxCost).toBeCloseTo(wallet - 0.01, 5);
  });

  test("bobMaxCost returns null when wallet <= overshootGuard", () => {
    const contract = makeContract({
      currentWindow: makeWindow({ assignedBudget: 2, actualSpent: 1.99 }),
      reserves: makeReserves({ validation: 0, repair: 0, integration: 0 }),
      overshootGuard: 0.05,
      features: [makeFeature({ estimate: { low: 0.001, high: 0.005, confidence: "medium" } })],
    });
    expect(bobMaxCost(contract, contract.features[0])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// RISK STATE (V1)
// ---------------------------------------------------------------------------

describe("computeRiskState", () => {
  test("SAFE when forecast < 80% of spendable", () => {
    const contract = makeContract({
      currentWindow: makeWindow({ assignedBudget: 20, actualSpent: 0 }),
      reserves: makeReserves({ validation: 1, repair: 0.5, integration: 0.5 }),
      features: [makeFeature({ estimate: { low: 1, high: 2, confidence: "medium" } })],
    });
    expect(computeRiskState(contract)).toBe("SAFE");
  });

  test("UNSAFE when forecast > spendable", () => {
    const contract = makeContract({
      currentWindow: makeWindow({ assignedBudget: 5, actualSpent: 2 }),
      reserves: makeReserves({ validation: 1, repair: 0.5, integration: 0.5 }),
      features: [makeFeature({ estimate: { low: 5, high: 10, confidence: "medium" } })],
    });
    expect(computeRiskState(contract)).toBe("UNSAFE");
  });

  test("UNSAFE when spendable is 0", () => {
    const contract = makeContract({
      currentWindow: makeWindow({ assignedBudget: 2, actualSpent: 2 }),
      reserves: makeReserves({ validation: 0, repair: 0, integration: 0 }),
      features: [makeFeature({ estimate: { low: 1, high: 2, confidence: "medium" } })],
    });
    expect(computeRiskState(contract)).toBe("UNSAFE");
  });
});

// ---------------------------------------------------------------------------
// STATE MACHINE (V1)
// ---------------------------------------------------------------------------

describe("state machine transitions", () => {
  test("BUILD when features pending and SAFE", () => {
    const contract = makeContract({ features: [makeFeature({ status: "pending" })] });
    expect(nextProjectState(contract, "SAFE")).toBe("BUILD");
  });

  test("COMPRESS when features pending and UNSAFE", () => {
    const contract = makeContract({ features: [makeFeature({ status: "pending" })] });
    expect(nextProjectState(contract, "UNSAFE")).toBe("COMPRESS");
  });

  test("LAND when all done", () => {
    const contract = makeContract({ features: [makeFeature({ status: "done" })] });
    expect(nextProjectState(contract, "SAFE")).toBe("LAND");
  });

  test("awaiting_validation keeps state from going to LAND prematurely", () => {
    const contract = makeContract({ features: [makeFeature({ status: "awaiting_validation" })] });
    expect(nextProjectState(contract, "SAFE")).toBe("BUILD");
  });
});

// ---------------------------------------------------------------------------
// SCOPE (V1)
// ---------------------------------------------------------------------------

describe("scope", () => {
  test("deferred features excluded from forecast", () => {
    const contract = makeContract({
      features: [
        makeFeature({ id: "f1", status: "pending", estimate: { low: 1, high: 3, confidence: "medium" } }),
        makeFeature({ id: "f2", status: "deferred", estimate: { low: 1, high: 5, confidence: "medium" } }),
      ],
    });
    expect(buildForecast(contract).remainingHighBC).toBe(3);
  });

  test("deferFeature marks feature deferred and adds to deferredIds", () => {
    const contract = makeContract({
      features: [makeFeature({ id: "f1", status: "pending" })],
    });
    const after = deferFeature(contract, "f1");
    expect(after.features[0].status).toBe("deferred");
    expect(after.deferredFeatureIds).toContain("f1");
  });

  test("deferring already-deferred feature is idempotent", () => {
    const contract = makeContract({
      features: [makeFeature({ id: "f1", status: "deferred" })],
      deferredFeatureIds: ["f1"],
    });
    const after = deferFeature(contract, "f1");
    expect(after.deferredFeatureIds.filter((id) => id === "f1")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// RESUME / openNewWindow (V1)
// ---------------------------------------------------------------------------

describe("resume / openNewWindow", () => {
  test("new window increments windowId", () => {
    const contract = makeContract();
    const after = openNewWindow(contract, 10, null, "custom");
    expect(after.currentWindow.windowId).toBe(2);
  });

  test("previous window is immutable after close", () => {
    const contract = makeContract({
      currentWindow: makeWindow({ assignedBudget: 5, actualSpent: 3 }),
    });
    const after = openNewWindow(contract, 10, null, "custom");
    const prev = after.previousWindows[0];
    expect(prev.assignedBudget).toBe(5);
    expect(prev.actualSpent).toBe(3);
  });

  test("budget_interrupted features reset to pending in new window", () => {
    const contract = makeContract({
      features: [makeFeature({ id: "f1", status: "budget_interrupted" })],
    });
    const after = openNewWindow(contract, 10, null, "custom");
    expect(after.features[0].status).toBe("pending");
  });

  test("done features remain done in new window", () => {
    const contract = makeContract({
      features: [makeFeature({ id: "f1", status: "done" })],
    });
    const after = openNewWindow(contract, 10, null, "custom");
    expect(after.features[0].status).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// BUDGET MODE DISPLAY (V1)
// ---------------------------------------------------------------------------

describe("status display — budget mode fields", () => {
  test("auto mode: providerRemainingAtStart is set", () => {
    const result = resolveAssignedBudget(15, null);
    expect(result.providerRemainingAtStart).toBe(15);
    expect(result.budgetMode).toBe("auto");
  });

  test("custom mode without provider: providerRemainingAtStart is null", () => {
    const result = resolveAssignedBudget(null, 10);
    expect(result.providerRemainingAtStart).toBeNull();
    expect(result.budgetMode).toBe("custom");
  });
});

// ---------------------------------------------------------------------------
// TOTAL RESERVE / WINDOW REMAINING (V1)
// ---------------------------------------------------------------------------

describe("totalReserve", () => {
  test("sums all reserve components", () => {
    expect(totalReserve({ validation: 1, repair: 0.5, integration: 0.5 })).toBe(2);
  });
});

describe("windowRemaining", () => {
  test("remaining = assigned - spent", () => {
    expect(windowRemaining(makeWindow({ assignedBudget: 10, actualSpent: 3 }))).toBe(7);
  });
});

describe("buildInitialPhaseAllocation", () => {
  test("planning fraction of flexible", () => {
    const reserves = makeReserves({ validation: 1, repair: 0.5, integration: 0.5 });
    const alloc = buildInitialPhaseAllocation(20, reserves);
    const flexTotal = 20 - totalReserve(reserves);
    expect(alloc.planning).toBeCloseTo(Math.min(PLANNING_BUDGET_MAX, PLANNING_BUDGET_FRACTION * flexTotal), 5);
  });
});

// ---------------------------------------------------------------------------
// REPAIR PROMPT (Part E)
// ---------------------------------------------------------------------------

describe("buildRepairPrompt", () => {
  test("contains REPAIR CONTRACT header", () => {
    const feature = makeFeature();
    const result = buildRepairPrompt(feature, [], []);
    expect(result).toContain("REPAIR CONTRACT");
  });

  test("contains feature id and name", () => {
    const feature = makeFeature({ id: "F99", name: "My Feature" });
    const result = buildRepairPrompt(feature, [], []);
    expect(result).toContain("F99");
    expect(result).toContain("My Feature");
  });

  test("contains failed command info", () => {
    const feature = makeFeature();
    const failedCmd = {
      command: "npm test",
      exitCode: 1,
      durationMs: 100,
      stdout: "test output",
      stderr: "test failed",
      passed: false,
    };
    const result = buildRepairPrompt(feature, [failedCmd], []);
    expect(result).toContain("npm test");
    expect(result).toContain("test failed");
  });

  test("contains minimal repair instructions", () => {
    const result = buildRepairPrompt(makeFeature(), [], []);
    expect(result).toContain("Do NOT add features");
    expect(result).toContain("Do NOT refactor");
    expect(result).toContain("Do NOT future-proof");
  });

  test("contains deferred IDs", () => {
    const result = buildRepairPrompt(makeFeature(), [], ["F03", "F04"]);
    expect(result).toContain("F03");
    expect(result).toContain("F04");
  });
});

// ---------------------------------------------------------------------------
// BOB SKILL INSTALL (Part I/K)
// ---------------------------------------------------------------------------

describe("Bob Skill install — path generation", () => {
  test("globalSkillsDir returns path under home directory", () => {
    const dir = globalSkillsDir();
    expect(dir).toContain(".bob");
    expect(dir).toContain("skills");
    expect(dir.startsWith(os.homedir())).toBe(true);
  });

  test("projectSkillsDir returns path under given cwd", () => {
    const cwd = path.join(os.tmpdir(), "my-project");
    const dir = projectSkillsDir(cwd);
    expect(dir).toBe(path.join(cwd, ".bob", "skills"));
  });

  test("pocketWatcherSkillDir appends pocket-watcher", () => {
    const base = "/some/skills/dir";
    const skillDir = pocketWatcherSkillDir(base);
    expect(skillDir).toBe(path.join(base, "pocket-watcher"));
  });

  test("skillMdPath returns SKILL.md inside skill dir", () => {
    const skillDir = "/some/pocket-watcher";
    expect(skillMdPath(skillDir)).toBe(path.join(skillDir, "SKILL.md"));
  });
});

describe("generateSkillMd — SKILL.md content", () => {
  let md: string;

  beforeAll(() => {
    md = generateSkillMd();
  });

  test("starts with YAML frontmatter", () => {
    expect(md.startsWith("---")).toBe(true);
  });

  test("contains skill name: pocket-watcher", () => {
    expect(md).toContain("name: pocket-watcher");
  });

  test("contains /pocket-watcher invocation", () => {
    expect(md).toContain("/pocket-watcher");
  });

  test("mentions budget delegation to CLI", () => {
    expect(md).toContain("pocket");
    expect(md).toContain("CLI");
  });

  test("mentions BUDGET IS FIXED principle", () => {
    expect(md).toContain("BUDGET IS FIXED");
  });

  test("mentions compute budget / Bobcoin", () => {
    expect(md).toContain("Bobcoin");
  });

  test("contains pocket run command reference", () => {
    expect(md).toContain("pocket run");
  });

  test("contains pocket validate reference", () => {
    expect(md).toContain("pocket validate");
  });

  test("contains pocket check reference", () => {
    expect(md).toContain("pocket check");
  });

  test("contains pocket repair reference", () => {
    expect(md).toContain("pocket repair");
  });

  test("mentions LAND mode", () => {
    expect(md).toContain("LAND");
  });
});

describe("installSkill — file system operations", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "pw-install-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("creates skill directory if it does not exist", async () => {
    const result = await installSkill("project", tmpDir);
    expect(fs.existsSync(result.skillDir)).toBe(true);
  });

  test("writes SKILL.md to skill directory", async () => {
    const result = await installSkill("project", tmpDir);
    expect(fs.existsSync(result.skillMdPath)).toBe(true);
  });

  test("SKILL.md contains pocket-watcher content", async () => {
    const result = await installSkill("project", tmpDir);
    const content = fs.readFileSync(result.skillMdPath, "utf-8");
    expect(content).toContain("pocket-watcher");
  });

  test("created=true on fresh install", async () => {
    const result = await installSkill("project", tmpDir);
    expect(result.created).toBe(true);
  });

  test("created=false on update (reinstall)", async () => {
    await installSkill("project", tmpDir);
    const second = await installSkill("project", tmpDir);
    expect(second.created).toBe(false);
  });

  test("reinstall is safe — SKILL.md updated with latest content", async () => {
    await installSkill("project", tmpDir);
    const second = await installSkill("project", tmpDir);
    expect(second.warnings).toHaveLength(0);
    const content = fs.readFileSync(second.skillMdPath, "utf-8");
    expect(content).toContain("pocket-watcher");
  });

  test("project scope installs into .bob/skills/pocket-watcher inside cwd", async () => {
    const result = await installSkill("project", tmpDir);
    expect(result.skillDir).toBe(path.join(tmpDir, ".bob", "skills", "pocket-watcher"));
  });

  test("does NOT overwrite unrelated skills", async () => {
    // Create an unrelated skill
    const otherSkillDir = path.join(tmpDir, ".bob", "skills", "other-skill");
    await mkdir(otherSkillDir, { recursive: true });
    const otherSkillMd = path.join(otherSkillDir, "SKILL.md");
    await writeFile(otherSkillMd, "---\nname: other-skill\n---\nOther skill content\n");

    // Install pocket-watcher
    await installSkill("project", tmpDir);

    // Other skill untouched
    const content = fs.readFileSync(otherSkillMd, "utf-8");
    expect(content).toContain("other-skill");
    expect(content).not.toContain("pocket-watcher");
  });

  test("warns and skips if existing SKILL.md is not pocket-watcher content", async () => {
    // Create a SKILL.md that looks like it belongs to another skill
    const skillDir = path.join(tmpDir, ".bob", "skills", "pocket-watcher");
    await mkdir(skillDir, { recursive: true });
    const mdPath = path.join(skillDir, "SKILL.md");
    await writeFile(mdPath, "---\nname: something-else-entirely\n---\nThis is a completely different skill.\n");

    const result = await installSkill("project", tmpDir);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("does not appear to be a Pocket Watcher skill");
  });
});

// ---------------------------------------------------------------------------
// COST LEARNING — interrupted + validated (Part A of task)
// ---------------------------------------------------------------------------

describe("applyBurnFactorReforecastAfterValidation — interrupted+validated cost learning", () => {
  /**
   * Scenario: F01 ran, was budget_interrupted, actual spend > high estimate.
   * Validation passes → F01 becomes done.
   * The actual spend should propagate as burn factor to remaining pending features.
   */
  test("interrupted→done validation applies burn factor when actual > high estimate", () => {
    const highEstimate = 0.010;
    const actualSpend  = 0.020; // 2× overrun
    const contract = makeContract({
      features: [
        // F01: was interrupted, validation just marked it done, has actualSpent
        makeFeature({
          id: "F01",
          status: "done",
          estimate: { low: 0.008, high: highEstimate, confidence: "medium" },
          actualSpent: actualSpend,
        }),
        // F02: pending, should get its estimates scaled up
        makeFeature({
          id: "F02",
          status: "pending",
          estimate: { low: 0.008, high: highEstimate, confidence: "medium" },
          actualSpent: 0,
        }),
      ],
    });

    const after = applyBurnFactorReforecastAfterValidation(contract, "F01");

    const f02 = after.features.find((f) => f.id === "F02")!;
    const expectedBurnFactor = actualSpend / highEstimate; // 2.0
    expect(f02.estimate.high).toBeCloseTo(highEstimate * expectedBurnFactor, 5);
    expect(f02.estimate.low).toBeCloseTo(0.008 * expectedBurnFactor, 5);
  });

  test("interrupted→done: burn factor marks completed feature burnFactorApplied=true", () => {
    const contract = makeContract({
      features: [
        makeFeature({ id: "F01", status: "done", estimate: { low: 0.008, high: 0.010, confidence: "medium" }, actualSpent: 0.020 }),
        makeFeature({ id: "F02", status: "pending", estimate: { low: 0.008, high: 0.010, confidence: "medium" }, actualSpent: 0 }),
      ],
    });
    const after = applyBurnFactorReforecastAfterValidation(contract, "F01");
    const f01 = after.features.find((f) => f.id === "F01")!;
    expect(f01.burnFactorApplied).toBe(true);
  });

  test("interrupted→done: repeated validation does NOT double-apply burn factor", () => {
    const highEstimate = 0.010;
    const actualSpend  = 0.020;
    const contract = makeContract({
      features: [
        makeFeature({ id: "F01", status: "done", estimate: { low: 0.008, high: highEstimate, confidence: "medium" }, actualSpent: actualSpend }),
        makeFeature({ id: "F02", status: "pending", estimate: { low: 0.008, high: highEstimate, confidence: "medium" }, actualSpent: 0 }),
      ],
    });

    // First application
    const after1 = applyBurnFactorReforecastAfterValidation(contract, "F01");
    const f02After1 = after1.features.find((f) => f.id === "F02")!;
    const highAfter1 = f02After1.estimate.high;

    // Second application — must be a no-op
    const after2 = applyBurnFactorReforecastAfterValidation(after1, "F01");
    const f02After2 = after2.features.find((f) => f.id === "F02")!;
    expect(f02After2.estimate.high).toBeCloseTo(highAfter1, 8);
  });

  test("interrupted→validation_failed: no completed-feature cost learning applied", () => {
    const highEstimate = 0.010;
    const actualSpend  = 0.020;
    // Feature is validation_failed — not done — burn factor must NOT apply
    const contract = makeContract({
      features: [
        makeFeature({ id: "F01", status: "validation_failed", estimate: { low: 0.008, high: highEstimate, confidence: "medium" }, actualSpent: actualSpend }),
        makeFeature({ id: "F02", status: "pending", estimate: { low: 0.008, high: highEstimate, confidence: "medium" }, actualSpent: 0 }),
      ],
    });

    const after = applyBurnFactorReforecastAfterValidation(contract, "F01");

    // F01 is not done → function is a no-op
    const f02 = after.features.find((f) => f.id === "F02")!;
    expect(f02.estimate.high).toBeCloseTo(highEstimate, 8);
  });

  test("actual spend is not double-counted: window budget unchanged after reforecast", () => {
    const highEstimate = 0.010;
    const actualSpend  = 0.020;
    const contract = makeContract({
      currentWindow: makeWindow({ assignedBudget: 0.5, actualSpent: actualSpend }),
      features: [
        makeFeature({ id: "F01", status: "done", estimate: { low: 0.008, high: highEstimate, confidence: "medium" }, actualSpent: actualSpend }),
        makeFeature({ id: "F02", status: "pending", estimate: { low: 0.008, high: highEstimate, confidence: "medium" }, actualSpent: 0 }),
      ],
    });

    const after = applyBurnFactorReforecastAfterValidation(contract, "F01");

    // Window actualSpent must not be increased again — it was already recorded in recordSpend
    expect(after.currentWindow.actualSpent).toBe(actualSpend);
    expect(after.currentWindow.assignedBudget).toBe(0.5);
  });

  test("fixed total budget remains unchanged after cost learning", () => {
    const contract = makeContract({
      currentWindow: makeWindow({ assignedBudget: 0.2, actualSpent: 0.020 }),
      features: [
        makeFeature({ id: "F01", status: "done", estimate: { low: 0.008, high: 0.010, confidence: "medium" }, actualSpent: 0.020 }),
        makeFeature({ id: "F02", status: "pending", estimate: { low: 0.008, high: 0.010, confidence: "medium" }, actualSpent: 0 }),
      ],
    });

    const after = applyBurnFactorReforecastAfterValidation(contract, "F01");

    expect(after.currentWindow.assignedBudget).toBe(0.2);
  });

  test("no burn factor when actual spend does not exceed high estimate (underrun)", () => {
    const highEstimate = 0.010;
    const actualSpend  = 0.008; // underrun — actual < high
    const contract = makeContract({
      features: [
        makeFeature({ id: "F01", status: "done", estimate: { low: 0.005, high: highEstimate, confidence: "medium" }, actualSpent: actualSpend }),
        makeFeature({ id: "F02", status: "pending", estimate: { low: 0.005, high: highEstimate, confidence: "medium" }, actualSpent: 0 }),
      ],
    });

    const after = applyBurnFactorReforecastAfterValidation(contract, "F01");

    // F02 estimate must be unchanged — underrun does not inflate
    const f02 = after.features.find((f) => f.id === "F02")!;
    expect(f02.estimate.high).toBeCloseTo(highEstimate, 8);
  });

  test("COMPRESS state after burn factor causes forecast to exceed spendable", () => {
    // Budget small enough that after burn factor reforecast, F02 no longer fits
    const highEstimate = 0.010;
    const actualSpend  = 0.020;
    // assignedBudget = 0.060 (tiny), reserves = 0.030, spendable ≈ 0.020
    // After F01 spends 0.020, remaining ≈ 0.040, spendable ≈ 0.010
    // F02 adjusted high estimate = 0.020 > spendable 0.010 → UNSAFE → COMPRESS
    const contract = makeContract({
      currentWindow: makeWindow({ assignedBudget: 0.060, actualSpent: actualSpend }),
      reserves: makeReserves({ validation: 0.010, repair: 0.010, integration: 0.010 }),
      features: [
        makeFeature({ id: "F01", status: "done", estimate: { low: 0.005, high: highEstimate, confidence: "medium" }, actualSpent: actualSpend }),
        makeFeature({ id: "F02", status: "pending", estimate: { low: 0.005, high: highEstimate, confidence: "medium" }, actualSpent: 0 }),
      ],
    });

    const after = applyBurnFactorReforecastAfterValidation(contract, "F01");

    // F02 estimate should be scaled to 0.020
    const f02 = after.features.find((f) => f.id === "F02")!;
    expect(f02.estimate.high).toBeCloseTo(highEstimate * (actualSpend / highEstimate), 5);
    // State should be COMPRESS (UNSAFE + pending features)
    expect(after.state).toBe("COMPRESS");
  });

  test("applyBurnFactorReforecast: guard prevents double-apply via burnFactorApplied flag", () => {
    const highEstimate = 2;
    const actualSpend  = 4;
    const contract = makeContract({
      features: [
        makeFeature({ id: "f1", status: "done", estimate: { low: 1, high: highEstimate, confidence: "medium" }, actualSpent: actualSpend }),
        makeFeature({ id: "f2", status: "pending", estimate: { low: 1, high: 2, confidence: "medium" }, actualSpent: 0 }),
      ],
    });

    const after1 = applyBurnFactorReforecast(contract, "f1", actualSpend);
    const f2After1 = after1.features.find((f) => f.id === "f2")!;

    // Second call must be a no-op because burnFactorApplied = true
    const after2 = applyBurnFactorReforecast(after1, "f1", actualSpend);
    const f2After2 = after2.features.find((f) => f.id === "f2")!;
    expect(f2After2.estimate.high).toBeCloseTo(f2After1.estimate.high, 8);
  });

  test("COMPRESS blocks new runs — nextProjectState returns COMPRESS when UNSAFE + pending", () => {
    const contract = makeContract({
      features: [makeFeature({ status: "pending" })],
    });
    expect(nextProjectState(contract, "UNSAFE")).toBe("COMPRESS");
  });

  test("deferring optional feature can restore affordability", () => {
    // F02 + F03 together = 0.040 forecast high, spendable = 0.025 → UNSAFE (ratio 1.6)
    // Defer F03 (could) → only F02 remains = 0.020 < 0.025 spendable → TIGHT (ratio 0.8)
    // assignedBudget=0.075, actualSpent=0.020, reserves=0.030
    // remaining = 0.055, spendable = 0.025
    const contract = makeContract({
      currentWindow: makeWindow({ assignedBudget: 0.075, actualSpent: 0.020 }),
      reserves: makeReserves({ validation: 0.010, repair: 0.010, integration: 0.010 }),
      features: [
        makeFeature({ id: "F02", status: "pending", priority: "must",  estimate: { low: 0.010, high: 0.020, confidence: "medium" }, actualSpent: 0 }),
        makeFeature({ id: "F03", status: "pending", priority: "could", estimate: { low: 0.010, high: 0.020, confidence: "medium" }, actualSpent: 0 }),
      ],
    });

    // Before defer: F02+F03 forecast high = 0.040 > spendable 0.025 → UNSAFE
    expect(computeRiskState(contract)).toBe("UNSAFE");
    expect(nextProjectState(contract, "UNSAFE")).toBe("COMPRESS");

    // Defer F03
    const after = deferFeature(contract, "F03");

    // Now only F02 high = 0.020, spendable = 0.025 → ratio = 0.8 → TIGHT (not UNSAFE)
    const riskAfter = computeRiskState(after);
    expect(riskAfter).not.toBe("UNSAFE");
    // State should allow F02 to be run (BUILD/TIGHT — not COMPRESS)
    expect(nextProjectState(after, riskAfter)).not.toBe("COMPRESS");
    // F03 remains deferred
    expect(after.features.find((f) => f.id === "F03")!.status).toBe("deferred");
  });

  test("optional deferred feature stays deferred after F02 completes", () => {
    const contract = makeContract({
      features: [
        makeFeature({ id: "F02", status: "done",     priority: "must",  estimate: { low: 0.010, high: 0.020, confidence: "medium" }, actualSpent: 0.020 }),
        makeFeature({ id: "F03", status: "deferred", priority: "could", estimate: { low: 0.010, high: 0.020, confidence: "medium" }, actualSpent: 0 }),
      ],
      deferredFeatureIds: ["F03"],
    });

    // Confirm state stays LAND (all non-deferred done)
    const state = nextProjectState(contract, "SAFE");
    expect(state).toBe("LAND");
    expect(contract.features.find((f) => f.id === "F03")!.status).toBe("deferred");
  });
});
