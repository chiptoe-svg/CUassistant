// One-off / maintenance: rebuild per-term SQLite snapshots (state/clemson/<term>.db)
// from the legacy gzip-JSON snapshots (state/clemson/<term>.json.gz) already on
// disk — NO Banner pull. Use this to recover terms whose .db is missing after the
// JSON→SQLite migration, instead of re-scanning Banner (slow, rate-limited).
//
//   npm run clemson:convert            # convert only terms with no .db yet
//   npm run clemson:convert -- --force # rebuild every .db from its .json.gz
//
// The legacy files are plain gzip of a ClemsonTermSnapshot, so we gunzip + parse
// and hand the snapshot straight to writeScheduleDb (same schema the readers use).
import fs from "fs";
import path from "path";
import zlib from "zlib";

import { STATE_DIR } from "../src/config.js";
import { writeScheduleDb, scheduleDbPath } from "../src/clemson-schedule-db.js";
import type { ClemsonTermSnapshot } from "../src/clemson-classes.js";

const force = process.argv.includes("--force");
const dir = path.join(STATE_DIR, "clemson");

const gzFiles = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".json.gz"))
  .sort();

if (gzFiles.length === 0) {
  console.log(`No .json.gz snapshots found in ${dir}.`);
  process.exit(0);
}

for (const f of gzFiles) {
  const term = f.replace(/\.json\.gz$/, "");
  const dbPath = scheduleDbPath(term);
  if (!force && fs.existsSync(dbPath)) {
    console.log(`${term}: .db already exists — skipping (use --force to rebuild).`);
    continue;
  }
  try {
    const snap = JSON.parse(
      zlib.gunzipSync(fs.readFileSync(path.join(dir, f))).toString("utf8"),
    ) as ClemsonTermSnapshot;
    writeScheduleDb(snap);
    console.log(
      `${term}: wrote ${snap.sections.length} sections -> ${path.basename(dbPath)} ` +
        `(${JSON.stringify(snap.termDescription)}, snapshot ${snap.fetchedAt})`,
    );
  } catch (e) {
    console.log(`${term}: FAILED — ${(e as Error).message}`);
    process.exitCode = 1;
  }
}
