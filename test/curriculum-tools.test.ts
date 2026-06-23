import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { listGcCatalogYears, getGcProgramPlan } from "../src/gc-curriculum.ts";
import { GC_ADVISOR_DB } from "../src/config.ts";
import { listGcCatalogYears as listLive } from "../src/gc-curriculum.ts";

test("listGcCatalogYears calls the runner with ['years'] and parses JSON", async () => {
  const run = async (args: string[]) => {
    assert.deepEqual(args, ["years"]);
    return JSON.stringify(["2026-2027", "2025-2026"]);
  };
  const years = await listGcCatalogYears(run);
  assert.deepEqual(years, ["2026-2027", "2025-2026"]);
});

test("getGcProgramPlan passes year+name and parses the plan JSON", async () => {
  const run = async (args: string[]) => {
    assert.deepEqual(args, [
      "program-plan", "--year", "2026-2027", "--name", "Graphic Communications, BS",
    ]);
    return JSON.stringify({ total_credits: 120, groups: [] });
  };
  const plan = await getGcProgramPlan("2026-2027", "Graphic Communications, BS", run);
  assert.equal((plan as { total_credits: number }).total_credits, 120);
});

test("listGcCatalogYears against the real gc_advisor DB", { skip: !fs.existsSync(GC_ADVISOR_DB) }, async () => {
  const years = await listLive();
  assert.ok(Array.isArray(years) && years.length > 0);
  assert.ok(years.every((y) => /^\d{4}-\d{4}$/.test(y)));
});
