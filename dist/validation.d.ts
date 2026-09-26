/**
 * Pocket Watcher — deterministic validation runner
 *
 * Runs configured validation commands without invoking Bob.
 * Consumes ZERO Bobcoins.
 *
 * Pure I/O — no budget side-effects.
 */
import type { Feature, ValidationCommandResult, ValidationResult, ProjectValidationConfig } from "./types.js";
/**
 * Run a single shell command and capture result.
 * Does not invoke Bob. Costs zero Bobcoins.
 *
 * @param command  The command string to run via sh -c
 * @param cwd      Working directory (defaults to process.cwd())
 */
export declare function runValidationCommand(command: string, cwd?: string): Promise<ValidationCommandResult>;
/**
 * Run all configured validation commands for a feature.
 *
 * Returns a ValidationResult with per-command results and overall pass/fail.
 * If the feature has no validation config, returns null — caller must handle
 * this as "awaiting_validation" (no deterministic evidence available).
 *
 * Does NOT invoke Bob. Costs zero Bobcoins.
 */
export declare function validateFeature(feature: Feature, cwd?: string): Promise<ValidationResult | null>;
/**
 * Run all configured project-level validation commands.
 *
 * Returns null if no project validation is configured.
 * Does NOT invoke Bob. Costs zero Bobcoins.
 */
export declare function validateProject(config: ProjectValidationConfig | undefined, cwd?: string): Promise<ValidationResult | null>;
