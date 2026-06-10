// Google Sheets MCP tools — backed by gws (Clemson Google Workspace account).
// Reads + routine value writes are exposed (policy approval: none, audited);
// destructive/structural edits are policy-gated (human_required) and unexposed.

import {
  appendSheetRows,
  createSpreadsheet,
  getSpreadsheetInfo,
  readSheetRange,
  updateSheetRange,
} from "../clemson-sheets.js";
import { startMcpAudit, finishMcpAudit } from "./audit.js";
import { registerOwnedFile } from "./gws-owned.js";
import { assertMcpOperation } from "./permissions.js";
import { registerTools } from "./server.js";
import { err, okJson, permissionErr, type McpToolDefinition } from "./types.js";

function asGrid(v: unknown): string[][] {
  if (!Array.isArray(v)) return [];
  return v.map((row) =>
    Array.isArray(row) ? row.map((c) => String(c ?? "")) : [],
  );
}

const readSheetRangeTool: McpToolDefinition = {
  operation: "sheets.read",
  tool: {
    name: "read-sheet-range",
    description:
      "Read a range of cells from a Google Sheet. Read-only. Give the " +
      "spreadsheetId and an A1 range (e.g. 'Sheet1!A1:D10' or 'Sheet1'). " +
      "Returns a 2-D array of cell values.",
    inputSchema: {
      type: "object" as const,
      properties: {
        spreadsheetId: { type: "string" },
        range: { type: "string", description: "A1 range, e.g. Sheet1!A1:D10" },
      },
      required: ["spreadsheetId", "range"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("sheets.read");
    } catch (e) {
      return permissionErr(e);
    }
    const spreadsheetId = args.spreadsheetId as string | undefined;
    const range = args.range as string | undefined;
    if (!spreadsheetId || !range)
      return err("spreadsheetId and range required");
    const res = readSheetRange(spreadsheetId, range);
    if (res === null) return err("gws sheets read failed (auth or id?).");
    return okJson(res);
  },
};

const getSpreadsheetInfoTool: McpToolDefinition = {
  operation: "sheets.info",
  tool: {
    name: "get-spreadsheet-info",
    description:
      "Get a spreadsheet's title and tab (sheet) names/ids. Read-only. Use " +
      "this to discover tab names before reading or writing a range.",
    inputSchema: {
      type: "object" as const,
      properties: { spreadsheetId: { type: "string" } },
      required: ["spreadsheetId"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("sheets.info");
    } catch (e) {
      return permissionErr(e);
    }
    const spreadsheetId = args.spreadsheetId as string | undefined;
    if (!spreadsheetId) return err("spreadsheetId required");
    const res = getSpreadsheetInfo(spreadsheetId);
    if (res === null) return err("gws sheets info failed (auth or id?).");
    return okJson(res);
  },
};

const createSpreadsheetTool: McpToolDefinition = {
  operation: "sheets.create",
  tool: {
    name: "create-spreadsheet",
    description:
      "Create a new Google Spreadsheet with a title. Returns its " +
      "spreadsheetId. The agent may then edit THIS sheet (and any it created); " +
      "update/append are restricted to agent-created files.",
    inputSchema: {
      type: "object" as const,
      properties: { title: { type: "string" } },
      required: ["title"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("sheets.create");
    } catch (e) {
      return permissionErr(e);
    }
    const title = args.title as string | undefined;
    if (!title) return err("title required");
    const audit = startMcpAudit({
      operation: "sheets.create",
      toolName: "create-spreadsheet",
      argsSummary: { title_length: title.length },
    });
    const res = createSpreadsheet(title);
    if (res === null || !res.spreadsheetId) {
      finishMcpAudit(audit, { result: "error", detail: "gws_create_failed" });
      return err("gws sheets create failed.");
    }
    registerOwnedFile(res.spreadsheetId, "spreadsheet", title);
    finishMcpAudit(audit, { result: "success", object_id: res.spreadsheetId });
    return okJson(res);
  },
};

const updateSheetRangeTool: McpToolDefinition = {
  operation: "sheets.update",
  tool: {
    name: "update-sheet-range",
    description:
      "Write values into a cell range (overwrites those cells only). Give " +
      "spreadsheetId, an A1 range, and a 2-D array of values. valueInputOption " +
      "USER_ENTERED (default) lets formula strings like '=SUM(A1:A9)' stay live; " +
      "RAW writes them literally. Reversible via Sheet version history.",
    inputSchema: {
      type: "object" as const,
      properties: {
        spreadsheetId: { type: "string" },
        range: { type: "string" },
        values: {
          type: "array",
          items: { type: "array", items: {} },
          description: "2-D array of cell values (rows of cells).",
        },
        valueInputOption: { type: "string", enum: ["USER_ENTERED", "RAW"] },
      },
      required: ["spreadsheetId", "range", "values"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("sheets.update", { input: args });
    } catch (e) {
      return permissionErr(e);
    }
    const spreadsheetId = args.spreadsheetId as string | undefined;
    const range = args.range as string | undefined;
    if (!spreadsheetId || !range)
      return err("spreadsheetId and range required");
    const grid = asGrid(args.values);
    const vio =
      args.valueInputOption === "RAW" ? "RAW" : ("USER_ENTERED" as const);
    const audit = startMcpAudit({
      operation: "sheets.update",
      toolName: "update-sheet-range",
      argsSummary: { spreadsheetId, range, rows: grid.length },
    });
    const okres = updateSheetRange(spreadsheetId, range, grid, vio);
    if (!okres) {
      finishMcpAudit(audit, { result: "error", detail: "gws_update_failed" });
      return err("gws sheets update failed.");
    }
    finishMcpAudit(audit, { result: "success", object_id: spreadsheetId });
    return okJson({ updated: true, range });
  },
};

const appendSheetRowsTool: McpToolDefinition = {
  operation: "sheets.append",
  tool: {
    name: "append-sheet-rows",
    description:
      "Append rows after the existing data on a specific tab. Give " +
      "spreadsheetId, a `range` selecting the tab (a tab name like " +
      "'Submissions', or an A1 anchor like 'Submissions!A1'), and a 2-D array " +
      "of rows. Non-destructive — inserts new rows below existing content. Use " +
      "get-spreadsheet-info to discover tab names.",
    inputSchema: {
      type: "object" as const,
      properties: {
        spreadsheetId: { type: "string" },
        range: {
          type: "string",
          description:
            "Tab name or A1 anchor, e.g. 'Submissions' or 'Sheet1!A1'.",
        },
        values: { type: "array", items: { type: "array", items: {} } },
      },
      required: ["spreadsheetId", "range", "values"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("sheets.append", { input: args });
    } catch (e) {
      return permissionErr(e);
    }
    const spreadsheetId = args.spreadsheetId as string | undefined;
    const range = args.range as string | undefined;
    if (!spreadsheetId || !range)
      return err("spreadsheetId and range required");
    const grid = asGrid(args.values);
    if (grid.length === 0) return err("values must be a non-empty 2-D array");
    const audit = startMcpAudit({
      operation: "sheets.append",
      toolName: "append-sheet-rows",
      argsSummary: { spreadsheetId, range, rows: grid.length },
    });
    const okres = appendSheetRows(spreadsheetId, range, grid);
    if (!okres) {
      finishMcpAudit(audit, { result: "error", detail: "gws_append_failed" });
      return err("gws sheets append failed.");
    }
    finishMcpAudit(audit, { result: "success", object_id: spreadsheetId });
    return okJson({ appended: grid.length });
  },
};

registerTools([
  readSheetRangeTool,
  getSpreadsheetInfoTool,
  createSpreadsheetTool,
  updateSheetRangeTool,
  appendSheetRowsTool,
]);
