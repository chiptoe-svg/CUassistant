# Preclassifier Instructions

The preclassifier is the cost-control layer in front of task creation. It has
two parts:

1. deterministic host rules that resolve obvious repeated mail without any
   model call;
2. an optional lean residual classifier for messages that still need model
   judgment after host rules run.

Codex remains the default classifier and the benchmark for tuning. The
preclassifier exists to reduce latency and token spend without giving any model
direct access to mailbox or task side effects.

## Why This Exists

The preclassifier is a cost-control loop, not a replacement for the agent. The
earlier 50-email triage test that dropped from about 5M tokens to about 50K
tokens used the full cost-control prototype: deterministic shortcuts for obvious
repeated patterns plus a lean classifier path for messages that still needed
model judgment. CUassistant keeps that lean classifier as an explicit
`MODE=hybrid` option via `RESIDUAL_CLASSIFIER=openai`; Codex remains the default.
Repeated obvious patterns should still become zero-token host rules after
compare mode proves they match the agent.

## Residual Classifier

- Default to `RESIDUAL_CLASSIFIER=codex` when the goal is the simplest Clemson
  review story or the closest match to ChatGPT/Codex behavior.
- Use `RESIDUAL_CLASSIFIER=openai` in `MODE=hybrid` when the goal is lower token
  use for residuals after deterministic rules have already removed obvious mail.
- The lean OpenAI classifier is not the deterministic prefilter. It receives
  only unresolved residuals, one email at a time, with sender, subject, hint,
  normalized body, taxonomy, and compact classification instructions.
- The lean classifier has no tools and no side-effect channel. It returns JSON;
  the host validates the folder, sanitizes the title, writes audit rows, and
  creates tasks.
- If `RESIDUAL_CLASSIFIER=openai` is enabled, `OPENAI_API_KEY` is required and
  should be treated as a local endpoint secret alongside the MS365 refresh token.

## Allowed Shortcuts

- Add deterministic skip rules only after repeated compare-mode evidence that
  the agent marks the same sender as `needs_task=false`.
- Add deterministic task templates only for stable, repeated sender + subject
  patterns where the agent marks `needs_task=true`.
- Prefer exact sender-address rules over broad domain rules.
- Prefer narrow subject patterns over broad words like "request", "update", or
  "reminder".
- Prefer false negatives over false positives. When uncertain, leave the mail
  for the agent.

## Review Rules

- Compare-mode suggestions are advisory. Do not auto-apply them.
- Any preclassifier rule that disagrees with the agent should be reviewed before
  more shortcuts are added.
- Never add deterministic task rules for student, personnel, legal, medical, or
  disciplinary mail unless the sender and subject pattern are extremely stable.
- Skip rules must not cover human direct mail unless compare evidence is strong
  and the sender is clearly automated or non-actionable.

## Evidence Defaults

- Minimum evidence for a proposed skip rule: 3 matching compare rows.
- Minimum evidence for a proposed task template: 3 matching compare rows.
- Compare rows older than 30 days should be treated as stale unless the pattern
  is still actively recurring.
