// test/mcp-email-triage-state.test.ts
//
// STATE_DIR is captured at config import time, so we MUST set it before
// importing anything that pulls in config.ts. Static ESM imports are hoisted,
// so we set the env var, then DYNAMIC-import the modules under test.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cuassistant-state-"));
process.env.STATE_DIR = TMP;

const { logTriageDecisionHandler, completeScanHandler, setActiveScanForTest } =
  await import("../src/mcp-tools/email-triage.ts");
const { loadProgress, writeProgress } = await import("../src/state.ts");

test("log_triage_decision writes a valid decisions.jsonl entry", async () => {
  setActiveScanForTest({
    scan_run_id: "2026-01-01T00:00:00.000Z",
    scan_started_iso: "2026-01-01T00:00:00.000Z",
    task_list_id: "list-123",
    listed_emails: [],
    completed_accounts: new Set(),
    progress: {},
    dry_run: false,
    candidates: [
      {
        email_id: "email-abc",
        account: "outlook",
        mail_account: "ms365",
        from: "test@example.com",
        subject: "Test Subject",
        received_iso: null,
        bucket_hint: "solicited",
        audit_marker: "cuassistant:deadbeef",
      },
    ],
  });

  const result = await logTriageDecisionHandler({
    scan_run_id: "2026-01-01T00:00:00.000Z",
    email_id: "email-abc",
    account: "outlook",
    from: "test@example.com",
    subject: "Test Subject",
    decision: "task",
    sort_folder: "Admin",
    task_title: "Reply to test@example.com re: Test Subject",
    task_id_created: "task-xyz",
    audit_marker: "cuassistant:deadbeef",
    reasoning: "Known contact",
    bucket_hint: "solicited",
  });

  assert.equal(result.isError, undefined);
  const decisions = path.join(TMP, "decisions.jsonl");
  assert.ok(fs.existsSync(decisions), "decisions.jsonl was not created");
  const lines = fs.readFileSync(decisions, "utf-8").trim().split("\n");
  const line = JSON.parse(lines.at(-1) as string);
  assert.equal(line.email_id, "email-abc");
  assert.equal(line.decision, "task");
  assert.equal(line.task_id_created, "task-xyz");
  // Outside an ALS request context, currentProvider() returns null → "unknown".
  assert.equal(line.model_used, "unknown");
});

test("log_triage_decision rejects a mismatched scan_run_id", async () => {
  setActiveScanForTest({
    scan_run_id: "scan-A",
    scan_started_iso: "scan-A",
    task_list_id: null,
    listed_emails: [],
    completed_accounts: new Set(),
    progress: {},
    dry_run: false,
    candidates: [],
  });
  const result = await logTriageDecisionHandler({
    scan_run_id: "scan-WRONG",
    email_id: "x",
    account: "outlook",
    from: "a@b.com",
    subject: "s",
    decision: "skip",
    audit_marker: "cuassistant:abc",
    reasoning: "r",
    bucket_hint: "solicited",
  });
  assert.equal(result.isError, true);
});

test("complete_scan releases lock and advances watermark", async () => {
  writeProgress({ last_scan_date: { outlook: "2026-01-01T00:00:00.000Z" } });
  fs.writeFileSync(path.join(TMP, "scan_in_progress.lock"), String(process.pid));

  setActiveScanForTest({
    scan_run_id: "2026-01-02T00:00:00.000Z",
    scan_started_iso: "2026-01-02T00:00:00.000Z",
    task_list_id: "list-123",
    listed_emails: [
      {
        id: "e1",
        account: "outlook",
        from: "x@x.com",
        subject: "A",
        receivedIso: "2026-01-02T10:00:00.000Z",
      },
    ],
    completed_accounts: new Set(["outlook"]),
    progress: { last_scan_date: { outlook: "2026-01-01T00:00:00.000Z" } },
    dry_run: false,
    candidates: [],
  });

  const result = await completeScanHandler({
    scan_run_id: "2026-01-02T00:00:00.000Z",
    advance_watermark: true,
    failed_candidates: [],
  });

  assert.equal(result.isError, undefined);
  assert.ok(
    !fs.existsSync(path.join(TMP, "scan_in_progress.lock")),
    "lock not released",
  );
  const prog = loadProgress();
  assert.ok(
    (prog.last_scan_date?.outlook ?? "") > "2026-01-01T00:00:00.000Z",
    "watermark not advanced",
  );
});

test("complete_scan with dry_run does not advance watermark", async () => {
  writeProgress({ last_scan_date: { outlook: "2026-03-01T00:00:00.000Z" } });
  fs.writeFileSync(path.join(TMP, "scan_in_progress.lock"), String(process.pid));
  setActiveScanForTest({
    scan_run_id: "dry-1",
    scan_started_iso: "dry-1",
    task_list_id: "dry-run",
    listed_emails: [
      {
        id: "e9",
        account: "outlook",
        from: "y@y.com",
        subject: "B",
        receivedIso: "2026-03-09T10:00:00.000Z",
      },
    ],
    completed_accounts: new Set(["outlook"]),
    progress: { last_scan_date: { outlook: "2026-03-01T00:00:00.000Z" } },
    dry_run: true,
    candidates: [],
  });
  const result = await completeScanHandler({ scan_run_id: "dry-1" });
  assert.equal(result.isError, undefined);
  const prog = loadProgress();
  assert.equal(prog.last_scan_date?.outlook, "2026-03-01T00:00:00.000Z");
});
