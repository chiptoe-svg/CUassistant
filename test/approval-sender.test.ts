import assert from "node:assert/strict";
import test from "node:test";

import { makeSender } from "../src/approval/sender.js";
import type { SendArtifact } from "../src/approval/types.js";

const gmail: SendArtifact = {
  account: "gmail",
  to: ["a@x.com"],
  subject: "s",
  body: "b",
};
const ms365: SendArtifact = {
  account: "ms365",
  to: ["a@x.com"],
  subject: "s",
  body: "b",
};

test("dispatches gmail to the gws backend", async () => {
  const calls: SendArtifact[] = [];
  const sender = makeSender({
    gmail: async (a) => {
      calls.push(a);
      return { id: "g1" };
    },
  });
  const r = await sender.send(gmail);
  assert.equal(r.id, "g1");
  assert.equal(calls.length, 1);
});

test("ms365 send is disabled in v1 and throws a clear error", async () => {
  const sender = makeSender({ gmail: async () => ({ id: "g1" }) });
  await assert.rejects(() => sender.send(ms365), /ms365 send not enabled/);
});
