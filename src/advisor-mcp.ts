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
  MCP_CATALOG_AUTH_TOKEN,
  MCP_HTTP_PORT,
  MCP_PUBLIC_AUTH_TOKEN,
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
  createClient: () =>
    new Client({ name: "cuassistant-advisor-mcp", version: "1.0.0" }),
};

async function loadToolsFromClient(
  serverName: string,
  client: ClientLike,
): Promise<AgentTool[]> {
  const listed = await client.listTools();
  return listed.tools.map((tool) => mcpToolToPiTool(serverName, tool, client));
}

/**
 * Expose each MCP tool under its BARE name — no `<server>__<tool>` prefix.
 *
 * The prefixing was inherited from nanoclaw, where it prevents collisions
 * between servers. It also breaks the model. The Spark endpoint's quantized
 * qwen3.6-35b-a3b degrades on double-underscore-namespaced tool names: it emits
 * <tool_call> XML into `content` with finish_reason "stop" and zero structured
 * tool_calls, i.e. the advisor never calls a tool at all.
 *
 * Established by replaying a captured wire payload, 3 trials each,
 * non-streaming:
 *
 *   captured as-is (namespaced)   0/3    tools block 14918 chars
 *   prefixes stripped             3/3    tools block 14735 chars  <-- only change
 *   descriptions trimmed to 80ch  3/3    tools block  9965
 *   first 12 tools (namespaced)   1/3    tools block 10401
 *   first 8 tools (namespaced)    3/3
 *
 * Size is NOT the mechanism: the smaller 12-tool namespaced variant fails while
 * the LARGER stripped variant is clean. The prefix is the only variable that
 * flips it.
 *
 * `label` keeps the server qualifier: it is UI-display metadata in
 * pi-agent-core and never reaches the wire, so it costs the model nothing while
 * keeping tool provenance visible to a human reading the transcript.
 *
 * Dropping the prefix reintroduces the collision risk it was preventing. See
 * the guard in createAdvisorMcpBridge, which fails startup loudly rather than
 * letting one server silently shadow another's tool.
 */
function mcpToolToPiTool(
  serverName: string,
  tool: McpTool,
  client: ClientLike,
): AgentTool {
  return {
    name: tool.name,
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
        content?: Array<
          { type: string; text?: string } & Record<string, unknown>
        >;
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
          content.push({
            type: "image",
            data: item.data,
            mimeType: item.mimeType,
          });
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
 * Reject an advisor MCP URL that points at the CREDENTIALED server's port.
 *
 * The server array is fixed at three entries, so no fourth server can be added
 * — but each entry's URL comes from the environment, so a slot can be
 * SUBSTITUTED. `ADVISOR_MCP_PUBLIC_URL=http://127.0.0.1:8765/` puts the
 * credentialed server (send-outlook-mail, send-gmail, calendar writes) into the
 * agent's tool array, and when MCP_AUTH_TOKEN is unset that server is
 * loopback-open, so the substitution needs no credential at all.
 *
 * The port is the identity check that matters: 8765 is where the credentialed
 * server lives. Matching on port regardless of host fails closed — a remote
 * host on 8765 is not our server either, and an advisor MCP URL has no business
 * naming that port.
 *
 * Called from advisorMcpServers(), which createAdvisorMcpBridge() calls at
 * startup, so a substituted URL kills the process before it accepts a request
 * rather than surfacing on the first turn.
 */
/**
 * The credentialed MCP server's port as a LITERAL, not as configuration.
 *
 * Deliberately not `MCP_HTTP_PORT`: see assertAdvisorMcpUrlSafe. A guard whose
 * threat model is a hostile environment cannot take its only constant from that
 * same environment.
 */
export const CREDENTIALED_MCP_PORT = 8765;

export function assertAdvisorMcpUrlSafe(serverName: string, url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      `advisor MCP server "${serverName}" has an unparseable URL`,
    );
  }
  const port = parsed.port
    ? Number(parsed.port)
    : parsed.protocol === "https:"
      ? 443
      : 80;
  // Both the CONFIGURED port and the literal 8765.
  //
  // MCP_HTTP_PORT is itself read from the environment, and the threat this guard
  // exists to stop is "URLs come from the environment, so a slot can be
  // substituted". Checking only the configured value lets the same mechanism
  // defeat the guard: `MCP_HTTP_PORT=9999 ADVISOR_MCP_PUBLIC_URL=http://127.0.0.1:8765/`
  // moves the variable out of the way and puts the credentialed server back into
  // the agent's tool array. 8765 is the port that server has always listened on,
  // so it is refused whether or not the environment still admits to it.
  if (port === MCP_HTTP_PORT || port === CREDENTIALED_MCP_PORT) {
    throw new Error(
      `advisor MCP server "${serverName}" resolves to port ${port}, the credentialed MCP server; ` +
        `the advisor agent must never be handed mail-send or calendar-write tools`,
    );
  }
}

/**
 * The agent's entire data surface. Three servers, declared in one place.
 *
 * 8765 is deliberately absent: it carries send-outlook-mail, send-gmail, and
 * calendar writes. Pi is handed an explicit tool array, so a server that is not
 * listed here contributes nothing — there is no inheritance path to close.
 * What IS closable is substitution of one of these three URLs, which
 * assertAdvisorMcpUrlSafe rejects.
 */
export function advisorMcpServers(): Record<string, McpServerConfig> {
  // Only attach the header when a token exists, so a missing token fails as a
  // clear 401 rather than being sent as the string "Bearer undefined".
  const bearer = (token: string): Record<string, string> | undefined =>
    token ? { Authorization: `Bearer ${token}` } : undefined;
  const withAuth = (url: string, token: string): McpServerConfig => {
    const config: McpServerConfig = { url };
    const headers = bearer(token);
    if (headers) config.headers = headers;
    return config;
  };
  // The advisor is a CLIENT of 8766/8767, which now require a bearer. Each
  // server gets its own key — the same values the servers authenticate
  // against, read from this repo's .env.
  const servers: Record<string, McpServerConfig> = {
    cu_public: withAuth(ADVISOR_MCP_PUBLIC_URL, MCP_PUBLIC_AUTH_TOKEN),
    cu_catalog: withAuth(ADVISOR_MCP_CATALOG_URL, MCP_CATALOG_AUTH_TOKEN),
    gc_curriculum_wiki: withAuth(ADVISOR_MCP_WIKI_URL, ADVISOR_MCP_WIKI_TOKEN),
  };
  for (const [name, config] of Object.entries(servers)) {
    assertAdvisorMcpUrlSafe(name, config.url);
  }
  return servers;
}

export async function createAdvisorMcpBridge(
  deps: AdvisorMcpBridgeDeps = defaultDeps,
): Promise<AdvisorMcpBridge> {
  const servers = advisorMcpServers();
  const runtimes: AdvisorMcpBridge[] = [];
  const tools: AgentTool[] = [];
  // Tool name -> the server that contributed it, so a collision can name BOTH
  // sides in the error.
  const owners = new Map<string, string>();

  for (const [serverName, config] of Object.entries(servers)) {
    let loaded: AgentTool[];
    // Isolate per-server failures: a down or misconfigured MCP server
    // (unreachable, 401, bad URL) must not crash the whole agent. Log and
    // skip it; the agent keeps the tools from the servers that did connect.
    try {
      const transport = deps.createTransport(new URL(config.url), {
        requestInit: { headers: config.headers },
      });
      const client = deps.createClient();

      await client.connect(transport);
      loaded = await loadToolsFromClient(serverName, client);
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
      continue;
    }

    // Deliberately OUTSIDE the try above. A name collision is a configuration
    // fault, not a per-server connection failure, and must kill startup rather
    // than be swallowed by the skip-and-continue handler.
    //
    // Tools are exposed under bare names (see mcpToolToPiTool), so two servers
    // offering the same tool name would leave one silently shadowing the other
    // — strictly worse than the collision itself, because the agent would call
    // one server believing it had called the other, and every answer built on
    // that result would be confidently wrong with nothing in the transcript to
    // show it.
    //
    // No collisions exist across the three servers today. The guard is here
    // because gc_curriculum_wiki is currently skipped for want of a token, so
    // its tool names have never actually been enumerated against the others.
    for (const tool of loaded) {
      const existing = owners.get(tool.name);
      if (existing !== undefined) {
        await Promise.allSettled(
          runtimes.map(async (runtime) => runtime.close()),
        );
        throw new Error(
          `advisor MCP tool name collision: "${tool.name}" is exposed by both ` +
            `"${existing}" and "${serverName}"; tools are exposed under bare names, so one ` +
            `would silently shadow the other — rename the tool on one of the servers`,
        );
      }
      owners.set(tool.name, serverName);
      tools.push(tool);
    }
  }

  return {
    tools,
    async close() {
      await Promise.allSettled(
        runtimes.map(async (runtime) => runtime.close()),
      );
    },
  };
}
