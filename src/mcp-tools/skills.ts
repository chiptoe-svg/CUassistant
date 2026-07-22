// src/mcp-tools/skills.ts
// Serve CUassistant skill documentation to external agents.
// Read-only, no credentials. Skills live at skills/<name>/SKILL.md.

import fs from "fs";
import path from "path";

import { GC_ADVISOR_SKILLS } from "../config.js";
import { log } from "../log.js";
import { assertMcpOperation } from "./permissions.js";
import { registerTools } from "./server.js";
import { err, okJson, permissionErr, type McpToolDefinition } from "./types.js";

// SKILL ROOTS
// ===========
// Skills come from two directories. The first is this repo's own `skills/`.
// The second is gc_advisor's, read IN PLACE rather than copied here: the
// catalog server already shells out to gc_advisor's query.py instead of
// duplicating its data (src/config.ts), and the documents describing how to
// drive those tools belong to the same owner. A copy in this repo would go
// stale against the project that keeps changing it, and nothing would say so.
const LOCAL_SKILLS_DIR = path.resolve(process.cwd(), "skills");

let skillRoots: readonly string[] = [LOCAL_SKILLS_DIR, GC_ADVISOR_SKILLS];

/** Override the roots. For tests only. */
export function __setSkillRoots(next: readonly string[]): void {
  skillRoots = [...next];
}

/** Restore the configured roots. For tests only. */
export function __resetSkillRoots(): void {
  skillRoots = [LOCAL_SKILLS_DIR, GC_ADVISOR_SKILLS];
  warnedRoots.clear();
}

const warnedRoots = new Set<string>();

/**
 * Map skill name -> the directory holding its SKILL.md, scanning `roots` in
 * order.
 *
 * A root that cannot be read is a DEGRADED experience, not a fatal one: the
 * catalog server's seven data tools work whether or not gc_advisor is checked
 * out beside it, so an absent root drops its skills and logs loudly (the same
 * shape as roomCapacity() degrading to "unknown everywhere") instead of
 * refusing to start.
 *
 * A name present in TWO roots is the opposite case and throws. The roots are
 * separate repos with no shared naming authority, so a collision is possible
 * in principle even though none exists today. Resolving it by precedence would
 * hand an agent the documentation for one skill while it calls the other, with
 * nothing in the transcript to show the substitution — the same reasoning that
 * makes createAdvisorMcpBridge kill startup on an MCP tool-name collision.
 */
export function buildSkillIndex(
  roots: readonly string[] = skillRoots,
): Map<string, string> {
  const index = new Map<string, string>();
  for (const root of roots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (e) {
      if (!warnedRoots.has(root)) {
        warnedRoots.add(root);
        log.warn("skill root unavailable; its skills will not be served", {
          root,
          err: String(e),
        });
      }
      continue;
    }
    warnedRoots.delete(root);
    for (const d of entries) {
      if (!d.isDirectory()) continue;
      if (!fs.existsSync(path.join(root, d.name, "SKILL.md"))) continue;
      const existing = index.get(d.name);
      if (existing !== undefined) {
        throw new Error(
          `skill name collision: "${d.name}" exists in both "${existing}" and ` +
            `"${path.join(root, d.name)}"; one would silently shadow the other, ` +
            `so an agent could read documentation for a different tool than it ` +
            `calls — rename the skill in one of the roots`,
        );
      }
      index.set(d.name, path.join(root, d.name));
    }
  }
  return index;
}

// PER-SERVER SKILL EXPOSURE
// =========================
// `skills/` is a single directory holding documents of MIXED trust: the
// Clemson class-schedule advising guide is public-path material, while
// `triage` (the email classifier's decision rules) and `add-cuassistant` (a
// full description of the credentialed 8765 surface — MS365 mail/calendar/
// tasks, the send approval gate, the install procedure) are private-path.
// Both skill tools are registered from index-public.ts, which the public
// server (8766) and the credentialed server (8765) BOTH load, so without a
// gate every skill is served on the campus-reachable port.
//
// This is an ALLOWLIST, deliberately, and NOT a denylist of the private
// skills. A denylist reverses the failure mode: a skill added later and not
// remembered in the deny set would be published to campus by omission, which
// is exactly how the whole directory ended up public in the first place. With
// an allowlist the default for anything new is invisible, and exposing it is
// an edit someone has to make on purpose.
//
// The default is the restrictive (public) set, so a server that never
// configures exposure fails closed. The credentialed entry point opts in to
// the full set explicitly.

/** Skills the public server (8766) may serve. Add a name here to publish it. */
export const PUBLIC_SKILLS: readonly string[] = ["clemson-schedule-advising"];

/**
 * Skills the catalog server (8767) may serve. These document the seven GC
 * curriculum tools that server exposes; both live in gc_advisor's skills root
 * and neither requires credentials.
 */
export const CATALOG_SKILLS: readonly string[] = [
  "gc-advisor",
  "gc-curriculum-lookup",
];

type SkillExposure = "all" | ReadonlySet<string>;

let exposure: SkillExposure = new Set(PUBLIC_SKILLS);

/**
 * Set which skills this process serves. Called by the credentialed entry point
 * with "all"; the public entry point leaves the fail-closed default in place.
 */
export function setSkillExposure(next: "all" | readonly string[]): void {
  exposure = next === "all" ? "all" : new Set(next);
}

/** Restore the fail-closed default (public allowlist). For tests. */
export function resetSkillExposure(): void {
  exposure = new Set(PUBLIC_SKILLS);
}

/** Whether `name` may be listed or fetched on this server. */
export function isSkillExposed(name: string): boolean {
  return exposure === "all" || exposure.has(name);
}

function parseDescription(content: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return "";
  const descMatch = /^description:\s*(.+)$/m.exec(match[1]);
  return descMatch ? descMatch[1].trim() : "";
}

const listSkills: McpToolDefinition = {
  operation: "host.list_skills",
  tool: {
    name: "list-skills",
    description:
      "List available CUassistant skill documents by name and description. " +
      "Pass a name to get-skill-docs to retrieve the full content.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  async handler(_args) {
    try {
      assertMcpOperation("host.list_skills");
    } catch (e) {
      return permissionErr(e);
    }
    const index = buildSkillIndex();
    const skills = [];
    for (const name of [...index.keys()].sort((a, b) => a.localeCompare(b))) {
      if (!isSkillExposed(name)) continue;
      const skillPath = path.join(index.get(name)!, "SKILL.md");
      let description = "";
      try {
        description = parseDescription(fs.readFileSync(skillPath, "utf-8"));
      } catch {
        // leave description empty for unreadable files
      }
      skills.push({ name, description });
    }
    return okJson({ skills });
  },
};

const getSkillDocs: McpToolDefinition = {
  operation: "host.get_skill_docs",
  tool: {
    name: "get-skill-docs",
    description:
      "Return the full documentation for a CUassistant skill by name. " +
      "Use list-skills to discover available skill names.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Skill name, e.g. 'clemson-schedule-advising'.",
        },
      },
      required: ["name"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("host.get_skill_docs");
    } catch (e) {
      return permissionErr(e);
    }
    const name = args.name as string | undefined;
    if (!name) return err("name is required");
    // Reject anything with slashes, dots, or non-slug characters.
    if (!/^[a-z0-9-]+$/.test(name)) {
      return err(
        `Invalid skill name "${name}". Use only lowercase letters, digits, and hyphens.`,
      );
    }
    // Gate the direct fetch too, not just list-skills. A skill hidden from the
    // listing but still retrievable by guessing its name is not hidden at all,
    // and the names are guessable. The message is deliberately identical to
    // the not-found message so the response does not confirm that a
    // non-exposed skill exists on this host.
    if (!isSkillExposed(name)) {
      return err(
        `Skill "${name}" not found. Use list-skills to see available skills.`,
      );
    }
    const dir = buildSkillIndex().get(name);
    if (dir === undefined) {
      return err(
        `Skill "${name}" not found. Use list-skills to see available skills.`,
      );
    }
    const skillPath = path.join(dir, "SKILL.md");
    let content: string;
    try {
      content = fs.readFileSync(skillPath, "utf-8");
    } catch {
      return err(
        `Skill "${name}" not found. Use list-skills to see available skills.`,
      );
    }
    const { mtimeMs } = fs.statSync(skillPath);
    return okJson({
      name,
      description: parseDescription(content),
      content,
      updated_at: new Date(mtimeMs).toISOString(),
    });
  },
};

registerTools([listSkills, getSkillDocs]);

// Scan once at import, so an unreadable root is reported at STARTUP rather
// than silently on some later tool call, and so a name collision aborts the
// process before it can ever serve a shadowed document.
buildSkillIndex();

/** Exported for tests: the tool handlers, exercised directly. */
export const __skillTools = { listSkills, getSkillDocs };
