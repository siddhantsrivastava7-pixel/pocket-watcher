/**
 * Pocket Watcher — project file I/O V1
 *
 * Contract files:
 *   .pocket/ship-contract.json   — current project state
 *   .pocket/history.jsonl        — append-only spend history
 */
import type { ShipContract, HistoryEntry } from "./types.js";
export declare function pocketDir(cwd?: string): string;
export declare function contractPath(cwd?: string): string;
export declare function historyPath(cwd?: string): string;
export declare function loadContract(cwd?: string): Promise<ShipContract>;
export declare function saveContract(contract: ShipContract, cwd?: string): Promise<void>;
export declare function appendHistory(entry: HistoryEntry, cwd?: string): Promise<void>;
