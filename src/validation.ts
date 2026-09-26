/**
 * Pocket Watcher — deterministic validation runner
 *
 * Runs configured validation commands without invoking Bob.
 * Consumes ZERO Bobcoins.
 *
 * Pure I/O — no budget side-effects.
 */

import { spawn } from "node:child_process";
import type {
  Feature,
  ValidationCommandResult,
  ValidationResult,
  ProjectValidationConfig,
} from "./types.js";

// ---------------------------------------------------------------------------
// Run a single command deterministically
// ---------------------------------------------------------------------------

/**
 * Run a single shell command and capture result.
 * Does not invoke Bob. Costs zero Bobcoins.
 *
 * @param command  The command string to run via sh -c
 * @param cwd      Working directory (defaults to process.cwd())
 */
export async function runValidationCommand(
  command: string,
  cwd = process.cwd()
): Promise<ValidationCommandResult> {
  const start = Date.now();

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";

    const child = spawn("sh", ["-c", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      resolve({
        command,
        exitCode: 1,
        durationMs: Date.now() - start,
        stdout: "",
        stderr: err.message,
        passed: false,
      });
    });

    child.on("close", (code) => {
      const exitCode = code ?? 1;
      resolve({
        command,
        exitCode,
        durationMs: Date.now() - start,
        // Keep summaries concise — first 500 chars of each stream
        stdout: stdout.slice(0, 500),
        stderr: stderr.slice(0, 500),
        passed: exitCode === 0,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Run all validation commands for a feature
// ---------------------------------------------------------------------------

/**
 * Run all configured validation commands for a feature.
 *
 * Returns a ValidationResult with per-command results and overall pass/fail.
 * If the feature has no validation config, returns null — caller must handle
 * this as "awaiting_validation" (no deterministic evidence available).
 *
 * Does NOT invoke Bob. Costs zero Bobcoins.
 */
export async function validateFeature(
  feature: Feature,
  cwd = process.cwd()
): Promise<ValidationResult | null> {
  if (!feature.validation || feature.validation.commands.length === 0) {
    return null;
  }

  const start = Date.now();
  const commandResults: ValidationCommandResult[] = [];

  for (const cmd of feature.validation.commands) {
    const result = await runValidationCommand(cmd, cwd);
    commandResults.push(result);
    // Stop on first failure to avoid running later dependent commands
    if (!result.passed) break;
  }

  const passed = commandResults.every((r) => r.passed);

  return {
    featureId: feature.id,
    commands: commandResults,
    passed,
    durationMs: Date.now() - start,
  };
}

// ---------------------------------------------------------------------------
// Run project-level validation
// ---------------------------------------------------------------------------

/**
 * Run all configured project-level validation commands.
 *
 * Returns null if no project validation is configured.
 * Does NOT invoke Bob. Costs zero Bobcoins.
 */
export async function validateProject(
  config: ProjectValidationConfig | undefined,
  cwd = process.cwd()
): Promise<ValidationResult | null> {
  if (!config || config.commands.length === 0) {
    return null;
  }

  const start = Date.now();
  const commandResults: ValidationCommandResult[] = [];

  for (const cmd of config.commands) {
    const result = await runValidationCommand(cmd, cwd);
    commandResults.push(result);
    // Stop on first failure
    if (!result.passed) break;
  }

  const passed = commandResults.every((r) => r.passed);

  return {
    featureId: null,
    commands: commandResults,
    passed,
    durationMs: Date.now() - start,
  };
}
