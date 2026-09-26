/**
 * Pocket Watcher — project file I/O
 *
 * Reads/writes pocket.json in the current working directory.
 */
import type { ProjectBudget } from "./types.js";
export declare function budgetPath(cwd?: string): string;
export declare function loadBudget(cwd?: string): Promise<ProjectBudget>;
export declare function saveBudget(budget: ProjectBudget, cwd?: string): Promise<void>;
