import assert from "node:assert/strict";
import test from "node:test";

import { auditContext, withConsumer } from "../src/mcp-tools/audit.ts";

test("withConsumer stamps the ALS consumer id inside a run scope", () => {
  auditContext.run({ consumerId: "agentX" }, () => {
    const row = withConsumer({ a: 1 });
    assert.equal(row.mcp_consumer_id, "agentX");
    assert.equal(row.a, 1);
  });
});

test("withConsumer yields null consumer id outside any run scope", () => {
  assert.equal(withConsumer({}).mcp_consumer_id, null);
});

test("auditContext isolates concurrent run scopes", async () => {
  const seen: Array<string | null> = [];
  await Promise.all([
    auditContext.run({ consumerId: "one" }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      seen.push((withConsumer({}).mcp_consumer_id as string) ?? null);
    }),
    auditContext.run({ consumerId: "two" }, async () => {
      seen.push((withConsumer({}).mcp_consumer_id as string) ?? null);
    }),
  ]);
  assert.deepEqual(seen.sort(), ["one", "two"]);
});
