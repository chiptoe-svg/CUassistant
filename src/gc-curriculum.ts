// GC curriculum data layer — bridges to the gc_advisor project's query.py CLI
// (JSON in/out) so gc_advisor's CatalogAccess stays the single source of truth.
// Read-only; the curriculum DB holds public catalog data.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  GC_ADVISOR_PYTHON,
  GC_ADVISOR_QUERY,
  GC_ADVISOR_DB,
} from "./config.js";

const execFileAsync = promisify(execFile);

/** Runs gc_advisor's query.py with the given subcommand args, returns stdout. */
export type QueryRunner = (args: string[]) => Promise<string>;

const defaultRunner: QueryRunner = async (args) => {
  const { stdout } = await execFileAsync(
    GC_ADVISOR_PYTHON,
    [GC_ADVISOR_QUERY, "--db", GC_ADVISOR_DB, ...args],
    { maxBuffer: 8 * 1024 * 1024, timeout: 15_000 },
  );
  return stdout;
};

export async function listGcCatalogYears(
  run: QueryRunner = defaultRunner,
): Promise<string[]> {
  const out = await run(["years"]);
  return JSON.parse(out) as string[];
}

export async function getGcProgramPlan(
  year: string,
  name: string,
  run: QueryRunner = defaultRunner,
): Promise<unknown> {
  const out = await run(["program-plan", "--year", year, "--name", name]);
  return JSON.parse(out);
}
