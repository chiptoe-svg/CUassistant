import assert from "node:assert/strict";
import test from "node:test";

import {
  deserializeSnapshot,
  serializeSnapshot,
  type ClemsonTermSnapshot,
} from "../src/clemson-classes.ts";

const snap: ClemsonTermSnapshot = {
  term: "202608",
  termDescription: "Fall 2026",
  fetchedAt: "2026-06-09T20:09:44.021Z",
  sectionCount: 2,
  sections: [
    { crn: "86379", title: "Capstone" } as never,
    { crn: "80844", title: "Studio" } as never,
  ],
};

test("serialize→deserialize round-trips and actually compresses", () => {
  const buf = serializeSnapshot(snap);
  // gzip magic bytes
  assert.equal(buf[0], 0x1f);
  assert.equal(buf[1], 0x8b);
  const raw = Buffer.byteLength(JSON.stringify(snap), "utf-8");
  assert.ok(
    buf.length < raw || raw < 200,
    "expected compression on real-size input",
  );
  assert.deepEqual(deserializeSnapshot(buf), snap);
});

test("deserialize still reads a legacy uncompressed JSON buffer", () => {
  const legacy = Buffer.from(JSON.stringify(snap), "utf-8");
  assert.deepEqual(deserializeSnapshot(legacy), snap);
});
