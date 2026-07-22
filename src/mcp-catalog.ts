// src/mcp-catalog.ts
// Public GC curriculum MCP server. Bridges to the gc_advisor project's
// query.py for catalog data. Defaults to stdio; serves HTTP when
// MCP_TRANSPORT=http. Holds no secrets and only reads public catalog data.
//
// AUTH: a single bearer, MCP_CATALOG_AUTH_TOKEN, distinct from the public
// server's key and from anything on 8765. See src/mcp-public.ts for the full
// rationale of the empty consumer source and the fail-closed startup.
//
// BIND: MCP_CATALOG_HTTP_HOST (its own variable, default loopback). Set to
// 0.0.0.0 for campus reachability; off loopback the bearer is the only gate.
import "./mcp-tools/index-catalog.js";
import { startMcpServer } from "./mcp-tools/server.js";
import {
  MCP_TRANSPORT,
  MCP_CATALOG_HTTP_HOST,
  MCP_CATALOG_HTTP_PORT,
  MCP_CATALOG_AUTH_TOKEN,
  MCP_CATALOG_AUTH_TOKEN_PROVIDER,
} from "./config.js";

startMcpServer({
  name: "cuassistant-catalog",
  transport: MCP_TRANSPORT,
  httpHost: MCP_CATALOG_HTTP_HOST,
  httpPort: MCP_CATALOG_HTTP_PORT,
  auth: {
    kind: "registry",
    envToken: MCP_CATALOG_AUTH_TOKEN,
    envTokenProvider: MCP_CATALOG_AUTH_TOKEN_PROVIDER,
    load: () => [],
  },
}).catch((err) => {
  process.stderr.write(
    `[cuassistant-catalog] ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
