import assert from "node:assert/strict";
import test from "node:test";
import { checkBearer } from "../src/mcp-tools/server.ts";

test("checkBearer: open when no token configured", () => {
  assert.equal(checkBearer(undefined, ""), true);
  assert.equal(checkBearer("Bearer anything", ""), true);
});
test("checkBearer: enforced when token configured", () => {
  assert.equal(checkBearer("Bearer s3cret", "s3cret"), true);
  assert.equal(checkBearer("Bearer wrong", "s3cret"), false);
  assert.equal(checkBearer(undefined, "s3cret"), false);
  assert.equal(checkBearer("s3cret", "s3cret"), false);
});
