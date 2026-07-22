// src/mcp-public.ts
// Public Clemson class-schedule MCP server. Defaults to stdio for local/dev;
// serves HTTP when MCP_TRANSPORT=http. It holds no secrets and only reaches
// Clemson's public Banner API.
//
// AUTH: a single bearer, MCP_PUBLIC_AUTH_TOKEN, distinct from the catalog
// server's key and from anything on 8765. The consumer source is empty
// (`load: () => []`), so this key is the ONLY credential — 8765's per-agent
// registry tokens do not work here, and revoking this key does not touch the
// catalog server. With the key unset there are zero consumers and
// resolveCredentialedAuth throws at startup rather than serving open.
//
// BIND: MCP_PUBLIC_HTTP_HOST (its own variable, default loopback). Set to
// 0.0.0.0 for campus reachability. NOTE: StreamableHTTPServerTransport has no
// Host/Origin validation, so off loopback the bearer is the only gate — there
// is no DNS-rebinding protection to enable.
import "./mcp-tools/index-public.js";
import { startMcpServer } from "./mcp-tools/server.js";
import {
  MCP_TRANSPORT,
  MCP_PUBLIC_HTTP_HOST,
  MCP_PUBLIC_HTTP_PORT,
  MCP_PUBLIC_AUTH_TOKEN,
  MCP_PUBLIC_AUTH_TOKEN_PROVIDER,
} from "./config.js";

startMcpServer({
  name: "cuassistant-public",
  transport: MCP_TRANSPORT,
  httpHost: MCP_PUBLIC_HTTP_HOST,
  httpPort: MCP_PUBLIC_HTTP_PORT,
  auth: {
    kind: "registry",
    envToken: MCP_PUBLIC_AUTH_TOKEN,
    envTokenProvider: MCP_PUBLIC_AUTH_TOKEN_PROVIDER,
    load: () => [],
  },
}).catch((err) => {
  process.stderr.write(
    `[cuassistant-public] ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
