// Room seating capacity for Clemson classrooms.
//
// Banner's public "Browse Classes" feed carries no room capacity — it is not in
// searchResults at either the section or meetingTime level. The numbers here
// come from the SSO-gated CuSectionOverview report, exported by hand and
// committed under data/ as reference data.
//
// That is why this lives in data/ and not the gitignored state/: the nightly
// Banner refresh rebuilds everything in state/, and it cannot rebuild this. If
// state/ is wiped it regenerates; if this file is lost it needs another manual
// export from a system behind Clemson SSO.
//
// Capacity is a planning aid, never an authority. It is a point-in-time
// snapshot (see _source in the JSON), so a renovated or re-measured room goes
// quietly stale. Unknown rooms yield null — never 0, which would read as "this
// room seats nobody" rather than "we don't know".
//
// This is its own module rather than living in clemson-classes.ts because both
// the live-scan path (clemson-classes) and the snapshot path
// (clemson-schedule-db) build meetings, and clemson-classes already imports
// clemson-schedule-db — putting it in either would create a cycle.

import { readFileSync } from "node:fs";

import { log } from "./log.js";

let capacities: Map<string, number> | null = null;

function load(): Map<string, number> {
  if (capacities) return capacities;
  try {
    const raw = readFileSync(
      new URL("../data/clemson-room-capacity.json", import.meta.url),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { rooms?: Record<string, number> };
    capacities = new Map(Object.entries(parsed.rooms ?? {}));
  } catch (err) {
    // Degrade to "unknown everywhere" rather than failing every class search.
    log.warn("clemson room capacity data unavailable", { err: String(err) });
    capacities = new Map();
  }
  return capacities;
}

/**
 * Seats in `room` of `building`, or null when unknown.
 *
 * `building` is the Banner *description* ("Jordan Hall"), not the code
 * ("JORDAN"), because that is what both meeting paths already carry.
 */
export function roomCapacity(
  building: string | null,
  room: string | null,
): number | null {
  if (!building || !room) return null;
  return load().get(`${building}|${room}`) ?? null;
}

/** Test seam: drop the memoised table so a fixture can be re-read. */
export function resetRoomCapacityCache(): void {
  capacities = null;
}
