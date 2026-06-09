import assert from "node:assert/strict";
import test from "node:test";

import {
  gwsResponseError,
  parseGmailLabels,
} from "../src/mcp-tools/gmail-folders.ts";

test("gwsResponseError surfaces gws error envelopes (vs. mistaking them for empty)", () => {
  assert.match(
    gwsResponseError(
      JSON.stringify({ error: { code: 401, message: "invalid_grant" } }),
    ) ?? "",
    /invalid_grant/,
  );
  assert.equal(gwsResponseError(JSON.stringify({ labels: [] })), null);
  assert.equal(gwsResponseError("not json"), null);
});

test("parseGmailLabels keeps user labels (name=path), drops system labels", () => {
  const json = JSON.stringify({
    labels: [
      { id: "INBOX", name: "INBOX", type: "system" },
      { id: "TRASH", name: "TRASH", type: "system" },
      { id: "Label_1", name: "sorted/Newsletters", type: "user" },
      { id: "Label_2", name: "sorted/Receipts", type: "user" },
      { id: "Label_3", name: "Personal", type: "user" },
    ],
  });
  const labels = parseGmailLabels(json);
  assert.deepEqual(labels.map((l) => l.path).sort(), [
    "Personal",
    "sorted/Newsletters",
    "sorted/Receipts",
  ]);
  assert.equal(
    labels.find((l) => l.path === "sorted/Newsletters")?.id,
    "Label_1",
  );
});

test("parseGmailLabels tolerates garbage and missing fields", () => {
  assert.deepEqual(parseGmailLabels("not json"), []);
  assert.deepEqual(parseGmailLabels(JSON.stringify({})), []);
  assert.deepEqual(
    parseGmailLabels(JSON.stringify({ labels: [{ name: "x", type: "user" }] })),
    [], // missing id
  );
});
