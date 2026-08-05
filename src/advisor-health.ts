// System health check for the advisor. Lets the agent (or an operator) confirm
// the assistant is up and every connected MCP data source is reachable — a real
// connect + tools/list per server, not just a TCP ping, so a server that is
// listening but broken is reported as such. Read-only; touches no student data.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import { advisorMcpServers, type McpServerConfig } from "./advisor-mcp.js";
import {
  ADVISOR_OMLX_MODELS_URL,
  ADVISOR_SPARK_HEALTH_TOKEN,
  ADVISOR_SPARK_HEALTH_URL,
  ADVISOR_WHISPER_KEY,
} from "./config.js";

const HEALTH_TIMEOUT_MS = 5_000;
// Spark's /spark/health runs a generation probe that hangs until its OWN timeout
// when the engine is wedged — the endpoint is slowest exactly when something is
// wrong. A short ceiling would misreport "engine wedged" as "unreachable", so
// Spark gets a much longer one. Healthy responses are ~1.3s (cached: sub-ms).
const SPARK_TIMEOUT_MS = 60_000;

export interface ServerHealth {
  name: string;
  reachable: boolean;
  /** MCP servers report their tool count; OMLX reports modelCount instead. */
  toolCount?: number;
  modelCount?: number;
  latencyMs: number;
  error?: string;
  /** Spark: its /spark/health response can be a cached result (<=300s TTL). */
  cached?: boolean;
  cacheAgeSec?: number;
  /** Spark: non-critical issues that do NOT flip `reachable` (e.g. MTP drift). */
  warnings?: string[];
}

export interface SystemHealth {
  /** True when every configured server answered a tools/list. */
  healthy: boolean;
  checkedAt: string;
  servers: ServerHealth[];
}

/** Probe one server; injectable so tests need no network. */
export type ServerProbe = (
  name: string,
  cfg: McpServerConfig,
) => Promise<ServerHealth>;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      const t = setTimeout(
        () => reject(new Error(`timed out after ${ms}ms`)),
        ms,
      );
      t.unref?.();
    }),
  ]);
}

async function probeMcpServer(
  name: string,
  cfg: McpServerConfig,
): Promise<ServerHealth> {
  const t0 = Date.now();
  const client = new Client(
    { name: "advisor-health", version: "0" },
    { capabilities: {} },
  );
  try {
    const transport = new StreamableHTTPClientTransport(
      new URL(cfg.url),
      cfg.headers ? { requestInit: { headers: cfg.headers } } : undefined,
    );
    await withTimeout(client.connect(transport), HEALTH_TIMEOUT_MS);
    const tools = await withTimeout(client.listTools(), HEALTH_TIMEOUT_MS);
    return {
      name,
      reachable: true,
      toolCount: tools.tools.length,
      latencyMs: Date.now() - t0,
    };
  } catch (err) {
    return {
      name,
      reachable: false,
      latencyMs: Date.now() - t0,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
    };
  } finally {
    try {
      await client.close();
    } catch {
      /* ignore close errors — we already have the verdict */
    }
  }
}

/** A non-MCP HTTP dependency probe (OMLX, Spark); injectable so tests need no network. */
export type ExtraProbe = () => Promise<ServerHealth>;

/**
 * Probe the OMLX on-host inference server via GET /v1/models. Counts as reachable
 * only when it answers 200 AND reports >=1 loaded model — a server that is
 * listening but has no model loaded is broken for our purposes, mirroring the MCP
 * probe's "listening but broken is still broken" philosophy.
 */
async function probeOmlx(
  url: string = ADVISOR_OMLX_MODELS_URL,
  key: string = ADVISOR_WHISPER_KEY,
): Promise<ServerHealth> {
  const name = "omlx";
  const t0 = Date.now();
  try {
    const res = await withTimeout(
      fetch(url, key ? { headers: { Authorization: `Bearer ${key}` } } : {}),
      HEALTH_TIMEOUT_MS,
    );
    const latencyMs = Date.now() - t0;
    if (!res.ok) {
      return { name, reachable: false, latencyMs, error: `HTTP ${res.status}` };
    }
    const body = (await res.json()) as { data?: unknown[] };
    const modelCount = Array.isArray(body.data) ? body.data.length : 0;
    return {
      name,
      reachable: modelCount > 0,
      modelCount,
      latencyMs,
      error: modelCount > 0 ? undefined : "listening but no models loaded",
    };
  } catch (err) {
    return {
      name,
      reachable: false,
      latencyMs: Date.now() - t0,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
    };
  }
}

/**
 * Probe the DGX Spark inference gateway via GET /spark/health. The endpoint's own
 * JSON drives the verdict: `healthy` reflects Spark's critical checks only (that
 * becomes our `reachable`), while `warnings` are non-critical and surface without
 * flipping it. `cached`/`cacheAgeSec` note when the answer is a cached result
 * (Spark runs the real generation probe at most once per 300s). Uses a 60s
 * timeout — see SPARK_TIMEOUT_MS.
 */
async function probeSpark(
  url: string = ADVISOR_SPARK_HEALTH_URL,
  token: string = ADVISOR_SPARK_HEALTH_TOKEN,
): Promise<ServerHealth> {
  const name = "spark";
  const t0 = Date.now();
  try {
    const res = await withTimeout(
      fetch(url, token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      SPARK_TIMEOUT_MS,
    );
    const latencyMs = Date.now() - t0;
    if (!res.ok) {
      return { name, reachable: false, latencyMs, error: `HTTP ${res.status}` };
    }
    const body = (await res.json()) as {
      healthy?: boolean;
      cached?: boolean;
      cacheAgeSec?: number;
      warnings?: unknown;
    };
    const warnings = Array.isArray(body.warnings)
      ? body.warnings.map(String)
      : undefined;
    return {
      name,
      reachable: body.healthy === true,
      latencyMs,
      cached: typeof body.cached === "boolean" ? body.cached : undefined,
      cacheAgeSec:
        typeof body.cacheAgeSec === "number" ? body.cacheAgeSec : undefined,
      warnings: warnings && warnings.length ? warnings : undefined,
      error: body.healthy === true ? undefined : "spark reports unhealthy",
    };
  } catch (err) {
    return {
      name,
      reachable: false,
      latencyMs: Date.now() - t0,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
    };
  }
}

/**
 * Non-MCP dependency probes, each gated behind its own credential: OMLX behind
 * ADVISOR_WHISPER_KEY (same server as local Whisper), Spark behind
 * ADVISOR_SPARK_HEALTH_TOKEN. A dependency whose credential is unset isn't
 * configured for health checking on this host, so it's omitted rather than
 * reported as perpetually down.
 */
function defaultExtraProbes(): ExtraProbe[] {
  const probes: ExtraProbe[] = [];
  if (ADVISOR_WHISPER_KEY) probes.push(() => probeOmlx());
  if (ADVISOR_SPARK_HEALTH_TOKEN) probes.push(() => probeSpark());
  return probes;
}

/**
 * Check every configured data source concurrently: each MCP server plus the
 * non-MCP dependencies (OMLX, Spark). `servers`/`probe`/`nowIso`/`extraProbes`
 * are injectable so the aggregation can be unit-tested without a live network.
 * Pass `extraProbes: []` to skip the non-MCP checks (they also self-skip when
 * their credential is unset).
 */
export async function checkSystemHealth(
  servers: Record<string, McpServerConfig> = advisorMcpServers(),
  probe: ServerProbe = probeMcpServer,
  nowIso: () => string = () => new Date().toISOString(),
  extraProbes: ExtraProbe[] = defaultExtraProbes(),
): Promise<SystemHealth> {
  const results = await Promise.all([
    ...Object.entries(servers).map(([name, cfg]) => probe(name, cfg)),
    ...extraProbes.map((p) => p()),
  ]);
  results.sort((a, b) => a.name.localeCompare(b.name));
  return {
    healthy: results.every((r) => r.reachable),
    checkedAt: nowIso(),
    servers: results,
  };
}

/** Host tool: the agent calls this to report whether the system is up. */
export function createHealthTool(
  check: () => Promise<SystemHealth> = () => checkSystemHealth(),
): AgentTool {
  return {
    name: "check-system-health",
    label: "check system health",
    description:
      "Check whether the assistant's data services are up. Pings each connected " +
      "data source (Banner class schedule, GC catalog, curriculum wiki, alumni " +
      "outcomes), the on-host OMLX inference server (local model + voice), and " +
      "the DGX Spark inference gateway, reporting which are reachable, their " +
      "tool/model counts, and latency, plus an overall healthy flag. Use when an " +
      "advisor asks whether the system is " +
      "working, or to explain why a lookup just failed. Read-only; no student data.",
    parameters: Type.Object({}),
    async execute() {
      const health = await check();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(health) }],
        details: health,
      };
    },
  };
}
