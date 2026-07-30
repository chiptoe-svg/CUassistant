import assert from "node:assert/strict";
import test from "node:test";

import {
  checkSystemHealth,
  createHealthTool,
  type ServerHealth,
  type SystemHealth,
} from "../src/advisor-health.ts";
import type { McpServerConfig } from "../src/advisor-mcp.ts";

const SERVERS: Record<string, McpServerConfig> = {
  cu_public: { url: "http://127.0.0.1:8766/" },
  cu_catalog: { url: "http://127.0.0.1:8767/" },
  gc_alumni: { url: "http://127.0.0.1:8012/mcp" },
};

const FIXED_NOW = () => "2026-07-30T00:00:00.000Z";

test("healthy when every server answers, sorted by name, with a stable timestamp", async () => {
  const probe = async (name: string): Promise<ServerHealth> => ({
    name,
    reachable: true,
    toolCount: name === "gc_alumni" ? 6 : 3,
    latencyMs: 12,
  });
  const health = await checkSystemHealth(SERVERS, probe, FIXED_NOW);
  assert.equal(health.healthy, true);
  assert.equal(health.checkedAt, "2026-07-30T00:00:00.000Z");
  assert.deepEqual(
    health.servers.map((s) => s.name),
    ["cu_catalog", "cu_public", "gc_alumni"],
  );
  assert.equal(health.servers.find((s) => s.name === "gc_alumni")!.toolCount, 6);
});

test("unhealthy when any single server is unreachable, and that server carries the error", async () => {
  const probe = async (name: string): Promise<ServerHealth> =>
    name === "gc_alumni"
      ? { name, reachable: false, latencyMs: 5000, error: "timed out after 5000ms" }
      : { name, reachable: true, toolCount: 3, latencyMs: 10 };
  const health = await checkSystemHealth(SERVERS, probe, FIXED_NOW);
  assert.equal(health.healthy, false);
  const alumni = health.servers.find((s) => s.name === "gc_alumni")!;
  assert.equal(alumni.reachable, false);
  assert.match(String(alumni.error), /timed out/);
  // The others still report reachable — one failure doesn't mask the rest.
  assert.equal(health.servers.filter((s) => s.reachable).length, 2);
});

test("check-system-health tool returns the health JSON as text and details", async () => {
  const fake: SystemHealth = {
    healthy: true,
    checkedAt: "2026-07-30T00:00:00.000Z",
    servers: [{ name: "cu_public", reachable: true, toolCount: 3, latencyMs: 8 }],
  };
  const tool = createHealthTool(async () => fake);
  assert.equal(tool.name, "check-system-health");
  const res = await tool.execute("call-1", {});
  const text = (res.content[0] as { text: string }).text;
  assert.deepEqual(JSON.parse(text), fake);
  assert.deepEqual((res as { details: SystemHealth }).details, fake);
});
