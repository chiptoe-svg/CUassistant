import assert from "node:assert/strict";
import test from "node:test";

import { isOwnedIn, parseOwned } from "../src/mcp-tools/gws-owned.ts";

test("parseOwned reads {files} and a bare array, dropping idless entries", () => {
  const a = parseOwned(
    JSON.stringify({
      files: [
        { id: "S1", kind: "spreadsheet", title: "Budget", created_at: "t" },
        { id: "D1", kind: "document" },
        { kind: "document" }, // no id -> dropped
      ],
    }),
  );
  assert.deepEqual(
    a.map((f) => [f.id, f.kind]),
    [
      ["S1", "spreadsheet"],
      ["D1", "document"],
    ],
  );
  // bare array form + default kind
  const b = parseOwned(JSON.stringify([{ id: "X" }]));
  assert.equal(b[0].kind, "document");
});

test("parseOwned returns [] on garbage", () => {
  assert.deepEqual(parseOwned("not json"), []);
  assert.deepEqual(parseOwned("{}"), []);
});

test("isOwnedIn is exact-id membership, fail-closed", () => {
  const files = parseOwned(JSON.stringify({ files: [{ id: "OWN1" }] }));
  assert.equal(isOwnedIn(files, "OWN1"), true);
  assert.equal(isOwnedIn(files, "OTHER"), false);
  assert.equal(isOwnedIn(files, ""), false);
  assert.equal(isOwnedIn([], "OWN1"), false);
});
