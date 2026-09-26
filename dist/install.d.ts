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
/** Global Bob skills directory — ~/.bob/skills */
export declare function globalSkillsDir(): string;
/** Project-local Bob skills directory — .bob/skills in cwd */
export declare function projectSkillsDir(cwd?: string): string;
/** Path to the pocket-watcher skill directory */
export declare function pocketWatcherSkillDir(baseSkillsDir: string): string;
/** Path to SKILL.md inside a skill dir */
export declare function skillMdPath(skillDir: string): string;
export declare function generateSkillMd(): string;
export type InstallScope = "global" | "project";
export interface InstallResult {
    scope: InstallScope;
    skillDir: string;
    skillMdPath: string;
    created: boolean;
    warnings: string[];
}
/**
 * Install (or update) the pocket-watcher Bob Skill.
 *
 * - Creates the skill directory if it does not exist.
 * - Writes SKILL.md (overwrites if already pocket-watcher content).
 * - Does NOT overwrite other skills or unrelated files.
 * - Safe to run repeatedly (idempotent).
 */
export declare function installSkill(scope: InstallScope, cwd?: string): Promise<InstallResult>;
