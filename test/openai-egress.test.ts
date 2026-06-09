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

test("egress blocked when configured but not authorized in policy", () => {
  assert.match(
    openAiEgressBlockReason(true, false) ?? "",
    /not authorized in policy/,
  );
});

test("egress allowed only when configured AND authorized", () => {
  assert.equal(openAiEgressBlockReason(true, true), null);
});
