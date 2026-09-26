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
import type { RunResult, Feature, ValidationCommandResult } from "./types.js";
export { RunResult };
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
export declare function resolveBobExecutable(): string;
/**
 * Build a narrow execution prompt for a single feature.
 *
 * The prompt contains only what is required to implement this feature.
 * It explicitly lists excluded work and deferred features to prevent scope drift.
 */
export declare function buildFeaturePrompt(feature: Feature, deferredFeatureIds: string[]): string;
/**
 * Build a narrow repair prompt for a feature.
 *
 * Contains only what is required to repair this feature.
 * Explicitly excludes all other work to prevent scope drift.
 */
export declare function buildRepairPrompt(feature: Feature, failedCommands: ValidationCommandResult[], deferredFeatureIds: string[]): string;
/**
 * Run a Bob task with a hard cost ceiling.
 *
 * stdin is closed immediately (stdio: ['ignore', ...]) so bob does not hang.
 */
export declare function runWithBudget(prompt: string, maxCost: number, extraArgs?: string[]): Promise<RunResult>;
