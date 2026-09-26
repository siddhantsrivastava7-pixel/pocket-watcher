/**
 * Pocket Watcher — project file I/O
 *
 * Reads/writes pocket.json in the current working directory.
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProjectBudget } from "./types.js";

const BUDGET_FILE = "pocket.json";

export function budgetPath(cwd = process.cwd()): string {
  return join(cwd, BUDGET_FILE);
}

export async function loadBudget(cwd = process.cwd()): Promise<ProjectBudget> {
  const path = budgetPath(cwd);
  if (!existsSync(path)) {
    throw new Error(
      `No pocket.json found in ${cwd}. Run \`pocket init\` first.`
    );
  }
  const raw = await readFile(path, "utf-8");
  return JSON.parse(raw) as ProjectBudget;
}

export async function saveBudget(
  budget: ProjectBudget,
  cwd = process.cwd()
): Promise<void> {
  await writeFile(budgetPath(cwd), JSON.stringify(budget, null, 2) + "\n");
}
