import assert from "node:assert/strict";
import test from "node:test";

import {
  assertMcpOperation,
  isMcpOperationExposed,
} from "../src/mcp-tools/permissions.ts";

// The Clemson Browse Classes tools are public, no-auth, read-only and should be
// exposed (their policy actions are approval=none).

test("clemson public class tools are exposed", () => {
  assert.equal(isMcpOperationExposed("clemson.list_terms"), true);
  assert.equal(isMcpOperationExposed("clemson.search_classes"), true);
  assert.equal(isMcpOperationExposed("clemson.section_details"), true);
});

test("clemson tools pass the policy gate", () => {
  assert.doesNotThrow(() => assertMcpOperation("clemson.list_terms"));
  assert.doesNotThrow(() =>
    assertMcpOperation("clemson.search_classes", { input: { term: "202608" } }),
  );
  assert.doesNotThrow(() =>
    assertMcpOperation("clemson.section_details", {
      input: { term: "202608", crn: "85865" },
    }),
  );
});
