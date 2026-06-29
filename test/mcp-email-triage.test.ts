// test/mcp-email-triage.test.ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  expandScopes,
  isMcpOperationExposed,
  isValidScopeToken,
} from "../src/mcp-tools/permissions.ts";

test("host:triage scope token is valid", () => {
  assert.ok(isValidScopeToken("host:triage"));
});

test("host:triage expands to the three triage operations", () => {
  const ops = expandScopes(["host:triage"]);
  assert.ok(ops.has("host.get_triage_candidates"), "missing get_triage_candidates");
  assert.ok(ops.has("host.log_triage_decision"), "missing log_triage_decision");
  assert.ok(ops.has("host.complete_scan"), "missing complete_scan");
});

test("all three triage operations are exposed (approval=none)", () => {
  assert.ok(isMcpOperationExposed("host.get_triage_candidates"));
  assert.ok(isMcpOperationExposed("host.log_triage_decision"));
  assert.ok(isMcpOperationExposed("host.complete_scan"));
});

import { routeEmails } from "../src/mcp-tools/email-triage.ts";
import type { Classification, EmailMinimal } from "../src/types.ts";

test("routeEmails classifies override, template, skip-sender, and candidate", () => {
  const classification: Classification = {
    action_templates: [
      {
        name: "registrar-task",
        match: { from_domain: "registrar.example.edu" },
        create_task: { title: "Registrar: {subject}", folder: "Admin" },
      },
      {
        name: "newsletter-skip",
        match: { from_address: "news@list.example.com" },
        skip: true,
      },
    ],
    skip_senders: [{ from_domain: "noreply.example.com", folder: "To Delete" }],
    overrides: [{ email_id: "ovr-1", decision: "skip", reasoning: "manual" }],
  };
  const institutions = new Set<string>(["clemson.edu"]);
  const contacts = new Set<string>(["sarah@clemson.edu"]);

  const emails: EmailMinimal[] = [
    { id: "ovr-1", account: "outlook", from: "anyone@x.com", subject: "x" },
    { id: "t1", account: "outlook", from: "dean@registrar.example.edu", subject: "Grades due" },
    { id: "s1", account: "gmail", from: "news@list.example.com", subject: "Weekly" },
    { id: "k1", account: "outlook", from: "auto@noreply.example.com", subject: "Auto" },
    { id: "c1", account: "gmail", from: "sarah@clemson.edu", subject: "Question" },
    { id: "c2", account: "outlook", from: "stranger@unknown.org", subject: "Hi" },
  ];

  const routed = routeEmails(emails, classification, institutions, contacts);
  const byId = new Map(routed.map((r) => [r.email.id, r]));

  assert.equal(byId.get("ovr-1")?.kind, "override");
  assert.equal(byId.get("t1")?.kind, "template-task");
  assert.equal(byId.get("s1")?.kind, "template-skip");
  assert.equal(byId.get("k1")?.kind, "skip-sender");
  const c1 = byId.get("c1");
  assert.equal(c1?.kind, "candidate");
  if (c1?.kind === "candidate") assert.equal(c1.bucket_hint, "solicited");
  const c2 = byId.get("c2");
  assert.equal(c2?.kind, "candidate");
  if (c2?.kind === "candidate") assert.equal(c2.bucket_hint, "outreach_check");
});
