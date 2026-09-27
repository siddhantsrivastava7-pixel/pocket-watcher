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
import type { BobOutputLine, BobResultLine, RunResult, Feature, ValidationCommandResult } from "./types.js";
/**
 * On Windows, npm global packages are installed as `.cmd` shims.
 * Node cannot spawn `.cmd` files directly with shell:false (EINVAL) —
 * they must be invoked via cmd.exe.  cross-spawn handles this correctly:
 * it routes through `cmd.exe /d /s /c` and applies proper Windows
 * CreateProcess argument escaping (double-escaping meta chars for
 * node_modules/.bin shims), so every argv element arrives byte-for-byte.
 *
 * shell:true with an args array is NOT used — it triggers Node DEP0190
 * and concatenates the args into a single string that cmd.exe re-parses,
 * mangling arguments containing spaces, quotes, or punctuation.
 *
 * Resolution order on Windows:
 *   1. Walk PATH directories looking for bob.cmd (preferred — npm shim)
 *   2. Fall back to bob.exe, then plain bob
 *
 * On POSIX, returns "bob" unchanged (the OS resolves it from PATH normally).
 */
export declare function resolveBobExecutable(env?: NodeJS.ProcessEnv): string;
/**
 * Spawn the Bob CLI with every argument preserved byte-for-byte.
 *
 * Uses cross-spawn on all platforms:
 * - On Windows: cross-spawn resolves the .cmd shim and routes through
 *   cmd.exe with properly escaped arguments (windowsVerbatimArguments).
 *   No DEP0190 warning. No shell re-parsing of the arg array.
 * - On POSIX: cross-spawn is equivalent to node's spawn (no overhead).
 */
export declare function spawnBob(args: string[], env: NodeJS.ProcessEnv): ReturnType<typeof spawn>;
export { RunResult };
export declare function parseBobJsonOutput(stdout: string): {
    allLines: BobOutputLine[];
    resultLine: BobResultLine | null;
    costLimitHit: boolean;
};
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
export declare function runWithBudget(prompt: string, maxCost: number): Promise<RunResult>;
