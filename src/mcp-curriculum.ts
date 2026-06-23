// src/mcp-curriculum.ts
// Public GC curriculum MCP server (no credentials). Bridges to the gc_advisor
// project's query.py for catalog data. Defaults to stdio; serves loopback HTTP
// when MCP_TRANSPORT=http. Holds no secrets and only reads public catalog data.
import "./mcp-tools/index-curriculum.js";
import { startMcpServer } from "./mcp-tools/server.js";
import {
  MCP_TRANSPORT,
  MCP_HTTP_HOST,
  MCP_CURRICULUM_HTTP_PORT,
} from "./config.js";

startMcpServer({
  name: "cuassistant-curriculum",
  transport: MCP_TRANSPORT,
  httpHost: MCP_HTTP_HOST,
  httpPort: MCP_CURRICULUM_HTTP_PORT,
  auth: { kind: "open" }, // public catalog data — loopback-open, no credentials
}).catch((err) => {
  process.stderr.write(
    `[cuassistant-curriculum] ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
