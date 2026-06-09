import assert from "node:assert/strict";
import test from "node:test";

import {
  approvalOutcomeLabel,
  formatApprovalMessage,
} from "../src/notifiers/telegram-approval.ts";
import type { PendingSend } from "../src/approval/types.ts";

const req: PendingSend = {
  request_id: "req1",
  artifact: {
    account: "gmail",
    to: ["a@clemson.edu", "b@gmail.com"],
    subject: "Meeting",
    body: "Body text",
  },
  content_hash: "abc",
  proposer: "agent:x",
  status: "pending",
  created_at: 0,
  expires_at: 0,
};

test("approval message includes recipients, subject, body, and flags externals", () => {
  const msg = formatApprovalMessage(req, ["b@gmail.com"]);
  assert.match(msg, /a@clemson\.edu/);
  assert.match(msg, /Meeting/);
  assert.match(msg, /Body text/);
  assert.match(msg, /⚠️.*b@gmail\.com/s);
});

test("approvalOutcomeLabel maps each terminal status to a distinct label", () => {
  assert.match(approvalOutcomeLabel("rejected"), /Rejected/);
  assert.match(approvalOutcomeLabel("sent"), /Approved.*sent/);
  assert.match(approvalOutcomeLabel("failed"), /send failed/);
  assert.match(approvalOutcomeLabel("expired"), /Expired/);
  // A no-op tap (still pending / unknown) must NOT read as a decision.
  assert.match(approvalOutcomeLabel("pending"), /No change/);
  assert.match(approvalOutcomeLabel(undefined), /No change/);
});

test("long bodies are truncated with a marker", () => {
  const long = {
    ...req,
    artifact: { ...req.artifact, body: "x".repeat(5000) },
  };
  const msg = formatApprovalMessage(long, []);
  assert.match(msg, /truncated, 5000 chars total/);
  assert.ok(msg.length < 4096);
});
