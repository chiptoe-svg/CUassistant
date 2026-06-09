// src/mcp-public.ts
// Public Clemson class-schedule MCP server (no credentials). Defaults to stdio
// for local/dev; serves loopback HTTP when MCP_TRANSPORT=http (e.g. inside a
// NanoClaw container that can't spawn it as a subprocess). It holds no secrets
// and only reaches Clemson's public Banner API, so the HTTP bind is
// loopback-open with no bearer.
import "./mcp-tools/index-public.js";
import { startMcpServer } from "./mcp-tools/server.js";
import {
  MCP_TRANSPORT,
  MCP_HTTP_HOST,
  MCP_PUBLIC_HTTP_PORT,
} from "./config.js";

startMcpServer({
  name: "cuassistant-public",
  transport: MCP_TRANSPORT,
  httpHost: MCP_HTTP_HOST,
  httpPort: MCP_PUBLIC_HTTP_PORT,
  auth: { kind: "open" }, // public data — loopback-open, no credentials
}).catch((err) => {
  process.stderr.write(
    `[cuassistant-public] ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
