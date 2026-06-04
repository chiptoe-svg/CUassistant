import assert from "node:assert/strict";
import test from "node:test";

import { hashArtifact, externalRecipients } from "../src/approval/freeze.ts";
import type { SendArtifact } from "../src/approval/types.ts";

const base: SendArtifact = {
  account: "gmail",
  to: ["alice@clemson.edu"],
  subject: "Hi",
  body: "Hello",
};

test("hashArtifact is stable for identical artifacts and changes with content", () => {
  assert.equal(hashArtifact(base), hashArtifact({ ...base }));
  assert.notEqual(
    hashArtifact(base),
    hashArtifact({ ...base, body: "Changed" }),
  );
});

test("externalRecipients flags only non-internal domains", () => {
  const a: SendArtifact = {
    ...base,
    to: ["alice@clemson.edu", "bob@gmail.com"],
    cc: ["carol@CLEMSON.EDU", "dave@evil.com"],
  };
  assert.deepEqual(externalRecipients(a, ["clemson.edu"]).sort(), [
    "bob@gmail.com",
    "dave@evil.com",
  ]);
});
