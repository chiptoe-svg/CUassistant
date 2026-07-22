import assert from "node:assert/strict";
import test from "node:test";

import { loadSystemPrompt } from "../src/advisor-agent.ts";

test("the persona carries the rules that keep answers grounded", () => {
  const p = loadSystemPrompt();
  assert.match(p, /catalog year/i, "catalog-year discipline");
  assert.match(p, /petitions/i, "the exceptions boundary");
  assert.match(p, /empty/i, "the empty-result rule");
  assert.match(p, /list-skills/, "skills are retrieved, not inlined");
});

// The three skills total ~6,500 tokens. Inlining them would spend a tenth of a
// 64k window on every turn — the budget the 2026-07-21 payload work reclaimed.
test("skill bodies are NOT inlined into the system prompt", () => {
  const p = loadSystemPrompt();
  assert.ok(p.length < 8000, `system prompt is ${p.length} chars — skills inlined?`);
  assert.doesNotMatch(p, /### `search-clemson-classes`/, "skill body leaked in");
});
