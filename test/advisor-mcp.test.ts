import assert from "node:assert/strict";
import test from "node:test";

import { advisorMcpServers } from "../src/advisor-mcp.ts";

test("exactly the three intended servers are configured", () => {
  const servers = advisorMcpServers();
  assert.deepEqual(Object.keys(servers).sort(), [
    "cu_catalog",
    "cu_public",
    "gc_curriculum_wiki",
  ]);
});

// 8765 carries send-outlook-mail, send-gmail, and calendar writes. Pi receives
// an explicit tool array, so a server that is not configured contributes no
// tools — but a typo in a URL could still point at it.
test("the credentialed server is never configured", () => {
  const json = JSON.stringify(advisorMcpServers());
  assert.doesNotMatch(json, /8765/, "8765 must never appear");
});

test("the public and catalog servers carry no auth header", () => {
  const servers = advisorMcpServers();
  assert.equal(servers.cu_public!.headers, undefined);
  assert.equal(servers.cu_catalog!.headers, undefined);
});

// The curriculum wiki returns 401 without a token. A missing token must be
// visible as a missing header, not silently sent as "Bearer undefined".
test("the wiki carries a bearer header only when a token is configured", () => {
  const servers = advisorMcpServers();
  const wiki = servers.gc_curriculum_wiki!;
  if (process.env.ADVISOR_MCP_WIKI_TOKEN) {
    assert.match(wiki.headers!.Authorization!, /^Bearer .+/);
  } else {
    assert.equal(wiki.headers, undefined);
  }
});
