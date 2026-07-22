// Fixture for advisor-mcp.test.ts.
//
// The advisor MCP URLs are module-level constants read from the environment at
// config load, so proving that a substituted URL fails CLOSED AT STARTUP needs
// a fresh process — an in-process test cannot re-read them, and a dynamic
// re-import gets the cached config module and silently tests nothing.
//
// Exits non-zero with the guard's message on the stderr when the environment
// substitutes a rejected URL; prints "servers-ok" otherwise.

import { advisorMcpServers } from "../../src/advisor-mcp.ts";

advisorMcpServers();
console.log("servers-ok");
