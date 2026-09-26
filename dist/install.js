/**
 * Pocket Watcher — Bob Skill installer
 *
 * Installs the pocket-watcher Bob Skill into the global or project-local
 * Bob skills directory.
 *
 * Architecture:
 *   Bob Skill (SKILL.md, conversational front door)
 *     ↓
 *   Pocket Watcher CLI (deterministic budget governor)
 *     ↓
 *   Bob Shell workers (bounded by --max-cost)
 *
 * The skill does NOT duplicate budget logic.
 * All economics are delegated to the CLI.
 */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
// ---------------------------------------------------------------------------
// Skill paths
// ---------------------------------------------------------------------------
/** Global Bob skills directory — ~/.bob/skills */
export function globalSkillsDir() {
    return join(homedir(), ".bob", "skills");
}
/** Project-local Bob skills directory — .bob/skills in cwd */
export function projectSkillsDir(cwd = process.cwd()) {
    return join(cwd, ".bob", "skills");
}
/** Path to the pocket-watcher skill directory */
export function pocketWatcherSkillDir(baseSkillsDir) {
    return join(baseSkillsDir, "pocket-watcher");
}
/** Path to SKILL.md inside a skill dir */
export function skillMdPath(skillDir) {
    return join(skillDir, "SKILL.md");
}
// ---------------------------------------------------------------------------
// SKILL.md content
// ---------------------------------------------------------------------------
export function generateSkillMd() {
    return `---
name: pocket-watcher
description: >
  Budget-aware execution governor for coding agents. Helps you finish useful
  work inside a fixed compute budget. Invoke with /pocket-watcher to start.

  Use when the user wants to:
  - conserve remaining usage or Bobcoin quota
  - finish a project inside remaining compute
  - complete a task within a specific compute budget
  - limit Bobcoin spending on a coding session
  - prevent planning from consuming the whole compute window
  - ensure a project lands before usage expires
  - manage which features to defer when scope is too large

  Do NOT activate for trivial single-step questions.
---

# Pocket Watcher

You are the conversational front door for the Pocket Watcher budget governor.

## Your role

You handle the human side of budget-aware execution:

- Understand what the user wants to build
- Ask for remaining usage when it cannot be determined automatically
- Help the user prioritize which outcomes matter most if full scope does not fit
- Explain SAFE / TIGHT / UNSAFE states in plain language
- Present COMPRESS choices when scope must be cut
- Explain which features were deferred and why
- Tell the user when LAND mode has begun (no new features, only finishing)
- Report validation results and repair status clearly

## What you MUST delegate to the CLI

All economics, budget enforcement, and state management are handled by the
Pocket Watcher CLI (\`pocket\`). You must never invent budget state.

Use CLI commands for:
- \`pocket init [--budget <n>]\` — initialize a new project budget
- \`pocket scope "<request>"\` — decompose a request into budgeted features
- \`pocket status\` — show current budget, risk, and feature state
- \`pocket run <feature-id>\` — execute one feature within its wallet
- \`pocket validate <feature-id>\` — run deterministic validation (zero cost)
- \`pocket validate --all\` — validate all eligible features
- \`pocket check\` — run project-level finishing validation
- \`pocket repair <feature-id>\` — repair a failed/interrupted feature
- \`pocket defer <feature-id>\` — defer a feature to conserve budget
- \`pocket land\` — enter LAND mode (finish what exists, no new scope)
- \`pocket resume [--budget <n>]\` — resume after a quota reset
- \`pocket install bob\` — (re)install this skill

## States

| State    | Meaning |
|----------|---------|
| SCOPE    | Defining features, no spending yet |
| BUILD    | Executing features within budget |
| COMPRESS | Over budget — must cut scope before continuing |
| LAND     | Minimal remaining — ship what exists, no new scope |
| SHIPPED  | Done |

## Risk levels

| Risk   | Meaning |
|--------|---------|
| SAFE   | Remaining forecast < 80% of spendable |
| TIGHT  | 80–100% of spendable |
| UNSAFE | Forecast exceeds spendable budget |

## LAND mode

LAND blocks:
- new pending product features
- optional features, deferred features
- speculative refactors, architecture cleanup
- visual polish, future-proofing

LAND allows:
- \`pocket validate\` and \`pocket validate --all\`
- \`pocket check\`
- \`pocket repair\` for failed/interrupted must-ship features
- Critical build, typecheck, and test fixes

## Typical conversation flow

1. User describes what they want to build
2. If remaining usage is unknown, ask once: "How many Bobcoins do you have remaining?"
3. Run \`pocket init --budget <n>\` with the assigned budget
4. Run \`pocket scope "<request>"\` to decompose and estimate features
5. If scope does not fit, present deferred features and ask which matter most
6. For each feature: \`pocket run <id>\` → \`pocket validate <id>\`
7. After each run, show updated budget and risk from \`pocket status\`
8. If COMPRESS: help user decide what to defer
9. If LAND: run \`pocket check\` and report final working feature set

## Example opening

When the user invokes /pocket-watcher and describes a project:

\`\`\`
POCKET WATCHER

Available compute: [from pocket status]
Protected finishing reserve: [from pocket status]

[If scope fits]
Full request fits conservatively. Running features in priority order.

[If scope does not fit]
Full request does not conservatively fit.

I can safely target:
✓ [must features that fit]

Likely deferred:
○ [could/should features that don't fit]

Which of the deferred outcomes is more important if budget remains?
\`\`\`

## Budget principles

BUDGET IS FIXED.
SCOPE IS VARIABLE.
SHIPPING RESERVE IS PROTECTED.
FINISHING IS MORE IMPORTANT THAN STARTING MORE WORK.

Never increase the assigned budget without explicit user instruction.
Never fabricate session_costs or validation results.
Repair uses only the protected repair reserve.
Deterministic validation costs zero Bobcoins.
`;
}
/**
 * Install (or update) the pocket-watcher Bob Skill.
 *
 * - Creates the skill directory if it does not exist.
 * - Writes SKILL.md (overwrites if already pocket-watcher content).
 * - Does NOT overwrite other skills or unrelated files.
 * - Safe to run repeatedly (idempotent).
 */
export async function installSkill(scope, cwd = process.cwd()) {
    const baseDir = scope === "global" ? globalSkillsDir() : projectSkillsDir(cwd);
    const skillDir = pocketWatcherSkillDir(baseDir);
    const mdPath = skillMdPath(skillDir);
    const warnings = [];
    // Detect existing install
    const existed = existsSync(mdPath);
    if (existed) {
        // Check that the existing file is ours (contains pocket-watcher name)
        const existing = await readFile(mdPath, "utf-8");
        if (!existing.includes("pocket-watcher") && !existing.includes("Pocket Watcher")) {
            warnings.push(`${mdPath} exists but does not appear to be a Pocket Watcher skill. Skipping to avoid overwriting unrelated content.`);
            return {
                scope,
                skillDir,
                skillMdPath: mdPath,
                created: false,
                warnings,
            };
        }
    }
    // Create directory tree
    if (!existsSync(skillDir)) {
        await mkdir(skillDir, { recursive: true });
    }
    // Write SKILL.md
    await writeFile(mdPath, generateSkillMd(), "utf-8");
    return {
        scope,
        skillDir,
        skillMdPath: mdPath,
        created: !existed,
        warnings,
    };
}
//# sourceMappingURL=install.js.map