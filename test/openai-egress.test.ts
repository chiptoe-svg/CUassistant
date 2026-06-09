import assert from "node:assert/strict";
import test from "node:test";

import { openAiEgressBlockReason } from "../src/openai-classifier.ts";

test("egress blocked when OpenAI is not configured", () => {
  assert.match(
    openAiEgressBlockReason(false, false) ?? "",
    /OPENAI_API_KEY is missing/,
  );
  assert.match(
    openAiEgressBlockReason(false, true) ?? "",
    /OPENAI_API_KEY is missing/,
  );
});

test("egress blocked when configured but not acknowledged", () => {
  assert.match(
    openAiEgressBlockReason(true, false) ?? "",
    /OPENAI_EGRESS_ACK=1 is required/,
  );
});

test("egress allowed only when configured AND acknowledged", () => {
  assert.equal(openAiEgressBlockReason(true, true), null);
});
