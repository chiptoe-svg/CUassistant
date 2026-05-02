import { DRY_RUN, MODE, RESIDUAL_CLASSIFIER } from "./config.js";
import {
  buildCleanTitle,
  matchActionTemplate,
  matchSkipSender,
  substituteTitle,
} from "./cascade.js";
import {
  loadAccounts,
  loadClassification,
  loadInstitutions,
  loadKnownContacts,
} from "./loaders.js";
import { log } from "./log.js";
import { computeDueIsoLocal } from "./ms365.js";
import { getTaskWriter } from "./provider-registry.js";
import {
  appendDecision,
  emailKey,
  loadPendingResiduals,
  loadProgress,
  loadResolvedEmailIds,
  writePendingResiduals,
} from "./state.js";
import { EmailMinimal, PendingResidual, ScanOutcome } from "./types.js";
import { compareAgentToPrefilter } from "./compare.js";
import { candidateFromEmail } from "./preclassifier.js";
import {
  classifyResidualsCodex,
  classifyResidualsOpenAi,
} from "./residual-classifiers.js";
import {
  fetchBodies,
  listAllNewMail,
  writeCompletedProgress,
} from "./scan-mail.js";
import { formatSummary } from "./scan-summary.js";
import { taskAuditMarker } from "./scan-effects.js";

const MAX_PENDING_ATTEMPTS = 5;

export async function runScan(): Promise<string> {
  const scanRunId = new Date().toISOString();
  const scanStartedIso = scanRunId;
  const outcome: ScanOutcome = {
    scan_run_id: scanRunId,
    scanned: 0,
    template_tasks: 0,
    template_skips: 0,
    skip_sender_count: 0,
    llm_candidates: [],
    errors: [],
  };

  const accounts = loadAccounts();
  if (accounts.length === 0) {
    return "No accounts configured. Edit config/accounts.yaml.";
  }

  const classification = loadClassification();
  const institutions = loadInstitutions();
  const contacts = loadKnownContacts();
  const progress = loadProgress();
  const wantsAgent = MODE === "agent";
  const wantsCompare = MODE === "compare";
  const taskWriter = getTaskWriter();

  // Carryover from prior scan: any pending residual whose email_id has a
  // logged decision is dropped; entries past MAX_PENDING_ATTEMPTS get a
  // synthetic skip and are dropped; the rest carry forward.
  const pendingPrev = wantsCompare ? [] : loadPendingResiduals();
  const resolvedIds = loadResolvedEmailIds(30);
  const unresolved = pendingPrev.filter(
    (e) => !resolvedIds.has(emailKey(e.account, e.email_id)),
  );
  const exhausted = unresolved.filter(
    (e) => e.attempt_count >= MAX_PENDING_ATTEMPTS,
  );
  const carryover = unresolved.filter(
    (e) => e.attempt_count < MAX_PENDING_ATTEMPTS,
  );
  if (!wantsCompare) {
    for (const e of exhausted) {
      appendDecision({
        scan_run_id: scanRunId,
        email_id: e.email_id,
        account: e.account,
        sender: e.from,
        subject: (e.subject || "").slice(0, 120),
        pass: "classify-failed",
        decision: "skip",
        sort_folder: "To Delete",
        rule_matched: `pending_attempts_exhausted:${e.attempt_count}`,
        reasoning: `Classifier failed ${e.attempt_count} times since ${e.first_handoff_ts}`,
        task_id_created: null,
        model_used: null,
      });
    }
  }
  if (!wantsCompare && exhausted.length > 0) {
    log.warn("gave up on emails after max retries", {
      exhausted: exhausted.length,
    });
  }
  const carryoverByEmailKey = new Map(
    carryover.map((e) => [emailKey(e.account, e.email_id), e]),
  );

  const listing = await listAllNewMail(progress.last_scan_date ?? {});
  outcome.errors.push(...listing.errors);
  const listedEmails = listing.emails;
  const freshEmails = listedEmails.filter(
    (e) => !resolvedIds.has(emailKey(e.account, e.id)),
  );
  const freshKeys = new Set(freshEmails.map((e) => emailKey(e.account, e.id)));
  const carryoverAsEmails: EmailMinimal[] = carryover
    .filter((c) => !freshKeys.has(emailKey(c.account, c.email_id)))
    .map((c) => ({
      id: c.email_id,
      account: c.account,
      from: c.from,
      subject: c.subject,
    }));
  const emails = [...carryoverAsEmails, ...freshEmails];
  outcome.scanned = emails.length;

  if (emails.length === 0) {
    if (!DRY_RUN && !wantsCompare) {
      writePendingResiduals([]);
      writeCompletedProgress(
        progress,
        accounts,
        listedEmails,
        listing.completedAccounts,
        scanStartedIso,
        scanRunId,
      );
    }
    return formatSummary(outcome, null, scanRunId);
  }

  if (wantsCompare) {
    const compare = await compareAgentToPrefilter(
      emails,
      classification,
      institutions,
      contacts,
      scanRunId,
    );
    return formatSummary(outcome, null, scanRunId, compare);
  }

  const taskListId = DRY_RUN ? "dry-run" : await taskWriter.getDefaultListId();

  const overrideById = new Map(
    classification.overrides.map((o) => [o.email_id, o]),
  );

  for (const email of emails) {
    const override = overrideById.get(email.id);
    if (override) {
      appendDecision({
        scan_run_id: scanRunId,
        email_id: email.id,
        account: email.account,
        sender: email.from,
        subject: (email.subject || "").slice(0, 120),
        pass: "override",
        decision: override.decision,
        sort_folder: override.sort_folder ?? null,
        rule_matched: `override:${email.id}`,
        reasoning: override.reasoning ?? null,
        task_id_created: null,
        model_used: null,
      });
      continue;
    }

    // MODE=agent: Codex is the source-of-truth classifier for every message.
    if (wantsAgent) {
      outcome.llm_candidates.push(
        candidateFromEmail(email, institutions, contacts),
      );
      continue;
    }

    const tpl = matchActionTemplate(email, classification.action_templates);
    if (tpl) {
      if (tpl.skip) {
        outcome.template_skips += 1;
        appendDecision({
          scan_run_id: scanRunId,
          email_id: email.id,
          account: email.account,
          sender: email.from,
          subject: (email.subject || "").slice(0, 120),
          pass: "template",
          decision: "skip",
          sort_folder: null,
          rule_matched: tpl.name,
          reasoning: "action_template skip rule",
          task_id_created: null,
          model_used: null,
        });
        continue;
      }
      if (tpl.create_task) {
        const rawTitle = substituteTitle(tpl.create_task.title, email);
        const cleanTitle = buildCleanTitle(
          rawTitle,
          email.account,
          tpl.create_task.folder,
        );
        const auditMarker = taskAuditMarker(email);
        const due =
          typeof tpl.create_task.due_offset_days === "number"
            ? computeDueIsoLocal(tpl.create_task.due_offset_days)
            : undefined;
        let taskId: string | null = null;
        let taskPreexisting = false;
        if (!DRY_RUN && taskListId) {
          appendDecision({
            scan_run_id: scanRunId,
            email_id: email.id,
            account: email.account,
            sender: email.from,
            subject: (email.subject || "").slice(0, 120),
            pass: "template-intent",
            decision: "task-intent",
            sort_folder: tpl.create_task.folder,
            rule_matched: tpl.name,
            reasoning: `action_template create_task (${tpl.name})`,
            task_id_created: null,
            task_audit_marker: auditMarker,
            model_used: null,
          });
          taskId = await taskWriter.findTaskByMarker(taskListId, auditMarker);
          taskPreexisting = Boolean(taskId);
          if (!taskId) {
            taskId = await taskWriter.createTask(
              taskListId,
              cleanTitle,
              due,
              auditMarker,
            );
          }
          if (!taskId) {
            outcome.errors.push(
              `template_${tpl.name}: create-task failed for "${email.subject}"`,
            );
            outcome.llm_candidates.push(
              candidateFromEmail(email, institutions, contacts),
            );
            continue;
          }
        }
        outcome.template_tasks += 1;
        appendDecision({
          scan_run_id: scanRunId,
          email_id: email.id,
          account: email.account,
          sender: email.from,
          subject: (email.subject || "").slice(0, 120),
          pass: "template",
          decision: "task",
          sort_folder: tpl.create_task.folder,
          rule_matched: tpl.name,
          reasoning: `action_template create_task (${tpl.name})`,
          task_id_created: taskId,
          task_audit_marker: auditMarker,
          task_preexisting: taskPreexisting || undefined,
          model_used: null,
        });
        continue;
      }
    }

    const skip = matchSkipSender(email, classification.skip_senders);
    if (skip) {
      outcome.skip_sender_count += 1;
      appendDecision({
        scan_run_id: scanRunId,
        email_id: email.id,
        account: email.account,
        sender: email.from,
        subject: (email.subject || "").slice(0, 120),
        pass: "skip",
        decision: "skip",
        sort_folder: skip.folder,
        rule_matched: `skip_senders:${skip.from_address || skip.from_domain}`,
        reasoning: null,
        task_id_created: null,
        model_used: null,
      });
      continue;
    }

    outcome.llm_candidates.push(
      candidateFromEmail(email, institutions, contacts),
    );
  }

  if (outcome.llm_candidates.length === 0) {
    if (!DRY_RUN) {
      writePendingResiduals([]);
      writeCompletedProgress(
        progress,
        accounts,
        listedEmails,
        listing.completedAccounts,
        scanStartedIso,
        scanRunId,
      );
    }
    return formatSummary(outcome, null, scanRunId);
  }

  await fetchBodies(outcome.llm_candidates);

  // MODE=agent always sends every email to Codex. MODE=hybrid applies
  // deterministic shortcuts first, then classifies residuals with the selected
  // backend. MODE=compare returned earlier and never creates tasks.
  const api =
    MODE === "hybrid" && RESIDUAL_CLASSIFIER === "openai"
      ? await classifyResidualsOpenAi(
          outcome,
          scanRunId,
          taskListId,
          taskWriter,
        )
      : await classifyResidualsCodex(
          outcome,
          scanRunId,
          taskListId,
          taskWriter,
        );

  if (!DRY_RUN) {
    const nowIso = new Date().toISOString();
    const pendingThisScan: PendingResidual[] = outcome.llm_candidates
      .filter((c) => api.failedEmailKeys.has(emailKey(c.account, c.id)))
      .map((c) => {
        const prior = carryoverByEmailKey.get(emailKey(c.account, c.id));
        return {
          scan_run_id: scanRunId,
          email_id: c.id,
          account: c.account,
          from: c.from,
          subject: c.subject,
          handoff_ts: nowIso,
          first_handoff_ts: prior?.first_handoff_ts ?? nowIso,
          attempt_count: (prior?.attempt_count ?? 0) + 1,
        };
      });
    writePendingResiduals(pendingThisScan);
    writeCompletedProgress(
      progress,
      accounts,
      listedEmails,
      listing.completedAccounts,
      scanStartedIso,
      scanRunId,
    );
  }

  return formatSummary(outcome, api, scanRunId);
}
