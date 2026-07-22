import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";

import {
  ADVISOR_MCP_CATALOG_URL,
  ADVISOR_MCP_PUBLIC_URL,
  ADVISOR_MCP_WIKI_TOKEN,
  ADVISOR_MCP_WIKI_URL,
} from "./config.js";

export interface McpServerConfig {
  url: string;
  headers?: Record<string, string>;
}

export interface AdvisorMcpBridge {
  tools: AgentTool[];
  close(): Promise<void>;
}

interface ClientLike {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{ tools: McpTool[] }>;
  callTool(request: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

interface AdvisorMcpBridgeDeps {
  createTransport: (
    url: URL,
    init: ConstructorParameters<typeof StreamableHTTPClientTransport>[1],
  ) => StreamableHTTPClientTransport;
  createClient: () => ClientLike;
}

const defaultDeps: AdvisorMcpBridgeDeps = {
  createTransport: (url, init) => new StreamableHTTPClientTransport(url, init),
  createClient: () => new Client({ name: "cuassistant-advisor-mcp", version: "1.0.0" }),
};

async function loadToolsFromClient(serverName: string, client: ClientLike): Promise<AgentTool[]> {
  const listed = await client.listTools();
  return listed.tools.map((tool) => mcpToolToPiTool(serverName, tool, client));
}

function mcpToolToPiTool(serverName: string, tool: McpTool, client: ClientLike): AgentTool {
  return {
    name: `${serverName}__${tool.name}`,
    label: `${serverName}:${tool.name}`,
    description: tool.description ?? `${tool.name} from ${serverName}`,
    parameters: Type.Unsafe(
      tool.inputSchema ?? {
        type: "object",
        properties: {},
        additionalProperties: true,
      },
    ),
    async execute(_toolCallId, params) {
      const result = (await client.callTool({
        name: tool.name,
        arguments: params as Record<string, unknown>,
      })) as Record<string, unknown> & {
        content?: Array<{ type: string; text?: string } & Record<string, unknown>>;
      };
      const content: Array<TextContent | ImageContent> = [];
      for (const item of result.content ?? []) {
        if (item.type === "text" && typeof item.text === "string") {
          content.push({ type: "text", text: item.text });
          continue;
        }
        if (
          item.type === "image" &&
          typeof item.data === "string" &&
          typeof item.mimeType === "string"
        ) {
          content.push({ type: "image", data: item.data, mimeType: item.mimeType });
        }
      }

      return {
        content,
        details: result,
      };
    },
  };
}

/**
 * The agent's entire data surface. Three servers, declared in one place.
 *
 * 8765 is deliberately absent: it carries send-outlook-mail, send-gmail, and
 * calendar writes. Pi is handed an explicit tool array, so a server that is not
 * listed here contributes nothing — there is no inheritance path to close.
 */
export function advisorMcpServers(): Record<string, McpServerConfig> {
  const wiki: McpServerConfig = { url: ADVISOR_MCP_WIKI_URL };
  // Only attach the header when a token exists, so a missing token fails as a
  // clear 401 rather than being sent as the string "Bearer undefined".
  if (ADVISOR_MCP_WIKI_TOKEN) {
    wiki.headers = { Authorization: `Bearer ${ADVISOR_MCP_WIKI_TOKEN}` };
  }
  return {
    cu_public: { url: ADVISOR_MCP_PUBLIC_URL },
    cu_catalog: { url: ADVISOR_MCP_CATALOG_URL },
    gc_curriculum_wiki: wiki,
  };
}

export async function createAdvisorMcpBridge(
  deps: AdvisorMcpBridgeDeps = defaultDeps,
): Promise<AdvisorMcpBridge> {
  const servers = advisorMcpServers();
  const runtimes: AdvisorMcpBridge[] = [];
  const tools: AgentTool[] = [];

  for (const [serverName, config] of Object.entries(servers)) {
    // Isolate per-server failures: a down or misconfigured MCP server
    // (unreachable, 401, bad URL) must not crash the whole agent. Log and
    // skip it; the agent keeps the tools from the servers that did connect.
    try {
      const transport = deps.createTransport(new URL(config.url), {
        requestInit: { headers: config.headers },
      });
      const client = deps.createClient();

      await client.connect(transport);
      tools.push(...(await loadToolsFromClient(serverName, client)));
      runtimes.push({
        tools: [],
        async close() {
          await client.close();
          await transport.close();
        },
      });
    } catch (err) {
      console.error(
        `[advisor-mcp] skipping MCP server "${serverName}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    tools,
    async close() {
      await Promise.allSettled(runtimes.map(async (runtime) => runtime.close()));
    },
  };
}
