/**
 * Pocket Watcher — project file I/O V1
 *
 * Contract files:
 *   .pocket/ship-contract.json   — current project state
 *   .pocket/history.jsonl        — append-only spend history
 */
import { readFile, writeFile, mkdir, appendFile, } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
export function pocketDir(cwd = process.cwd()) {
    return join(cwd, ".pocket");
}
export function contractPath(cwd = process.cwd()) {
    return join(pocketDir(cwd), "ship-contract.json");
}
export function historyPath(cwd = process.cwd()) {
    return join(pocketDir(cwd), "history.jsonl");
}
// ---------------------------------------------------------------------------
// Contract I/O
// ---------------------------------------------------------------------------
export async function loadContract(cwd = process.cwd()) {
    const path = contractPath(cwd);
    if (!existsSync(path)) {
        throw new Error(`No .pocket/ship-contract.json found in ${cwd}. Run \`pocket init\` first.`);
    }
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw);
}
export async function saveContract(contract, cwd = process.cwd()) {
    const dir = pocketDir(cwd);
    if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
    }
    await writeFile(contractPath(cwd), JSON.stringify(contract, null, 2) + "\n");
}
// ---------------------------------------------------------------------------
// History I/O
// ---------------------------------------------------------------------------
export async function appendHistory(entry, cwd = process.cwd()) {
    const dir = pocketDir(cwd);
    if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
    }
    await appendFile(historyPath(cwd), JSON.stringify(entry) + "\n");
}
//# sourceMappingURL=store.js.map