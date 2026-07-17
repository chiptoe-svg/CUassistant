// Daily refresh of Clemson per-term class snapshots.
//
// Discovers the live (registering) terms via Banner's getTerms — so newly
// published terms like Spring 2027 are picked up automatically — and writes a
// full-section snapshot to state/clemson/<term>.json for each. Past
// "(View Only)" terms are skipped (they never change). Run via
//   npm run clemson:refresh
// or the launchd plist in launchd/com.cuassistant.clemson-refresh.plist.

import {
  refreshLiveClemsonSnapshots,
  refreshClemsonSnapshot,
} from "../src/clemson-classes.js";

async function main() {
  // Explicit terms (e.g. `npm run clemson:refresh -- 202601 202505`) refresh
  // exactly those, regardless of View-Only status — used to backfill stable past
  // semesters that the live-term discovery deliberately skips. No args = the
  // normal daily job (discover + refresh the live/registering terms).
  const explicit = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  if (explicit.length > 0) {
    let failed = false;
    for (const term of explicit) {
      const snap = await refreshClemsonSnapshot(term);
      if (!snap) failed = true;
      console.log(
        `${term}: ${
          snap
            ? `${snap.sectionCount} sections (${snap.termDescription})`
            : "FAILED (snapshot left unchanged)"
        }`,
      );
    }
    if (failed) process.exitCode = 1;
    return;
  }

  const results = await refreshLiveClemsonSnapshots();
  if (results.length === 0) {
    console.log("No live terms found (getTerms unavailable?).");
    return;
  }
  for (const r of results) {
    console.log(
      `${r.term} ${r.description}: ${
        r.sections === null
          ? "FAILED (snapshot left unchanged)"
          : `${r.sections} sections`
      }`,
    );
  }
  if (results.some((r) => r.sections === null)) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
