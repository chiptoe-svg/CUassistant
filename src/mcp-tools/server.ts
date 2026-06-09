// MCP server bootstrap and tool registration.
//
// Pattern mirrors NanoClaw v2's container/agent-runner/src/mcp-tools/server.ts:
// each tool module calls registerTools([...]) at import time; index.ts imports
// each module for side effect, then calls startMcpServer().
//
// AUTH MODEL (HTTP transport)
// ===========================
// The credentialed server authenticates each request against a per-agent token
// REGISTRY (src/mcp-tools/consumers.ts): every authorized agent has its own
// bearer token; the matched consumer id is the audit identity; grant/revoke is
// per-agent. The server FAILS CLOSED — it refuses to start over HTTP with no
// authorized consumers, so an un-provisioned agent on the same host gets
// nothing. The public server runs in "open" mode (no credentials, public data)
// and is allowed only on a loopback bind.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import http from "http";

import {
  authenticateBearer,
  hashToken,
  loadConsumers,
  type Consumer,
} from "./consumers.js";
import type { McpToolDefinition } from "./types.js";
import { isMcpOperationExposed } from "./permissions.js";

/** Reject bodies larger than this on the HTTP transport (local DoS guard). */
const MAX_BODY_BYTES = 1_048_576; // 1 MiB

function log(msg: string): void {
  process.stderr.write(`[cuassistant-mcp] ${msg}\n`);
}

const allTools: McpToolDefinition[] = [];
const toolMap = new Map<string, McpToolDefinition>();

export function shouldRegisterMcpTool(t: Partial<McpToolDefinition>): boolean {
  if (!t.operation) {
    return false;
  }
  return isMcpOperationExposed(t.operation);
}

export function registerTools(tools: McpToolDefinition[]): void {
  for (const t of tools) {
    if (!shouldRegisterMcpTool(t)) {
      log(
        `skipping tool "${t.tool.name}" because operation ` +
          `"${t.operation ?? "(missing)"}" is not active and ` +
          `policy-approved`,
      );
      continue;
    }
    if (toolMap.has(t.tool.name)) {
      log(`warning: duplicate tool "${t.tool.name}" — skipping`);
      continue;
    }
    allTools.push(t);
    toolMap.set(t.tool.name, t);
  }
}

/** Authenticates an HTTP request; returns the consumer id, or null to reject. */
export type Authenticator = (authHeader: string | undefined) => string | null;

/** Open mode: no credentials. Used by the public server (loopback-only). */
export const openAuthenticator: Authenticator = () => "public";

/** Fail closed: open mode is only allowed on a loopback bind. */
export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
export function assertHttpAuthConfig(expected: string, host: string): void {
  if (!expected && !isLoopbackHost(host)) {
    throw new Error(
      `MCP_AUTH_TOKEN is required when MCP_HTTP_HOST is not loopback (got "${host}")`,
    );
  }
}

export interface ResolveAuthOptions {
  /** Optional single token (MCP_AUTH_TOKEN) accepted as an "env-token" consumer. */
  envToken?: string;
  /** Registry loader; defaults to the on-disk registry. Injectable for tests. */
  load?: () => Consumer[];
  /** Called with the consumer id on each successful auth (for last-seen touch). */
  onSeen?: (consumerId: string) => void;
}

/**
 * Build the credentialed authenticator. THROWS (fail closed) when there are no
 * authorized consumers, so the server never silently runs open. Reloads the
 * registry per call so `mcp:pair`/revoke take effect without a restart.
 */
export function resolveCredentialedAuth(
  opts: ResolveAuthOptions = {},
): Authenticator {
  const load = opts.load ?? loadConsumers;
  const envToken = (opts.envToken ?? "").trim();
  const gather = (): Consumer[] => {
    const live = load();
    if (envToken) {
      live.push({
        id: "env-token",
        token_hash: hashToken(envToken),
        created_at: "",
      });
    }
    return live;
  };
  if (gather().length === 0) {
    throw new Error(
      "credentialed MCP HTTP server has no authorized consumers — provision " +
        "one with `npm run mcp:pair -- --id <agent>` (or set MCP_AUTH_TOKEN). " +
        "Refusing to start open.",
    );
  }
  return (authHeader) => {
    const id = authenticateBearer(authHeader, gather());
    if (id) opts.onSeen?.(id);
    return id;
  };
}

function buildServer(name: string): Server {
  const server = new Server(
    { name, version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools.map((t) => t.tool),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name: toolName, arguments: args } = request.params;
    const tool = toolMap.get(toolName);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
        isError: true,
      };
    }
    return tool.handler(args ?? {});
  });
  return server;
}

export function createHttpHandler(
  name: string,
  authenticate: Authenticator,
): http.RequestListener {
  return (req, res) => {
    const consumerId = authenticate(req.headers.authorization);
    if (!consumerId) {
      log(
        `${name}: 401 unauthorized ${req.method ?? "?"} from ${req.socket.remoteAddress ?? "?"}`,
      );
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (c) => {
      const buf = c as Buffer;
      size += buf.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "payload_too_large" }));
        req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => {
      if (tooLarge) return;
      let body: unknown = undefined;
      if (chunks.length) {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
        } catch {
          /* no body */
        }
      }
      // Stateless MCP: a FRESH server+transport per request. Sharing one
      // stateless transport across requests 500s on the post-initialize
      // notifications/initialized POST (verified by the nanoclaw integration test).
      void (async () => {
        const server = buildServer(name);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      })();
    });
  };
}

export type AuthConfig =
  | { kind: "open" }
  | { kind: "registry"; envToken?: string; onSeen?: (id: string) => void };

export interface StartOptions {
  name: string;
  transport?: "stdio" | "http";
  httpHost?: string;
  httpPort?: number;
  auth: AuthConfig;
}

export async function startMcpServer(opts: StartOptions): Promise<void> {
  if ((opts.transport ?? "stdio") === "http") {
    const host = opts.httpHost ?? "127.0.0.1";
    const port = opts.httpPort ?? 8765;
    let authenticate: Authenticator;
    let mode: string;
    if (opts.auth.kind === "open") {
      assertHttpAuthConfig("", host);
      authenticate = openAuthenticator;
      mode = "OPEN-loopback (no credentials, public data)";
    } else {
      authenticate = resolveCredentialedAuth({
        envToken: opts.auth.envToken,
        onSeen: opts.auth.onSeen,
      });
      const count = loadConsumers().length + (opts.auth.envToken ? 1 : 0);
      mode = `registry (${count} authorized consumer${count === 1 ? "" : "s"})`;
    }
    const httpServer = http.createServer(
      createHttpHandler(opts.name, authenticate),
    );
    httpServer.listen(port, host, () => {
      log(
        `${opts.name} http on ${host}:${port} — auth: ${mode}; tools: ${allTools
          .map((t) => t.tool.name)
          .join(", ")}`,
      );
    });
    return;
  }
  const server = buildServer(opts.name);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(
    `${opts.name} stdio started with ${allTools.length} tools: ${allTools.map((t) => t.tool.name).join(", ")}`,
  );
}
