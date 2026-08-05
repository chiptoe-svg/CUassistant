import assert from "node:assert/strict";
import test from "node:test";

import {
  checkSystemHealth,
  createHealthTool,
  type ExtraProbe,
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

const OMLX_UP: ServerHealth = {
  name: "omlx",
  reachable: true,
  modelCount: 11,
  latencyMs: 4,
};

test("healthy when every server answers, sorted by name, with a stable timestamp", async () => {
  const probe = async (name: string): Promise<ServerHealth> => ({
    name,
    reachable: true,
    toolCount: name === "gc_alumni" ? 6 : 3,
    latencyMs: 12,
  });
  // extraProbes: [] keeps this test focused on MCP aggregation.
  const health = await checkSystemHealth(SERVERS, probe, FIXED_NOW, []);
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
  const health = await checkSystemHealth(SERVERS, probe, FIXED_NOW, []);
  assert.equal(health.healthy, false);
  const alumni = health.servers.find((s) => s.name === "gc_alumni")!;
  assert.equal(alumni.reachable, false);
  assert.match(String(alumni.error), /timed out/);
  // The others still report reachable — one failure doesn't mask the rest.
  assert.equal(health.servers.filter((s) => s.reachable).length, 2);
});

test("OMLX is included as its own server, sorted in, when its probe answers", async () => {
  const probe = async (name: string): Promise<ServerHealth> => ({
    name,
    reachable: true,
    toolCount: 3,
    latencyMs: 10,
  });
  const health = await checkSystemHealth(SERVERS, probe, FIXED_NOW, [
    async () => OMLX_UP,
  ]);
  assert.equal(health.healthy, true);
  assert.deepEqual(
    health.servers.map((s) => s.name),
    ["cu_catalog", "cu_public", "gc_alumni", "omlx"],
  );
  const omlx = health.servers.find((s) => s.name === "omlx")!;
  assert.equal(omlx.modelCount, 11);
});

test("OMLX down gates the overall health to false even when every MCP server is up", async () => {
  const probe = async (name: string): Promise<ServerHealth> => ({
    name,
    reachable: true,
    toolCount: 3,
    latencyMs: 10,
  });
  const omlxDown: ExtraProbe = async () => ({
    name: "omlx",
    reachable: false,
    latencyMs: 5000,
    error: "listening but no models loaded",
  });
  const health = await checkSystemHealth(SERVERS, probe, FIXED_NOW, [omlxDown]);
  assert.equal(health.healthy, false);
  const omlx = health.servers.find((s) => s.name === "omlx")!;
  assert.equal(omlx.reachable, false);
  assert.match(String(omlx.error), /no models loaded/);
  // MCP servers are unaffected — only OMLX flipped the overall flag.
  assert.equal(health.servers.filter((s) => s.reachable).length, 3);
});

test("Spark: its own `healthy` drives reachable; warnings surface without flipping it", async () => {
  const probe = async (name: string): Promise<ServerHealth> => ({
    name,
    reachable: true,
    toolCount: 3,
    latencyMs: 10,
  });
  const sparkUp: ExtraProbe = async () => ({
    name: "spark",
    reachable: true, // maps from body.healthy === true
    latencyMs: 1300,
    cached: false,
    warnings: ["mtp acceptance drifting"],
  });
  const health = await checkSystemHealth(SERVERS, probe, FIXED_NOW, [sparkUp]);
  // A non-critical warning does NOT flip the overall box red.
  assert.equal(health.healthy, true);
  const spark = health.servers.find((s) => s.name === "spark")!;
  assert.equal(spark.reachable, true);
  assert.deepEqual(spark.warnings, ["mtp acceptance drifting"]);
});

test("Spark down (its healthy=false) gates the overall health to false", async () => {
  const probe = async (name: string): Promise<ServerHealth> => ({
    name,
    reachable: true,
    toolCount: 3,
    latencyMs: 10,
  });
  const sparkDown: ExtraProbe = async () => ({
    name: "spark",
    reachable: false, // body.healthy !== true
    latencyMs: 42000,
    error: "spark reports unhealthy",
  });
  const health = await checkSystemHealth(SERVERS, probe, FIXED_NOW, [sparkDown]);
  assert.equal(health.healthy, false);
  const spark = health.servers.find((s) => s.name === "spark")!;
  assert.equal(spark.reachable, false);
  assert.match(String(spark.error), /unhealthy/);
  assert.equal(health.servers.filter((s) => s.reachable).length, 3);
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
