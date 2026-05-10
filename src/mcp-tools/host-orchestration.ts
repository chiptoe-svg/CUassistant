// Host orchestration tools — CUassistant-only.
//
// Not in CUagent's MCP surface (CUagent's MCP server was embedded in the
// agent loop, so triggering a scan from outside wasn't needed). CUassistant
// runs on a schedule, so these tools let NanoClaw drive it on demand.
//
// trigger_scan invokes runScan() directly in the host process. This is
// correct while CUassistant runs host-side. If scan logic is ever moved into
// a NanoClaw v2 container, trigger_scan should instead enqueue a request
// into a SQLite queue (matching NanoClaw v2's inbound.db / outbound.db IPC
// model) rather than calling runScan() across the container boundary.

import fs from "fs";
import path from "path";

import { STATE_DIR } from "../config.js";
import { runScan } from "../scan.js";
import { setActiveHandler } from "../permissions.js";
import { acquireScanLock, releaseScanLock } from "../state.js";
import { startMcpAudit, finishMcpAudit } from "./audit.js";
import { assertMcpOperation } from "./permissions.js";
import { registerTools } from "./server.js";
import { err, okJson, permissionErr, type McpToolDefinition } from "./types.js";

const triggerScan: McpToolDefinition = {
  tool: {
    name: "trigger_scan",
    description:
      "Run an email triage scan immediately. Returns the same summary the " +
      "scheduled run produces. Pass dry_run=true to evaluate without " +
      "creating tasks or advancing the progress cursor — useful for a " +
      "preview from a NanoClaw orchestration agent. Acquires the scan lock " +
      "and refuses if another run is already in progress.",
    inputSchema: {
      type: "object" as const,
      properties: {
        dry_run: {
          type: "boolean",
          description:
            "When true, sets DRY_RUN=1 for this invocation. The scan reads " +
            "mail and computes decisions but does not create tasks or " +
            "update progress. The flag affects only this process.",
        },
      },
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("host.trigger_scan");
    } catch (e) {
      return permissionErr(e);
    }
    const dryRun = Boolean(args.dry_run);
    const audit = startMcpAudit({
      operation: "host.trigger_scan",
      toolName: "trigger_scan",
      argsSummary: { dry_run: dryRun },
    });
    if (!acquireScanLock()) {
      finishMcpAudit(audit, {
        result: "error",
        detail: "scan_lock_held",
      });
      return err("scan_already_in_progress");
    }
    const previousDryRun = process.env.DRY_RUN;
    if (dryRun) process.env.DRY_RUN = "1";
    try {
      setActiveHandler("triage");
      const summary = await runScan();
      finishMcpAudit(audit, { result: "success", detail: "scan_complete" });
      return okJson({ summary, dry_run: dryRun });
    } catch (e) {
      finishMcpAudit(audit, { result: "error", detail: String(e) });
      return err(`scan threw: ${String(e)}`);
    } finally {
      setActiveHandler(null);
      if (dryRun) {
        if (previousDryRun === undefined) {
          delete process.env.DRY_RUN;
        } else {
          process.env.DRY_RUN = previousDryRun;
        }
      }
      releaseScanLock();
    }
  },
};

const getScanStatus: McpToolDefinition = {
  tool: {
    name: "get_scan_status",
    description:
      "Return the most recent rows from state/decisions.jsonl. Pass " +
      "since_timestamp to filter to rows at or after a specific ISO time. " +
      "Defaults to the last 20 rows (oldest first). Read-only.",
    inputSchema: {
      type: "object" as const,
      properties: {
        n: {
          type: "integer",
          description: "Max rows to return when since_timestamp is not set (default 20).",
        },
        since_timestamp: {
          type: "string",
          description:
            "Optional ISO 8601 lower bound on the row's `ts` field.",
        },
      },
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("host.get_scan_status");
    } catch (e) {
      return permissionErr(e);
    }
    const n = typeof args.n === "number" ? Math.max(1, args.n as number) : 20;
    const sinceTimestamp = args.since_timestamp as string | undefined;
    const rows = readDecisions({ n, sinceIso: sinceTimestamp });
    return okJson({ rows, count: rows.length });
  },
};

const getPendingActions: McpToolDefinition = {
  tool: {
    name: "get_pending_actions",
    description:
      "Return decisions that asked for a task (`needs_task=true`) but ended " +
      "without a `task_id_created` — items that should have produced a task " +
      "but didn't, awaiting follow-up action. Read-only.",
    inputSchema: {
      type: "object" as const,
      properties: {
        since_timestamp: {
          type: "string",
          description:
            "Optional ISO 8601 lower bound on the row's `ts` field.",
        },
      },
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("host.get_pending_actions");
    } catch (e) {
      return permissionErr(e);
    }
    const sinceTimestamp = args.since_timestamp as string | undefined;
    const rows = readDecisions({ n: Number.MAX_SAFE_INTEGER, sinceIso: sinceTimestamp });
    const pending = rows.filter((r) => {
      const decision = String(r.decision ?? "");
      const taskId = r.task_id_created;
      const needsTask = decision === "task" || decision === "task-intent";
      const noTaskId = taskId === null || taskId === undefined;
      return needsTask && noTaskId && r.pass !== "compare";
    });
    return okJson({ pending, count: pending.length });
  },
};

function readDecisions(opts: {
  n: number;
  sinceIso?: string;
}): Array<Record<string, unknown>> {
  const p = path.join(STATE_DIR, "decisions.jsonl");
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, "utf-8").split("\n").filter(Boolean);
  const cutoff = opts.sinceIso ? Date.parse(opts.sinceIso) : 0;
  const out: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (cutoff) {
      const ts = typeof row.ts === "string" ? Date.parse(row.ts) : NaN;
      if (Number.isNaN(ts) || ts < cutoff) continue;
    }
    out.push(row);
  }
  if (!opts.sinceIso) {
    return out.slice(-opts.n);
  }
  return out;
}

registerTools([triggerScan, getScanStatus, getPendingActions]);
