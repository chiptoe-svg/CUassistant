// src/mcp-tools/clemson-schedule.ts
// Deterministic schedule-conflict tools backed by the per-term SQLite snapshot.
import {
  openScheduleDb,
  getMeetingsForCrns,
  findConflicts,
  type ConflictPair,
} from "../clemson-schedule-db.js";
import { assertMcpOperation } from "./permissions.js";
import { registerTools } from "./server.js";
import { err, okJson, permissionErr, type McpToolDefinition } from "./types.js";

const checkConflicts: McpToolDefinition = {
  operation: "clemson.check_schedule_conflicts",
  tool: {
    name: "check-schedule-conflicts",
    description:
      "Given a list of CRNs for a term, returns which pairs have time " +
      "conflicts (same day, overlapping minutes) and which are conflict-free. " +
      "Deterministic — reads the daily Banner snapshot, not live Banner. " +
      "Use CRNs from search-clemson-classes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        term: { type: "string", description: "Term code, e.g. 202608." },
        crns: {
          type: "array",
          items: { type: "string" },
          description: "CRNs to check, e.g. [\"80001\", \"80002\"].",
        },
      },
      required: ["term", "crns"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.check_schedule_conflicts");
    } catch (e) {
      return permissionErr(e);
    }
    const term = args.term as string | undefined;
    const crns = args.crns as string[] | undefined;
    if (!term || !Array.isArray(crns) || crns.length === 0)
      return err("term and a non-empty crns array are required");

    const db = openScheduleDb(term);
    if (!db)
      return err(
        `No snapshot available for term ${term}. Run the daily refresh or try again after 05:00.`,
      );
    try {
      const meetings = getMeetingsForCrns(db, term, crns);
      const conflicts = findConflicts(meetings);
      const conflictingCrns = new Set(
        conflicts.flatMap((c) => [c.crn_a, c.crn_b]),
      );
      return okJson({
        term,
        crns_checked: crns,
        conflict_free: crns.filter((c) => !conflictingCrns.has(c)),
        conflicts,
        has_conflicts: conflicts.length > 0,
      });
    } finally {
      db.close();
    }
  },
};

const findConflictFree: McpToolDefinition = {
  operation: "clemson.find_conflict_free_schedule",
  tool: {
    name: "find-conflict-free-schedule",
    description:
      "Given fixed CRNs (already committed) and candidate CRNs (options to " +
      "consider), returns which candidates can be added without time conflicts. " +
      "Each candidate is checked against every fixed CRN and against every " +
      "other candidate. Returns conflict_free candidates and details of any " +
      "conflicts for the rest. Reads the daily Banner snapshot.",
    inputSchema: {
      type: "object" as const,
      properties: {
        term: { type: "string", description: "Term code, e.g. 202608." },
        fixed_crns: {
          type: "array",
          items: { type: "string" },
          description: "CRNs already locked in the schedule.",
        },
        candidate_crns: {
          type: "array",
          items: { type: "string" },
          description: "CRNs to evaluate.",
        },
      },
      required: ["term", "fixed_crns", "candidate_crns"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.find_conflict_free_schedule");
    } catch (e) {
      return permissionErr(e);
    }
    const term = args.term as string | undefined;
    const fixedCrns = args.fixed_crns as string[] | undefined;
    const candidateCrns = args.candidate_crns as string[] | undefined;
    if (
      !term ||
      !Array.isArray(fixedCrns) ||
      !Array.isArray(candidateCrns) ||
      candidateCrns.length === 0
    )
      return err("term, fixed_crns, and a non-empty candidate_crns array are required");

    const db = openScheduleDb(term);
    if (!db)
      return err(
        `No snapshot available for term ${term}. Run the daily refresh or try again after 05:00.`,
      );
    try {
      const allCrns = [...new Set([...fixedCrns, ...candidateCrns])];
      const meetings = getMeetingsForCrns(db, term, allCrns);
      const allConflicts = findConflicts(meetings);

      const fixedSet = new Set(fixedCrns);

      type CandidateResult = {
        crn: string;
        conflict_free: boolean;
        conflicts: ConflictPair[];
      };

      const results: CandidateResult[] = candidateCrns.map((crn) => {
        const conflicts = allConflicts.filter(
          (c) =>
            (c.crn_a === crn || c.crn_b === crn) &&
            (c.crn_a !== crn || fixedSet.has(c.crn_b) || candidateCrns.includes(c.crn_b)) &&
            (c.crn_b !== crn || fixedSet.has(c.crn_a) || candidateCrns.includes(c.crn_a)),
        );
        return { crn, conflict_free: conflicts.length === 0, conflicts };
      });

      return okJson({
        term,
        fixed_crns: fixedCrns,
        candidates: results,
        conflict_free: results.filter((r) => r.conflict_free).map((r) => r.crn),
      });
    } finally {
      db.close();
    }
  },
};

registerTools([checkConflicts, findConflictFree]);
