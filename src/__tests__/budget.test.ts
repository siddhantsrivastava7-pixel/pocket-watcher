/**
 * Pocket Watcher V1 — comprehensive test suite
 *
 * Covers all categories specified in the product definition:
 * - Budget acquisition
 * - Fixed budget invariants
 * - Dynamic re-budgeting
 * - Planning wallet
 * - Runner (cost parsing, interruption detection)
 * - Max-cost behavior
 * - Feature wallet + overshoot guard
 * - Risk state boundaries
 * - State machine transitions
 * - Scope (deferred exclusion, dependencies, excluded work)
 * - Resume (new window, previous window immutable)
 * - Status display (auto vs custom budget modes)
 */

import {
  totalReserve,
  spendableBudget,
  computeRiskState,
  featureWallet,
  bobMaxCost,
  canStartFeature,
  recordSpend,
  applyBurnFactorReforecast,
  deferFeature,
  openNewWindow,
  buildForecast,
  nextProjectState,
  planningWallet,
  resolveAssignedBudget,
  buildInitialPhaseAllocation,
  DEFAULT_RESERVES,
  DEFAULT_OVERSHOOT_GUARD,
  PLANNING_BUDGET_FRACTION,
  PLANNING_BUDGET_MAX,
  windowRemaining,
} from "../budget.js";
import { buildFeaturePrompt } from "../runner.js";
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
// BUDGET ACQUISITION
// ---------------------------------------------------------------------------

describe("resolveAssignedBudget — budget acquisition", () => {
  it("auto mode: uses provider remaining when no user budget given", () => {
    const result = resolveAssignedBudget(23.6, null);
    expect(result.assignedBudget).toBe(23.6);
    expect(result.budgetMode).toBe("auto");
    expect(result.capped).toBe(false);
    expect(result.providerRemainingAtStart).toBe(23.6);
  });

  it("manual fallback: when provider remaining is unknown and no user budget, throws (caller should ask user)", () => {
    expect(() => resolveAssignedBudget(null, null)).toThrow();
  });

  it("custom budget below provider remaining: uses user budget", () => {
    const result = resolveAssignedBudget(23.6, 10);
    expect(result.assignedBudget).toBe(10);
    expect(result.budgetMode).toBe("custom");
    expect(result.capped).toBe(false);
  });

  it("custom budget above provider remaining: caps to provider remaining", () => {
    const result = resolveAssignedBudget(18, 30);
    expect(result.assignedBudget).toBe(18);
    expect(result.budgetMode).toBe("custom");
    expect(result.capped).toBe(true);
    expect(result.providerRemainingAtStart).toBe(18);
  });

  it("assigned budget never exceeds available provider compute", () => {
    const result = resolveAssignedBudget(5, 100);
    expect(result.assignedBudget).toBeLessThanOrEqual(5);
  });

  it("user budget with no provider info: assigns user budget directly", () => {
    const result = resolveAssignedBudget(null, 10);
    expect(result.assignedBudget).toBe(10);
    expect(result.capped).toBe(false);
    expect(result.providerRemainingAtStart).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// FIXED BUDGET INVARIANTS
// ---------------------------------------------------------------------------

describe("fixed budget invariants", () => {
  it("user-assigned project budget never silently increases after spend", () => {
    const contract = makeContract({
      currentWindow: makeWindow({ assignedBudget: 10, actualSpent: 0 }),
    });
    const updated = recordSpend(contract, "f1", 3, false);
    expect(updated.currentWindow.assignedBudget).toBe(10);
  });

  it("actual overspend reduces remainingAssignedBudget", () => {
    const contract = makeContract({
      currentWindow: makeWindow({ assignedBudget: 10, actualSpent: 0, remainingAssignedBudget: 10 }),
    });
    const updated = recordSpend(contract, "f1", 4, false);
    expect(updated.currentWindow.remainingAssignedBudget).toBeCloseTo(6);
    expect(updated.currentWindow.actualSpent).toBeCloseTo(4);
  });

  it("total historical spend is preserved across windows", () => {
    const contract = makeContract({
      currentWindow: makeWindow({ assignedBudget: 10, actualSpent: 5, remainingAssignedBudget: 5 }),
      previousWindows: [makeWindow({ windowId: 0, assignedBudget: 20, actualSpent: 19 })],
    });
    // The previous window spend is immutable
    expect(contract.previousWindows[0].actualSpent).toBe(19);
    const updated = recordSpend(contract, "f1", 2, false);
    expect(updated.previousWindows[0].actualSpent).toBe(19); // unchanged
    expect(updated.currentWindow.actualSpent).toBeCloseTo(7);
  });
});

// ---------------------------------------------------------------------------
// DYNAMIC RE-BUDGETING
// ---------------------------------------------------------------------------

describe("dynamic re-budgeting", () => {
  it("planning overrun reduces implementation capacity (spendable)", () => {
    const contract = makeContract({
      currentWindow: makeWindow({ assignedBudget: 20, actualSpent: 0, remainingAssignedBudget: 20 }),
      reserves: makeReserves({ validation: 1, repair: 0.5, integration: 0.5 }),
      features: [makeFeature({ id: "f1", estimate: { low: 2, high: 5, confidence: "medium" } })],
    });
    const spendableBefore = spendableBudget(contract);

    // Simulate planning overrun of 3 BC
    const afterPlanning = recordSpend(contract, null, 3, false);
    const spendableAfter = spendableBudget(afterPlanning);

    expect(spendableAfter).toBeCloseTo(spendableBefore - 3);
  });

  it("feature overrun triggers burn-factor reforecast on remaining features", () => {
    const contract = makeContract({
      currentWindow: makeWindow({ assignedBudget: 20, actualSpent: 0, remainingAssignedBudget: 20 }),
      features: [
        makeFeature({ id: "f1", status: "done", estimate: { low: 1, high: 2, confidence: "medium" } }),
        makeFeature({ id: "f2", status: "pending", estimate: { low: 1, high: 2, confidence: "medium" } }),
      ],
    });

    // f1 actual = 3, high = 2 → burnFactor = 1.5
    const updated = applyBurnFactorReforecast(contract, "f1", 3);
    const f2Updated = updated.features.find((f) => f.id === "f2")!;
    expect(f2Updated.estimate.high).toBeCloseTo(3); // 2 * 1.5
    expect(f2Updated.estimate.low).toBeCloseTo(1.5); // 1 * 1.5
  });

  it("feature underspend returns budget to flexible pool", () => {
    const contract = makeContract({
      currentWindow: makeWindow({ assignedBudget: 20, actualSpent: 0, remainingAssignedBudget: 20 }),
      features: [makeFeature({ id: "f1", estimate: { low: 1, high: 5, confidence: "medium" } })],
    });
    // Only spent 1 instead of estimate 5 → 4 BC remains in the pool
    const updated = recordSpend(contract, "f1", 1, false);
    expect(updated.currentWindow.remainingAssignedBudget).toBeCloseTo(19);
    expect(spendableBudget(updated)).toBeGreaterThan(spendableBudget(contract) - 5 + 3.9);
  });

  it("protected reserve floors remain intact after spend", () => {
    const reserves = makeReserves({ validation: 1, repair: 0.5, integration: 0.5 });
    const contract = makeContract({
      currentWindow: makeWindow({ assignedBudget: 5, actualSpent: 0, remainingAssignedBudget: 5 }),
      reserves,
      features: [makeFeature({ id: "f1", estimate: { low: 1, high: 3, confidence: "medium" } })],
    });
    // Spend 3 → remaining = 2 = exactly reserves. Spendable = 0
    const updated = recordSpend(contract, "f1", 3, false);
    expect(spendableBudget(updated)).toBe(0);
    // Reserves are still "intact" — they were not consumed
    expect(updated.reserves.validation).toBe(1);
    expect(updated.reserves.repair).toBe(0.5);
    expect(updated.reserves.integration).toBe(0.5);
  });

  it("dynamic phase allocation: burn factor does not increase assignedBudget", () => {
    const contract = makeContract({
      currentWindow: makeWindow({ assignedBudget: 20, actualSpent: 0, remainingAssignedBudget: 20 }),
      features: [
        makeFeature({ id: "f1", status: "done", estimate: { low: 2, high: 4, confidence: "medium" } }),
        makeFeature({ id: "f2", status: "pending", estimate: { low: 2, high: 4, confidence: "medium" } }),
      ],
    });
    const updated = applyBurnFactorReforecast(contract, "f1", 6);
    // Budget does not increase
    expect(updated.currentWindow.assignedBudget).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// PLANNING WALLET
// ---------------------------------------------------------------------------

describe("planningWallet", () => {
  it("is a small fraction of spendable budget", () => {
    const contract = makeContract({
      currentWindow: makeWindow({ assignedBudget: 20, actualSpent: 0, remainingAssignedBudget: 20 }),
      reserves: makeReserves({ validation: 1, repair: 0.5, integration: 0.5 }),
    });
    const spendable = spendableBudget(contract);
    const wallet = planningWallet(contract);
    expect(wallet).toBeCloseTo(PLANNING_BUDGET_FRACTION * spendable);
  });

  it("is capped at PLANNING_BUDGET_MAX regardless of spendable", () => {
    const contract = makeContract({
      currentWindow: makeWindow({ assignedBudget: 1000, actualSpent: 0, remainingAssignedBudget: 1000 }),
      reserves: makeReserves({ validation: 0, repair: 0, integration: 0 }),
    });
    const wallet = planningWallet(contract);
    expect(wallet).toBeLessThanOrEqual(PLANNING_BUDGET_MAX);
  });

  it("planning cannot consume unbounded compute — wallet < total spendable", () => {
    const contract = makeContract({
      currentWindow: makeWindow({ assignedBudget: 20, actualSpent: 0, remainingAssignedBudget: 20 }),
      reserves: makeReserves({ validation: 1, repair: 0.5, integration: 0.5 }),
    });
    expect(planningWallet(contract)).toBeLessThan(spendableBudget(contract));
  });
});

// ---------------------------------------------------------------------------
// RUNNER — cost parsing behavior
// ---------------------------------------------------------------------------

describe("runner — cost limit detection via output parsing", () => {
  /**
   * These tests verify the parsing logic by simulating the Bob output format
   * directly, without spawning a real process.
   */

  function parseBobOutput(lines: string[]): {
    costLimitHit: boolean;
    actualCost: number;
    resultStatus: string | undefined;
  } {
    let costLimitHit = false;
    let actualCost = 0;
    let resultStatus: string | undefined;

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (obj.type === "result") {
          const stats = obj.stats as Record<string, unknown>;
          actualCost = stats.session_costs as number;
          resultStatus = obj.status as string;
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
    return { costLimitHit, actualCost, resultStatus };
  }

  it("normal completion: no cost limit event, parses session_costs", () => {
    const lines = [
      `{"type":"result","timestamp":"2025-01-01T00:00:00Z","status":"success","stats":{"task_id":"abc","duration_ms":1000,"session_costs":0.019634,"max_cost":10,"tool_calls":0},"last_message":"hello"}`,
    ];
    const result = parseBobOutput(lines);
    expect(result.costLimitHit).toBe(false);
    expect(result.actualCost).toBeCloseTo(0.019634);
    expect(result.resultStatus).toBe("success");
  });

  it("cost limit hit: detects error event before result line", () => {
    const lines = [
      `{"type":"error","timestamp":"2025-01-01T00:00:00Z","severity":"error","message":"The task reached the cost limit of 0.0010 (spent: 0.020)."}`,
      `{"type":"result","timestamp":"2025-01-01T00:00:00Z","status":"success","stats":{"task_id":"abc","duration_ms":1000,"session_costs":0.020,"max_cost":0.001,"tool_calls":1},"last_message":"partial"}`,
    ];
    const result = parseBobOutput(lines);
    expect(result.costLimitHit).toBe(true);
    expect(result.actualCost).toBeCloseTo(0.020);
  });

  it("exit code 0 with cost limit hit does NOT imply completion", () => {
    // Bob always exits 0 on cost limit — so exit code alone cannot determine completion.
    // This test verifies the parsing approach (not exit code) drives the decision.
    const costLimitOutput = [
      `{"type":"error","severity":"error","message":"The task reached the cost limit of 0.001 (spent: 0.02).","timestamp":"t"}`,
      `{"type":"result","status":"success","stats":{"task_id":"x","duration_ms":100,"session_costs":0.02,"max_cost":0.001,"tool_calls":1},"last_message":"partial","timestamp":"t"}`,
    ];
    const normalOutput = [
      `{"type":"result","status":"success","stats":{"task_id":"x","duration_ms":100,"session_costs":0.01,"max_cost":1,"tool_calls":0},"last_message":"done","timestamp":"t"}`,
    ];
    const limitResult = parseBobOutput(costLimitOutput);
    const normalResult = parseBobOutput(normalOutput);

    // Both would have exit code 0 in real Bob — only parsing distinguishes them
    expect(limitResult.costLimitHit).toBe(true);
    expect(normalResult.costLimitHit).toBe(false);
    // result.status is "success" in both cases
    expect(limitResult.resultStatus).toBe("success");
    expect(normalResult.resultStatus).toBe("success");
  });

  it("result status success does NOT imply feature completion", () => {
    // This is a documentation/invariant test.
    // When costLimitHit is true, feature should be budget_interrupted, not done.
    const contract = makeContract({
      features: [makeFeature({ id: "f1", status: "running" })],
    });
    const updated = recordSpend(contract, "f1", 1.5, /* interrupted= */ true);
    const f1 = updated.features.find((f) => f.id === "f1")!;
    expect(f1.status).toBe("budget_interrupted");
    expect(f1.status).not.toBe("done");
  });

  it("partial interrupted run is marked budget_interrupted", () => {
    const contract = makeContract({
      features: [makeFeature({ id: "f1", status: "running" })],
    });
    const updated = recordSpend(contract, "f1", 0.5, true);
    expect(updated.features[0].status).toBe("budget_interrupted");
  });

  it("stats.session_costs is persisted as actual cost", () => {
    const contract = makeContract({
      currentWindow: makeWindow({ assignedBudget: 10, actualSpent: 0, remainingAssignedBudget: 10 }),
      features: [makeFeature({ id: "f1" })],
    });
    const realCost = 0.060302;
    const updated = recordSpend(contract, "f1", realCost, false);
    expect(updated.currentWindow.actualSpent).toBeCloseTo(realCost);
    const f1 = updated.features.find((f) => f.id === "f1")!;
    expect(f1.actualSpent).toBeCloseTo(realCost);
  });
});

// ---------------------------------------------------------------------------
// FEATURE WALLET + OVERSHOOT GUARD
// ---------------------------------------------------------------------------

describe("featureWallet + bobMaxCost + overshoot guard", () => {
  it("featureWallet is capped at feature estimate.high", () => {
    const contract = makeContract({
      currentWindow: makeWindow({ assignedBudget: 20, actualSpent: 0, remainingAssignedBudget: 20 }),
    });
    const feature = makeFeature({ estimate: { low: 1, high: 3, confidence: "medium" } });
    expect(featureWallet(contract, feature)).toBe(3);
  });

  it("featureWallet is capped at spendable when spendable < highEstimate", () => {
    const contract = makeContract({
      currentWindow: makeWindow({ assignedBudget: 5, actualSpent: 0, remainingAssignedBudget: 5 }),
      reserves: makeReserves({ validation: 1, repair: 0.5, integration: 0.5 }),
    });
    const spendable = spendableBudget(contract); // 5 - 2 = 3
    const feature = makeFeature({ estimate: { low: 2, high: 10, confidence: "medium" } });
    expect(featureWallet(contract, feature)).toBe(spendable);
  });

  it("bobMaxCost subtracts overshoot guard from wallet", () => {
    const contract = makeContract({
      overshootGuard: 0.05,
      currentWindow: makeWindow({ assignedBudget: 20, actualSpent: 0, remainingAssignedBudget: 20 }),
    });
    const feature = makeFeature({ estimate: { low: 1, high: 2, confidence: "medium" } });
    const wallet = featureWallet(contract, feature);
    const maxCost = bobMaxCost(contract, feature);
    expect(maxCost).toBeCloseTo(wallet - 0.05);
  });

  it("bobMaxCost returns null when wallet <= overshoot guard (zero/negative prevention)", () => {
    const contract = makeContract({
      overshootGuard: 0.1,
      currentWindow: makeWindow({ assignedBudget: 2.1, actualSpent: 0, remainingAssignedBudget: 2.1 }),
      reserves: makeReserves({ validation: 1, repair: 0.5, integration: 0.5 }),
      // spendable = 2.1 - 2 = 0.1 = exactly overshoot guard → 0 max cost → null
    });
    const feature = makeFeature({ estimate: { low: 0.05, high: 0.1, confidence: "medium" } });
    expect(bobMaxCost(contract, feature)).toBeNull();
  });

  it("feature cannot consume full project wallet — protected reserves excluded", () => {
    const contract = makeContract({
      currentWindow: makeWindow({ assignedBudget: 10, actualSpent: 0, remainingAssignedBudget: 10 }),
      reserves: makeReserves({ validation: 2, repair: 1, integration: 1 }),
    });
    const feature = makeFeature({ estimate: { low: 1, high: 100, confidence: "medium" } });
    const wallet = featureWallet(contract, feature);
    // wallet must not include the 4 BC reserves
    expect(wallet).toBeLessThanOrEqual(10 - 4); // 6
  });

  it("protected reserves cannot be assigned to new feature work", () => {
    const contract = makeContract({
      currentWindow: makeWindow({ assignedBudget: 3, actualSpent: 0, remainingAssignedBudget: 3 }),
      reserves: makeReserves({ validation: 1, repair: 0.5, integration: 0.5 }),
    });
    // spendable = 3 - 2 = 1
    const feature = makeFeature({ estimate: { low: 1, high: 5, confidence: "medium" } });
    expect(featureWallet(contract, feature)).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// RISK STATE
// ---------------------------------------------------------------------------

describe("computeRiskState", () => {
  it("SAFE when forecast < 80% of spendable", () => {
    // spendable = 8, forecast = 5  → ratio = 0.625
    const contract = makeContract({
      currentWindow: makeWindow({ assignedBudget: 10, actualSpent: 0, remainingAssignedBudget: 10 }),
      features: [makeFeature({ estimate: { low: 3, high: 5, confidence: "medium" }, status: "pending" })],
    });
    expect(computeRiskState(contract)).toBe("SAFE");
  });

  it("TIGHT when forecast is exactly 80% of spendable", () => {
    // spendable = 10, forecast = 8 → ratio = 0.8
    const contract = makeContract({
      currentWindow: makeWindow({ assignedBudget: 12, actualSpent: 0, remainingAssignedBudget: 12 }),
      reserves: makeReserves({ validation: 1, repair: 0.5, integration: 0.5 }),
      features: [makeFeature({ estimate: { low: 6, high: 8, confidence: "medium" }, status: "pending" })],
    });
    expect(computeRiskState(contract)).toBe("TIGHT");
  });

  it("TIGHT when forecast is between 80% and 100%", () => {
    // spendable = 10, forecast = 9 → ratio = 0.9
    const contract = makeContract({
      currentWindow: makeWindow({ assignedBudget: 12, actualSpent: 0, remainingAssignedBudget: 12 }),
      reserves: makeReserves({ validation: 1, repair: 0.5, integration: 0.5 }),
      features: [makeFeature({ estimate: { low: 7, high: 9, confidence: "medium" }, status: "pending" })],
    });
    expect(computeRiskState(contract)).toBe("TIGHT");
  });

  it("UNSAFE when forecast > 100% of spendable", () => {
    // spendable = 8, forecast = 10
    const contract = makeContract({
      currentWindow: makeWindow({ assignedBudget: 10, actualSpent: 0, remainingAssignedBudget: 10 }),
      features: [makeFeature({ estimate: { low: 8, high: 10, confidence: "medium" }, status: "pending" })],
    });
    expect(computeRiskState(contract)).toBe("UNSAFE");
  });

  it("UNSAFE when spendable is 0", () => {
    const contract = makeContract({
      currentWindow: makeWindow({ assignedBudget: 2, actualSpent: 0, remainingAssignedBudget: 2 }),
      reserves: makeReserves({ validation: 1, repair: 0.5, integration: 0.5 }),
      features: [makeFeature({ estimate: { low: 1, high: 1, confidence: "medium" }, status: "pending" })],
    });
    expect(computeRiskState(contract)).toBe("UNSAFE");
  });
});

// ---------------------------------------------------------------------------
// STATE MACHINE
// ---------------------------------------------------------------------------

describe("state machine transitions", () => {
  it("UNSAFE -> COMPRESS when pending features exist", () => {
    const contract = makeContract({
      features: [makeFeature({ status: "pending" })],
    });
    expect(nextProjectState(contract, "UNSAFE")).toBe("COMPRESS");
  });

  it("UNSAFE -> LAND when no pending features", () => {
    const contract = makeContract({
      features: [makeFeature({ status: "done" })],
    });
    expect(nextProjectState(contract, "UNSAFE")).toBe("LAND");
  });

  it("manual LAND via deferring all features + transition", () => {
    let contract = makeContract({
      currentWindow: makeWindow({ assignedBudget: 10, actualSpent: 0, remainingAssignedBudget: 10 }),
      features: [makeFeature({ id: "f1", status: "pending" })],
    });
    contract = deferFeature(contract, "f1");
    // All features now deferred → no pending → LAND
    expect(contract.state).toBe("LAND");
  });

  it("automatic LAND when spending reduces remaining to reserve level", () => {
    const contract = makeContract({
      currentWindow: makeWindow({ assignedBudget: 5, actualSpent: 0, remainingAssignedBudget: 5 }),
      reserves: makeReserves({ validation: 1, repair: 0.5, integration: 0.5 }),
      features: [
        makeFeature({ id: "f1", estimate: { low: 1, high: 2, confidence: "medium" } }),
        makeFeature({ id: "f2", estimate: { low: 1, high: 4, confidence: "medium" } }),
      ],
    });
    // Spend 3 → remaining = 2 = reserves → spendable = 0 → UNSAFE → COMPRESS (f2 still pending)
    const updated = recordSpend(contract, "f1", 3, false);
    expect(["COMPRESS", "LAND"]).toContain(updated.state);
  });

  it("LAND blocks new features — canStartFeature returns false when spendable is 0", () => {
    const contract = makeContract({
      state: "LAND",
      currentWindow: makeWindow({ assignedBudget: 2, actualSpent: 0, remainingAssignedBudget: 2 }),
      reserves: makeReserves({ validation: 1, repair: 0.5, integration: 0.5 }),
    });
    const feature = makeFeature({ estimate: { low: 0.1, high: 0.1, confidence: "medium" } });
    expect(canStartFeature(contract, feature)).toBe(false);
  });

  it("LAND allows finishing a budget_interrupted feature if wallet available", () => {
    const contract = makeContract({
      state: "LAND",
      currentWindow: makeWindow({ assignedBudget: 10, actualSpent: 2, remainingAssignedBudget: 8 }),
      features: [makeFeature({ id: "f1", status: "budget_interrupted", estimate: { low: 1, high: 2, confidence: "medium" } })],
    });
    expect(canStartFeature(contract, contract.features[0])).toBe(true);
  });

  it("SHIPPED state only possible via explicit state assignment (not auto-transition)", () => {
    // V1 does not auto-transition to SHIPPED — user must explicitly call pocket land
    // and then manually mark shipped after validation. This test verifies nextProjectState never returns SHIPPED.
    const contract = makeContract({ features: [makeFeature({ status: "done" })] });
    expect(nextProjectState(contract, "SAFE")).not.toBe("SHIPPED");
    expect(nextProjectState(contract, "TIGHT")).not.toBe("SHIPPED");
    expect(nextProjectState(contract, "UNSAFE")).not.toBe("SHIPPED");
  });

  it("BUILD -> COMPRESS when forecast goes UNSAFE", () => {
    const contract = makeContract({
      state: "BUILD",
      currentWindow: makeWindow({ assignedBudget: 5, actualSpent: 0, remainingAssignedBudget: 5 }),
      reserves: makeReserves({ validation: 1, repair: 0.5, integration: 0.5 }),
      features: [
        makeFeature({ id: "f1", estimate: { low: 0.5, high: 0.5, confidence: "medium" } }),
        makeFeature({ id: "f2", estimate: { low: 5, high: 10, confidence: "medium" } }),
      ],
    });
    // After f1 completes and we spend 2.5 → remaining = 2.5 = reserves → spendable = 0.5 but forecast for f2 = 10 → UNSAFE
    const updated = recordSpend(contract, "f1", 2.5, false);
    expect(updated.state).toBe("COMPRESS");
  });
});

// ---------------------------------------------------------------------------
// SCOPE — feature contracts, deferred exclusion, dependencies
// ---------------------------------------------------------------------------

describe("scope", () => {
  it("deferred features have status 'deferred'", () => {
    const contract = makeContract({
      features: [
        makeFeature({ id: "f1", status: "pending" }),
        makeFeature({ id: "f2", status: "pending" }),
      ],
    });
    const updated = deferFeature(contract, "f2");
    const f2 = updated.features.find((f) => f.id === "f2")!;
    expect(f2.status).toBe("deferred");
    expect(updated.deferredFeatureIds).toContain("f2");
  });

  it("deferring a feature adds it to deferredFeatureIds without duplicates", () => {
    let contract = makeContract({
      features: [makeFeature({ id: "f1", status: "pending" })],
    });
    contract = deferFeature(contract, "f1");
    contract = deferFeature(contract, "f1"); // second time — no duplicate
    expect(contract.deferredFeatureIds.filter((id) => id === "f1").length).toBe(1);
  });

  it("buildFeaturePrompt includes feature id, name, goal, acceptance", () => {
    const feature = makeFeature({
      id: "f1",
      name: "Auth",
      goal: "Implement login",
      acceptance: ["user can log in", "token is issued"],
      excluded: ["social login"],
    });
    const prompt = buildFeaturePrompt(feature, []);
    expect(prompt).toContain("f1");
    expect(prompt).toContain("Auth");
    expect(prompt).toContain("Implement login");
    expect(prompt).toContain("user can log in");
    expect(prompt).toContain("token is issued");
  });

  it("buildFeaturePrompt excludes listed deferred feature IDs", () => {
    const feature = makeFeature({ id: "f1" });
    const prompt = buildFeaturePrompt(feature, ["f2", "f3"]);
    expect(prompt).toContain("f2");
    expect(prompt).toContain("f3");
    expect(prompt.toLowerCase()).toContain("deferred");
  });

  it("buildFeaturePrompt includes excluded work from feature contract", () => {
    const feature = makeFeature({
      id: "f1",
      excluded: ["OCR", "drag and drop"],
    });
    const prompt = buildFeaturePrompt(feature, []);
    expect(prompt).toContain("OCR");
    expect(prompt).toContain("drag and drop");
    expect(prompt.toLowerCase()).toContain("excluded");
  });

  it("buildFeaturePrompt instructs against scope drift", () => {
    const feature = makeFeature();
    const prompt = buildFeaturePrompt(feature, []);
    expect(prompt.toLowerCase()).toContain("do not perform speculative refactoring");
    expect(prompt.toLowerCase()).toContain("do not add optional functionality");
  });
});

// ---------------------------------------------------------------------------
// RESUME — new compute window, previous window immutable
// ---------------------------------------------------------------------------

describe("resume / openNewWindow", () => {
  it("creates a new window with incremented windowId", () => {
    const contract = makeContract({
      currentWindow: makeWindow({ windowId: 1, assignedBudget: 10, actualSpent: 9, remainingAssignedBudget: 1 }),
    });
    const updated = openNewWindow(contract, 15, 15, "auto");
    expect(updated.currentWindow.windowId).toBe(2);
    expect(updated.currentWindow.assignedBudget).toBe(15);
    expect(updated.currentWindow.actualSpent).toBe(0);
  });

  it("previous window is moved to previousWindows and is immutable", () => {
    const contract = makeContract({
      currentWindow: makeWindow({ windowId: 1, assignedBudget: 10, actualSpent: 8, remainingAssignedBudget: 2 }),
      previousWindows: [],
    });
    const updated = openNewWindow(contract, 20, 20, "auto");
    expect(updated.previousWindows.length).toBe(1);
    expect(updated.previousWindows[0].windowId).toBe(1);
    expect(updated.previousWindows[0].actualSpent).toBe(8);
    // Ensure the original contract's previous windows are unchanged
    expect(contract.previousWindows.length).toBe(0);
  });

  it("completed features remain completed after resume", () => {
    const contract = makeContract({
      currentWindow: makeWindow({ windowId: 1, assignedBudget: 10, actualSpent: 5, remainingAssignedBudget: 5 }),
      features: [
        makeFeature({ id: "f1", status: "done" }),
        makeFeature({ id: "f2", status: "budget_interrupted" }),
      ],
    });
    const updated = openNewWindow(contract, 10, 10, "auto");
    const f1 = updated.features.find((f) => f.id === "f1")!;
    expect(f1.status).toBe("done");
  });

  it("budget_interrupted features are reset to pending in new window", () => {
    const contract = makeContract({
      currentWindow: makeWindow({ windowId: 1, assignedBudget: 10, actualSpent: 9, remainingAssignedBudget: 1 }),
      features: [
        makeFeature({ id: "f1", status: "budget_interrupted" }),
      ],
    });
    const updated = openNewWindow(contract, 10, 10, "auto");
    const f1 = updated.features.find((f) => f.id === "f1")!;
    expect(f1.status).toBe("pending");
  });

  it("deferred features remain deferred after resume", () => {
    const contract = makeContract({
      currentWindow: makeWindow({ windowId: 1 }),
      features: [makeFeature({ id: "f1", status: "deferred" })],
      deferredFeatureIds: ["f1"],
    });
    const updated = openNewWindow(contract, 10, 10, "auto");
    const f1 = updated.features.find((f) => f.id === "f1")!;
    expect(f1.status).toBe("deferred");
    expect(updated.deferredFeatureIds).toContain("f1");
  });

  it("previous window spend is never rewritten on resume", () => {
    const contract = makeContract({
      currentWindow: makeWindow({ windowId: 1, assignedBudget: 20, actualSpent: 18, remainingAssignedBudget: 2 }),
      previousWindows: [],
    });
    const updated = openNewWindow(contract, 10, 10, "auto");
    expect(updated.previousWindows[0].actualSpent).toBe(18);
    // Now spend on new window
    const afterSpend = recordSpend(updated, "f1", 2, false);
    expect(afterSpend.previousWindows[0].actualSpent).toBe(18); // still 18
  });

  it("custom resume budget capped at provider remaining", () => {
    const resolved = resolveAssignedBudget(5, 10);
    expect(resolved.assignedBudget).toBe(5);
    expect(resolved.capped).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// STATUS DISPLAY — auto vs custom budget modes
// ---------------------------------------------------------------------------

describe("status display — budget mode fields", () => {
  it("auto mode: window.budgetMode is 'auto'", () => {
    const result = resolveAssignedBudget(20, null);
    expect(result.budgetMode).toBe("auto");
  });

  it("custom mode: window.budgetMode is 'custom'", () => {
    const result = resolveAssignedBudget(20, 10);
    expect(result.budgetMode).toBe("custom");
  });

  it("manually_supplied mode: resolveAssignedBudget with provider null and no userBudget throws so caller asks user", () => {
    expect(() => resolveAssignedBudget(null, null)).toThrow();
  });

  it("custom budget mode: provider available and assigned budget are distinct", () => {
    const providerAvailable = 23.6;
    const userBudget = 10;
    const result = resolveAssignedBudget(providerAvailable, userBudget);
    expect(result.providerRemainingAtStart).toBe(providerAvailable);
    expect(result.assignedBudget).toBe(userBudget);
    expect(result.assignedBudget).not.toBe(result.providerRemainingAtStart);
  });
});

// ---------------------------------------------------------------------------
// totalReserve + windowRemaining helpers
// ---------------------------------------------------------------------------

describe("totalReserve", () => {
  it("sums all three reserve buckets", () => {
    expect(totalReserve({ validation: 1, repair: 0.5, integration: 0.5 })).toBe(2);
  });

  it("handles zero reserves", () => {
    expect(totalReserve({ validation: 0, repair: 0, integration: 0 })).toBe(0);
  });
});

describe("windowRemaining", () => {
  it("returns assignedBudget - actualSpent", () => {
    const w = makeWindow({ assignedBudget: 10, actualSpent: 3 });
    expect(windowRemaining(w)).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// buildInitialPhaseAllocation
// ---------------------------------------------------------------------------

describe("buildInitialPhaseAllocation", () => {
  it("planning allocation is a small fraction of flexible budget", () => {
    const reserves = makeReserves({ validation: 1, repair: 0.5, integration: 0.5 });
    const alloc = buildInitialPhaseAllocation(20, reserves);
    const flexTotal = 20 - totalReserve(reserves); // 18
    expect(alloc.planning).toBeCloseTo(Math.min(PLANNING_BUDGET_MAX, PLANNING_BUDGET_FRACTION * flexTotal));
  });

  it("total does not exceed assigned budget", () => {
    const reserves = makeReserves();
    const alloc = buildInitialPhaseAllocation(10, reserves);
    const total = alloc.planning + alloc.implementation + alloc.integration + alloc.validation + alloc.repairLanding;
    expect(total).toBeLessThanOrEqual(10 + 0.001); // small float tolerance
  });
});
