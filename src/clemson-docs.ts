// Google Docs host functions via the `gws` CLI (the Clemson Google Workspace
// account). Mirrors src/gmail.ts through src/gws-cli.ts. Reads + routine text
// writes (create, append) only; destructive edges (delete, share, overwrite the
// whole body) are gated at the policy boundary (approval: human_required) and
// not implemented here.

import { log } from "./log.js";
import { gwsResponseError, runGws } from "./gws-cli.js";

/** Walk a Docs document body into plain text (paragraphs + table cells). */
export function parseDocText(json: string): string {
  const d = JSON.parse(json) as { body?: { content?: unknown[] } };
  const out: string[] = [];
  const walk = (els: unknown[] | undefined): void => {
    for (const raw of els ?? []) {
      const el = raw as {
        paragraph?: { elements?: Array<{ textRun?: { content?: string } }> };
        table?: {
          tableRows?: Array<{ tableCells?: Array<{ content?: unknown[] }> }>;
        };
      };
      for (const pe of el.paragraph?.elements ?? []) {
        if (typeof pe.textRun?.content === "string")
          out.push(pe.textRun.content);
      }
      for (const row of el.table?.tableRows ?? []) {
        for (const cell of row.tableCells ?? []) walk(cell.content);
      }
    }
  };
  walk(d.body?.content);
  return out.join("");
}

export interface CreatedDoc {
  documentId: string;
  title: string;
}

export function parseCreatedDoc(json: string): CreatedDoc {
  const d = JSON.parse(json) as { documentId?: string; title?: string };
  return { documentId: d.documentId ?? "", title: d.title ?? "" };
}

function err(out: string | null, what: string): string | null {
  if (out === null) return "gws unavailable";
  const e = gwsResponseError(out);
  if (e) log.warn(`gws docs ${what} error`, { error: e });
  return e;
}

export interface DocContent {
  documentId: string;
  title: string;
  text: string;
}

/** Read a document's title + plain text. */
export function readDoc(documentId: string): DocContent | null {
  const out = runGws([
    "docs",
    "documents",
    "get",
    "--params",
    JSON.stringify({ documentId }),
    "--format",
    "json",
  ]);
  if (err(out, "read")) return null;
  try {
    const d = JSON.parse(out as string) as {
      documentId?: string;
      title?: string;
    };
    return {
      documentId: d.documentId ?? documentId,
      title: d.title ?? "",
      text: parseDocText(out as string),
    };
  } catch {
    return null;
  }
}

/** Create a blank document with a title (non-destructive). */
export function createDoc(title: string): CreatedDoc | null {
  const out = runGws([
    "docs",
    "documents",
    "create",
    "--params",
    JSON.stringify({ title }),
    "--format",
    "json",
  ]);
  if (err(out, "create")) return null;
  try {
    return parseCreatedDoc(out as string);
  } catch {
    return null;
  }
}

/** Append plain text to the end of a document (routine, reversible). */
export function appendDocText(documentId: string, text: string): boolean {
  const out = runGws([
    "docs",
    "+write",
    "--document",
    documentId,
    "--text",
    text,
    "--format",
    "json",
  ]);
  return out !== null && gwsResponseError(out) === null;
}
