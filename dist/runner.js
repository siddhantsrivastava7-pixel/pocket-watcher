/**
 * Pocket Watcher — Bob runner
 *
 * Spawns `bob run --format json --max-cost <wallet>` and parses output.
 * Returns the actual session_costs from the result line.
 */
import { spawn } from "node:child_process";
/**
 * Run a Bob task with a hard cost ceiling.
 *
 * stdin is closed immediately (< /dev/null equivalent) so bob does not hang
 * waiting for interactive input.
 */
export async function runWithBudget(prompt, maxCost, extraArgs = []) {
    const apiKey = process.env.BOB_API_KEY;
    if (!apiKey) {
        throw new Error("BOB_API_KEY environment variable is required for pocket run");
    }
    const args = [
        "run",
        "--format",
        "json",
        "--max-cost",
        String(maxCost),
        "--disable-mcp",
        "--disable-subagents",
        ...extraArgs,
        prompt,
    ];
    return new Promise((resolve, reject) => {
        const child = spawn("bob", args, {
            env: { ...process.env, BOB_API_KEY: apiKey },
            stdio: ["ignore", "pipe", "pipe"], // stdin closed, capture stdout+stderr
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });
        child.on("error", reject);
        child.on("close", (code) => {
            const exitCode = code ?? 1;
            const allLines = [];
            let resultLine = null;
            let costLimitHit = false;
            for (const raw of stdout.split("\n")) {
                const line = raw.trim();
                if (!line)
                    continue;
                try {
                    const obj = JSON.parse(line);
                    allLines.push(obj);
                    if (obj.type === "result") {
                        resultLine = obj;
                    }
                    if (obj.type === "error" &&
                        "message" in obj &&
                        typeof obj.message === "string" &&
                        obj.message.includes("cost limit")) {
                        costLimitHit = true;
                    }
                }
                catch {
                    // non-JSON lines (e.g. error messages to stderr) — ignore
                }
            }
            if (stderr.trim() && !resultLine) {
                // Fatal error before any JSON output
                return reject(new Error(`bob run failed: ${stderr.trim()}`));
            }
            const actualCost = resultLine?.stats.session_costs ?? 0;
            resolve({ actualCost, costLimitHit, exitCode, resultLine, allLines });
        });
    });
}
//# sourceMappingURL=runner.js.map