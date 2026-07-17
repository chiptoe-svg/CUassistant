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
  assert.equal(isMcpOperationExposed("clemson.instructor_classes"), true);
  assert.equal(isMcpOperationExposed("clemson.room_availability"), true);
  assert.equal(isMcpOperationExposed("clemson.check_schedule_conflicts"), true);
  assert.equal(isMcpOperationExposed("clemson.find_conflict_free_schedule"), true);
  assert.equal(isMcpOperationExposed("clemson.find_eligible_sections"), true);
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

test("skill docs tools are exposed and pass the policy gate", () => {
  assert.equal(isMcpOperationExposed("host.list_skills"), true);
  assert.equal(isMcpOperationExposed("host.get_skill_docs"), true);
  assert.doesNotThrow(() => assertMcpOperation("host.list_skills"));
  assert.doesNotThrow(() =>
    assertMcpOperation("host.get_skill_docs", {
      input: { name: "clemson-schedule-advising" },
    }),
  );
});

test("schedule conflict tools pass the policy gate", () => {
  assert.doesNotThrow(() =>
    assertMcpOperation("clemson.check_schedule_conflicts", {
      input: { term: "202608", crns: ["80001"] },
    }),
  );
  assert.doesNotThrow(() =>
    assertMcpOperation("clemson.find_conflict_free_schedule", {
      input: { term: "202608", fixed_crns: [], candidate_crns: ["80001"] },
    }),
  );
  assert.doesNotThrow(() =>
    assertMcpOperation("clemson.find_eligible_sections", {
      input: {
        term: "202608",
        slot_type: "Specialty Area Requirement",
        completed_courses: ["GC 1010"],
      },
    }),
  );
});
