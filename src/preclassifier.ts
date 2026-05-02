import {
  bucketHintFor,
  matchActionTemplate,
  matchSkipSender,
  substituteTitle,
} from "./cascade.js";
import {
  Classification,
  DeterministicDecision,
  EmailMinimal,
  LlmCandidate,
} from "./types.js";

export function candidateFromEmail(
  email: EmailMinimal,
  institutions: Set<string>,
  contacts: Set<string>,
): LlmCandidate {
  return {
    ...email,
    bucket_hint: bucketHintFor(email, institutions, contacts),
  };
}

export function deterministicDecisionFor(
  email: EmailMinimal,
  classification: Classification,
): DeterministicDecision {
  const override = classification.overrides.find(
    (o) => o.email_id === email.id,
  );
  if (override) {
    return {
      source: "override",
      needs_task:
        override.decision === "task"
          ? true
          : override.decision === "skip"
            ? false
            : null,
      sort_folder: override.sort_folder ?? null,
      task_title: null,
      rule_matched: `override:${email.id}`,
      reasoning: override.reasoning ?? null,
    };
  }

  const tpl = matchActionTemplate(email, classification.action_templates);
  if (tpl?.skip) {
    return {
      source: "template",
      needs_task: false,
      sort_folder: null,
      task_title: null,
      rule_matched: tpl.name,
      reasoning: "action_template skip rule",
    };
  }
  if (tpl?.create_task) {
    return {
      source: "template",
      needs_task: true,
      sort_folder: tpl.create_task.folder,
      task_title: substituteTitle(tpl.create_task.title, email),
      rule_matched: tpl.name,
      reasoning: `action_template create_task (${tpl.name})`,
    };
  }

  const skip = matchSkipSender(email, classification.skip_senders);
  if (skip) {
    return {
      source: "skip",
      needs_task: false,
      sort_folder: skip.folder,
      task_title: null,
      rule_matched: `skip_senders:${skip.from_address || skip.from_domain}`,
      reasoning: null,
    };
  }

  return {
    source: "agent-needed",
    needs_task: null,
    sort_folder: null,
    task_title: null,
    rule_matched: null,
    reasoning: "deterministic prefilter would defer to agent",
  };
}
