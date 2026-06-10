// Registry of Google files (Sheets/Docs) this agent created. Writes are
// restricted to files in this registry (the "write-own" half of read-any/
// write-own): create-doc / create-spreadsheet register the new file's id here,
// and the write tools' `own_created_file_only` policy constraint refuses any
// target id that isn't listed. Reads are unrestricted. The escape hatch is
// `npm run gws:grant` (add a specific pre-existing file id by hand).

import fs from "fs";
import path from "path";

import { STATE_DIR } from "../config.js";

export type OwnedKind = "spreadsheet" | "document";

export interface OwnedFile {
  id: string;
  kind: OwnedKind;
  title?: string;
  created_at: string;
}

const REGISTRY_PATH = (): string =>
  path.join(STATE_DIR, "gws-created-files.json");

/** Parse a registry document, dropping entries without a string id. */
export function parseOwned(raw: string): OwnedFile[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : ((parsed as { files?: unknown[] })?.files ?? []);
  if (!Array.isArray(list)) return [];
  return list
    .filter(
      (f): f is Partial<OwnedFile> =>
        !!f && typeof (f as OwnedFile).id === "string",
    )
    .map((f) => ({
      id: String(f.id),
      kind: f.kind === "spreadsheet" ? "spreadsheet" : "document",
      title: typeof f.title === "string" ? f.title : undefined,
      created_at: typeof f.created_at === "string" ? f.created_at : "",
    }));
}

/** Pure membership test (testable without disk). */
export function isOwnedIn(files: OwnedFile[], id: string): boolean {
  return id.length > 0 && files.some((f) => f.id === id);
}

export function loadOwned(): OwnedFile[] {
  try {
    return parseOwned(fs.readFileSync(REGISTRY_PATH(), "utf-8"));
  } catch {
    return [];
  }
}

function saveOwned(files: OwnedFile[]): void {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(REGISTRY_PATH(), JSON.stringify({ files }, null, 2) + "\n", {
    mode: 0o600,
  });
  try {
    fs.chmodSync(REGISTRY_PATH(), 0o600);
  } catch {
    /* best effort */
  }
}

/** Whether this agent created (or was granted) write access to `id`. */
export function isOwnedFile(id: string): boolean {
  return isOwnedIn(loadOwned(), id);
}

/** Record a newly-created (or hand-granted) file as writable. Idempotent. */
export function registerOwnedFile(
  id: string,
  kind: OwnedKind,
  title?: string,
): void {
  if (!id) return;
  const files = loadOwned();
  if (files.some((f) => f.id === id)) return;
  files.push({ id, kind, title, created_at: new Date().toISOString() });
  saveOwned(files);
}

export function listOwnedFiles(): OwnedFile[] {
  return loadOwned();
}
