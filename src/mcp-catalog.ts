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
import { CATALOG_SKILLS, setSkillExposure } from "./mcp-tools/skills.js";
import { renameRegisteredTool, startMcpServer } from "./mcp-tools/server.js";
import {
  MCP_TRANSPORT,
  MCP_CATALOG_HTTP_HOST,
  MCP_CATALOG_HTTP_PORT,
  MCP_CATALOG_AUTH_TOKEN,
  MCP_CATALOG_AUTH_TOKEN_PROVIDER,
} from "./config.js";

// SKILLS: an explicit allowlist of exactly the two GC skills, never a denylist.
// The default exposure is the PUBLIC set (clemson-schedule-advising), which is
// not what this server serves, so it must opt in by name. Anything added to
// either skill root later is invisible here until someone edits CATALOG_SKILLS
// on purpose — the inversion that would have prevented `triage` and
// `add-cuassistant` from reaching the public port by omission.
setSkillExposure(CATALOG_SKILLS);

// skills.js is loaded by BOTH the public barrel and this one, so both servers
// advertised `list-skills`/`get-skill-docs`. The advisor bridges 8766 and 8767
// and exposes tools under bare names, so it refused to start on the collision
// (advisor-mcp.ts) — which is how this was found: the advisor has not been run
// since the catalog gained skill tools.
//
// The catalog's copies are renamed rather than the public server's: `list-skills`
// meant the public server's skills before this server had any, and the advisor's
// prompt and the shipped skill documents refer to it under that name.
renameRegisteredTool("list-skills", "list-gc-skills");
renameRegisteredTool("get-skill-docs", "get-gc-skill-docs");

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
