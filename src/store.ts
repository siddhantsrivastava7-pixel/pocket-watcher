/**
 * Pocket Watcher — project file I/O V1
 *
 * Contract files:
 *   .pocket/ship-contract.json   — current project state
 *   .pocket/history.jsonl        — append-only spend history
 */

import {
  readFile,
  writeFile,
  mkdir,
  appendFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ShipContract, HistoryEntry } from "./types.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function pocketDir(cwd = process.cwd()): string {
  return join(cwd, ".pocket");
}

export function contractPath(cwd = process.cwd()): string {
  return join(pocketDir(cwd), "ship-contract.json");
}

export function historyPath(cwd = process.cwd()): string {
  return join(pocketDir(cwd), "history.jsonl");
}

// ---------------------------------------------------------------------------
// Contract I/O
// ---------------------------------------------------------------------------

export async function loadContract(cwd = process.cwd()): Promise<ShipContract> {
  const path = contractPath(cwd);
  if (!existsSync(path)) {
    throw new Error(
      `No .pocket/ship-contract.json found in ${cwd}. Run \`pocket init\` first.`
    );
  }
  const raw = await readFile(path, "utf-8");
  return JSON.parse(raw) as ShipContract;
}

export async function saveContract(
  contract: ShipContract,
  cwd = process.cwd()
): Promise<void> {
  const dir = pocketDir(cwd);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(contractPath(cwd), JSON.stringify(contract, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// History I/O
// ---------------------------------------------------------------------------

export async function appendHistory(
  entry: HistoryEntry,
  cwd = process.cwd()
): Promise<void> {
  const dir = pocketDir(cwd);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await appendFile(historyPath(cwd), JSON.stringify(entry) + "\n");
}
