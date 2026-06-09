// Pure path logic shared by the MS365 (folder) and Gmail (label) move paths.
// Destinations are `/`-separated paths; the allow-list is a set of path
// prefixes; matching is segment-aware and case-insensitive.

/** Trim, drop leading/trailing slashes, collapse repeats. "" means root. */
export function normalizeMailPath(p: string): string {
  return p
    .trim()
    .split("/")
    .filter((seg) => seg.trim() !== "")
    .map((seg) => seg.trim())
    .join("/");
}

function segments(p: string): string[] {
  const n = normalizeMailPath(p).toLowerCase();
  return n === "" ? [] : n.split("/");
}

/**
 * True if `path` is at or under one of `prefixes`, matched on whole segments
 * (so "sorted" admits "sorted" and "sorted/x" but not "sortedother"). An empty
 * prefix list fails closed.
 */
export function isUnderAllowedPrefix(
  path: string,
  prefixes: string[],
): boolean {
  const p = segments(path);
  if (p.length === 0) return false;
  return prefixes.some((prefix) => {
    const pre = segments(prefix);
    if (pre.length === 0) return false;
    if (pre.length > p.length) return false;
    return pre.every((seg, i) => seg === p[i]);
  });
}

// System / destructive folders never valid as a move destination, regardless of
// the allow-list (matched per segment, case-insensitive).
const BLOCKED_SEGMENTS = new Set([
  "trash",
  "deleted",
  "deleted items",
  "deleteditems",
  "junk",
  "junk email",
  "junkemail",
  "spam",
  "recoverable",
  "recoverable items",
  "recoverableitems",
]);

/** True if any path segment is a blocked system/destructive folder name. */
export function isBlockedMailFolder(path: string): boolean {
  return segments(path).some((seg) => BLOCKED_SEGMENTS.has(seg));
}

export interface RawFolder {
  id: string;
  displayName: string;
  parentFolderId?: string;
}

/**
 * Flatten provider folder records to `{id, path}` by joining displayNames along
 * the parentFolderId chain. A parent absent from the set is treated as root
 * (so top-level folders get a single-segment path). Depth-guarded against cycles.
 */
export function buildFolderPaths(
  folders: RawFolder[],
): Array<{ id: string; path: string }> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  return folders.map((f) => {
    const parts: string[] = [];
    let cur: RawFolder | undefined = f;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      parts.unshift(cur.displayName);
      cur = cur.parentFolderId ? byId.get(cur.parentFolderId) : undefined;
    }
    return { id: f.id, path: parts.join("/") };
  });
}
