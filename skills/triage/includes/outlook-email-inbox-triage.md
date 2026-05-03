# Advisory Outlook inbox triage guidance

This section mirrors the useful judgment guidance from Codex Desktop's Outlook
inbox triage skill. It is advisory only. CUassistant's `triage` skill remains
the final authority for `needs_task`, `sort_folder`, `task_title`, and JSON
output shape.

## Reading pattern

- Start from a bounded Inbox slice.
- Use sender, subject, received time, and preview/body text to build the first
  pass.
- Expand full bodies only when urgency, ownership, or reply-needed state is
  unclear.
- Treat reply-needed status as an inference from the supplied message context,
  not as guaranteed inbox-wide truth.

## Triage buckets

- `Urgent`: direct asks with time pressure, blockers, escalation risk, or
  operational consequences if ignored.
- `Needs reply soon`: direct asks without same-day urgency, active threads where
  the recipient is likely the next responder, or follow-ups that will go stale.
- `Waiting`: threads where the recipient already replied or the current blocker
  belongs to someone else.
- `FYI`: announcements, newsletters, calendar churn, transactional mail, and
  messages that do not currently require action.

## CUassistant mapping

- `Urgent` and `Needs reply soon` usually map to `needs_task=true`.
- `Waiting` and `FYI` usually map to `needs_task=false`.
- Obvious newsletters, automated alerts, promotions, marketplace
  recommendations, and generic social notifications should be skipped unless
  the message contains a concrete obligation.
- Keep classification separate from mailbox actions. This agent must not ask to
  move, archive, mark read, draft, send, or delete mail.
