// Daily refresh of Clemson per-term class snapshots.
//
// Discovers the live (registering) terms via Banner's getTerms — so newly
// published terms like Spring 2027 are picked up automatically — and writes a
// full-section snapshot to state/clemson/<term>.json for each. Past
// "(View Only)" terms are skipped (they never change). Run via
//   npm run clemson:refresh
// or the launchd plist in launchd/com.cuassistant.clemson-refresh.plist.

import { refreshLiveClemsonSnapshots } from "../src/clemson-classes.js";

async function main() {
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
