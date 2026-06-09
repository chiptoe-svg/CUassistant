// MCP server bootstrap and tool registration.
//
// Pattern mirrors NanoClaw v2's container/agent-runner/src/mcp-tools/server.ts:
// each tool module calls registerTools([...]) at import time; index.ts imports
// each module for side effect, then calls startMcpServer().

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import http from "http";

import type { McpToolDefinition } from "./types.js";
import { isMcpOperationExposed } from "./permissions.js";

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

/** Bearer check. Open when expected is empty (loopback interim mode). */
export function checkBearer(
  authHeader: string | undefined,
  expected: string,
): boolean {
  if (!expected) return true;
  return authHeader === `Bearer ${expected}`;
}

export interface StartOptions {
  name: string;
  transport?: "stdio" | "http";
  httpHost?: string;
  httpPort?: number;
  authToken?: string;
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

export async function startMcpServer(opts: StartOptions): Promise<void> {
  if ((opts.transport ?? "stdio") === "http") {
    const host = opts.httpHost ?? "127.0.0.1";
    const port = opts.httpPort ?? 8765;
    const expected = opts.authToken ?? "";
    const server = buildServer(opts.name);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    const httpServer = http.createServer((req, res) => {
      if (!checkBearer(req.headers.authorization, expected)) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        let body: unknown = undefined;
        if (chunks.length) {
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
          } catch {
            /* no body */
          }
        }
        void transport.handleRequest(req, res, body);
      });
    });
    httpServer.listen(port, host, () => {
      log(
        `${opts.name} http on ${host}:${port} (auth ${expected ? "required" : "OPEN-loopback"}) tools: ${allTools.map((t) => t.tool.name).join(", ")}`,
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
