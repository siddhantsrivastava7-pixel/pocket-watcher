/**
 * Pocket Watcher — budget engine tests
 *
 * Covers: spendable computation, risk states, canStartFeature guard,
 * featureWallet capping, recordFeatureSpend, nextProjectState transitions.
 */

import {
  totalReserve,
  remainingBudget,
  spendableBudget,
  forecastRemaining,
  computeRiskState,
  featureWallet,
  canStartFeature,
  recordFeatureSpend,
  nextProjectState,
} from "../budget.js";
import type { ProjectBudget, Feature, Reserves } from "../types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
    title: partial.title ?? "Feature 1",
    highEstimate: partial.highEstimate ?? 2,
    spent: partial.spent ?? 0,
    state: partial.state ?? "pending",
  };
}

function makeBudget(partial: Partial<ProjectBudget> = {}): ProjectBudget {
  return {
    startingBudget: partial.startingBudget ?? 10,
    totalSpent: partial.totalSpent ?? 0,
    reserves: partial.reserves ?? makeReserves(),
    features: partial.features ?? [makeFeature()],
    state: partial.state ?? "BUILD",
    activeFeatureId: partial.activeFeatureId ?? null,
  };
}

// ---------------------------------------------------------------------------
// totalReserve
// ---------------------------------------------------------------------------

describe("totalReserve", () => {
  it("sums all three reserve buckets", () => {
    expect(totalReserve({ validation: 1, repair: 0.5, integration: 0.5 })).toBe(2);
  });

  it("handles zero reserves", () => {
    expect(totalReserve({ validation: 0, repair: 0, integration: 0 })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// remainingBudget
// ---------------------------------------------------------------------------

describe("remainingBudget", () => {
  it("subtracts totalSpent from startingBudget", () => {
    expect(remainingBudget(makeBudget({ startingBudget: 10, totalSpent: 3 }))).toBe(7);
  });

  it("returns 0 when exactly spent", () => {
    expect(remainingBudget(makeBudget({ startingBudget: 5, totalSpent: 5 }))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// spendableBudget
// ---------------------------------------------------------------------------

describe("spendableBudget", () => {
  it("subtracts reserves from remaining", () => {
    // remaining = 10, reserve = 2  →  spendable = 8
    const budget = makeBudget({ startingBudget: 10, totalSpent: 0 });
    expect(spendableBudget(budget)).toBe(8);
  });

  it("never goes below 0", () => {
    // remaining = 1, reserve = 2  →  would be -1, clamped to 0
    const budget = makeBudget({
      startingBudget: 5,
      totalSpent: 4,
      reserves: makeReserves({ validation: 1, repair: 0.5, integration: 0.5 }),
    });
    expect(spendableBudget(budget)).toBe(0);
  });

  it("is exactly 0 when remaining equals reserve", () => {
    const budget = makeBudget({ startingBudget: 4, totalSpent: 2, reserves: makeReserves() });
    // remaining=2, reserve=2  →  0
    expect(spendableBudget(budget)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// forecastRemaining
// ---------------------------------------------------------------------------

describe("forecastRemaining", () => {
  it("sums highEstimates for pending and running features only", () => {
    const budget = makeBudget({
      features: [
        makeFeature({ id: "f1", highEstimate: 2, state: "pending" }),
        makeFeature({ id: "f2", highEstimate: 3, state: "running" }),
        makeFeature({ id: "f3", highEstimate: 1, state: "done" }),
        makeFeature({ id: "f4", highEstimate: 1, state: "skipped" }),
      ],
    });
    expect(forecastRemaining(budget)).toBe(5); // f1 + f2
  });

  it("returns 0 when all features are done", () => {
    const budget = makeBudget({
      features: [makeFeature({ state: "done" })],
    });
    expect(forecastRemaining(budget)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeRiskState
// ---------------------------------------------------------------------------

describe("computeRiskState", () => {
  it("returns SAFE when forecast < 80% of spendable", () => {
    // spendable = 8, forecast = 5  →  ratio = 0.625
    const budget = makeBudget({
      startingBudget: 10,
      totalSpent: 0,
      features: [makeFeature({ highEstimate: 5, state: "pending" })],
    });
    expect(computeRiskState(budget)).toBe("SAFE");
  });

  it("returns TIGHT when forecast is exactly 80% of spendable", () => {
    // spendable = 10, forecast = 8  →  ratio = 0.8
    const budget = makeBudget({
      startingBudget: 12,
      totalSpent: 0,
      reserves: makeReserves({ validation: 1, repair: 0.5, integration: 0.5 }),
      features: [makeFeature({ highEstimate: 8, state: "pending" })],
    });
    expect(computeRiskState(budget)).toBe("TIGHT");
  });

  it("returns TIGHT when forecast is between 80% and 100% of spendable", () => {
    // spendable = 10, forecast = 9  →  ratio = 0.9
    const budget = makeBudget({
      startingBudget: 12,
      totalSpent: 0,
      reserves: makeReserves({ validation: 1, repair: 0.5, integration: 0.5 }),
      features: [makeFeature({ highEstimate: 9, state: "pending" })],
    });
    expect(computeRiskState(budget)).toBe("TIGHT");
  });

  it("returns UNSAFE when forecast > spendable", () => {
    // spendable = 8, forecast = 10
    const budget = makeBudget({
      startingBudget: 10,
      totalSpent: 0,
      features: [makeFeature({ highEstimate: 10, state: "pending" })],
    });
    expect(computeRiskState(budget)).toBe("UNSAFE");
  });

  it("returns UNSAFE when spendable is 0", () => {
    const budget = makeBudget({
      startingBudget: 5,
      totalSpent: 4,
      reserves: makeReserves(),
      features: [makeFeature({ highEstimate: 1, state: "pending" })],
    });
    expect(computeRiskState(budget)).toBe("UNSAFE");
  });

  it("returns SAFE when no pending features (forecast = 0)", () => {
    const budget = makeBudget({
      startingBudget: 10,
      totalSpent: 0,
      features: [makeFeature({ state: "done" })],
    });
    expect(computeRiskState(budget)).toBe("SAFE");
  });
});

// ---------------------------------------------------------------------------
// featureWallet
// ---------------------------------------------------------------------------

describe("featureWallet", () => {
  it("returns highEstimate when spendable is larger", () => {
    const budget = makeBudget({ startingBudget: 20, totalSpent: 0 }); // spendable = 18
    const feature = makeFeature({ highEstimate: 5 });
    expect(featureWallet(budget, feature)).toBe(5);
  });

  it("caps at spendable when spendable < highEstimate", () => {
    // spendable = 3, highEstimate = 5
    const budget = makeBudget({
      startingBudget: 5,
      totalSpent: 0,
      reserves: makeReserves({ validation: 1, repair: 0.5, integration: 0.5 }),
    });
    const feature = makeFeature({ highEstimate: 5 });
    expect(featureWallet(budget, feature)).toBe(3);
  });

  it("returns 0 when spendable is 0", () => {
    const budget = makeBudget({ startingBudget: 2, totalSpent: 0, reserves: makeReserves() });
    const feature = makeFeature({ highEstimate: 5 });
    expect(featureWallet(budget, feature)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// canStartFeature
// ---------------------------------------------------------------------------

describe("canStartFeature", () => {
  it("allows start when highEstimate <= spendable", () => {
    const budget = makeBudget({ startingBudget: 10, totalSpent: 0 }); // spendable=8
    const feature = makeFeature({ highEstimate: 8 });
    expect(canStartFeature(budget, feature)).toBe(true);
  });

  it("blocks start when highEstimate > spendable", () => {
    const budget = makeBudget({ startingBudget: 10, totalSpent: 0 }); // spendable=8
    const feature = makeFeature({ highEstimate: 9 });
    expect(canStartFeature(budget, feature)).toBe(false);
  });

  it("blocks start when spendable is 0", () => {
    const budget = makeBudget({ startingBudget: 2, totalSpent: 0, reserves: makeReserves() });
    const feature = makeFeature({ highEstimate: 0.1 });
    expect(canStartFeature(budget, feature)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// recordFeatureSpend
// ---------------------------------------------------------------------------

describe("recordFeatureSpend", () => {
  it("updates totalSpent and marks feature done", () => {
    const budget = makeBudget({ startingBudget: 10, totalSpent: 0 });
    const updated = recordFeatureSpend(budget, "f1", 1.5);
    expect(updated.totalSpent).toBeCloseTo(1.5);
    expect(updated.features[0].state).toBe("done");
    expect(updated.features[0].spent).toBeCloseTo(1.5);
  });

  it("clears activeFeatureId", () => {
    const budget = makeBudget({ activeFeatureId: "f1" });
    const updated = recordFeatureSpend(budget, "f1", 1);
    expect(updated.activeFeatureId).toBeNull();
  });

  it("does not mutate the original budget", () => {
    const budget = makeBudget({ totalSpent: 0 });
    recordFeatureSpend(budget, "f1", 2);
    expect(budget.totalSpent).toBe(0);
  });

  it("transitions to LAND when no more pending features", () => {
    const budget = makeBudget({
      startingBudget: 10,
      totalSpent: 0,
      features: [makeFeature({ id: "f1", highEstimate: 2, state: "pending" })],
    });
    const updated = recordFeatureSpend(budget, "f1", 1);
    expect(updated.state).toBe("LAND");
  });

  it("stays in BUILD when more pending features remain and not UNSAFE", () => {
    const budget = makeBudget({
      startingBudget: 20,
      totalSpent: 0,
      features: [
        makeFeature({ id: "f1", highEstimate: 2, state: "pending" }),
        makeFeature({ id: "f2", highEstimate: 2, state: "pending" }),
      ],
    });
    const updated = recordFeatureSpend(budget, "f1", 1);
    expect(updated.state).toBe("BUILD");
  });

  it("transitions to COMPRESS when UNSAFE and pending features remain", () => {
    // After recording spend, remaining is tiny → UNSAFE
    const budget = makeBudget({
      startingBudget: 5,
      totalSpent: 2,
      reserves: makeReserves({ validation: 1, repair: 0.5, integration: 0.5 }),
      features: [
        makeFeature({ id: "f1", highEstimate: 0.5, state: "pending" }),
        makeFeature({ id: "f2", highEstimate: 5, state: "pending" }),
      ],
    });
    // After spending 2.5 more → totalSpent=4.5, remaining=0.5, spendable≤0 → UNSAFE
    const updated = recordFeatureSpend(budget, "f1", 2.5);
    expect(updated.state).toBe("COMPRESS");
  });
});

// ---------------------------------------------------------------------------
// nextProjectState
// ---------------------------------------------------------------------------

describe("nextProjectState", () => {
  it("returns BUILD when SAFE and pending features exist", () => {
    const budget = makeBudget({
      features: [makeFeature({ state: "pending" })],
    });
    expect(nextProjectState(budget, "SAFE")).toBe("BUILD");
  });

  it("returns BUILD when TIGHT and pending features exist", () => {
    const budget = makeBudget({
      features: [makeFeature({ state: "pending" })],
    });
    expect(nextProjectState(budget, "TIGHT")).toBe("BUILD");
  });

  it("returns LAND when SAFE and no pending features", () => {
    const budget = makeBudget({
      features: [makeFeature({ state: "done" })],
    });
    expect(nextProjectState(budget, "SAFE")).toBe("LAND");
  });

  it("returns COMPRESS when UNSAFE and pending features exist", () => {
    const budget = makeBudget({
      features: [makeFeature({ state: "pending" })],
    });
    expect(nextProjectState(budget, "UNSAFE")).toBe("COMPRESS");
  });

  it("returns LAND when UNSAFE and no pending features", () => {
    const budget = makeBudget({
      features: [makeFeature({ state: "done" })],
    });
    expect(nextProjectState(budget, "UNSAFE")).toBe("LAND");
  });
});
