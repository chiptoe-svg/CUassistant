// Google Docs MCP tools — backed by gws (Clemson Google Workspace account).
// Read + routine text writes (create, append) are exposed (policy approval:
// none, audited); destructive edges (delete, share, overwrite whole body) are
// policy-gated (human_required) and unexposed.

import { appendDocText, createDoc, readDoc } from "../clemson-docs.js";
import { startMcpAudit, finishMcpAudit } from "./audit.js";
import { assertMcpOperation } from "./permissions.js";
import { registerTools } from "./server.js";
import { err, okJson, permissionErr, type McpToolDefinition } from "./types.js";

const readDocTool: McpToolDefinition = {
  operation: "docs.read",
  tool: {
    name: "read-doc",
    description:
      "Read a Google Doc's title and plain-text content by documentId. " +
      "Read-only. Returns concatenated paragraph/table text.",
    inputSchema: {
      type: "object" as const,
      properties: { documentId: { type: "string" } },
      required: ["documentId"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("docs.read");
    } catch (e) {
      return permissionErr(e);
    }
    const documentId = args.documentId as string | undefined;
    if (!documentId) return err("documentId required");
    const res = readDoc(documentId);
    if (res === null) return err("gws docs read failed (auth or id?).");
    return okJson(res);
  },
};

const createDocTool: McpToolDefinition = {
  operation: "docs.create",
  tool: {
    name: "create-doc",
    description:
      "Create a new, blank Google Doc with a title. Returns its documentId. " +
      "Non-destructive. Add content afterward with append-doc-text.",
    inputSchema: {
      type: "object" as const,
      properties: { title: { type: "string" } },
      required: ["title"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("docs.create");
    } catch (e) {
      return permissionErr(e);
    }
    const title = args.title as string | undefined;
    if (!title) return err("title required");
    const audit = startMcpAudit({
      operation: "docs.create",
      toolName: "create-doc",
      argsSummary: { title_length: title.length },
    });
    const res = createDoc(title);
    if (res === null || !res.documentId) {
      finishMcpAudit(audit, { result: "error", detail: "gws_create_failed" });
      return err("gws docs create failed.");
    }
    finishMcpAudit(audit, { result: "success", object_id: res.documentId });
    return okJson(res);
  },
};

const appendDocTextTool: McpToolDefinition = {
  operation: "docs.append",
  tool: {
    name: "append-doc-text",
    description:
      "Append plain text to the end of a Google Doc by documentId. Routine, " +
      "reversible (via doc version history). For rich formatting, edit in the " +
      "doc directly.",
    inputSchema: {
      type: "object" as const,
      properties: {
        documentId: { type: "string" },
        text: { type: "string" },
      },
      required: ["documentId", "text"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("docs.append");
    } catch (e) {
      return permissionErr(e);
    }
    const documentId = args.documentId as string | undefined;
    const text = args.text as string | undefined;
    if (!documentId || !text) return err("documentId and text required");
    const audit = startMcpAudit({
      operation: "docs.append",
      toolName: "append-doc-text",
      argsSummary: { documentId, text_length: text.length },
    });
    const okres = appendDocText(documentId, text);
    if (!okres) {
      finishMcpAudit(audit, { result: "error", detail: "gws_append_failed" });
      return err("gws docs append failed.");
    }
    finishMcpAudit(audit, { result: "success", object_id: documentId });
    return okJson({ appended: true });
  },
};

registerTools([readDocTool, createDocTool, appendDocTextTool]);
