/**
 * Pocket Watcher — Bob runner
 *
 * Spawns `bob run --format json --max-cost <wallet>` and parses output.
 * Returns the actual session_costs from the result line.
 */
import type { BobOutputLine, BobResultLine } from "./types.js";
export interface RunResult {
    /** Actual Bobcoins consumed, from stats.session_costs. */
    actualCost: number;
    /** True if the cost limit was hit during the run. */
    costLimitHit: boolean;
    /** Exit code of the bob process. */
    exitCode: number;
    /** The raw result line, if present. */
    resultLine: BobResultLine | null;
    /** All output lines for debugging. */
    allLines: BobOutputLine[];
}
/**
 * Run a Bob task with a hard cost ceiling.
 *
 * stdin is closed immediately (< /dev/null equivalent) so bob does not hang
 * waiting for interactive input.
 */
export declare function runWithBudget(prompt: string, maxCost: number, extraArgs?: string[]): Promise<RunResult>;
