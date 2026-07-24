// The advisor's own skill tools: list-skills / get-skill-docs as HOST tools
// (advisor-skills.ts), built over the combined skill index (this repo's
// skills/ + gc_advisor's) and allowlisted to the advising skills. This is
// what replaced the MCP bridge's list-skills / get-skill-docs, which are
// filtered out of the advisor's tool array by ADVISOR_SKILL_TOOL_DENYLIST.

import assert from "node:assert/strict";
import test from "node:test";

import { ADVISOR_SKILLS, createSkillTools } from "../src/advisor-skills.ts";

interface TextResult {
  content: { type: string; text: string }[];
}

function payload(result: TextResult): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

function getTools() {
  const tools = createSkillTools();
  const listSkills = tools.find((t) => t.name === "list-skills")!;
  const getSkillDocs = tools.find((t) => t.name === "get-skill-docs")!;
  assert.ok(listSkills, "list-skills tool must be present");
  assert.ok(getSkillDocs, "get-skill-docs tool must be present");
  return { listSkills, getSkillDocs };
}

test("createSkillTools returns exactly list-skills and get-skill-docs", () => {
  const tools = createSkillTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ["get-skill-docs", "list-skills"],
  );
});

test("list-skills lists the allowlisted skills that exist on disk", async () => {
  const { listSkills } = getTools();
  const result = (await listSkills.execute("call-1", {})) as TextResult;
  const skills = payload(result).skills as { name: string; description: string }[];
  const names = skills.map((s) => s.name);

  // These two ship in this repo's skills/ regardless of test environment;
  // gc-advisor / gc-curriculum-lookup depend on gc_advisor being checked out
  // beside this repo and are not asserted here.
  assert.ok(names.includes("clemson-schedule-advising"));
  assert.ok(names.includes("how-it-works"));

  // Every returned name must be allowlisted and carry a non-empty description.
  for (const s of skills) {
    assert.ok(
      ADVISOR_SKILLS.has(s.name),
      `list-skills returned a non-allowlisted skill: ${s.name}`,
    );
    assert.ok(s.description.length > 0, `expected a description for ${s.name}`);
  }
});

test("list-skills never includes the private skills", async () => {
  const { listSkills } = getTools();
  const result = (await listSkills.execute("call-1", {})) as TextResult;
  const names = (payload(result).skills as { name: string }[]).map((s) => s.name);
  assert.ok(!names.includes("add-cuassistant"));
  assert.ok(!names.includes("triage"));
});

test("get-skill-docs returns the full how-it-works content", async () => {
  const { getSkillDocs } = getTools();
  const result = (await getSkillDocs.execute("call-1", {
    name: "how-it-works",
  })) as TextResult;
  const doc = payload(result);
  assert.equal(doc.name, "how-it-works");
  assert.match(doc.content as string, /How this assistant works/);
});

test("get-skill-docs refuses an allowlist miss without revealing it exists", async () => {
  const { getSkillDocs } = getTools();
  await assert.rejects(
    () => getSkillDocs.execute("call-1", { name: "add-cuassistant" }),
    /not found/i,
  );
});

test("get-skill-docs refuses a bad slug", async () => {
  const { getSkillDocs } = getTools();
  await assert.rejects(
    () => getSkillDocs.execute("call-1", { name: "../etc" }),
    /not found|Invalid/i,
  );
});
