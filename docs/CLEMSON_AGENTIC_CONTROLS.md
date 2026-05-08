# Clemson Agentic Workflow Control Memo

This memo frames the requested Microsoft 365 workflow against the ACSC guidance
"Careful adoption of agentic AI services" published on 01 May 2026:
[cyber.gov.au guidance](https://www.cyber.gov.au/business-government/secure-design/artificial-intelligence/careful-adoption-of-agentic-ai-services)

## Requested Scope

Single-user, local workflow operating only in the requestor's own Microsoft 365
account:

- read Inbox messages
- create To Do tasks
- move mail only between approved folders
- create drafts only in Drafts
- create events only on the requestor's personal calendar with no attendees

Out of scope:

- send mail
- delete or permanently delete mail
- shared or delegated mailbox actions
- shared or delegated calendar actions
- invitations, attendee management, meeting cancellation
- custom Azure app hosting

## Guidance Mapping

### 1. Incremental adoption for low-risk tasks

The guidance recommends that organisations "deploy agentic AI incrementally"
and begin with "clearly defined low-risk tasks."

Argument:

- The requested workflow is not a general-purpose agent platform.
- It is a narrow personal productivity workflow bound to one mailbox, one To Do
  list, and one calendar.
- The current repo already isolates capability by handler and host-applied side
  effects.

Relevant implementation:

- [src/handlers/triage.ts](/Users/tonkin/Documents/ClaudeWorkingFolder/Projects/CUassistant/src/handlers/triage.ts)
- [src/permissions.ts](/Users/tonkin/Documents/ClaudeWorkingFolder/Projects/CUassistant/src/permissions.ts)

### 2. Human classification by impact and reversibility

The guidance says to "classify agent actions by potential impact, likelihood and
reversibility" and use approval where the "cost of error is high" or actions
are difficult to reverse.

Argument:

- Moving mail between approved folders in the user's own mailbox is reversible
  and non-destructive.
- Creating a draft is reversible and does not create external communication.
- Creating an event on the user's own calendar with no attendees is reversible
  and does not affect other users.
- Sending mail, deleting mail, and shared-calendar effects remain out of scope.

Policy artifact:

- [action-policy.yaml](/Users/tonkin/Documents/ClaudeWorkingFolder/Projects/CUassistant/policy/action-policy.yaml)

### 3. Least privilege

The guidance says to "limit privileges of AI agents to the minimum required"
and "restrict scope of privileges to narrowest possible level."

Argument:

- The workflow should use delegated access only.
- The preferred path is a Microsoft first-party client rather than a custom
  app registration.
- The code should expose only the small action set required for this workflow.

Current code shape:

- The host operation allow-list is explicit in
  [src/permissions.ts](/Users/tonkin/Documents/ClaudeWorkingFolder/Projects/CUassistant/src/permissions.ts).
- Durable audit and usage logs are written in
  [src/state.ts](/Users/tonkin/Documents/ClaudeWorkingFolder/Projects/CUassistant/src/state.ts).

### 4. Runtime control and oversight

The guidance recommends "human control and oversight," "explicit control
flows," and bounded autonomy.

Argument:

- The model should not receive direct Graph capability.
- The host should remain the enforcement point for approved actions.
- Higher-risk actions should remain disallowed or approval-gated by policy.

Current code shape:

- The agent returns structured classification output.
- The host applies side effects and maintains audit records.

### 5. Visibility, monitoring, and audit

The guidance stresses visibility, monitoring, and auditable operation.

Argument:

- This workflow already keeps append-only decision and usage logs.
- Side effects should continue to be logged before and after execution.
- The request is therefore easier to inspect than a broad autonomous workflow.

Relevant implementation:

- [src/state.ts](/Users/tonkin/Documents/ClaudeWorkingFolder/Projects/CUassistant/src/state.ts)
- [docs/IT_REVIEW_NOTES.md](/Users/tonkin/Documents/ClaudeWorkingFolder/Projects/CUassistant/docs/IT_REVIEW_NOTES.md)

## Request Framing

The strongest request is not "approve agentic email and calendar automation."

It is:

"Approve a single-user, local, delegated workflow that uses a Microsoft
first-party client, operates only within the requestor's own Microsoft 365
account, and is restricted to a small set of reversible actions with durable
audit logging and host-enforced policy boundaries."
