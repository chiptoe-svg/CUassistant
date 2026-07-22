// Regression tests for the per-server skill allowlist.
//
// `skills/` holds documents of mixed trust in one flat directory. Both skill
// tools are registered from index-public.ts, which the campus-reachable public
// server (8766) AND the loopback credentialed server (8765) load, so before
// the allowlist the public port served `triage` (the email classifier's
// decision rules) and `add-cuassistant` (a full map of the credentialed 8765
// surface) to anyone holding the public bearer.
//
// Three properties have to hold:
//
//   1. list-skills on the public server lists ONLY the allowlisted skill.
//   2. get-skill-docs on the public server refuses a non-allowlisted name even
//      when asked for it directly. This is the bypass that matters — hiding a
//      document from an index while still serving it by name is not hiding it.
//   3. The credentialed server still serves the full set, so triage and the
//      install docs remain reachable where they belong.

import assert from "node:assert/strict";
import test from "node:test";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CATALOG_SKILLS,
  PUBLIC_SKILLS,
  __resetSkillRoots,
  __setSkillRoots,
  __skillTools,
  buildSkillIndex,
  resetSkillExposure,
  setSkillExposure,
} from "../src/mcp-tools/skills.ts";

/** Skills that exist on disk but must never be served on the public port. */
const PRIVATE_SKILLS = ["triage", "add-cuassistant"];

interface CallResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

function payload(res: CallResult): Record<string, unknown> {
  assert.equal(res.isError, undefined, `unexpected error: ${res.content[0]?.text}`);
  return JSON.parse(res.content[0].text) as Record<string, unknown>;
}

async function listNames(): Promise<string[]> {
  const res = (await __skillTools.listSkills.handler({})) as CallResult;
  const skills = payload(res).skills as { name: string }[];
  return skills.map((s) => s.name);
}

async function fetchDocs(name: string): Promise<CallResult> {
  return (await __skillTools.getSkillDocs.handler({ name })) as CallResult;
}

test("the on-disk skills include the private ones (fixture sanity)", async () => {
  // Without this the tests below could pass simply because `triage` and
  // `add-cuassistant` no longer exist, which would make them vacuous.
  setSkillExposure("all");
  const names = await listNames();
  for (const s of [...PRIVATE_SKILLS, ...PUBLIC_SKILLS]) {
    assert.ok(names.includes(s), `expected skill "${s}" to exist on disk`);
  }
  resetSkillExposure();
});

test("public server: list-skills returns only the allowlisted skill", async () => {
  resetSkillExposure(); // the fail-closed default the public entry point uses
  const names = await listNames();
  assert.deepEqual(names, [...PUBLIC_SKILLS]);
  for (const s of PRIVATE_SKILLS) {
    assert.ok(!names.includes(s), `"${s}" must not be listed on the public server`);
  }
});

test("public server: get-skill-docs refuses a non-allowlisted skill asked for by name", async () => {
  // THE BYPASS. A skill missing from list-skills but fetchable directly is
  // still published — the names are short and guessable, and `triage` /
  // `add-cuassistant` are named in this repo's own docs.
  resetSkillExposure();
  for (const s of PRIVATE_SKILLS) {
    const res = await fetchDocs(s);
    assert.equal(res.isError, true, `get-skill-docs("${s}") must fail on the public server`);
    const text = res.content[0].text;
    assert.match(text, /not found/, `expected a not-found refusal, got: ${text}`);
    // The refusal must not leak the document it is refusing to serve.
    assert.ok(
      !/source-of-truth classifier|8765|approval gate/i.test(text),
      `refusal for "${s}" leaked document content: ${text}`,
    );
  }
});

test("public server: the allowlisted skill is still fetchable (advisor + nanoclaw depend on it)", async () => {
  resetSkillExposure();
  const res = await fetchDocs("clemson-schedule-advising");
  const doc = payload(res);
  assert.equal(doc.name, "clemson-schedule-advising");
  assert.ok((doc.content as string).length > 100, "expected real skill content");
});

test("credentialed server: setSkillExposure('all') serves the full set", async () => {
  setSkillExposure("all"); // what src/mcp-server.ts does at startup
  const names = await listNames();
  for (const s of [...PRIVATE_SKILLS, ...PUBLIC_SKILLS]) {
    assert.ok(names.includes(s), `credentialed server must still list "${s}"`);
  }
  for (const s of PRIVATE_SKILLS) {
    const doc = payload(await fetchDocs(s));
    assert.ok((doc.content as string).length > 100, `expected full docs for "${s}"`);
  }
  resetSkillExposure();
});

test("the exposure default is the restrictive set, not 'all'", async () => {
  // A server that never calls setSkillExposure must fail closed. This is the
  // property that makes it an allowlist rather than a denylist: a skill added
  // to skills/ tomorrow is invisible everywhere until someone opts it in.
  resetSkillExposure();
  const names = await listNames();
  assert.deepEqual(
    names,
    [...PUBLIC_SKILLS],
    "an unconfigured server must serve only the public allowlist",
  );
});

// ---------------------------------------------------------------------------
// Catalog server (8767): the GC skills, read from gc_advisor's root.
// ---------------------------------------------------------------------------

test("catalog server: list-skills returns exactly the two GC skills", async () => {
  // What src/mcp-catalog.ts does at startup.
  setSkillExposure(CATALOG_SKILLS);
  const names = await listNames();
  assert.deepEqual(names, ["gc-advisor", "gc-curriculum-lookup"]);
  resetSkillExposure();
});

test("catalog server: get-skill-docs refuses the private skills by direct name", async () => {
  // The bypass again, on the new server. `triage` and `add-cuassistant` live in
  // THIS repo's root, which the catalog server also scans, so only the
  // allowlist keeps them off 8767.
  setSkillExposure(CATALOG_SKILLS);
  for (const s of [...PRIVATE_SKILLS, "clemson-schedule-advising"]) {
    const res = await fetchDocs(s);
    assert.equal(res.isError, true, `get-skill-docs("${s}") must fail on 8767`);
    assert.match(res.content[0].text, /not found/);
  }
  resetSkillExposure();
});

test("catalog server: the GC skills are actually fetchable and have real content", async () => {
  // Guards the two halves that could each make the test above vacuous: the
  // gc_advisor root being unreadable, and the allowlist naming skills that do
  // not exist.
  setSkillExposure(CATALOG_SKILLS);
  for (const s of CATALOG_SKILLS) {
    const doc = payload(await fetchDocs(s));
    assert.equal(doc.name, s);
    assert.ok((doc.content as string).length > 100, `expected real docs for "${s}"`);
  }
  resetSkillExposure();
});

test("8766 and 8765 exposure are unchanged by the second root", async () => {
  // The GC skills are now on disk for every server that loads skills.ts. The
  // public server must still list exactly one skill, and the credentialed
  // server must still see the full local set.
  resetSkillExposure();
  assert.deepEqual(await listNames(), [...PUBLIC_SKILLS]);
  for (const s of CATALOG_SKILLS) {
    const res = await fetchDocs(s);
    assert.equal(res.isError, true, `"${s}" must not be served on 8766`);
  }

  setSkillExposure("all");
  const all = await listNames();
  for (const s of [...PRIVATE_SKILLS, ...PUBLIC_SKILLS]) {
    assert.ok(all.includes(s), `credentialed server must still list "${s}"`);
  }
  resetSkillExposure();
});

test("a missing second root degrades rather than throwing", async () => {
  // The catalog server's seven data tools do not depend on gc_advisor's skills
  // being checked out. An absent root drops its documents and logs; it must not
  // take the server down or break the roots that ARE readable.
  const absent = path.join(os.tmpdir(), "cuassistant-no-such-skills-root");
  fs.rmSync(absent, { recursive: true, force: true });

  __setSkillRoots([path.resolve(process.cwd(), "skills"), absent]);
  try {
    const index = buildSkillIndex();
    assert.ok(index.has("triage"), "the readable root must still be indexed");
    assert.ok(!index.has("gc-advisor"), "the absent root contributes nothing");

    setSkillExposure(CATALOG_SKILLS);
    const res = (await __skillTools.listSkills.handler({})) as CallResult;
    assert.equal(res.isError, undefined, "list-skills must still succeed");
    assert.deepEqual((payload(res).skills as { name: string }[]).map((s) => s.name), []);
  } finally {
    resetSkillExposure();
    __resetSkillRoots();
  }
});

test("a cross-root name collision fails loudly", async () => {
  // Two independent repos with no shared naming authority. Precedence would let
  // an agent read one skill's documentation while calling the other's tools,
  // with nothing in the transcript to show the substitution.
  const shadow = fs.mkdtempSync(path.join(os.tmpdir(), "cuassistant-skill-shadow-"));
  fs.mkdirSync(path.join(shadow, "triage"), { recursive: true });
  fs.writeFileSync(path.join(shadow, "triage", "SKILL.md"), "---\ndescription: impostor\n---\n");

  __setSkillRoots([path.resolve(process.cwd(), "skills"), shadow]);
  try {
    assert.throws(
      () => buildSkillIndex(),
      /collision.*triage/s,
      "a name present in two roots must throw, not silently shadow",
    );
  } finally {
    __resetSkillRoots();
    fs.rmSync(shadow, { recursive: true, force: true });
  }
});

test("a hypothetical new skill is not public by default", async () => {
  // Encodes the intent directly: exposure is decided by membership in the
  // allowlist, never by absence from a deny set.
  setSkillExposure(["clemson-schedule-advising"]);
  const { isSkillExposed } = await import("../src/mcp-tools/skills.ts");
  assert.equal(isSkillExposed("some-future-private-skill"), false);
  assert.equal(isSkillExposed("clemson-schedule-advising"), true);
  resetSkillExposure();
});
