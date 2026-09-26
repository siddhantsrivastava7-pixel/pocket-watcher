/**
 * Pocket Watcher — project file I/O
 *
 * Reads/writes pocket.json in the current working directory.
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
const BUDGET_FILE = "pocket.json";
export function budgetPath(cwd = process.cwd()) {
    return join(cwd, BUDGET_FILE);
}
export async function loadBudget(cwd = process.cwd()) {
    const path = budgetPath(cwd);
    if (!existsSync(path)) {
        throw new Error(`No pocket.json found in ${cwd}. Run \`pocket init\` first.`);
    }
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw);
}
export async function saveBudget(budget, cwd = process.cwd()) {
    await writeFile(budgetPath(cwd), JSON.stringify(budget, null, 2) + "\n");
}
//# sourceMappingURL=store.js.map