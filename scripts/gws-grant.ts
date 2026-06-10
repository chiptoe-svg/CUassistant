// Manual escape hatch for the write-own model: grant the agent write access to
// a SPECIFIC pre-existing Google file by adding its id to the owned-files
// registry (state/gws-created-files.json). Reads never need this — only writes.
//
//   npm run gws:grant -- --id <fileId> [--kind spreadsheet|document] [--title "..."]
//   npm run gws:grant -- --list

import {
  listOwnedFiles,
  registerOwnedFile,
} from "../src/mcp-tools/gws-owned.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv.includes("--list")) {
  const files = listOwnedFiles();
  if (files.length === 0) {
    console.log("No agent-writable files yet.");
  } else {
    for (const f of files) {
      console.log(
        `- ${f.kind}  ${f.id}  ${f.title ?? ""}  (since ${f.created_at})`,
      );
    }
  }
  process.exit(0);
}

const id = arg("--id");
if (!id) {
  console.error(
    'usage: npm run gws:grant -- --id <fileId> [--kind spreadsheet|document] [--title "..."]',
  );
  process.exit(1);
}
const kind = arg("--kind") === "spreadsheet" ? "spreadsheet" : "document";
registerOwnedFile(id, kind, arg("--title"));
console.log(`Granted the agent write access to ${kind} ${id}.`);
