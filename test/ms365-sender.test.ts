import assert from "node:assert/strict";
import test from "node:test";
import { buildSendMailPayload } from "../src/approval/ms365-sender.ts";

test("buildSendMailPayload maps recipients + body", () => {
  const p = buildSendMailPayload({
    account: "ms365",
    to: ["a@x.edu", "b@x.edu"],
    cc: ["c@x.edu"],
    subject: "Hi",
    body: "Body text",
  });
  assert.equal(p.message.subject, "Hi");
  assert.equal(p.message.body.contentType, "Text");
  assert.equal(p.message.body.content, "Body text");
  assert.deepEqual(
    p.message.toRecipients.map((r) => r.emailAddress.address),
    ["a@x.edu", "b@x.edu"],
  );
  assert.equal(p.message.ccRecipients[0].emailAddress.address, "c@x.edu");
  assert.equal(p.saveToSentItems, true);
});
