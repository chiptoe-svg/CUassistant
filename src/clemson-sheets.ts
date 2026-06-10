// Google Sheets host functions via the `gws` CLI (the Clemson Google Workspace
// account). Mirrors src/gmail.ts's execFileSync + buildChildEnv pattern through
// the shared runner in src/gws-cli.ts. Reads + routine value writes only;
// destructive/structural edits (delete spreadsheet, delete tab, share) are gated
// at the policy boundary (policy/action-policy.yaml, approval: human_required)
// and intentionally NOT implemented here.

import { log } from "./log.js";
import { gwsResponseError, runGws } from "./gws-cli.js";

export interface SheetValues {
  range: string;
  values: string[][];
}

/** Parse a Sheets `values.get` / `+read` response into a 2-D string grid. */
export function parseSheetValues(json: string): SheetValues {
  const d = JSON.parse(json) as { range?: string; values?: unknown[][] };
  return {
    range: typeof d.range === "string" ? d.range : "",
    values: Array.isArray(d.values)
      ? d.values.map((row) =>
          Array.isArray(row) ? row.map((c) => String(c ?? "")) : [],
        )
      : [],
  };
}

export interface SpreadsheetInfo {
  title: string;
  tabs: Array<{ title: string; sheetId: number }>;
}

/** Parse a Sheets `spreadsheets.get` response into title + tab list. */
export function parseSpreadsheetInfo(json: string): SpreadsheetInfo {
  const d = JSON.parse(json) as {
    properties?: { title?: string };
    sheets?: Array<{ properties?: { title?: string; sheetId?: number } }>;
  };
  return {
    title: d.properties?.title ?? "",
    tabs: (d.sheets ?? []).map((s) => ({
      title: s.properties?.title ?? "",
      sheetId: Number(s.properties?.sheetId ?? 0),
    })),
  };
}

function ok(out: string | null, what: string): boolean {
  if (out === null) return false;
  const e = gwsResponseError(out);
  if (e) {
    log.warn(`gws sheets ${what} error`, { error: e });
    return false;
  }
  return true;
}

/** Read a range, e.g. "Sheet1!A1:D10". */
export function readSheetRange(
  spreadsheetId: string,
  range: string,
): SheetValues | null {
  const out = runGws([
    "sheets",
    "+read",
    "--spreadsheet",
    spreadsheetId,
    "--range",
    range,
    "--format",
    "json",
  ]);
  if (!ok(out, "read")) return null;
  try {
    return parseSheetValues(out as string);
  } catch {
    return null;
  }
}

/** Spreadsheet title + tab names. */
export function getSpreadsheetInfo(
  spreadsheetId: string,
): SpreadsheetInfo | null {
  const out = runGws([
    "sheets",
    "spreadsheets",
    "get",
    "--params",
    JSON.stringify({
      spreadsheetId,
      fields: "properties.title,sheets.properties(sheetId,title,index)",
    }),
    "--format",
    "json",
  ]);
  if (!ok(out, "info")) return null;
  try {
    return parseSpreadsheetInfo(out as string);
  } catch {
    return null;
  }
}

/** Set values in a range (USER_ENTERED keeps formulas live; RAW writes literal). */
export function updateSheetRange(
  spreadsheetId: string,
  range: string,
  values: string[][],
  valueInputOption: "USER_ENTERED" | "RAW" = "USER_ENTERED",
): boolean {
  // gws splits URL/query params (--params) from the request body (--json). The
  // ValueRange body (`values`) MUST go in --json; in --params it 400s as an
  // unbindable query parameter.
  const out = runGws([
    "sheets",
    "spreadsheets",
    "values",
    "update",
    "--params",
    JSON.stringify({ spreadsheetId, range, valueInputOption }),
    "--json",
    JSON.stringify({ values }),
    "--format",
    "json",
  ]);
  return ok(out, "update");
}

/** Append rows after the existing table (a routine, reversible write). */
export function appendSheetRows(
  spreadsheetId: string,
  values: string[][],
): boolean {
  const out = runGws([
    "sheets",
    "+append",
    "--spreadsheet",
    spreadsheetId,
    "--json-values",
    JSON.stringify(values),
    "--format",
    "json",
  ]);
  return ok(out, "append");
}
