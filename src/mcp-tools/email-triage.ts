// src/mcp-tools/email-triage.ts
//
// Three MCP tools that split the CUassistant scan pipeline so Linda can do
// one-at-a-time LLM classification for bucket-3/4 residuals.
//
// Flow:
//   Linda calls get_triage_candidates → CUassistant runs B1+B2 deterministically,
//   creates B1 template tasks, logs B1+B2 decisions, stores state, returns B3/B4
//   candidates (each carrying both `account` and `mail_account`).
//   Linda classifies each candidate (body fetch + LLM), calls log_triage_decision
//   per email, then calls complete_scan to advance the watermark + release the lock.

import {
  buildCleanTitle,
  bucketHintFor,
  matchActionTemplate,
  matchSkipSender,
  substituteTitle,
} from "../cascade.js";
import { DRY_RUN } from "../config.js";
import {
  loadAccounts,
  loadClassification,
  loadInstitutions,
  loadKnownContacts,
} from "../loaders.js";
import { computeDueIsoLocal } from "../ms365.js";
import { getTaskWriter } from "../provider-registry.js";
import {
  acquireScanLock,
  appendDecision,
  emailKey,
  loadProgress,
  loadResolvedEmailIds,
  releaseScanLock,
  writePendingResiduals,
} from "../state.js";
import { taskAuditMarker } from "../scan-effects.js";
import { listAllNewMail, writeCompletedProgress } from "../scan-mail.js";
import type {
  Account,
  ActionTemplate,
  Classification,
  EmailMinimal,
  Override,
  PendingResidual,
  Progress,
  ProgressAccount,
  SkipSender,
} from "../types.js";
import { startMcpAudit, finishMcpAudit, currentProvider } from "./audit.js";
import { assertMcpOperation } from "./permissions.js";
import { registerTools } from "./server.js";
import { err, okJson, permissionErr, type McpToolDefinition } from "./types.js";

// ---------------------------------------------------------------------------
// Pure routing (no IO) — unit-testable without network/Graph.
// ---------------------------------------------------------------------------

export type RoutedEmail =
  | { kind: "override"; email: EmailMinimal; override: Override }
  | { kind: "template-skip"; email: EmailMinimal; tpl: ActionTemplate }
  | { kind: "template-task"; email: EmailMinimal; tpl: ActionTemplate }
  | { kind: "skip-sender"; email: EmailMinimal; skip: SkipSender }
  | {
      kind: "candidate";
      email: EmailMinimal;
      bucket_hint: "solicited" | "outreach_check";
    };

export function routeEmails(
  emails: EmailMinimal[],
  classification: Classification,
  institutions: Set<string>,
  contacts: Set<string>,
): RoutedEmail[] {
  const overrideById = new Map(
    classification.overrides.map((o) => [o.email_id, o]),
  );
  const out: RoutedEmail[] = [];
  for (const email of emails) {
    const override = overrideById.get(email.id);
    if (override) {
      out.push({ kind: "override", email, override });
      continue;
    }
    const tpl = matchActionTemplate(email, classification.action_templates);
    if (tpl) {
      if (tpl.skip) {
        out.push({ kind: "template-skip", email, tpl });
        continue;
      }
      if (tpl.create_task) {
        out.push({ kind: "template-task", email, tpl });
        continue;
      }
    }
    const skip = matchSkipSender(email, classification.skip_senders);
    if (skip) {
      out.push({ kind: "skip-sender", email, skip });
      continue;
    }
    out.push({
      kind: "candidate",
      email,
      bucket_hint: bucketHintFor(email, institutions, contacts),
    });
  }
  return out;
}

/** Bridge CUassistant's internal account vocab to the get-mail-message tool vocab. */
export function mailAccountFor(account: Account): "ms365" | "g.clemson" {
  return account === "gmail" ? "g.clemson" : "ms365";
}

// ---------------------------------------------------------------------------
// Module-level state shared across the three MCP calls for one scan session.
// The scan lock (scan_in_progress.lock) ensures only one activeScan at a time.
// ---------------------------------------------------------------------------

interface TriageCandidate {
  email_id: string;
  account: Account; // "outlook" | "gmail" — used by log_triage_decision
  mail_account: "ms365" | "g.clemson"; // used by get-mail-message
  from: string;
  subject: string;
  received_iso: string | null;
  bucket_hint: "solicited" | "outreach_check";
  audit_marker: string;
}

interface ActiveScan {
  scan_run_id: string;
  scan_started_iso: string;
  task_list_id: string | null;
  listed_emails: EmailMinimal[];
  completed_accounts: Set<ProgressAccount>;
  progress: Progress;
  dry_run: boolean;
  candidates: TriageCandidate[];
}

let activeScan: ActiveScan | null = null;

/** Exposed only for unit tests — do not call from production code. */
export function setActiveScanForTest(scan: ActiveScan | null): void {
  activeScan = scan;
}

// ---------------------------------------------------------------------------
// Tool 1: get_triage_candidates
// ---------------------------------------------------------------------------

const getTriageCandidates: McpToolDefinition = {
  operation: "host.get_triage_candidates",
  tool: {
    name: "get_triage_candidates",
    description:
      "Start an email triage scan. Runs buckets 1+2 (action_templates, " +
      "skip_senders) deterministically, creates template tasks immediately, " +
      "logs those decisions, then returns bucket 3+4 candidates for the " +
      "agent to classify one-at-a-time. Each candidate carries `account` " +
      "(outlook/gmail, for log_triage_decision) and `mail_account` " +
      "(ms365/g.clemson, for get-mail-message). Acquires the scan lock; the " +
      "agent MUST call complete_scan when done (or on error) to release it.",
    inputSchema: {
      type: "object" as const,
      properties: {
        dry_run: {
          type: "boolean",
          description:
            "When true: read mail and compute candidates but skip task " +
            "creation and watermark advancement. Pass the same dry_run value " +
            "to complete_scan.",
        },
      },
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("host.get_triage_candidates");
    } catch (e) {
      return permissionErr(e);
    }

    const dryRun = Boolean(args.dry_run) || DRY_RUN;

    const audit = startMcpAudit({
      operation: "host.get_triage_candidates",
      toolName: "get_triage_candidates",
      argsSummary: { dry_run: dryRun },
    });

    if (!acquireScanLock()) {
      finishMcpAudit(audit, { result: "error", detail: "scan_lock_held" });
      return err("scan_already_in_progress");
    }

    const scanRunId = new Date().toISOString();
    const scanStartedIso = scanRunId;

    try {
      const accounts = loadAccounts();
      if (accounts.length === 0) {
        releaseScanLock();
        finishMcpAudit(audit, { result: "error", detail: "no_accounts" });
        return err("No accounts configured. Edit config/accounts.yaml.");
      }

      const classification = loadClassification();
      const institutions = loadInstitutions();
      const contacts = loadKnownContacts();
      const progress = loadProgress();
      const resolvedIds = loadResolvedEmailIds(30);

      const taskWriter = getTaskWriter();
      const taskListId = dryRun
        ? "dry-run"
        : await taskWriter.getDefaultListId();

      const listing = await listAllNewMail(progress.last_scan_date ?? {});
      const errors: string[] = [...listing.errors];

      const freshEmails = listing.emails.filter(
        (e) => !resolvedIds.has(emailKey(e.account, e.id)),
      );

      const routed = routeEmails(
        freshEmails,
        classification,
        institutions,
        contacts,
      );

      let templateTasks = 0;
      let templateSkips = 0;
      let skipSenderCount = 0;
      const candidates: TriageCandidate[] = [];

      for (const r of routed) {
        const email = r.email;
        if (r.kind === "override") {
          appendDecision({
            scan_run_id: scanRunId,
            email_id: email.id,
            account: email.account,
            sender: email.from,
            subject: (email.subject || "").slice(0, 120),
            pass: "override",
            decision: r.override.decision,
            sort_folder: r.override.sort_folder ?? null,
            rule_matched: `override:${email.id}`,
            reasoning: r.override.reasoning ?? null,
            task_id_created: null,
            model_used: null,
          });
          continue;
        }

        if (r.kind === "template-skip") {
          templateSkips += 1;
          appendDecision({
            scan_run_id: scanRunId,
            email_id: email.id,
            account: email.account,
            sender: email.from,
            subject: (email.subject || "").slice(0, 120),
            pass: "template",
            decision: "skip",
            sort_folder: null,
            rule_matched: r.tpl.name,
            reasoning: "action_template skip rule",
            task_id_created: null,
            model_used: null,
          });
          continue;
        }

        if (r.kind === "template-task") {
          const tpl = r.tpl;
          const rawTitle = substituteTitle(tpl.create_task!.title, email);
          const cleanTitle = buildCleanTitle(
            rawTitle,
            email.account,
            tpl.create_task!.folder,
          );
          const auditMarker = taskAuditMarker(email);
          const due =
            typeof tpl.create_task!.due_offset_days === "number"
              ? computeDueIsoLocal(tpl.create_task!.due_offset_days)
              : undefined;

          let taskId: string | null = null;
          if (!dryRun && taskListId && taskListId !== "dry-run") {
            appendDecision({
              scan_run_id: scanRunId,
              email_id: email.id,
              account: email.account,
              sender: email.from,
              subject: (email.subject || "").slice(0, 120),
              pass: "template-intent",
              decision: "task-intent",
              sort_folder: tpl.create_task!.folder,
              rule_matched: tpl.name,
              reasoning: `action_template create_task (${tpl.name})`,
              task_id_created: null,
              task_audit_marker: auditMarker,
              model_used: null,
            });
            const existing = await taskWriter.findTaskByMarker(
              taskListId,
              auditMarker,
            );
            taskId =
              existing ??
              (await taskWriter.createTask(
                taskListId,
                cleanTitle,
                due,
                auditMarker,
              ));
            if (!taskId) {
              errors.push(
                `template_${tpl.name}: create-task failed for "${email.subject}"`,
              );
            }
          }
          templateTasks += 1;
          appendDecision({
            scan_run_id: scanRunId,
            email_id: email.id,
            account: email.account,
            sender: email.from,
            subject: (email.subject || "").slice(0, 120),
            pass: "template",
            decision: taskId ? "task" : "skip",
            sort_folder: tpl.create_task!.folder,
            rule_matched: tpl.name,
            reasoning: `action_template create_task (${tpl.name})`,
            task_id_created: taskId,
            task_audit_marker: auditMarker,
            model_used: null,
            dry_run: dryRun || undefined,
          });
          continue;
        }

        if (r.kind === "skip-sender") {
          skipSenderCount += 1;
          appendDecision({
            scan_run_id: scanRunId,
            email_id: email.id,
            account: email.account,
            sender: email.from,
            subject: (email.subject || "").slice(0, 120),
            pass: "skip",
            decision: "skip",
            sort_folder: r.skip.folder,
            rule_matched: `skip_senders:${r.skip.from_address ?? r.skip.from_domain ?? "?"}`,
            reasoning: null,
            task_id_created: null,
            model_used: null,
          });
          continue;
        }

        // r.kind === "candidate"
        candidates.push({
          email_id: email.id,
          account: email.account,
          mail_account: mailAccountFor(email.account),
          from: email.from,
          subject: email.subject,
          received_iso: email.receivedIso ?? null,
          bucket_hint: r.bucket_hint,
          audit_marker: taskAuditMarker(email),
        });
      }

      activeScan = {
        scan_run_id: scanRunId,
        scan_started_iso: scanStartedIso,
        task_list_id: taskListId,
        listed_emails: listing.emails,
        completed_accounts: listing.completedAccounts,
        progress,
        dry_run: dryRun,
        candidates,
      };

      finishMcpAudit(audit, {
        result: "success",
        detail: `candidates:${candidates.length} b1:${templateTasks} b2:${skipSenderCount}`,
      });

      return okJson({
        scan_run_id: scanRunId,
        task_list_id: taskListId,
        deterministic_summary: {
          template_tasks: templateTasks,
          template_skips: templateSkips,
          skip_senders: skipSenderCount,
        },
        candidates,
        errors,
      });
    } catch (e) {
      releaseScanLock();
      activeScan = null;
      finishMcpAudit(audit, { result: "error", detail: String(e) });
      return err(`get_triage_candidates threw: ${String(e)}`);
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 2: log_triage_decision — one call per B3/B4 email Linda classifies.
// ---------------------------------------------------------------------------

export async function logTriageDecisionHandler(
  args: Record<string, unknown>,
): Promise<ReturnType<typeof okJson>> {
  const scanRunId = args.scan_run_id as string | undefined;
  if (!activeScan || activeScan.scan_run_id !== scanRunId) {
    return err(
      `no active scan matching scan_run_id "${scanRunId ?? "(none)"}" — ` +
        "call get_triage_candidates first",
    );
  }

  // Issue 3 fix: only accept decisions for email_ids that were actually returned
  // as candidates by this scan — prevents spurious entries in decisions.jsonl.
  const emailId = String(args.email_id ?? "");
  const account = String(args.account ?? "");
  const inScope = activeScan.candidates.some(
    (c) => c.email_id === emailId && c.account === account,
  );
  if (!inScope) {
    return err(
      `email "${emailId}" (${account}) was not in this scan's candidates — ` +
        "only candidates returned by get_triage_candidates may be logged",
    );
  }

  appendDecision({
    scan_run_id: String(scanRunId),
    email_id: emailId,
    account,
    sender: String(args.from ?? ""),
    subject: String(args.subject ?? "").slice(0, 120),
    pass: "classifier",
    decision: String(args.decision ?? "skip"),
    sort_folder: args.sort_folder != null ? String(args.sort_folder) : null,
    rule_matched: String(args.bucket_hint ?? "agent-needed"),
    reasoning: String(args.reasoning ?? ""),
    task_id_created:
      args.task_id_created != null ? String(args.task_id_created) : null,
    task_audit_marker:
      args.audit_marker != null ? String(args.audit_marker) : undefined,
    // Issue 2 fix: record the actual provider from the authenticated consumer
    // (set in the ALS by buildServer at request time) rather than a hardcoded string.
    model_used: currentProvider() ?? "unknown",
    dry_run: activeScan.dry_run || undefined,
  });

  return okJson({ logged: true });
}

const logTriageDecision: McpToolDefinition = {
  operation: "host.log_triage_decision",
  tool: {
    name: "log_triage_decision",
    description:
      "Log one email's triage decision to decisions.jsonl. Call after " +
      "classifying each B3/B4 candidate from get_triage_candidates. Requires " +
      "an active scan with the same scan_run_id. Use the candidate's " +
      "`account` field here (outlook/gmail), NOT mail_account.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scan_run_id: {
          type: "string",
          description: "The scan_run_id returned by get_triage_candidates.",
        },
        email_id: { type: "string", description: "Email message ID." },
        account: {
          type: "string",
          enum: ["outlook", "gmail"],
          description: "Candidate's `account` field (outlook/gmail).",
        },
        from: { type: "string", description: "Sender address." },
        subject: { type: "string", description: "Email subject (raw)." },
        decision: {
          type: "string",
          enum: ["task", "skip", "label-only"],
          description: "Classification outcome.",
        },
        sort_folder: {
          type: "string",
          description: "Target folder from taxonomy (even for skip decisions).",
        },
        task_title: {
          type: "string",
          description: "Task title created (omit if decision is not task).",
        },
        task_id_created: {
          type: "string",
          description: "MS To Do task id from create-todo-task (omit if skip).",
        },
        audit_marker: {
          type: "string",
          description: "The audit_marker from the candidate (cuassistant:sha256...).",
        },
        reasoning: {
          type: "string",
          description: "One-sentence rationale for the decision.",
        },
        bucket_hint: {
          type: "string",
          enum: ["solicited", "outreach_check"],
          description: "The bucket_hint from the candidate.",
        },
      },
      required: [
        "scan_run_id",
        "email_id",
        "account",
        "from",
        "subject",
        "decision",
        "audit_marker",
        "reasoning",
        "bucket_hint",
      ],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("host.log_triage_decision");
    } catch (e) {
      return permissionErr(e);
    }
    return logTriageDecisionHandler(args);
  },
};

// ---------------------------------------------------------------------------
// Tool 3: complete_scan — advance watermark + release lock.
// ---------------------------------------------------------------------------

export async function completeScanHandler(
  args: Record<string, unknown>,
): Promise<ReturnType<typeof okJson>> {
  const scanRunId = args.scan_run_id as string | undefined;
  if (!activeScan || activeScan.scan_run_id !== scanRunId) {
    return err(
      `no active scan matching scan_run_id "${scanRunId ?? "(none)"}" — ` +
        "call get_triage_candidates first",
    );
  }

  const scan = activeScan;
  activeScan = null;

  const failedCandidates = Array.isArray(args.failed_candidates)
    ? (args.failed_candidates as Array<{ email_id: string; account: string }>)
    : [];

  const advanceWatermark = args.advance_watermark !== false && !scan.dry_run;

  if (!scan.dry_run) {
    const nowIso = new Date().toISOString();
    const pendingEntries: PendingResidual[] = failedCandidates
      .map((fc) => {
        const cand = scan.candidates.find(
          (c) => c.email_id === fc.email_id && c.account === fc.account,
        );
        if (!cand) return null;
        return {
          scan_run_id: scan.scan_run_id,
          email_id: cand.email_id,
          account: cand.account,
          from: cand.from,
          subject: cand.subject,
          handoff_ts: nowIso,
          first_handoff_ts: nowIso,
          attempt_count: 1,
        };
      })
      .filter((x): x is PendingResidual => x !== null);
    writePendingResiduals(pendingEntries);

    if (advanceWatermark) {
      const accounts = loadAccounts();
      writeCompletedProgress(
        scan.progress,
        accounts,
        scan.listed_emails,
        scan.completed_accounts,
        scan.scan_started_iso,
        scan.scan_run_id,
      );
    }
  }

  releaseScanLock();
  return okJson({ watermark_advanced: advanceWatermark, lock_released: true });
}

const completeScan: McpToolDefinition = {
  operation: "host.complete_scan",
  tool: {
    name: "complete_scan",
    description:
      "Finish a triage scan started by get_triage_candidates. Writes " +
      "pending_residuals for candidates Linda could not classify, advances " +
      "the progress watermark (unless advance_watermark=false or dry_run), " +
      "and releases the scan lock. Must be called even on error to release " +
      "the lock.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scan_run_id: {
          type: "string",
          description: "Must match the scan_run_id from get_triage_candidates.",
        },
        advance_watermark: {
          type: "boolean",
          description:
            "Default true. Pass false to skip watermark advancement " +
            "(e.g., the scan was incomplete due to errors).",
        },
        failed_candidates: {
          type: "array",
          description:
            "Candidates Linda could not classify; each is written to " +
            "pending_residuals.jsonl for the next scan run.",
          items: {
            type: "object",
            properties: {
              email_id: { type: "string" },
              account: { type: "string", enum: ["outlook", "gmail"] },
            },
            required: ["email_id", "account"],
          },
        },
      },
      required: ["scan_run_id"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("host.complete_scan");
    } catch (e) {
      return permissionErr(e);
    }
    return completeScanHandler(args);
  },
};

registerTools([getTriageCandidates, logTriageDecision, completeScan]);
