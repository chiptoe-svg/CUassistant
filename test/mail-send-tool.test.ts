import assert from "node:assert/strict";
import test from "node:test";

import { requestSendMail, getSendStatus, __setGate } from "../src/mcp-tools/mail-send.ts";

function fakeGate() {
  return {
    async submit(artifact: unknown, proposer: string) {
      return { request_id: "req1", status: "pending" as const };
    },
    getStatus(id: string) {
      return id === "req1" ? ({ status: "pending" as const }) : null;
    },
  };
}

test("request_send_mail validates and returns a request_id", async () => {
  __setGate(fakeGate() as never);
  const res = await requestSendMail.handler({
    account: "gmail",
    to: ["a@x.com"],
    subject: "s",
    body: "b",
  });
  const payload = JSON.parse((res.content[0] as { text: string }).text);
  assert.equal(payload.request_id, "req1");
  assert.equal(payload.status, "pending");
});

test("request_send_mail rejects missing recipients", async () => {
  __setGate(fakeGate() as never);
  const res = await requestSendMail.handler({ account: "gmail", to: [], subject: "s", body: "b" });
  assert.equal(res.isError, true);
});

test("get_send_status returns the current state", async () => {
  __setGate(fakeGate() as never);
  const res = await getSendStatus.handler({ request_id: "req1" });
  const payload = JSON.parse((res.content[0] as { text: string }).text);
  assert.equal(payload.status, "pending");
});
