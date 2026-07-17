// src/mcp-tools/skills.ts
// Serve CUassistant skill documentation to external agents.
// Read-only, no credentials. Skills live at skills/<name>/SKILL.md.

import fs from "fs";
import path from "path";

import { assertMcpOperation } from "./permissions.js";
import { registerTools } from "./server.js";
import { err, okJson, permissionErr, type McpToolDefinition } from "./types.js";

const SKILLS_DIR = path.resolve(process.cwd(), "skills");

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
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
    } catch {
      return err("Skills directory not found.");
    }
    const skills = [];
    for (const d of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!d.isDirectory()) continue;
      const skillPath = path.join(SKILLS_DIR, d.name, "SKILL.md");
      if (!fs.existsSync(skillPath)) continue;
      let description = "";
      try {
        description = parseDescription(fs.readFileSync(skillPath, "utf-8"));
      } catch {
        // leave description empty for unreadable files
      }
      skills.push({ name: d.name, description });
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
    const skillPath = path.join(SKILLS_DIR, name, "SKILL.md");
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
