# container/providers

This directory holds **v1-fork compatibility** artifacts for installing
CUassistant as a NanoClaw provider plugin.

## NanoClaw v2 users — use the skill instead

The v2 way to wire CUassistant into a NanoClaw fork is the install skill at
[`skills/add-cuassistant/SKILL.md`](../../skills/add-cuassistant/SKILL.md).
Invoke it as `/add-cuassistant` from a NanoClaw v2 agent. The skill calls
`add_mcp_server` programmatically and drops the agent docs fragment into the
group's `CLAUDE.md` — matching v2's "small main + skill-installed extras"
philosophy.

NanoClaw v2 trunk does not ship data-source provider JSONs and does not load
files from this directory.

## v1-fork users

If you are on a NanoClaw v1 fork (e.g. CUagent's branch) that loads provider
plugins by reading JSON from `~/.nanoclaw/providers/`, copy the file in
[`v1-fork/cuassistant.json`](v1-fork/cuassistant.json) to that directory.
The format matches CUagent's existing `ms365.json` and `gws.json` shape:
declares the MCP server command, allowed tool prefix, agent docs, and login
helper.
