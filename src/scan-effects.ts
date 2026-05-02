import crypto from "crypto";

import {
  buildCleanTitle,
  sanitizeTaskTitle,
  validateSortFolder,
} from "./cascade.js";
import { DRY_RUN } from "./config.js";
import { loadTaxonomy } from "./loaders.js";
import { log } from "./log.js";
import { TaskWriter } from "./providers.js";
import { appendDecision, emailKey } from "./state.js";
import {
  ApiOutcome,
  ClassificationResult,
  EmailMinimal,
  LlmCandidate,
} from "./types.js";

export function createApiOutcome(): ApiOutcome {
  return {
    apiTaskCount: 0,
    apiSkipCount: 0,
    apiFailureCount: 0,
    tasksCreated: [],
    failedEmailKeys: new Set(),
  };
}

export function taskAuditMarker(email: EmailMinimal): string {
  return (
    "cuassistant:" +
    crypto
      .createHash("sha256")
      .update(emailKey(email.account, email.id))
      .digest("hex")
  );
}

export function noteApiFailure(out: ApiOutcome, email: EmailMinimal): void {
  out.apiFailureCount += 1;
  out.failedEmailKeys.add(emailKey(email.account, email.id));
}

export async function applyClassification(
  email: LlmCandidate,
  result: ClassificationResult,
  scanRunId: string,
  modelLabel: string,
  taskListId: string | null,
  taskWriter: TaskWriter,
  out: ApiOutcome,
): Promise<void> {
  const taxonomy = loadTaxonomy();
  const validatedFolder = validateSortFolder(result.sort_folder, taxonomy);
  const bodyChars = (email.body || "").length;
  const bodySha256 = crypto
    .createHash("sha256")
    .update(email.body || "")
    .digest("hex");

  if (result.needs_task) {
    if (!taskListId || DRY_RUN) {
      if (DRY_RUN) {
        log.info("[dry-run] would create task", {
          subject: email.subject,
          folder: validatedFolder,
          title: result.task_title,
        });
      } else {
        log.warn("no MS365 list - leaving email in pending for retry", {
          emailId: email.id,
        });
        noteApiFailure(out, email);
        return;
      }
    }
    const rawTitle =
      result.task_title ||
      result.reasoning.split(".")[0].slice(0, 80) ||
      `Review: ${email.subject}`;
    const sanitizedTitle = sanitizeTaskTitle(rawTitle, email.subject || "");
    const cleanTitle = buildCleanTitle(
      sanitizedTitle,
      email.account,
      validatedFolder,
    );
    const auditMarker = taskAuditMarker(email);
    if (!DRY_RUN) {
      appendDecision({
        scan_run_id: scanRunId,
        email_id: email.id,
        account: email.account,
        sender: email.from,
        subject: (email.subject || "").slice(0, 120),
        pass: "classifier-intent",
        decision: "task-intent",
        sort_folder: validatedFolder,
        rule_matched: email.bucket_hint,
        reasoning: result.reasoning,
        task_id_created: null,
        task_audit_marker: auditMarker,
        model_used: modelLabel,
        body_sha256: bodySha256,
        body_chars_sent: bodyChars,
      });
    }
    let taskId: string | null = null;
    let taskPreexisting = false;
    if (!DRY_RUN && taskListId) {
      taskId = await taskWriter.findTaskByMarker(taskListId, auditMarker);
      taskPreexisting = Boolean(taskId);
      if (!taskId) {
        taskId = await taskWriter.createTask(
          taskListId,
          cleanTitle,
          undefined,
          auditMarker,
        );
      }
      if (!taskId) {
        noteApiFailure(out, email);
        return;
      }
    }
    out.apiTaskCount += 1;
    out.tasksCreated.push({ title: cleanTitle, folder: validatedFolder });
    appendDecision({
      scan_run_id: scanRunId,
      email_id: email.id,
      account: email.account,
      sender: email.from,
      subject: (email.subject || "").slice(0, 120),
      pass: "classifier",
      decision: "task",
      sort_folder: validatedFolder,
      rule_matched: email.bucket_hint,
      reasoning: result.reasoning,
      task_id_created: taskId,
      task_audit_marker: auditMarker,
      task_preexisting: taskPreexisting || undefined,
      model_used: modelLabel,
      body_sha256: bodySha256,
      body_chars_sent: bodyChars,
      dry_run: DRY_RUN || undefined,
    });
  } else {
    out.apiSkipCount += 1;
    appendDecision({
      scan_run_id: scanRunId,
      email_id: email.id,
      account: email.account,
      sender: email.from,
      subject: (email.subject || "").slice(0, 120),
      pass: "classifier",
      decision: "skip",
      sort_folder: validatedFolder,
      rule_matched: email.bucket_hint,
      reasoning: result.reasoning,
      task_id_created: null,
      model_used: modelLabel,
      body_sha256: bodySha256,
      body_chars_sent: bodyChars,
      dry_run: DRY_RUN || undefined,
    });
  }
}
