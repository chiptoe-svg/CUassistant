// System health check for the advisor. Lets the agent (or an operator) confirm
// the assistant is up and every connected MCP data source is reachable — a real
// connect + tools/list per server, not just a TCP ping, so a server that is
// listening but broken is reported as such. Read-only; touches no student data.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import { advisorMcpServers, type McpServerConfig } from "./advisor-mcp.js";

const HEALTH_TIMEOUT_MS = 5_000;

export interface ServerHealth {
  name: string;
  reachable: boolean;
  toolCount?: number;
  latencyMs: number;
  error?: string;
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

/**
 * Check every configured MCP data source concurrently. `servers`/`probe`/`nowIso`
 * are injectable so the aggregation can be unit-tested without a live network.
 */
export async function checkSystemHealth(
  servers: Record<string, McpServerConfig> = advisorMcpServers(),
  probe: ServerProbe = probeMcpServer,
  nowIso: () => string = () => new Date().toISOString(),
): Promise<SystemHealth> {
  const results = await Promise.all(
    Object.entries(servers).map(([name, cfg]) => probe(name, cfg)),
  );
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
      "outcomes), reporting which are reachable, their tool counts, and latency, " +
      "plus an overall healthy flag. Use when an advisor asks whether the system " +
      "is working, or to explain why a lookup just failed. Read-only; no student data.",
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
