#!/usr/bin/env node
/**
 * Pocket Watcher CLI — V1 + packaging
 *
 * Commands:
 *   pocket init [--budget <n>]
 *   pocket scope "<request>"
 *   pocket status
 *   pocket run <feature-id>
 *   pocket validate <feature-id>
 *   pocket validate --all
 *   pocket check
 *   pocket repair <feature-id>
 *   pocket defer <feature-id>
 *   pocket land
 *   pocket resume [--budget <n>]
 *   pocket install bob [--global|--project]
 */
import { argv, exit, stdin, stdout } from "node:process";
import * as readline from "node:readline";
import { randomUUID } from "node:crypto";
import { loadContract, saveContract, appendHistory, appendValidationHistory, appendRepairHistory, appendProjectCheckHistory } from "./store.js";
import { totalReserve, spendableBudget, computeRiskState, canStartFeature, canRepairFeature, recordSpend, recordRepairSpend, setFeatureStatus, applyBurnFactorReforecast, applyBurnFactorReforecastAfterValidation, deferFeature, openNewWindow, buildForecast, nextProjectState, bobMaxCost, featureWallet, repairWallet, planningWallet, resolveAssignedBudget, buildInitialPhaseAllocation, DEFAULT_RESERVES, DEFAULT_OVERSHOOT_GUARD, } from "./budget.js";
import { runWithBudget, buildFeaturePrompt, buildRepairPrompt } from "./runner.js";
import { validateFeature, validateProject } from "./validation.js";
import { installSkill } from "./install.js";
// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
function bc(n) {
    return `${n.toFixed(4)} BC`;
}
function riskBadge(r) {
    if (r === "SAFE")
        return "✅ SAFE";
    if (r === "TIGHT")
        return "⚠️  TIGHT";
    return "🚨 UNSAFE";
}
function featureStatusIcon(s) {
    switch (s) {
        case "done": return "✓";
        case "running": return "▶";
        case "deferred": return "⏸";
        case "budget_interrupted": return "⚡";
        case "awaiting_validation": return "?";
        case "validation_failed": return "✗";
        default: return "○";
    }
}
// ---------------------------------------------------------------------------
// Prompt helper (asks user a question on stdin)
// ---------------------------------------------------------------------------
function askQuestion(question) {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}
// ---------------------------------------------------------------------------
// Parse CLI flags
// ---------------------------------------------------------------------------
function parseBudgetFlag(args) {
    const idx = args.indexOf("--budget");
    if (idx === -1)
        return null;
    const val = parseFloat(args[idx + 1]);
    if (isNaN(val) || val <= 0) {
        console.error(`Error: --budget must be a positive number`);
        exit(1);
    }
    return val;
}
// ---------------------------------------------------------------------------
// Provider budget acquisition (Bob V1)
// ---------------------------------------------------------------------------
/**
 * Attempt to get provider remaining quota.
 * Bob V1: no reliable API for remaining balance → returns null.
 */
async function getProviderRemaining() {
    return null;
}
/**
 * Ask the user once how much compute they have remaining.
 */
async function askUserForBudget() {
    console.log(`\nPocket Watcher cannot determine your remaining provider quota automatically.`);
    const answer = await askQuestion(`How much usage do you currently have left in this window (in Bobcoins)? `);
    const val = parseFloat(answer);
    if (isNaN(val) || val <= 0) {
        console.error(`Error: Please enter a positive number.`);
        exit(1);
    }
    return val;
}
// ---------------------------------------------------------------------------
// 1. pocket init [--budget <n>]
// ---------------------------------------------------------------------------
async function cmdInit(args) {
    const userBudget = parseBudgetFlag(args);
    let providerRemaining = await getProviderRemaining();
    if (userBudget === null && providerRemaining === null) {
        providerRemaining = await askUserForBudget();
    }
    const resolved = resolveAssignedBudget(providerRemaining, userBudget);
    if (resolved.capped && userBudget !== null && providerRemaining !== null) {
        console.log(`\n⚠️  Budget capped:`);
        console.log(`   Requested budget       ${bc(userBudget)}`);
        console.log(`   Available this window  ${bc(providerRemaining)}`);
        console.log(`   Maximum assignable     ${bc(providerRemaining)}`);
    }
    const reserves = DEFAULT_RESERVES;
    const phaseAllocation = buildInitialPhaseAllocation(resolved.assignedBudget, reserves);
    const now = new Date().toISOString();
    const window = {
        windowId: 1,
        provider: "bob",
        unit: "bobcoin",
        budgetMode: userBudget === null ? resolved.budgetMode : "custom",
        providerRemainingAtStart: resolved.providerRemainingAtStart,
        assignedBudget: resolved.assignedBudget,
        actualSpent: 0,
        remainingAssignedBudget: resolved.assignedBudget,
        createdAt: now,
        closedAt: null,
    };
    if (userBudget === null) {
        if (resolved.budgetMode === "auto") {
            window.budgetMode = "auto";
        }
        else {
            window.budgetMode = "manually_supplied";
        }
    }
    const contract = {
        projectId: randomUUID(),
        createdAt: now,
        updatedAt: now,
        currentWindow: window,
        previousWindows: [],
        reserves,
        phaseAllocation,
        overshootGuard: DEFAULT_OVERSHOOT_GUARD,
        features: [],
        deferredFeatureIds: [],
        activeFeatureId: null,
        forecast: {
            remainingHighBC: 0,
            remainingLowBC: 0,
            riskState: "SAFE",
        },
        state: "SCOPE",
    };
    await saveContract(contract);
    console.log(`\n✅ Pocket Watcher initialized`);
    console.log(`   Provider        : Bob`);
    console.log(`   Unit            : Bobcoin`);
    console.log(`   Budget mode     : ${window.budgetMode}`);
    if (window.providerRemainingAtStart !== null) {
        console.log(`   Provider quota  : ${bc(window.providerRemainingAtStart)}`);
    }
    console.log(`   Assigned budget : ${bc(window.assignedBudget)}`);
    console.log(`   Protected floor : ${bc(totalReserve(reserves))}`);
    console.log(`   Spendable       : ${bc(window.assignedBudget - totalReserve(reserves))}`);
    console.log(`\n   Run: pocket scope "<your request>"`);
}
// ---------------------------------------------------------------------------
// 2. pocket scope "<request>"
// ---------------------------------------------------------------------------
async function cmdScope(args) {
    const request = args.join(" ").replace(/^"|"$/g, "");
    if (!request) {
        console.error(`Usage: pocket scope "<product or task request>"`);
        exit(1);
    }
    let contract = await loadContract();
    const spendable = spendableBudget(contract);
    const pWallet = planningWallet(contract);
    console.log(`\nPOCKET WATCHER — Planning`);
    console.log(`═════════════════════════`);
    console.log(`Request   : ${request}`);
    console.log(`Spendable : ${bc(spendable)}`);
    console.log(`Plan wallet: ${bc(pWallet)}`);
    if (pWallet <= contract.overshootGuard) {
        console.error(`🚨 Planning wallet too small (${bc(pWallet)}). Check budget.`);
        exit(1);
    }
    const apiKey = process.env.BOB_API_KEY;
    if (!apiKey) {
        console.error(`Error: BOB_API_KEY is required for pocket scope`);
        exit(1);
    }
    const planningPrompt = buildPlanningPrompt(request, spendable);
    const planMaxCost = Math.max(0.001, pWallet - contract.overshootGuard);
    console.log(`\nRunning planning with max-cost: ${bc(planMaxCost)} ...`);
    let planResult;
    try {
        planResult = await runWithBudget(planningPrompt, planMaxCost);
    }
    catch (err) {
        console.error(`Error during planning: ${err.message}`);
        exit(1);
    }
    const stateBefore = contract.state;
    contract = recordSpend(contract, null, planResult.actualCost, planResult.costLimitHit);
    const histEntry = {
        windowId: contract.currentWindow.windowId,
        timestamp: new Date().toISOString(),
        featureId: null,
        phase: "planning",
        predictedLow: null,
        predictedHigh: pWallet,
        assignedWallet: pWallet,
        bobMaxCost: planMaxCost,
        realSessionCosts: planResult.actualCost,
        durationMs: planResult.resultLine?.stats.duration_ms ?? null,
        toolCalls: planResult.resultLine?.stats.tool_calls ?? null,
        bobTaskId: planResult.resultLine?.stats.task_id ?? null,
        normalCompletion: !planResult.costLimitHit,
        budgetInterrupted: planResult.costLimitHit,
        finalFeatureStatus: null,
        stateBefore,
        stateAfter: contract.state,
        note: "planning run",
    };
    await appendHistory(histEntry);
    const planOutput = planResult.resultLine?.last_message ?? "";
    const candidates = parsePlanningOutput(planOutput);
    if (candidates.length === 0) {
        console.log(`\n⚠️  Could not automatically parse features from planning output.`);
        console.log(`\nPlanning output:\n${planOutput.slice(0, 2000)}`);
        console.log(`\nAdd features manually to .pocket/ship-contract.json`);
        await saveContract(contract);
        return;
    }
    const newSpendable = spendableBudget(contract);
    const totalHighEstimate = candidates.reduce((s, f) => s + f.estimate.high, 0);
    console.log(`\nCandidate features (${candidates.length}):`);
    for (const f of candidates) {
        console.log(`  [${f.id}] ${f.name}  est: ${bc(f.estimate.low)}–${bc(f.estimate.high)}  priority: ${f.priority}`);
    }
    console.log(`\nTotal estimate  : ${bc(totalHighEstimate)}`);
    console.log(`Safe envelope   : ${bc(newSpendable)}`);
    let selectedFeatures = candidates;
    if (totalHighEstimate > newSpendable) {
        console.log(`\n⚠️  Full request does not fit safely in this compute window.`);
        console.log(`\nPOCKET WATCHER`);
        console.log(`Available project budget   ${bc(newSpendable)}`);
        console.log(`Protected finish reserve   ${bc(totalReserve(contract.reserves))}`);
        console.log(`\nWhich outcomes are essential? (Enter IDs separated by commas, or "all")`);
        for (const f of candidates) {
            console.log(`  [ ] ${f.id}: ${f.name}  (est ${bc(f.estimate.low)}–${bc(f.estimate.high)})`);
        }
        const answer = await askQuestion(`\nEssential feature IDs: `);
        if (answer.toLowerCase() !== "all") {
            const essentialIds = answer.split(",").map((s) => s.trim()).filter(Boolean);
            selectedFeatures = candidates.filter((f) => essentialIds.includes(f.id));
            const deferred = candidates.filter((f) => !essentialIds.includes(f.id));
            if (deferred.length > 0) {
                console.log(`\nDeferred: ${deferred.map((f) => f.id).join(", ")}`);
            }
        }
    }
    const deferredIds = candidates
        .filter((f) => !selectedFeatures.some((s) => s.id === f.id))
        .map((f) => f.id);
    const featuresWithWindow = [
        ...selectedFeatures.map((f) => ({
            ...f,
            status: "pending",
            actualSpent: 0,
            windowId: contract.currentWindow.windowId,
        })),
        ...candidates
            .filter((f) => deferredIds.includes(f.id))
            .map((f) => ({
            ...f,
            status: "deferred",
            actualSpent: 0,
            windowId: contract.currentWindow.windowId,
        })),
    ];
    contract = {
        ...contract,
        features: featuresWithWindow,
        deferredFeatureIds: deferredIds,
        state: "BUILD",
        updatedAt: new Date().toISOString(),
    };
    const forecast = buildForecast(contract);
    contract = {
        ...contract,
        forecast,
        state: nextProjectState(contract, forecast.riskState),
    };
    await saveContract(contract);
    console.log(`\n✅ Ship Contract created`);
    console.log(`   Active features : ${selectedFeatures.length}`);
    console.log(`   Deferred        : ${deferredIds.length}`);
    console.log(`\n   Run: pocket status`);
}
function buildPlanningPrompt(request, spendableBudgetBC) {
    return [
        `You are a planning assistant. Your ONLY job is to decompose the following request into a compact, structured JSON list of candidate features.`,
        ``,
        `Request: "${request}"`,
        ``,
        `Available compute budget (Bobcoins): ${spendableBudgetBC.toFixed(4)}`,
        ``,
        `RULES:`,
        `- Respond ONLY with a valid JSON array. No prose, no markdown fences.`,
        `- Each feature must have: id (string), name (string), goal (string), dependencies (string[]), priority ("must"|"should"|"could"), estimate ({low: number, high: number, confidence: "low"|"medium"|"high"}), acceptance (string[]), excluded (string[])`,
        `- Estimate costs in Bobcoins. Be conservative — do NOT underestimate.`,
        `- Keep features small and independently shippable where possible.`,
        `- Do NOT produce architecture essays, speculative systems, or implementation plans for deferred features.`,
        `- If the full scope exceeds the budget, list lower-priority items as "could" priority.`,
        ``,
        `Respond with ONLY the JSON array.`,
    ].join("\n");
}
function parsePlanningOutput(output) {
    const match = output.match(/\[[\s\S]*\]/);
    if (!match)
        return [];
    try {
        const parsed = JSON.parse(match[0]);
        if (!Array.isArray(parsed))
            return [];
        return parsed.filter(isValidCandidate);
    }
    catch {
        return [];
    }
}
function isValidCandidate(obj) {
    if (typeof obj !== "object" || obj === null)
        return false;
    const o = obj;
    return (typeof o.id === "string" &&
        typeof o.name === "string" &&
        typeof o.goal === "string" &&
        Array.isArray(o.dependencies) &&
        typeof o.priority === "string" &&
        typeof o.estimate === "object" &&
        o.estimate !== null &&
        typeof o.estimate.low === "number" &&
        typeof o.estimate.high === "number" &&
        Array.isArray(o.acceptance) &&
        Array.isArray(o.excluded));
}
// ---------------------------------------------------------------------------
// 3. pocket status
// ---------------------------------------------------------------------------
async function cmdStatus() {
    const contract = await loadContract();
    const cw = contract.currentWindow;
    const spendable = spendableBudget(contract);
    const reserve = totalReserve(contract.reserves);
    const risk = computeRiskState(contract);
    const forecast = contract.forecast;
    console.log(`\nPOCKET WATCHER`);
    console.log(`══════════════`);
    console.log(`Provider   : Bob`);
    console.log(`Unit       : Bobcoin`);
    console.log(``);
    console.log(`Compute window #${cw.windowId}`);
    console.log(`  Mode              : ${cw.budgetMode.toUpperCase()}`);
    if (cw.providerRemainingAtStart !== null) {
        console.log(`  Provider available: ${bc(cw.providerRemainingAtStart)}`);
    }
    if (cw.budgetMode === "custom") {
        console.log(`  Project cap       : ${bc(cw.assignedBudget)}`);
        console.log(`  Project remaining : ${bc(cw.remainingAssignedBudget)}`);
    }
    else {
        console.log(`  Assigned          : ${bc(cw.assignedBudget)}`);
        console.log(`  Spent             : ${bc(cw.actualSpent)}`);
        console.log(`  Remaining         : ${bc(cw.remainingAssignedBudget)}`);
    }
    console.log(``);
    console.log(`  Protected landing : ${bc(reserve)}`);
    console.log(`  Flexible spendable: ${bc(spendable)}`);
    console.log(``);
    console.log(`Remaining forecast  : ${bc(forecast.remainingLowBC)}–${bc(forecast.remainingHighBC)}`);
    console.log(`Risk                : ${riskBadge(risk)}`);
    console.log(`State               : ${contract.state}`);
    if (contract.features.length > 0) {
        console.log(``);
        console.log(`Ship Contract:`);
        for (const f of contract.features) {
            if (f.status === "deferred")
                continue;
            const icon = featureStatusIcon(f.status);
            const spentStr = f.actualSpent > 0 ? `  actual ${bc(f.actualSpent)}` : `  wallet ~${bc(f.estimate.high)}`;
            console.log(`  ${icon} ${f.id} ${f.name}${spentStr}`);
        }
        const deferred = contract.features.filter((f) => f.status === "deferred");
        if (deferred.length > 0) {
            console.log(``);
            console.log(`Deferred:`);
            for (const f of deferred) {
                console.log(`  - ${f.id}: ${f.name}`);
            }
        }
    }
    if (contract.previousWindows.length > 0) {
        console.log(``);
        console.log(`Previous windows:`);
        for (const w of contract.previousWindows) {
            console.log(`  Window #${w.windowId}: assigned ${bc(w.assignedBudget)} spent ${bc(w.actualSpent)}`);
        }
    }
    console.log();
}
// ---------------------------------------------------------------------------
// 4. pocket run <feature-id>
// ---------------------------------------------------------------------------
async function cmdRun(featureId) {
    let contract = await loadContract();
    const feature = contract.features.find((f) => f.id === featureId);
    if (!feature) {
        console.error(`Error: feature "${featureId}" not found`);
        exit(1);
    }
    if (feature.status === "done") {
        console.error(`Error: feature "${featureId}" is already done`);
        exit(1);
    }
    if (feature.status === "deferred") {
        console.error(`Error: feature "${featureId}" is deferred. Use 'pocket defer' to manage.`);
        exit(1);
    }
    // LAND mode: block ALL new pending features.
    // Only allows validation, check, and repair (handled by separate commands).
    if (contract.state === "LAND") {
        console.error(`🚨 Project is in LAND mode. No new features may be started.\n` +
            `   LAND allows: pocket validate, pocket check, pocket repair <id> for failed features.\n` +
            `   Use 'pocket status' to review the current state.`);
        exit(2);
    }
    if (contract.state === "COMPRESS") {
        console.error(`⚠️  Project is in COMPRESS mode. Run 'pocket status' and 'pocket defer' to reduce scope first.`);
        exit(2);
    }
    // Check dependencies
    for (const depId of feature.dependencies) {
        const dep = contract.features.find((f) => f.id === depId);
        if (!dep || dep.status !== "done") {
            console.error(`Error: dependency "${depId}" of feature "${featureId}" is not done yet.`);
            exit(1);
        }
    }
    if (!canStartFeature(contract, feature)) {
        const spendable = spendableBudget(contract);
        console.error(`🚨 Cannot start "${featureId}". ` +
            `Estimate ${bc(feature.estimate.high)} exceeds safe spendable ${bc(spendable)}. ` +
            `Transitioning to COMPRESS.`);
        const risk = computeRiskState(contract);
        contract = {
            ...contract,
            state: nextProjectState(contract, risk),
            updatedAt: new Date().toISOString(),
        };
        await saveContract(contract);
        exit(2);
    }
    const maxCost = bobMaxCost(contract, feature);
    if (maxCost === null || maxCost <= 0) {
        console.error(`🚨 Feature wallet after overshoot guard is zero or negative. Transitioning to LAND.`);
        contract = { ...contract, state: "LAND", updatedAt: new Date().toISOString() };
        await saveContract(contract);
        exit(2);
    }
    const wallet = featureWallet(contract, feature);
    console.log(`\n▶ Running feature: [${feature.id}] ${feature.name}`);
    console.log(`  Wallet (estimate) : ${bc(wallet)}`);
    console.log(`  bob --max-cost    : ${bc(maxCost)}`);
    console.log(`  Spendable budget  : ${bc(spendableBudget(contract))}`);
    console.log();
    const stateBefore = contract.state;
    contract = {
        ...contract,
        activeFeatureId: featureId,
        features: contract.features.map((f) => f.id === featureId ? { ...f, status: "running" } : f),
        updatedAt: new Date().toISOString(),
    };
    await saveContract(contract);
    const prompt = buildFeaturePrompt(feature, contract.deferredFeatureIds);
    let runResult;
    try {
        runResult = await runWithBudget(prompt, maxCost);
    }
    catch (err) {
        console.error(`Error running bob: ${err.message}`);
        exit(1);
    }
    const { actualCost, costLimitHit, exitCode, resultLine } = runResult;
    console.log(`\nBob run complete:`);
    console.log(`  Exit code         : ${exitCode}`);
    console.log(`  Cost limit hit    : ${costLimitHit}`);
    console.log(`  Actual cost       : ${bc(actualCost)}`);
    console.log(`  Result status     : ${resultLine?.status ?? "unknown"}`);
    if (resultLine?.last_message) {
        console.log(`  Last message      : ${resultLine.last_message.slice(0, 120)}`);
    }
    // recordSpend: non-interrupted run → awaiting_validation (NOT done)
    contract = recordSpend(contract, featureId, actualCost, costLimitHit);
    if (!costLimitHit) {
        contract = applyBurnFactorReforecast(contract, featureId, actualCost);
    }
    await saveContract(contract);
    const risk = computeRiskState(contract);
    const finalFeature = contract.features.find((f) => f.id === featureId);
    const histEntry = {
        windowId: contract.currentWindow.windowId,
        timestamp: new Date().toISOString(),
        featureId,
        phase: "implementation",
        predictedLow: feature.estimate.low,
        predictedHigh: feature.estimate.high,
        assignedWallet: wallet,
        bobMaxCost: maxCost,
        realSessionCosts: actualCost,
        durationMs: resultLine?.stats.duration_ms ?? null,
        toolCalls: resultLine?.stats.tool_calls ?? null,
        bobTaskId: resultLine?.stats.task_id ?? null,
        normalCompletion: !costLimitHit,
        budgetInterrupted: costLimitHit,
        finalFeatureStatus: finalFeature?.status ?? null,
        stateBefore,
        stateAfter: contract.state,
        note: costLimitHit ? "budget interrupted" : "completed — awaiting validation",
    };
    await appendHistory(histEntry);
    console.log(`\nBudget updated:`);
    console.log(`  Window spent  : ${bc(contract.currentWindow.actualSpent)}`);
    console.log(`  Remaining     : ${bc(contract.currentWindow.remainingAssignedBudget)}`);
    console.log(`  Spendable     : ${bc(spendableBudget(contract))}`);
    console.log(`  Risk          : ${riskBadge(risk)}`);
    console.log(`  Project state : ${contract.state}`);
    if (costLimitHit) {
        console.log(`\n⚡ Cost limit hit — feature marked budget_interrupted.`);
        console.log(`   Partial workspace changes may exist.`);
        console.log(`   Feature is NOT considered completed.`);
        console.log(`   Use: pocket repair ${featureId}`);
    }
    else {
        // Run deterministic validation immediately after a normal completion
        console.log(`\n🔍 Running deterministic validation for ${featureId}...`);
        await runAndReportValidation(contract, feature);
    }
    console.log();
}
// ---------------------------------------------------------------------------
// Shared validation runner (used by cmdRun and cmdValidate)
// ---------------------------------------------------------------------------
async function runAndReportValidation(contract, feature) {
    // Capture pre-validation status — needed to decide whether to apply cost learning.
    const preValidationStatus = feature.status;
    const valResult = await validateFeature(feature);
    if (valResult === null) {
        // No deterministic validation configured
        contract = setFeatureStatus(contract, feature.id, "awaiting_validation");
        await saveContract(contract);
        const valHistEntry = {
            event: "validation",
            timestamp: new Date().toISOString(),
            featureId: feature.id,
            commands: [],
            passed: false,
            durationMs: 0,
        };
        await appendValidationHistory(valHistEntry);
        console.log(`\n⚠️  No deterministic validation configured for ${feature.id}.`);
        console.log(`   Feature status: awaiting_validation`);
        console.log(`   Deterministic acceptance evidence is unavailable.`);
        console.log(`   Configure feature.validation.commands in .pocket/ship-contract.json`);
        console.log(`   or manually verify and update status to done.`);
        return;
    }
    const valHistEntry = {
        event: "validation",
        timestamp: new Date().toISOString(),
        featureId: feature.id,
        commands: valResult.commands,
        passed: valResult.passed,
        durationMs: valResult.durationMs,
    };
    await appendValidationHistory(valHistEntry);
    if (valResult.passed) {
        contract = setFeatureStatus(contract, feature.id, "done");
        // Cost-learning for interrupted-but-validated work:
        // If the run was budget_interrupted and validation now proves it done,
        // the actual spend is legitimate historical evidence. Apply burn factor
        // reforecast exactly once (guarded by burnFactorApplied flag).
        if (preValidationStatus === "budget_interrupted") {
            const completedFeature = contract.features.find((f) => f.id === feature.id);
            if (completedFeature && completedFeature.actualSpent > 0) {
                contract = applyBurnFactorReforecastAfterValidation(contract, feature.id);
                const bf = completedFeature.actualSpent / feature.estimate.high;
                if (bf > 1.0) {
                    console.log(`\n📊 Cost learning: interrupted run actual spend ${bc(completedFeature.actualSpent)} ` +
                        `exceeded high estimate ${bc(feature.estimate.high)} ` +
                        `(burn factor ${bf.toFixed(2)}×). Remaining forecasts updated.`);
                }
            }
        }
        await saveContract(contract);
        console.log(`\n✅ Validation PASSED — feature ${feature.id} marked done.`);
        console.log(`   Ran ${valResult.commands.length} command(s) in ${valResult.durationMs}ms`);
    }
    else {
        contract = setFeatureStatus(contract, feature.id, "validation_failed");
        await saveContract(contract);
        console.log(`\n❌ Validation FAILED — feature ${feature.id} marked validation_failed.`);
        for (const cmd of valResult.commands) {
            const mark = cmd.passed ? "✓" : "✗";
            console.log(`  ${mark} ${cmd.command}  (exit ${cmd.exitCode})`);
            if (!cmd.passed && cmd.stderr) {
                console.log(`     stderr: ${cmd.stderr.trim().slice(0, 200)}`);
            }
        }
        console.log(`\n   Use: pocket repair ${feature.id}`);
    }
}
// ---------------------------------------------------------------------------
// 5. pocket validate <feature-id> | --all
// ---------------------------------------------------------------------------
async function cmdValidate(args) {
    const contract = await loadContract();
    if (args[0] === "--all") {
        await cmdValidateAll(contract);
        return;
    }
    const featureId = args[0];
    if (!featureId) {
        console.error("Usage: pocket validate <feature-id> | --all");
        exit(1);
    }
    const feature = contract.features.find((f) => f.id === featureId);
    if (!feature) {
        console.error(`Error: feature "${featureId}" not found`);
        exit(1);
    }
    if (feature.status === "deferred") {
        console.error(`Error: feature "${featureId}" is deferred — skipping validation.`);
        exit(1);
    }
    console.log(`\n🔍 Validating ${featureId}: ${feature.name}`);
    console.log(`   (zero Bobcoins consumed)`);
    await runAndReportValidation(contract, feature);
    console.log();
}
async function cmdValidateAll(contract) {
    const eligible = contract.features.filter((f) => f.status !== "deferred" &&
        f.status !== "pending" &&
        f.validation &&
        f.validation.commands.length > 0);
    if (eligible.length === 0) {
        console.log(`\nNo features with deterministic validation configured (or none are eligible).`);
        return;
    }
    console.log(`\n🔍 Validating ${eligible.length} feature(s) — zero Bobcoins consumed`);
    console.log(`═══════════════════════════════════════════`);
    for (const feature of eligible) {
        console.log(`\n  [${feature.id}] ${feature.name}`);
        await runAndReportValidation(contract, feature);
        // Re-load after each save
        contract = await loadContract();
        const updated = contract.features.find((f) => f.id === feature.id);
        if (updated) {
            console.log(`  Status: ${updated.status}`);
        }
    }
    console.log();
}
// ---------------------------------------------------------------------------
// 6. pocket check — project-level validation
// ---------------------------------------------------------------------------
async function cmdCheck() {
    const contract = await loadContract();
    if (!contract.projectValidation || contract.projectValidation.commands.length === 0) {
        console.log(`\nNo project-level validation configured.`);
        console.log(`Add "projectValidation": {"commands": [...]} to .pocket/ship-contract.json`);
        return;
    }
    console.log(`\n🔍 Project validation check — zero Bobcoins consumed`);
    console.log(`═══════════════════════════════════════════`);
    for (const cmd of contract.projectValidation.commands) {
        console.log(`  → ${cmd}`);
    }
    console.log();
    const result = await validateProject(contract.projectValidation);
    if (result === null) {
        console.log(`No project validation commands to run.`);
        return;
    }
    const histEntry = {
        event: "project_check",
        timestamp: new Date().toISOString(),
        commands: result.commands,
        passed: result.passed,
        durationMs: result.durationMs,
    };
    await appendProjectCheckHistory(histEntry);
    if (result.passed) {
        console.log(`✅ Project check PASSED in ${result.durationMs}ms`);
        for (const cmd of result.commands) {
            console.log(`  ✓ ${cmd.command}`);
        }
    }
    else {
        console.log(`❌ Project check FAILED in ${result.durationMs}ms`);
        for (const cmd of result.commands) {
            const mark = cmd.passed ? "✓" : "✗";
            console.log(`  ${mark} ${cmd.command}  (exit ${cmd.exitCode})`);
            if (!cmd.passed && cmd.stderr) {
                console.log(`     stderr: ${cmd.stderr.trim().slice(0, 300)}`);
            }
        }
        console.log(`\nResult NOT fabricated. Fix the failures above.`);
    }
    console.log();
}
// ---------------------------------------------------------------------------
// 7. pocket repair <feature-id>
// ---------------------------------------------------------------------------
async function cmdRepair(featureId) {
    let contract = await loadContract();
    const feature = contract.features.find((f) => f.id === featureId);
    if (!feature) {
        console.error(`Error: feature "${featureId}" not found`);
        exit(1);
    }
    // Repair eligibility check
    const eligibleStatuses = ["validation_failed", "budget_interrupted", "awaiting_validation"];
    if (!eligibleStatuses.includes(feature.status)) {
        console.error(`Error: feature "${featureId}" is not eligible for repair.\n` +
            `  Current status: ${feature.status}\n` +
            `  Eligible:       ${eligibleStatuses.join(", ")}`);
        exit(1);
    }
    // LAND mode allows repair of failed must-ship features
    // COMPRESS mode also allows repair
    if (!canRepairFeature(contract, feature)) {
        const repairReserve = contract.reserves.repair;
        console.error(`🚨 LANDING BUDGET TOO LOW FOR REPAIR\n` +
            `   Repair reserve : ${bc(repairReserve)}\n` +
            `   Overshoot guard: ${bc(contract.overshootGuard)}\n` +
            `   Safe repair amt: ${bc(repairReserve - contract.overshootGuard)}\n` +
            `   Workspace preserved. Cannot launch Bob for repair.`);
        exit(2);
    }
    const rWallet = repairWallet(contract);
    if (rWallet === null || rWallet <= 0) {
        console.error(`🚨 LANDING BUDGET TOO LOW FOR REPAIR. Workspace preserved.`);
        exit(2);
    }
    // Get failed commands for the repair prompt
    const failedCommands = feature.validation
        ? (await validateFeature(feature))?.commands.filter((c) => !c.passed) ?? []
        : [];
    console.log(`\n🔧 Repair: [${feature.id}] ${feature.name}`);
    console.log(`  Status         : ${feature.status}`);
    console.log(`  Repair wallet  : ${bc(rWallet)}`);
    console.log(`  (funded from repair reserve only)`);
    console.log();
    // Build repair prompt
    const repairPrompt = buildRepairPrompt(feature, failedCommands, contract.deferredFeatureIds);
    // Mark as running
    const stateBefore = contract.state;
    contract = {
        ...contract,
        activeFeatureId: featureId,
        features: contract.features.map((f) => f.id === featureId ? { ...f, status: "running" } : f),
        updatedAt: new Date().toISOString(),
    };
    await saveContract(contract);
    let runResult;
    try {
        runResult = await runWithBudget(repairPrompt, rWallet);
    }
    catch (err) {
        console.error(`Error running bob repair: ${err.message}`);
        exit(1);
    }
    const { actualCost, costLimitHit, exitCode, resultLine } = runResult;
    console.log(`\nRepair run complete:`);
    console.log(`  Exit code         : ${exitCode}`);
    console.log(`  Cost limit hit    : ${costLimitHit}`);
    console.log(`  Actual cost       : ${bc(actualCost)}`);
    // Record repair spend from repair reserve
    contract = recordRepairSpend(contract, featureId, actualCost, costLimitHit);
    await saveContract(contract);
    // Run validation after repair
    const updatedFeature = contract.features.find((f) => f.id === featureId);
    let validationPassed = null;
    if (!costLimitHit && updatedFeature) {
        console.log(`\n🔍 Running deterministic validation after repair...`);
        const valResult = await validateFeature(updatedFeature);
        if (valResult !== null) {
            validationPassed = valResult.passed;
            const valHistEntry = {
                event: "validation",
                timestamp: new Date().toISOString(),
                featureId,
                commands: valResult.commands,
                passed: valResult.passed,
                durationMs: valResult.durationMs,
            };
            await appendValidationHistory(valHistEntry);
            if (valResult.passed) {
                contract = setFeatureStatus(contract, featureId, "done");
                await saveContract(contract);
                console.log(`\n✅ Repair + validation PASSED — ${featureId} marked done.`);
            }
            else {
                contract = setFeatureStatus(contract, featureId, "validation_failed");
                await saveContract(contract);
                console.log(`\n❌ Repair completed but validation still FAILED — ${featureId} remains validation_failed.`);
                for (const cmd of valResult.commands) {
                    const mark = cmd.passed ? "✓" : "✗";
                    console.log(`  ${mark} ${cmd.command}  (exit ${cmd.exitCode})`);
                }
            }
        }
        else {
            contract = setFeatureStatus(contract, featureId, "awaiting_validation");
            await saveContract(contract);
            console.log(`\n⚠️  No deterministic validation configured. Status: awaiting_validation`);
        }
    }
    const finalFeature = contract.features.find((f) => f.id === featureId);
    const repairHistEntry = {
        event: "repair",
        timestamp: new Date().toISOString(),
        windowId: contract.currentWindow.windowId,
        featureId,
        assignedRepairWallet: rWallet,
        bobMaxCost: rWallet,
        realSessionCosts: actualCost,
        durationMs: resultLine?.stats.duration_ms ?? null,
        toolCalls: resultLine?.stats.tool_calls ?? null,
        bobTaskId: resultLine?.stats.task_id ?? null,
        costLimitHit,
        validationPassed,
        finalFeatureStatus: finalFeature?.status ?? "validation_failed",
        note: costLimitHit ? "repair budget interrupted" : "repair completed",
    };
    await appendRepairHistory(repairHistEntry);
    console.log(`\nRepair reserve remaining: ${bc(contract.reserves.repair)}`);
    console.log(`Project state: ${contract.state}`);
    console.log();
}
// ---------------------------------------------------------------------------
// 8. pocket defer <feature-id>
// ---------------------------------------------------------------------------
async function cmdDefer(featureId) {
    let contract = await loadContract();
    const feature = contract.features.find((f) => f.id === featureId);
    if (!feature) {
        console.error(`Error: feature "${featureId}" not found`);
        exit(1);
    }
    if (feature.status === "done") {
        console.error(`Error: feature "${featureId}" is already done — cannot defer.`);
        exit(1);
    }
    contract = deferFeature(contract, featureId);
    await saveContract(contract);
    console.log(`\n⏸ Feature "${featureId}" deferred.`);
    console.log(`  Risk  : ${riskBadge(contract.forecast.riskState)}`);
    console.log(`  State : ${contract.state}`);
    console.log();
}
// ---------------------------------------------------------------------------
// 9. pocket land
// ---------------------------------------------------------------------------
async function cmdLand() {
    let contract = await loadContract();
    if (contract.state === "SHIPPED") {
        console.log(`Project is already SHIPPED.`);
        return;
    }
    contract = {
        ...contract,
        state: "LAND",
        updatedAt: new Date().toISOString(),
    };
    await saveContract(contract);
    const spendable = spendableBudget(contract);
    const reserve = totalReserve(contract.reserves);
    console.log(`\n🛬 LAND MODE ACTIVATED`);
    console.log(`═══════════════════════`);
    console.log(`  Remaining   : ${bc(contract.currentWindow.remainingAssignedBudget)}`);
    console.log(`  Protected   : ${bc(reserve)}`);
    console.log(`  Spendable   : ${bc(spendable)}`);
    console.log(``);
    console.log(`LAND blocks:`);
    console.log(`  - new pending product features`);
    console.log(`  - optional features`);
    console.log(`  - deferred work`);
    console.log(`  - speculative refactors`);
    console.log(`  - architecture cleanup`);
    console.log(``);
    console.log(`LAND allows:`);
    console.log(`  - pocket validate <id>`);
    console.log(`  - pocket validate --all`);
    console.log(`  - pocket check`);
    console.log(`  - pocket repair <id>  (for validation_failed / budget_interrupted features)`);
    console.log(`  - critical build/typecheck/test fixes`);
    console.log(`  - final checkpoint/handoff`);
    console.log();
}
// ---------------------------------------------------------------------------
// 10. pocket resume [--budget <n>]
// ---------------------------------------------------------------------------
async function cmdResume(args) {
    const userBudget = parseBudgetFlag(args);
    let contract = await loadContract();
    if (contract.state === "SHIPPED") {
        console.log(`Project is already SHIPPED. No resume needed.`);
        return;
    }
    let providerRemaining = await getProviderRemaining();
    if (userBudget === null && providerRemaining === null) {
        console.log(`\nStarting new compute window...`);
        providerRemaining = await askUserForBudget();
    }
    const resolved = resolveAssignedBudget(providerRemaining, userBudget);
    if (resolved.capped && userBudget !== null && providerRemaining !== null) {
        console.log(`\n⚠️  Budget capped for new window:`);
        console.log(`   Requested              ${bc(userBudget)}`);
        console.log(`   Provider available     ${bc(providerRemaining)}`);
        console.log(`   Maximum assignable     ${bc(providerRemaining)}`);
    }
    contract = openNewWindow(contract, resolved.assignedBudget, resolved.providerRemainingAtStart, resolved.budgetMode);
    if (userBudget !== null && providerRemaining === null) {
        contract = {
            ...contract,
            currentWindow: { ...contract.currentWindow, budgetMode: "custom" },
        };
    }
    await saveContract(contract);
    const cw = contract.currentWindow;
    console.log(`\n▶ New compute window opened: #${cw.windowId}`);
    console.log(`  Budget mode     : ${cw.budgetMode}`);
    if (cw.providerRemainingAtStart !== null) {
        console.log(`  Provider quota  : ${bc(cw.providerRemainingAtStart)}`);
    }
    console.log(`  Assigned budget : ${bc(cw.assignedBudget)}`);
    console.log(`  Previous windows preserved: ${contract.previousWindows.length}`);
    const resumed = contract.features.filter((f) => f.status === "pending");
    if (resumed.length > 0) {
        console.log(`\n  Resumed features:`);
        for (const f of resumed) {
            console.log(`    ○ ${f.id}: ${f.name}`);
        }
    }
    console.log();
}
// ---------------------------------------------------------------------------
// 11. pocket install bob [--global|--project]
// ---------------------------------------------------------------------------
async function cmdInstall(args) {
    const target = args[0];
    if (target !== "bob") {
        console.error(`Usage: pocket install bob [--global|--project]`);
        console.error(`  bob    Install as a Bob Skill`);
        exit(1);
    }
    const hasGlobal = args.includes("--global");
    const hasProject = args.includes("--project");
    // Default: project scope (safer — doesn't touch user home dir without flag)
    const scope = hasGlobal ? "global" : "project";
    if (!hasGlobal && !hasProject) {
        console.log(`\n⚠️  No scope flag provided. Defaulting to --project (safer).`);
        console.log(`   Use --global to install for all workspaces.`);
    }
    console.log(`\n📦 Installing pocket-watcher Bob Skill (${scope})...`);
    try {
        const result = await installSkill(scope);
        if (result.warnings.length > 0) {
            for (const w of result.warnings) {
                console.error(`  ⚠️  ${w}`);
            }
            exit(1);
        }
        const action = result.created ? "Installed" : "Updated";
        console.log(`\n✅ ${action} pocket-watcher skill`);
        console.log(`   Scope     : ${scope}`);
        console.log(`   Directory : ${result.skillDir}`);
        console.log(`   SKILL.md  : ${result.skillMdPath}`);
        console.log(``);
        if (scope === "global") {
            console.log(`   Open any Bob workspace and invoke: /pocket-watcher`);
        }
        else {
            console.log(`   In this project, invoke: /pocket-watcher`);
        }
        console.log();
    }
    catch (err) {
        console.error(`Error installing skill: ${err.message}`);
        exit(1);
    }
}
// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------
const [, , command, ...rest] = argv;
async function main() {
    switch (command) {
        case "init":
            await cmdInit(rest);
            break;
        case "scope":
            await cmdScope(rest);
            break;
        case "status":
            await cmdStatus();
            break;
        case "run": {
            const featureId = rest[0];
            if (!featureId) {
                console.error("Usage: pocket run <feature-id>");
                exit(1);
            }
            await cmdRun(featureId);
            break;
        }
        case "validate":
            await cmdValidate(rest);
            break;
        case "check":
            await cmdCheck();
            break;
        case "repair": {
            const featureId = rest[0];
            if (!featureId) {
                console.error("Usage: pocket repair <feature-id>");
                exit(1);
            }
            await cmdRepair(featureId);
            break;
        }
        case "defer": {
            const featureId = rest[0];
            if (!featureId) {
                console.error("Usage: pocket defer <feature-id>");
                exit(1);
            }
            await cmdDefer(featureId);
            break;
        }
        case "land":
            await cmdLand();
            break;
        case "resume":
            await cmdResume(rest);
            break;
        case "install":
            await cmdInstall(rest);
            break;
        default:
            console.log("Usage:");
            console.log("  pocket init [--budget <n>]");
            console.log("  pocket scope \"<request>\"");
            console.log("  pocket status");
            console.log("  pocket run <feature-id>");
            console.log("  pocket validate <feature-id> | --all");
            console.log("  pocket check");
            console.log("  pocket repair <feature-id>");
            console.log("  pocket defer <feature-id>");
            console.log("  pocket land");
            console.log("  pocket resume [--budget <n>]");
            console.log("  pocket install bob [--global|--project]");
            exit(1);
    }
}
main().catch((e) => {
    console.error(e.message);
    exit(1);
});
//# sourceMappingURL=cli.js.map