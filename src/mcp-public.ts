// src/mcp-public.ts
// Public Clemson class-schedule MCP server (no credentials). stdio only — it
// can run as a subprocess inside a NanoClaw container; it holds no secrets and
// only reaches Clemson's public Banner API.
import "./mcp-tools/index-public.js";
import { startMcpServer } from "./mcp-tools/server.js";

startMcpServer({ name: "cuassistant-public", transport: "stdio" }).catch(
  (err) => {
    process.stderr.write(
      `[cuassistant-public] ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  },
);
