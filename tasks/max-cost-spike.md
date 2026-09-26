# Max-Cost Spike — Observed Facts

**Date:** 2025-09  
**Bob Shell version:** 2.0.5 (commit 2dc180906)  
**Platform:** macOS arm64  
**Test workspace:** `/Users/siddhantsrivastava/Downloads/pocket-watcher`

All invocations used:
```
bob run --format json --max-cost <value> --disable-mcp --disable-subagents "<prompt>" < /dev/null
```

stdin was closed via `< /dev/null` (or `stdio: ['ignore', ...]` from Node.js).  
`BOB_API_KEY` was set from `.env.local`.

---

## Part A — Experimental Observations

### A1. Task completes below the limit

**Command:**
```
bob run --format json --max-cost 10 --disable-mcp --disable-subagents "Reply with the single word: hello" < /dev/null
```

**OBSERVED output:**
```json
{"type":"result","timestamp":"2026-09-26T05:42:48.381Z","status":"success","stats":{"task_id":"ab221d8f3c9898458e4f0b993fc6cb61","duration_ms":2677,"session_costs":0.019634,"max_cost":10,"tool_calls":0},"last_message":"hello"}
```
**OBSERVED exit code:** `0`

---

### A2. --max-cost set below cost of one turn, single-turn task

**Command:**
```
bob run --format json --max-cost 0.001 --disable-mcp --disable-subagents "Reply with the single word: hello" < /dev/null
```

**OBSERVED output:**
```json
{"type":"result","timestamp":"...","status":"success","stats":{"session_costs":0.019634,"max_cost":0.001,"tool_calls":0},"last_message":"hello"}
```
**OBSERVED exit code:** `0`

**OBSERVED: The cost check fires BETWEEN turns, not mid-turn.**  
A single-turn task always completes its first turn before the limit check runs.  
The task cost (0.019634) exceeded max_cost (0.001), but the task finished anyway.

---

### A3. --max-cost exceeded mid multi-turn task

**Command:**
```
bob run --format json --max-cost 0.001 --disable-mcp --disable-subagents \
  "List files, write step1.txt, write step2.txt, write step3.txt, ..." < /dev/null
```

**OBSERVED output (two lines):**
```json
{"type":"error","timestamp":"...","severity":"error","message":"The task reached the cost limit of 0.0010 (spent: 0.020)."}
{"type":"result","timestamp":"...","status":"success","stats":{"session_costs":0.01978,"max_cost":0.001,"tool_calls":1},"last_message":"Directory listing for .:\n\n..."}
```
**OBSERVED exit code:** `0`

**OBSERVED:**
- An `{"type":"error"}` line is emitted BEFORE the result line when the cost limit fires.
- The result line still carries `"status":"success"` regardless.
- `stats.session_costs` reflects actual cost including the turn that crossed the limit.
- **Exit code is 0 in all cases** — cost limit termination is NOT distinguishable from normal completion via exit code alone.
- Partial work remained on disk (first file written, subsequent files not created).

---

### A4. --max-cost exceeded in multi-step task with confirmed partial work

**Command:**
```
bob run --format json --max-cost 0.025 --disable-mcp --disable-subagents \
  "Write step1.txt through step5.txt" < /dev/null
```

**OBSERVED:**
- `session_costs: 0.04044`, `max_cost: 0.025`, `tool_calls: 2`
- `step1.txt` existed on disk after the run; `step2.txt`–`step5.txt` did not.
- Exit code: `0`.
- `last_message` described only step1 completion.

**OBSERVED: Partial work CAN remain in the workspace after cost-limit termination.**

---

### A5. Minimum accepted value

**Command:**
```
bob run --format json --max-cost 0 ...
```
**OBSERVED error:** `Error: Invalid --maxCost: Too small: expected number to be >0`  
**OBSERVED exit code:** `1`

Same result for `--max-cost -1`.

**Command:**
```
bob run --format json --max-cost 0.00001 ...
```
**OBSERVED:** Task ran and succeeded. No minimum enforced above `>0`.

---

### A6. JSON output schema (exact fields observed)

When task completes normally (no cost hit):
```json
{
  "type": "result",
  "timestamp": "<ISO8601>",
  "status": "success",
  "stats": {
    "task_id": "<string>",
    "duration_ms": <number>,
    "session_costs": <number>,
    "max_cost": <number>,
    "tool_calls": <number>
  },
  "last_message": "<string|null>"
}
```

When cost limit is hit, this additional line is emitted BEFORE the result:
```json
{
  "type": "error",
  "timestamp": "<ISO8601>",
  "severity": "error",
  "message": "The task reached the cost limit of <X> (spent: <Y>)."
}
```

---

### A7. stdin handling

**OBSERVED:** If stdin is not explicitly closed (no `< /dev/null`), `bob run` hangs indefinitely waiting for stdin input. stdin MUST be redirected to `/dev/null` or closed in any programmatic invocation.

---

## Summary of Observed Behaviors

| Scenario | Exit code | Result status | session_costs present | Cost limit message |
|---|---|---|---|---|
| Task completes below limit | 0 | success | ✅ | ✗ |
| Single-turn task exceeds limit | 0 | success | ✅ | ✗ (check fires after turn, task already done) |
| Multi-turn task exceeds limit mid-task | 0 | success | ✅ | ✅ (type:error line before result) |
| `--max-cost 0` | 1 | — | — | CLI validation error |
| `--max-cost <negative>` | 1 | — | — | CLI validation error |

**Key finding for Pocket Watcher:** Cost limit termination cannot be detected from exit code or `status` alone. Callers must check for the presence of a `{"type":"error"}` line containing "cost limit" in the JSON output stream.

---

## Part B — Minimal Prototype Viability

OBSERVED: The economic control loop is technically viable. Evidence:

1. `stats.session_costs` is always present in the result JSON and contains the real cost.
2. `--max-cost` reliably stops the agent after the current turn when the limit is exceeded.
3. Partial work can remain — callers must handle this.
4. Exit code is always 0 for cost-limit events — detection requires parsing JSON output.
5. The full loop (`pocket status` → `pocket run` → budget updated with real costs → risk state computed) executed successfully end-to-end in the prototype.

Prototype `pocket run hello` demo output (real observed run):
```
▶ Running feature: [hello] Hello World feature
  Wallet (max-cost): 0.1500 BC
  High estimate    : 0.1500 BC
  Spendable budget : 0.4000 BC

Bob run complete:
  Exit code        : 0
  Cost limit hit   : false
  Actual cost      : 0.0603 BC
  Result status    : success

Budget updated:
  Total spent    : 0.0603 BC
  Spendable left : 0.3397 BC
  Risk           : ✅ SAFE
  Project state  : BUILD
```
