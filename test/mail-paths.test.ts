import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFolderPaths,
  isBlockedMailFolder,
  isUnderAllowedPrefix,
  normalizeMailPath,
} from "../src/mail-paths.ts";

test("normalizeMailPath strips slashes and collapses separators", () => {
  assert.equal(normalizeMailPath("/sorted/News/"), "sorted/News");
  assert.equal(normalizeMailPath("sorted//news"), "sorted/news");
  assert.equal(normalizeMailPath("  /a/ "), "a");
  assert.equal(normalizeMailPath(""), "");
  assert.equal(normalizeMailPath("/"), "");
});

test("isUnderAllowedPrefix is segment-aware and case-insensitive", () => {
  assert.equal(isUnderAllowedPrefix("sorted/news", ["sorted"]), true);
  assert.equal(isUnderAllowedPrefix("sorted", ["sorted"]), true); // the subtree root itself
  assert.equal(isUnderAllowedPrefix("SORTED/News", ["sorted"]), true);
  assert.equal(isUnderAllowedPrefix("sorted/a/b", ["sorted/a"]), true);
  // not under
  assert.equal(isUnderAllowedPrefix("sortedother", ["sorted"]), false); // not a segment boundary
  assert.equal(isUnderAllowedPrefix("other/sorted", ["sorted"]), false); // prefix must be at the front
  assert.equal(isUnderAllowedPrefix("sorted/ab", ["sorted/a"]), false);
  // fail closed
  assert.equal(isUnderAllowedPrefix("sorted/news", []), false);
});

test("isBlockedMailFolder rejects system/destructive folders by segment", () => {
  assert.equal(isBlockedMailFolder("Deleted Items"), true);
  assert.equal(isBlockedMailFolder("Junk Email"), true);
  assert.equal(isBlockedMailFolder("trash"), true);
  assert.equal(isBlockedMailFolder("spam"), true);
  assert.equal(isBlockedMailFolder("sorted/Recoverable"), true);
  assert.equal(isBlockedMailFolder("sorted/Newsletters"), false);
});

test("buildFolderPaths joins displayNames along the parent chain", () => {
  const folders = [
    { id: "s", displayName: "Sorted", parentFolderId: "root" },
    { id: "n", displayName: "Newsletters", parentFolderId: "s" },
    { id: "d", displayName: "Deep", parentFolderId: "n" },
    { id: "i", displayName: "Inbox", parentFolderId: "root" },
  ];
  const map = Object.fromEntries(
    buildFolderPaths(folders).map((f) => [f.id, f.path]),
  );
  assert.equal(map.s, "Sorted");
  assert.equal(map.n, "Sorted/Newsletters");
  assert.equal(map.d, "Sorted/Newsletters/Deep");
  assert.equal(map.i, "Inbox");
});
