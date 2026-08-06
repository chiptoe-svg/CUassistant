# Schedule Visualizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render a schedule as an inline weekly time-grid in the advisor chat, via a reusable pure renderer and a generic sandboxed artifact frame.

**Architecture:** A new pure module `src/schedule-grid.ts` holds the normalized `ScheduleView` type, an adapter from the existing `CheckedSchedule`, and `renderScheduleGrid` (self-contained HTML). The server builds that HTML from `session.lastSchedule` when `propose_schedule` ran and adds it to the `/chat` JSON as an `artifact`. The client mounts it in a `<iframe sandbox srcdoc>` — the page stays `innerHTML`-free; the artifact runs only inside the isolated frame.

**Tech Stack:** TypeScript, Node built-in test runner (`node:test`) run with `npx tsx --test`. No new dependencies.

## Global Constraints

- **No new dependencies.** Pure TS + existing patterns only.
- **Tests run with:** `npx tsx --test <file>`; full suite `npm test`. Keep the suite green.
- **Self-contained HTML:** `renderScheduleGrid` output must have **no external URLs** (inline `<style>` only) so it works in an iframe, an export, or a page.
- **Page stays `innerHTML`-free:** the artifact HTML is only ever assigned to `iframe.srcdoc` (a property). Never `element.innerHTML = …` in `advisor-ui.ts`.
- **Sandbox posture (v1):** the iframe uses `sandbox=""` (empty — no scripts, no same-origin). **No `allow-scripts`.**
- **Model never writes HTML:** the agent supplies structured data; the host renders. `renderScheduleGrid` is only ever called host-side.
- **Day letters:** `M T W R F S U` (R = Thursday, U = Sunday). Meeting times arrive as `"HHMM"` 4-digit strings; non-4-digit (`""`, `"TBA"`) means untimed.
- **v1 producer:** `propose_schedule` only. Navigator-paste-to-grid and `/export` swap are out of scope (fast-follows).
- **Commit trailers** (every commit):
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_016khb3pm2aUNjYtxT8Bk6bx
  ```

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/schedule-grid.ts` | `ScheduleView`/`ScheduleEntry` types, helpers (`parseHhmm`, `gridBounds`, `findConflicts`, `hueFor`), `checkedScheduleToView`, `renderScheduleGrid`, `scheduleGridHeightPx` |
| Create | `test/schedule-grid.test.ts` | Unit tests for the adapter + renderer (pure, no DOM) |
| Modify | `src/advisor-artifacts.ts` | Export the existing `esc` helper for reuse |
| Modify | `src/advisor-server.ts:537-545` | Add `artifact` to the `/chat` response |
| Modify | `test/advisor-server.test.ts` | Assert the response carries the artifact when a schedule exists |
| Modify | `src/advisor-ui.ts` | `mountArtifact` (sandboxed iframe) + wire into the answer render + CSS |
| Modify | `test/advisor-ui.test.ts` | Assert a sandboxed, script-free iframe is mounted via `srcdoc` |

---

### Task 1: `ScheduleView` types, helpers, and the `CheckedSchedule` adapter

**Files:**
- Create: `src/schedule-grid.ts`
- Create: `test/schedule-grid.test.ts`
- Modify: `src/advisor-artifacts.ts` (export `esc`)

**Interfaces:**
- Consumes: `ProposedSection` + `esc` from `src/advisor-artifacts.ts`; `CheckedSchedule` from `src/advisor-schedule-verify.ts` (it extends `ProposedSchedule` with `verifiedAgainst`).
- Produces:
  ```ts
  export interface ScheduleEntry {
    label: string; title?: string; days: string;
    startMin?: number; endMin?: number; room?: string;
    credits?: number; colorKey?: string;
  }
  export interface ScheduleView { term: string; entries: ScheduleEntry[]; }
  export function parseHhmm(t: string): number | null;
  export function checkedScheduleToView(s: CheckedSchedule): ScheduleView;
  ```

- [ ] **Step 1: Export `esc` from advisor-artifacts.ts**

In `src/advisor-artifacts.ts`, change `function esc(` to `export function esc(` (line ~153). No other change.

- [ ] **Step 2: Write the failing test**

Create `test/schedule-grid.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { parseHhmm, checkedScheduleToView } from "../src/schedule-grid.ts";
import type { CheckedSchedule } from "../src/advisor-schedule-verify.ts";

test("parseHhmm converts 4-digit Banner times to minutes; else null", () => {
  assert.equal(parseHhmm("1430"), 870);
  assert.equal(parseHhmm("0800"), 480);
  assert.equal(parseHhmm("TBA"), null);
  assert.equal(parseHhmm(""), null);
});

const SCHED: CheckedSchedule = {
  term: "202608",
  verifiedAgainst: "2026-08-01",
  notes: null,
  sections: [
    { crn: "80763", subjectCourse: "GC 1010", section: "001", title: "Orientation",
      creditHours: 1, days: "MWF", beginTime: "1430", endTime: "1545",
      building: "Godfrey", room: "201" },
    { crn: "88888", subjectCourse: "CU 1000", section: "005", title: "Connect",
      creditHours: 0, days: "", beginTime: "TBA", endTime: "TBA",
      building: null, room: null },
  ],
};

test("checkedScheduleToView maps sections, splits times, derives room + colorKey", () => {
  const view = checkedScheduleToView(SCHED);
  assert.equal(view.term, "202608");
  assert.equal(view.entries.length, 2);
  const gc = view.entries[0];
  assert.equal(gc.label, "GC 1010 001");
  assert.equal(gc.days, "MWF");
  assert.equal(gc.startMin, 870);
  assert.equal(gc.endMin, 945);
  assert.equal(gc.room, "Godfrey 201");
  assert.equal(gc.credits, 1);
  assert.equal(gc.colorKey, "GC");
  // Untimed section: no start/end, empty days preserved.
  const cu = view.entries[1];
  assert.equal(cu.startMin, undefined);
  assert.equal(cu.days, "");
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx tsx --test test/schedule-grid.test.ts`
Expected: FAIL — cannot find module `../src/schedule-grid.ts`.

- [ ] **Step 4: Write the module (types + helpers + adapter)**

Create `src/schedule-grid.ts`:

```ts
// Pure schedule → weekly-grid renderer. No DOM, no network, no external assets:
// the HTML it returns is self-contained so it can be shown in a sandboxed iframe
// (inline chat), served as an export, or opened as a page. Called host-side only.

import { esc, type ProposedSection } from "./advisor-artifacts.js";
import type { CheckedSchedule } from "./advisor-schedule-verify.js";

export interface ScheduleEntry {
  label: string;        // e.g. "GC 1010 001"
  title?: string;
  days: string;         // "MWF"; "" = untimed
  startMin?: number;    // minutes since midnight; undefined = untimed
  endMin?: number;
  room?: string;
  credits?: number;
  colorKey?: string;    // stable hue seed (subject) so a course keeps its color
}
export interface ScheduleView {
  term: string;
  entries: ScheduleEntry[];
}

/** "1430" -> 870 minutes; anything not HHMM (e.g. "TBA", "") -> null. */
export function parseHhmm(t: string): number | null {
  if (!/^\d{4}$/.test(t)) return null;
  return Number(t.slice(0, 2)) * 60 + Number(t.slice(2));
}

function roomOf(s: ProposedSection): string | undefined {
  if (!s.building) return undefined;
  return `${s.building} ${s.room ?? ""}`.trim();
}

export function checkedScheduleToView(s: CheckedSchedule): ScheduleView {
  return {
    term: s.term,
    entries: s.sections.map((sec) => {
      const startMin = parseHhmm(sec.beginTime);
      const endMin = parseHhmm(sec.endTime);
      const entry: ScheduleEntry = {
        label: `${sec.subjectCourse} ${sec.section}`,
        title: sec.title,
        days: sec.days,
        room: roomOf(sec),
        credits: sec.creditHours,
        colorKey: sec.subjectCourse.split(" ")[0] || sec.subjectCourse,
      };
      if (startMin != null) entry.startMin = startMin;
      if (endMin != null) entry.endMin = endMin;
      return entry;
    }),
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx --test test/schedule-grid.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/schedule-grid.ts test/schedule-grid.test.ts src/advisor-artifacts.ts
git commit -m "$(printf 'feat(schedule-grid): ScheduleView types + CheckedSchedule adapter\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_016khb3pm2aUNjYtxT8Bk6bx')"
```

---

### Task 2: `renderScheduleGrid` + `scheduleGridHeightPx`

**Files:**
- Modify: `src/schedule-grid.ts`
- Modify: `test/schedule-grid.test.ts`

**Interfaces:**
- Consumes: `ScheduleView`, `ScheduleEntry`, `parseHhmm` from Task 1; `esc` from `advisor-artifacts`.
- Produces:
  ```ts
  export function gridBounds(entries: ScheduleEntry[]): { days: string[]; startMin: number; endMin: number };
  export function findConflicts(entries: ScheduleEntry[]): Set<number>; // indices in conflict
  export function scheduleGridHeightPx(view: ScheduleView): number;
  export function renderScheduleGrid(view: ScheduleView): string;
  ```

Constants (module-scope): `const DAY_ORDER = ["M","T","W","R","F","S","U"] as const;` `const DAY_LABEL: Record<string,string> = { M:"Mon", T:"Tue", W:"Wed", R:"Thu", F:"Fri", S:"Sat", U:"Sun" };` `const PX_PER_HOUR = 44; const HEADER_PX = 34; const CAPTION_PX = 44;`

- [ ] **Step 1: Write the failing tests**

Append to `test/schedule-grid.test.ts`:

```ts
import { gridBounds, findConflicts, renderScheduleGrid, scheduleGridHeightPx } from "../src/schedule-grid.ts";
import type { ScheduleView } from "../src/schedule-grid.ts";

const VIEW: ScheduleView = {
  term: "Fall 2026",
  entries: [
    { label: "GC 1010 001", days: "MWF", startMin: 870, endMin: 945, credits: 1, colorKey: "GC" }, // 14:30-15:45
    { label: "GC 1040 001", days: "TR", startMin: 750, endMin: 825, credits: 3, colorKey: "GC" },   // 12:30-13:45
    { label: "GC 1041 002", days: "T",  startMin: 780, endMin: 825, credits: 0, colorKey: "GC" },    // 13:00-13:45 (overlaps GC1040 on T)
    { label: "CU 1000 005", days: "",   credits: 0, colorKey: "CU" },                                 // untimed
  ],
};

test("gridBounds covers only used days and snaps to the hour", () => {
  const b = gridBounds(VIEW.entries);
  assert.deepEqual(b.days, ["M", "T", "W", "R", "F"]); // no S/U — unused
  assert.equal(b.startMin, 720); // 12:00 (floor of 12:30)
  assert.equal(b.endMin, 960);   // 16:00 (ceil of 15:45)
});

test("findConflicts flags the T overlap (GC 1040 vs GC 1041), nothing else", () => {
  const c = findConflicts(VIEW.entries);
  assert.ok(c.has(1) && c.has(2), "the two Tuesday-overlapping entries are flagged");
  assert.ok(!c.has(0), "GC 1010 does not conflict");
});

test("renderScheduleGrid is self-contained and places timed blocks + an unscheduled list", () => {
  const html = renderScheduleGrid(VIEW);
  assert.match(html, /^<!DOCTYPE html>/);
  assert.doesNotMatch(html, /https?:\/\//, "no external URLs — must be self-contained");
  assert.match(html, /GC 1010 001/);
  assert.match(html, /Fall 2026/);
  // Untimed section shown separately, not on the grid.
  assert.match(html, /Unscheduled/);
  assert.match(html, /CU 1000 005/);
  // Conflict surfaced.
  assert.match(html, /conflict/i);
  // Credits caption: 1 + 3 + 0 + 0 = 4.
  assert.match(html, /4 credit/);
});

test("scheduleGridHeightPx grows with the time span", () => {
  const tall = scheduleGridHeightPx(VIEW);
  const shortView: ScheduleView = { term: "x", entries: [
    { label: "A 1 001", days: "M", startMin: 540, endMin: 600, colorKey: "A" }] };
  assert.ok(tall > scheduleGridHeightPx(shortView));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test test/schedule-grid.test.ts`
Expected: FAIL — `gridBounds`/`renderScheduleGrid`/etc. not exported.

- [ ] **Step 3: Implement the renderer**

Append to `src/schedule-grid.ts`:

```ts
const DAY_ORDER = ["M", "T", "W", "R", "F", "S", "U"] as const;
const DAY_LABEL: Record<string, string> = {
  M: "Mon", T: "Tue", W: "Wed", R: "Thu", F: "Fri", S: "Sat", U: "Sun",
};
const PX_PER_HOUR = 44;
const HEADER_PX = 34;
const CAPTION_PX = 44;

function isTimed(e: ScheduleEntry): boolean {
  return !!e.days && e.startMin != null && e.endMin != null;
}

/** Used days (Mon–Fri always shown; Sat/Sun only if used) + hour-snapped bounds. */
export function gridBounds(entries: ScheduleEntry[]): { days: string[]; startMin: number; endMin: number } {
  const timed = entries.filter(isTimed);
  const used = new Set<string>();
  let lo = Infinity;
  let hi = -Infinity;
  for (const e of timed) {
    for (const d of e.days) if (DAY_LABEL[d]) used.add(d);
    lo = Math.min(lo, e.startMin as number);
    hi = Math.max(hi, e.endMin as number);
  }
  const base = ["M", "T", "W", "R", "F"];
  const days = DAY_ORDER.filter((d) => base.includes(d) || used.has(d));
  if (!Number.isFinite(lo)) return { days, startMin: 8 * 60, endMin: 17 * 60 };
  return {
    days,
    startMin: Math.floor(lo / 60) * 60,
    endMin: Math.ceil(hi / 60) * 60,
  };
}

/** Indices of entries that share a day and overlap in time. */
export function findConflicts(entries: ScheduleEntry[]): Set<number> {
  const hit = new Set<number>();
  const idx = entries.map((e, i) => i).filter((i) => isTimed(entries[i]));
  for (let a = 0; a < idx.length; a++) {
    for (let b = a + 1; b < idx.length; b++) {
      const x = entries[idx[a]];
      const y = entries[idx[b]];
      const sharedDay = [...x.days].some((d) => y.days.includes(d));
      if (!sharedDay) continue;
      if ((x.startMin as number) < (y.endMin as number) && (y.startMin as number) < (x.endMin as number)) {
        hit.add(idx[a]);
        hit.add(idx[b]);
      }
    }
  }
  return hit;
}

function hueFor(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
  return h;
}

function minLabel(min: number): string {
  const h24 = Math.floor(min / 60);
  const m = min % 60;
  const ampm = h24 < 12 ? "am" : "pm";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return m === 0 ? `${h12}${ampm}` : `${h12}:${String(m).padStart(2, "0")}${ampm}`;
}

export function scheduleGridHeightPx(view: ScheduleView): number {
  const b = gridBounds(view.entries);
  const hours = (b.endMin - b.startMin) / 60;
  return HEADER_PX + hours * PX_PER_HOUR + CAPTION_PX;
}

export function renderScheduleGrid(view: ScheduleView): string {
  const b = gridBounds(view.entries);
  const conflicts = findConflicts(view.entries);
  const span = b.endMin - b.startMin;
  const bodyPx = (span / 60) * PX_PER_HOUR;
  const credits = view.entries.reduce((n, e) => n + (e.credits ?? 0), 0);

  // Hour gridlines + labels.
  const hourMarks: string[] = [];
  for (let m = b.startMin; m <= b.endMin; m += 60) {
    const top = ((m - b.startMin) / span) * bodyPx;
    hourMarks.push(
      `<div class="hour" style="top:${top}px"><span>${esc(minLabel(m))}</span></div>`,
    );
  }

  // Blocks per day column.
  const columns = b.days.map((day) => {
    const blocks = view.entries
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => isTimed(e) && e.days.includes(day))
      .map(({ e, i }) => {
        const top = (((e.startMin as number) - b.startMin) / span) * bodyPx;
        const height = (((e.endMin as number) - (e.startMin as number)) / span) * bodyPx;
        const hue = hueFor(e.colorKey ?? e.label);
        const conflict = conflicts.has(i) ? " conflict" : "";
        const room = e.room ? `<div class="room">${esc(e.room)}</div>` : "";
        return `<div class="block${conflict}" style="top:${top}px;height:${Math.max(height, 16)}px;` +
          `background:hsl(${hue} 70% 92%);border-color:hsl(${hue} 55% 62%)">` +
          `<div class="code">${esc(e.label)}</div>` +
          `<div class="when">${esc(minLabel(e.startMin as number))}–${esc(minLabel(e.endMin as number))}</div>` +
          `${room}</div>`;
      })
      .join("");
    return `<div class="col"><div class="colhead">${esc(DAY_LABEL[day])}</div>` +
      `<div class="colbody" style="height:${bodyPx}px">${blocks}</div></div>`;
  }).join("");

  const untimed = view.entries.filter((e) => !isTimed(e));
  const untimedHtml = untimed.length
    ? `<div class="unscheduled"><strong>Unscheduled (no meeting time):</strong> ` +
      untimed.map((e) => esc(e.label)).join(", ") + `</div>`
    : "";

  const conflictNote = conflicts.size
    ? `<span class="warn">${conflicts.size / 2} conflict${conflicts.size === 2 ? "" : "s"}</span>`
    : "";

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<style>
  :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 8px; color: #1f2428; }
  @media (prefers-color-scheme: dark) { body { color: #e8eaed; } }
  .cap { font-size: 13px; margin-bottom: 6px; display: flex; gap: 10px; align-items: baseline; }
  .warn { color: #b3261e; font-weight: 700; }
  .grid { display: flex; border: 1px solid #8884; border-radius: 6px; overflow: hidden; }
  .axis { width: 52px; position: relative; border-right: 1px solid #8884; }
  .axis .pad { height: ${HEADER_PX}px; }
  .axis .body { position: relative; }
  .hour { position: absolute; left: 0; right: 0; border-top: 1px solid #8883; font-size: 10px; color: #8a9097; }
  .hour span { position: absolute; top: -6px; left: 4px; background: transparent; }
  .col { flex: 1 1 0; border-left: 1px solid #8883; position: relative; min-width: 0; }
  .colhead { height: ${HEADER_PX}px; display: flex; align-items: center; justify-content: center;
             font-weight: 650; font-size: 12px; border-bottom: 1px solid #8884; }
  .colbody { position: relative; }
  .block { position: absolute; left: 2px; right: 2px; border: 1px solid; border-radius: 5px;
           padding: 2px 4px; overflow: hidden; font-size: 11px; line-height: 1.15; color: #1f2428; }
  .block.conflict { outline: 2px solid #b3261e; }
  .block .code { font-weight: 700; }
  .block .when, .block .room { font-size: 10px; opacity: .8; }
  .unscheduled { margin-top: 8px; font-size: 12px; color: #687078; }
</style></head>
<body>
  <div class="cap"><strong>${esc(view.term)}</strong>
    <span>${view.entries.length} section${view.entries.length === 1 ? "" : "s"}, ${credits} credit${credits === 1 ? "" : "s"}</span>
    ${conflictNote}</div>
  <div class="grid">
    <div class="axis"><div class="pad"></div><div class="body" style="height:${bodyPx}px">${hourMarks.join("")}</div></div>
    ${columns}
  </div>
  ${untimedHtml}
</body></html>`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test test/schedule-grid.test.ts`
Expected: PASS (all 7 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/schedule-grid.ts test/schedule-grid.test.ts
git commit -m "$(printf 'feat(schedule-grid): renderScheduleGrid weekly time-grid + conflict/untimed handling\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_016khb3pm2aUNjYtxT8Bk6bx')"
```

---

### Task 3: Emit the artifact in the `/chat` response

**Files:**
- Modify: `src/advisor-server.ts` (import + the response object at ~537-545)
- Modify: `test/advisor-server.test.ts`

**Interfaces:**
- Consumes: `renderScheduleGrid`, `scheduleGridHeightPx`, `checkedScheduleToView` from `src/schedule-grid.ts`; `session.lastSchedule: CheckedSchedule | undefined`.
- Produces: `/chat` JSON gains `artifact?: { kind: "schedule"; html: string; height: number }`.

- [ ] **Step 1: Write the failing test**

In `test/advisor-server.test.ts`, add a test that drives a turn whose result sets `session.lastSchedule` and asserts the response includes `artifact`. Follow the file's existing harness for POSTing `/chat` with an injected turn runner; set the runner so the session's `lastSchedule` is populated (mirror how the existing `schedule: true` test arranges it), then:

```ts
// after awaiting the /chat POST whose turn populated lastSchedule:
assert.equal(body.schedule, true);
assert.ok(body.artifact, "response carries an inline artifact");
assert.equal(body.artifact.kind, "schedule");
assert.match(body.artifact.html, /<!DOCTYPE html>/);
assert.equal(typeof body.artifact.height, "number");
```

(If no existing test populates `lastSchedule`, construct one `CheckedSchedule` on the session in the test's deps exactly as the current `schedule`-flag test does — reuse that arrangement so this test only adds the `artifact` assertions.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/advisor-server.test.ts`
Expected: FAIL — `body.artifact` is undefined.

- [ ] **Step 3: Add the artifact to the response**

In `src/advisor-server.ts`, add the import near the other artifact imports (the file already imports `renderSchedule` from `./advisor-artifacts.js`):

```ts
import { renderScheduleGrid, scheduleGridHeightPx, checkedScheduleToView } from "./schedule-grid.js";
```

Then change the `/chat` response object (currently ending with `schedule: Boolean(session.lastSchedule),`) to:

```ts
        return json(res, 200, {
          text: withOutcomeNote(result),
          toolCalls: result.toolCalls,
          outcome: result.outcome,
          schedule: Boolean(session.lastSchedule),
          artifact: session.lastSchedule
            ? {
                kind: "schedule" as const,
                html: renderScheduleGrid(checkedScheduleToView(session.lastSchedule)),
                height: scheduleGridHeightPx(checkedScheduleToView(session.lastSchedule)),
              }
            : undefined,
        });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/advisor-server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/advisor-server.ts test/advisor-server.test.ts
git commit -m "$(printf 'feat(advisor): emit inline schedule artifact in the /chat response\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_016khb3pm2aUNjYtxT8Bk6bx')"
```

---

### Task 4: Mount the artifact inline as a sandboxed iframe (client)

**Files:**
- Modify: `src/advisor-ui.ts` (CSS in the `<style>` block, a `mountArtifact` helper, and the submit handler)
- Modify: `test/advisor-ui.test.ts`

**Interfaces:**
- Consumes: the `/chat` response `data.artifact = { kind, html, height }`; the existing `addAnswer(role, text)` which returns the answer `<article>` element.
- Produces: nothing consumed downstream (leaf behavior).

**Context — the template doubles backslashes** (e.g. regexes use `\\d`). The strings below contain none, so no doubling is needed here.

- [ ] **Step 1: Write the failing test**

In `test/advisor-ui.test.ts`, add a test using the existing `runChatSubmit(responseBody, userMessage?)` harness. Pass a response body carrying an artifact and assert a sandboxed iframe was mounted (the fake `document.createElement` returns a `FakeElement`; extend the harness's fake element to record `setAttribute`/property sets if needed — the existing `makeElement` already tracks `setAttribute` for `data-*`; add capture for `sandbox`/`srcdoc` in this test's element or assert via the created children):

```ts
test("an artifact in the response mounts a sandboxed, script-free iframe via srcdoc", async () => {
  const html = "<!DOCTYPE html><html><body>grid</body></html>";
  const { elements } = await runChatSubmit({
    text: "Here is your schedule.",
    artifact: { kind: "schedule", html, height: 400 },
  });
  const agent = elements.answers.children.find((a) =>
    a.children.some((c) => c.tagName === "h2" && String(c.textContent).indexOf("Advisor chat") === 0),
  );
  assert.ok(agent, "expected an assistant article");
  const frame = agent!.children.find((c) => c.tagName === "iframe");
  assert.ok(frame, "expected an <iframe> artifact");
  assert.equal(frame!.attrs?.sandbox, "", "sandbox must be empty (no scripts)");
  assert.doesNotMatch(String(frame!.attrs?.sandbox ?? ""), /allow-scripts/);
  assert.equal(frame!.value, html, "content set via srcdoc property, not page innerHTML");
});
```

To support this, extend `makeElement` in `test/advisor-ui.test.ts`: add an `attrs: Record<string,string>` field and have `setAttribute(name, value)` also store `this.attrs[name] = value`; and let the test read `frame.value` as the `srcdoc` (the client sets `frame.srcdoc = html`, and the fake element stores property writes on `value` only if named `value` — instead, in `mountArtifact` set `frame.setAttribute("srcdoc", html)` so the fake records it in `attrs`, and assert `frame.attrs.srcdoc === html`). Adjust the assertion to `assert.equal(frame!.attrs?.srcdoc, html)`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/advisor-ui.test.ts`
Expected: FAIL — no iframe mounted.

- [ ] **Step 3: Add CSS, `mountArtifact`, and wire it in**

In `src/advisor-ui.ts` `<style>` block, add:

```css
  #answers iframe.artifact { width:100%; border:1px solid #8884; border-radius:8px;
    margin:.4rem 0 .2rem; background:#fff; }
  @media (prefers-color-scheme: dark) { #answers iframe.artifact { background:#1c2024; } }
```

Add the helper (near `addAnswer`):

```js
// Mount a host-rendered artifact as a SANDBOXED iframe. sandbox="" is maximally
// restricted (no scripts, no same-origin), so arbitrary HTML/CSS is safe. Content
// is set via setAttribute("srcdoc", …) — it runs only inside the isolated frame;
// the page itself never uses innerHTML.
function mountArtifact(container, artifact) {
  if (!artifact || !artifact.html) return;
  const frame = document.createElement("iframe");
  frame.className = "artifact";
  frame.setAttribute("sandbox", "");
  frame.setAttribute("title", artifact.kind === "schedule" ? "Weekly schedule" : "Artifact");
  frame.setAttribute("srcdoc", artifact.html);
  if (artifact.height) frame.style.height = artifact.height + "px";
  container.appendChild(frame);
}
```

In the submit handler, where the answer is appended (`addAnswer("Advisor chat", data.text)`), capture the returned article and mount the artifact:

```js
      const article = addAnswer("Advisor chat", data.text);
      if (data.artifact) mountArtifact(article, data.artifact);
```

(Apply the same for the aborted branch only if desired; v1: only the normal "Advisor chat" branch mounts artifacts.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/advisor-ui.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; suite green.

- [ ] **Step 6: Commit**

```bash
git add src/advisor-ui.ts test/advisor-ui.test.ts
git commit -m "$(printf 'feat(advisor-ui): mount inline schedule as a sandboxed srcdoc iframe\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_016khb3pm2aUNjYtxT8Bk6bx')"
```

---

## Deployment

The chat page and `/chat` response are generated by the advisor daemon, so after Task 3/4 land, **restart the advisor daemon** (port 8770) to serve the new response + client:

```bash
launchctl kickstart -k gui/$(id -u)/com.cuassistant.advisor
```

Then hard-refresh the chat; ask the agent for a schedule (it calls `propose_schedule`) and confirm the weekly grid renders inline. No MCP tool/policy changes → 8765/8766/8767 do not restart.

## Notes for later phases (out of scope here)

- **Navigator paste → grid:** add `navigatorToView(cleaned)` and a producer path; reuse `renderScheduleGrid`.
- **`/export/schedule` swap:** point its body at `renderScheduleGrid` (same function) for a visual printable.
- **Interactivity:** flip that artifact kind to `sandbox="allow-scripts"`, ship JS in the `srcdoc`, and add the `postMessage` `{ artifact:"schedule", action, crn }` channel relayed to the agent.
```
