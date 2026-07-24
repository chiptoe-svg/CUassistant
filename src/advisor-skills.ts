// Host-side skill tools for the advisor.
//
// The advisor's tool array is bridge.tools plus a small number of host tools
// that reach nothing and write nothing (see advisor-artifacts.ts for the
// pattern this follows). Skill documentation used to reach the advisor
// through the MCP bridge's list-skills / get-skill-docs tools, but those are
// filtered out by ADVISOR_SKILL_TOOL_DENYLIST in advisor-mcp.ts — the bridge
// aggregates multiple MCP servers under bare tool names, and a server-scoped
// exposure allowlist (PUBLIC_SKILLS, CATALOG_SKILLS) is the wrong shape for
// "what this one client may see," which is a property of the advisor, not of
// a port.
//
// So the advisor gets its own pair of host tools, built directly over
// buildSkillIndex() — the same index the MCP skill tools read, which already
// scans BOTH this repo's skills/ and gc_advisor's. A local allowlist below
// (ADVISOR_SKILLS) plays the same role PUBLIC_SKILLS and CATALOG_SKILLS play
// on their servers: the default for anything new is invisible, and exposing
// it to the advisor is an edit someone has to make on purpose. `triage` and
// `add-cuassistant` are deliberately excluded — neither describes anything an
// academic advisor asks about.

import fs from "node:fs";
import path from "node:path";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import { buildSkillIndex } from "./mcp-tools/skills.js";

/** Skills the advisor may list and fetch. Add a name here to expose it. */
export const ADVISOR_SKILLS: ReadonlySet<string> = new Set([
  "clemson-schedule-advising",
  "gc-advisor",
  "gc-curriculum-lookup",
  "how-it-works",
]);

/**
 * Mirrors mcp-tools/skills.ts's parseDescription — that one is not exported,
 * and a shared helper would be a smaller diff, but it would also entangle
 * this host tool's parsing with the MCP tool's, which are otherwise
 * independent (different exposure model, different caller). Duplicated on
 * purpose; if the frontmatter shape ever changes, both call sites need the
 * same fix regardless of whether they share code.
 */
function parseDescription(content: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return "";
  const descMatch = /^description:\s*(.+)$/m.exec(match[1]);
  return descMatch ? descMatch[1].trim() : "";
}

const SLUG = /^[a-z0-9-]+$/;

function notFoundMessage(name: string): string {
  return `Skill "${name}" not found. Use list-skills to see available skills.`;
}

/**
 * The two skill tools the advisor gets, built fresh per call so they always
 * read the current on-disk index (buildSkillIndex() is cheap — a directory
 * scan — and the advisor process is long-lived, so a stale snapshot taken
 * once at startup would outlive any skill added or edited later).
 */
export function createSkillTools(): AgentTool[] {
  const listSkillsTool: AgentTool = {
    name: "list-skills",
    label: "list skills",
    description:
      "List the advising skill documents available (name + description). " +
      "Call this to discover which skill covers a question — GC " +
      "scheduling/tool workflows, GC degree requirements and rules, or how " +
      "this assistant works — then fetch the full text with get-skill-docs.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      const index = buildSkillIndex();
      const skills: { name: string; description: string }[] = [];
      for (const name of [...index.keys()].sort((a, b) =>
        a.localeCompare(b),
      )) {
        if (!ADVISOR_SKILLS.has(name)) continue;
        const skillPath = path.join(index.get(name)!, "SKILL.md");
        let description = "";
        try {
          description = parseDescription(fs.readFileSync(skillPath, "utf-8"));
        } catch {
          // leave description empty for an unreadable file
        }
        skills.push({ name, description });
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ skills }),
          },
        ],
        details: { skills },
      };
    },
  };

  const getSkillDocsTool: AgentTool = {
    name: "get-skill-docs",
    label: "get skill docs",
    description:
      "Return the full text of one advising skill by name (from " +
      "list-skills). Read the relevant skill before answering GC " +
      "scheduling or requirement questions, or when asked how this " +
      "assistant works.",
    parameters: Type.Object({
      name: Type.String({
        description: "Skill name, e.g. 'clemson-schedule-advising'.",
      }),
    }),
    async execute(_toolCallId, params) {
      // Throwing is how a Pi host tool reports a recoverable failure (see
      // createProposeScheduleTool in advisor-artifacts.ts): agent-loop.js
      // catches it and feeds the message back as an error tool result, which
      // lets the model correct itself rather than getting a result it must
      // parse for success.
      const name = (params as { name?: unknown }).name;
      if (typeof name !== "string" || name === "") {
        throw new Error("name is required");
      }
      // Read-only, no filesystem traversal: the name is validated as a bare
      // slug and looked up in the index, never joined into a path directly.
      // The allowlist gate is checked BEFORE the index lookup too, not just
      // before returning content — a skill hidden from list-skills but still
      // fetchable by guessing its name is not hidden at all, and the same
      // not-found message on both a bad slug and an allowlist miss avoids
      // confirming that a non-allowlisted skill exists on disk.
      if (!SLUG.test(name) || !ADVISOR_SKILLS.has(name)) {
        throw new Error(notFoundMessage(name));
      }
      const index = buildSkillIndex();
      const dir = index.get(name);
      if (dir === undefined) {
        throw new Error(notFoundMessage(name));
      }
      const skillPath = path.join(dir, "SKILL.md");
      let content: string;
      try {
        content = fs.readFileSync(skillPath, "utf-8");
      } catch {
        throw new Error(notFoundMessage(name));
      }
      const description = parseDescription(content);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ name, description, content }),
          },
        ],
        details: { name, description, content },
      };
    },
  };

  return [listSkillsTool, getSkillDocsTool];
}
