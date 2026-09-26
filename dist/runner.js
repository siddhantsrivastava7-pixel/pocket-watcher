/**
 * Pocket Watcher — Bob runner V1
 *
 * Spawns `bob run --format json --max-cost <wallet>` and parses output.
 *
 * Key observed behavior (from spike):
 * - Exit code is ALWAYS 0, even when cost limit is hit.
 * - result.status is ALWAYS "success", even when cost limit is hit.
 * - Cost limit is detected ONLY by the presence of a {"type":"error"} line
 *   containing "cost limit" in the output stream.
 * - stdin MUST be closed (stdio: ['ignore', ...]) or bob hangs forever.
 * - BOB_API_KEY must be set in the environment.
 */
import { spawn } from "node:child_process";
// ---------------------------------------------------------------------------
// Executable resolution
// ---------------------------------------------------------------------------
/**
 * Return the Bob executable name for the current platform.
 *
 * On Windows, npm installs CLI tools as both a bare script (no extension) and
 * a `.cmd` shim. Node's `spawn` without `shell:true` only finds the `.cmd`
 * shim on Windows because it searches PATH for exact file names — the bare
 * name "bob" without an extension is not an executable file on Windows.
 *
 * On macOS / Linux, "bob" resolves normally via PATH.
 *
 * Exported so tests can assert the resolution logic without invoking Bob.
 */
export function resolveBobExecutable() {
    return process.platform === "win32" ? "bob.cmd" : "bob";
}
// ---------------------------------------------------------------------------
// Narrow prompt builder
// ---------------------------------------------------------------------------
/**
 * Build a narrow execution prompt for a single feature.
 *
 * The prompt contains only what is required to implement this feature.
 * It explicitly lists excluded work and deferred features to prevent scope drift.
 */
export function buildFeaturePrompt(feature, deferredFeatureIds) {
    const lines = [
        `FEATURE CONTRACT`,
        `================`,
        `ID:   ${feature.id}`,
        `Name: ${feature.name}`,
        `Goal: ${feature.goal}`,
        ``,
        `Acceptance criteria:`,
        ...feature.acceptance.map((a) => `  - ${a}`),
    ];
    if (feature.excluded.length > 0) {
        lines.push(``, `Explicitly excluded from this task:`);
        lines.push(...feature.excluded.map((e) => `  - ${e}`));
    }
    if (deferredFeatureIds.length > 0) {
        lines.push(``, `Deferred — do not implement these:`);
        lines.push(...deferredFeatureIds.map((id) => `  - ${id}`));
    }
    lines.push(``, `INSTRUCTIONS`, `============`, `Work only on this feature. Implement the goal and satisfy the acceptance criteria above.`, `Do not work on deferred features.`, `Do not perform speculative refactoring.`, `Do not future-proof unrelated architecture.`, `Do not add optional functionality not listed in acceptance criteria.`, `Stop once the acceptance criteria are satisfied and required validation passes.`);
    return lines.join("\n");
}
// ---------------------------------------------------------------------------
// Repair prompt builder
// ---------------------------------------------------------------------------
/**
 * Build a narrow repair prompt for a feature.
 *
 * Contains only what is required to repair this feature.
 * Explicitly excludes all other work to prevent scope drift.
 */
export function buildRepairPrompt(feature, failedCommands, deferredFeatureIds) {
    const lines = [
        `REPAIR CONTRACT`,
        `===============`,
        `ID:   ${feature.id}`,
        `Name: ${feature.name}`,
        `Goal: ${feature.goal}`,
        ``,
        `Acceptance criteria:`,
        ...feature.acceptance.map((a) => `  - ${a}`),
    ];
    if (feature.excluded.length > 0) {
        lines.push(``, `Explicitly excluded from this task:`);
        lines.push(...feature.excluded.map((e) => `  - ${e}`));
    }
    if (failedCommands.length > 0) {
        lines.push(``, `Failed validation commands:`);
        for (const cmd of failedCommands) {
            lines.push(`  Command : ${cmd.command}`);
            lines.push(`  Exit    : ${cmd.exitCode}`);
            if (cmd.stderr.trim()) {
                lines.push(`  Stderr  : ${cmd.stderr.trim().slice(0, 300)}`);
            }
            if (cmd.stdout.trim()) {
                lines.push(`  Stdout  : ${cmd.stdout.trim().slice(0, 300)}`);
            }
        }
    }
    if (deferredFeatureIds.length > 0) {
        lines.push(``, `Deferred — do not implement these:`);
        lines.push(...deferredFeatureIds.map((id) => `  - ${id}`));
    }
    lines.push(``, `REPAIR INSTRUCTIONS`, `===================`, `Make the SMALLEST repair necessary to satisfy the acceptance criteria above.`, `Do NOT add features.`, `Do NOT refactor unrelated code.`, `Do NOT future-proof.`, `Do NOT work on deferred features.`, `Repair only what is needed to satisfy this feature's acceptance criteria.`, `Stop once the minimum repair is done and the failed validation would pass.`);
    return lines.join("\n");
}
// ---------------------------------------------------------------------------
// Core runner
// ---------------------------------------------------------------------------
/**
 * Run a Bob task with a hard cost ceiling.
 *
 * stdin is closed immediately (stdio: ['ignore', ...]) so bob does not hang.
 */
export async function runWithBudget(prompt, maxCost, extraArgs = []) {
    const apiKey = process.env.BOB_API_KEY;
    if (!apiKey) {
        throw new Error("BOB_API_KEY environment variable is required for pocket run");
    }
    if (maxCost <= 0) {
        throw new Error(`Invalid maxCost: ${maxCost}. Must be > 0. Bob rejects zero and negative values.`);
    }
    const args = [
        "run",
        "--format",
        "json",
        "--max-cost",
        String(maxCost),
        "--disable-mcp",
        "--disable-subagents",
        ...extraArgs,
        prompt,
    ];
    return new Promise((resolve, reject) => {
        const child = spawn(resolveBobExecutable(), args, {
            env: { ...process.env, BOB_API_KEY: apiKey },
            // stdin closed (ignore), capture stdout + stderr
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });
        child.on("error", reject);
        child.on("close", (code) => {
            const exitCode = code ?? 1;
            const allLines = [];
            let resultLine = null;
            let costLimitHit = false;
            for (const raw of stdout.split("\n")) {
                const line = raw.trim();
                if (!line)
                    continue;
                try {
                    const obj = JSON.parse(line);
                    allLines.push(obj);
                    if (obj.type === "result") {
                        resultLine = obj;
                    }
                    // Cost limit detection: MUST parse the error event text.
                    // Do NOT use exit code or result.status — both are 0/"success" on cost limit.
                    if (obj.type === "error" &&
                        "message" in obj &&
                        typeof obj.message === "string" &&
                        obj.message
                            .toLowerCase()
                            .includes("cost limit")) {
                        costLimitHit = true;
                    }
                }
                catch {
                    // non-JSON lines — ignore
                }
            }
            // If bob exited non-zero and produced no result, reject as fatal error.
            if (exitCode !== 0 && !resultLine) {
                const errMsg = stderr.trim() || "bob run exited with non-zero code and no result";
                return reject(new Error(`bob run failed: ${errMsg}`));
            }
            const actualCost = resultLine?.stats.session_costs ?? 0;
            resolve({ actualCost, costLimitHit, exitCode, resultLine, allLines });
        });
    });
}
//# sourceMappingURL=runner.js.map