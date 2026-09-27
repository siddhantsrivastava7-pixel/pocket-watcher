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
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import type {
  BobOutputLine,
  BobResultLine,
  RunResult,
  Feature,
  ValidationCommandResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// cross-spawn loader (CJS interop)
// ---------------------------------------------------------------------------

/**
 * cross-spawn is a CJS module.  Load it via createRequire so this ESM file
 * can import it without "require is not defined" errors.
 */
const _require = createRequire(import.meta.url);
const crossSpawn = _require("cross-spawn") as {
  spawn: typeof spawn;
};

// ---------------------------------------------------------------------------
// Platform-aware Bob executable resolver
// ---------------------------------------------------------------------------

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
export function resolveBobExecutable(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform !== "win32") {
    return "bob";
  }

  const pathEnv = env.PATH ?? env.Path ?? "";
  const pathDirs = pathEnv
    .split(";")
    .map((dir) => dir.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);

  // Preferred Windows extension order for npm-installed CLIs
  const extensions = [".cmd", ".exe", ""];

  for (const dir of pathDirs) {
    for (const ext of extensions) {
      const candidate = join(dir, `bob${ext}`);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  // Fallback: let cross-spawn/OS try
  return "bob";
}

// ---------------------------------------------------------------------------
// Platform-aware Bob executable launcher
// ---------------------------------------------------------------------------

/**
 * Spawn the Bob CLI with every argument preserved byte-for-byte.
 *
 * Uses cross-spawn on all platforms:
 * - On Windows: cross-spawn resolves the .cmd shim and routes through
 *   cmd.exe with properly escaped arguments (windowsVerbatimArguments).
 *   No DEP0190 warning. No shell re-parsing of the arg array.
 * - On POSIX: cross-spawn is equivalent to node's spawn (no overhead).
 */
export function spawnBob(
  args: string[],
  env: NodeJS.ProcessEnv
): ReturnType<typeof spawn> {
  const executable = resolveBobExecutable(env);
  return crossSpawn.spawn(executable, args, {
    env,
    // stdin closed (ignore), capture stdout + stderr
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export { RunResult };

export function parseBobJsonOutput(stdout: string): {
  allLines: BobOutputLine[];
  resultLine: BobResultLine | null;
  costLimitHit: boolean;
} {
  const allLines: BobOutputLine[] = [];
  let resultLine: BobResultLine | null = null;
  let costLimitHit = false;

  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as BobOutputLine;
      allLines.push(obj);

      if (
        obj.type === "result" &&
        "stats" in obj &&
        typeof obj.stats === "object" &&
        obj.stats !== null &&
        Number.isFinite((obj.stats as { session_costs?: number }).session_costs) &&
        (obj.stats as { session_costs: number }).session_costs >= 0
      ) {
        resultLine = obj as BobResultLine;
      }

      // Bob reports cost-limit exhaustion as an explicit error event. Its
      // process exit code and result status are not reliable indicators.
      if (
        obj.type === "error" &&
        "message" in obj &&
        typeof (obj as { message?: string }).message === "string" &&
        (obj as { message: string }).message.toLowerCase().includes("cost limit")
      ) {
        costLimitHit = true;
      }
    } catch {
      // Bob may write non-JSON diagnostics alongside JSONL output.
    }
  }

  return { allLines, resultLine, costLimitHit };
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
export function buildFeaturePrompt(
  feature: Feature,
  deferredFeatureIds: string[]
): string {
  const lines: string[] = [
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

  lines.push(
    ``,
    `INSTRUCTIONS`,
    `============`,
    `Work only on this feature. Implement the goal and satisfy the acceptance criteria above.`,
    `Do not work on deferred features.`,
    `Do not perform speculative refactoring.`,
    `Do not future-proof unrelated architecture.`,
    `Do not add optional functionality not listed in acceptance criteria.`,
    `Stop once the acceptance criteria are satisfied and required validation passes.`
  );

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
export function buildRepairPrompt(
  feature: Feature,
  failedCommands: ValidationCommandResult[],
  deferredFeatureIds: string[]
): string {
  const lines: string[] = [
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

  lines.push(
    ``,
    `REPAIR INSTRUCTIONS`,
    `===================`,
    `Make the SMALLEST repair necessary to satisfy the acceptance criteria above.`,
    `Do NOT add features.`,
    `Do NOT refactor unrelated code.`,
    `Do NOT future-proof.`,
    `Do NOT work on deferred features.`,
    `Repair only what is needed to satisfy this feature's acceptance criteria.`,
    `Stop once the minimum repair is done and the failed validation would pass.`
  );

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
export async function runWithBudget(
  prompt: string,
  maxCost: number
): Promise<RunResult> {
  const apiKey = process.env.BOB_API_KEY;
  if (!apiKey) {
    throw new Error(
      "BOB_API_KEY environment variable is required for pocket run"
    );
  }

  if (!Number.isFinite(maxCost) || maxCost <= 0) {
    throw new Error(
      `Invalid maxCost: ${maxCost}. Must be > 0. Bob rejects zero and negative values.`
    );
  }

  const args = [
    "run",
    "--format",
    "json",
    "--max-cost",
    String(maxCost),
    "--disable-mcp",
    "--disable-subagents",
    prompt,
  ];

  return new Promise((resolve, reject) => {
    const child = spawnBob(args, { ...process.env, BOB_API_KEY: apiKey });

    let stdout = "";
    let stderr = "";

    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);

    child.on("close", (code) => {
      const exitCode = code ?? 1;
      const { allLines, resultLine, costLimitHit } = parseBobJsonOutput(stdout);

      // If bob exited non-zero and produced no result, reject as fatal error.
      if (exitCode !== 0 && !resultLine) {
        const errMsg = stderr.trim() || "bob run exited with non-zero code and no result";
        return reject(new Error(`bob run failed: ${errMsg}`));
      }

      if (!resultLine) {
        const detail = stderr.trim();
        return reject(
          new Error(
            `bob run did not emit a valid result with stats.session_costs${
              detail ? `: ${detail}` : ""
            }`
          )
        );
      }

      const actualCost = resultLine.stats.session_costs;

      resolve({ actualCost, costLimitHit, exitCode, resultLine, allLines });
    });
  });
}
