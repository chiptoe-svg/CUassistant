# Schedule Visualizer — Design

**Goal:** Give the advisor chat a **weekly time-grid** view of a schedule so a student can *see* the shape and conflicts of a semester (and, later, the impact of changing it) instead of reading a table.

**Status:** Design approved; ready for implementation planning.

## Context

- The agent already produces schedules: `propose_schedule` (a host tool) hands the host a validated `CheckedSchedule` (`src/advisor-artifacts.ts`), which today renders as a **printable table** at `GET /export/schedule` (`renderSchedule`). Each section already carries `days` ("MWF"), `beginTime`, `endTime`, room, title, CRN, `creditHours`.
- The schedule **cleaner** we just shipped parses pastes into structured courses; the **Navigator** module (`advisor/cleaner/modules/navigator-schedule.js`) yields `days`/`time`/`room` — griddable. The **Banner "Advising Profile"** module has no meeting times.
- The chat renderer (`src/advisor-ui.ts`, `renderMarkdown`/`addAnswer`) is deliberately **`createElement`/`textContent`-only — never `innerHTML`** (a load-bearing XSS property, since the pane shows agent output *and* user input).

## Decisions

1. **Reusable renderer, not a schedule-only widget:** a pure `renderScheduleGrid(view) → self-contained HTML`, surface-agnostic (inline chat, `/export`, standalone page all consume it).
2. **Inline display = a generic sandboxed artifact frame** (`<iframe sandbox srcdoc>`), reusable for any future artifact — not just schedules.
3. **Model never writes HTML:** the agent hands *structured data*; the host validates and renders (same philosophy as today's `propose_schedule`).
4. **v1 is static** (sandbox with **no** `allow-scripts`); interactivity is a designed-for future phase, not built now.
5. **First producer:** `propose_schedule`. `/export/schedule` and a standalone page are fast-follows reusing the renderer.

## Non-goals (v1)

- No interactivity (drag-to-swap, live edits) — only the seam is reserved.
- No standalone page or `/export` swap in v1 (fast-follows).
- No new schedule *data* — only a new render of data we already have.
- No auto-gridding of entries without meeting times (shown as an "unscheduled" list).

---

## Architecture (three separable pieces)

```
agent → propose_schedule(structured data)
      → HOST: validate → renderScheduleGrid(view) → self-contained HTML
      → chat response carries { artifact: { kind:"schedule", html, height } }
      → CLIENT mounts <iframe sandbox srcdoc=html> via the .srcdoc property
```

### 1. `renderScheduleGrid(view: ScheduleView): string`
Pure function (mirrors `renderSchedule`), lives in `src/advisor-artifacts.ts` (or a new `src/schedule-grid.ts`). Returns standalone HTML: `<style>` + a weekly grid — Mon–Fri columns (Sat only if any entry uses it), a time axis spanning the earliest→latest meeting, course **blocks** absolutely positioned by `start`/`end`, **overlaps highlighted** as conflicts, and a caption (section count + total credits). No JS, no external assets — self-contained so it works in an iframe, an export, or a page. Theme-aware + print-friendly.

### 2. Inline artifact frame (client, `src/advisor-ui.ts`)
A generic helper `mountArtifact(container, { kind, html, height })` that appends a **sandboxed iframe** whose content is `html`:
- Set content via `iframe.srcdoc = html` (a property assignment — the *page* stays `innerHTML`-free; the artifact runs only *inside* the isolated frame).
- `sandbox=""` (empty = maximally restricted: no scripts, no same-origin, no forms) in v1.
- Height from the artifact payload (a computed fixed height for a grid).
- Reusable for any `{kind, html, height}` artifact, not schedule-specific.

### 3. `ScheduleView` contract (the normalized input)
```ts
interface ScheduleEntry {
  label: string;      // e.g. "GC 1010 001"
  title?: string;
  days: string;       // "MWF" (letters M T W R F S U); "" = no meeting time
  start?: string;     // "14:30" (24h) or null when unscheduled
  end?: string;       // "15:45"
  room?: string;
  colorKey?: string;  // stable hue seed (e.g. subject) so a course keeps its color
}
interface ScheduleView { term: string; entries: ScheduleEntry[]; }
```
Adapters map existing shapes onto it (both pure, unit-testable):
- `checkedScheduleToView(s: CheckedSchedule): ScheduleView` — from a proposed schedule.
- `navigatorToView(cleaned): ScheduleView` — from a Navigator cleaner result (has days/times).

---

## Data flow (preserves page XSS-safety)

1. Agent calls `propose_schedule` with structured section data (as today).
2. Host builds a `CheckedSchedule`, then `checkedScheduleToView` → `renderScheduleGrid` → HTML; stores it on the session (like `lastSchedule`).
3. The chat response JSON gains `artifact: { kind:"schedule", html, height }`.
4. Client’s answer-render path calls `mountArtifact` → sandboxed iframe. The page never `innerHTML`s the artifact; it only assigns `iframe.srcdoc`.

`/export/schedule` continues to work and can switch its body to `renderScheduleGrid` in a fast-follow (same function).

---

## Future-interactivity seam (reserved, not built)

- **Sandbox flag:** an interactive artifact kind flips to `sandbox="allow-scripts"` and ships JS in its `srcdoc`. v1 keeps `sandbox=""`.
- **Action channel:** define (but do not implement) a `postMessage` envelope `{ artifact:"schedule", action:"swap"|"drop", crn }` from frame → parent; the client would relay it to the agent as a follow-up turn. v1 documents the shape only.
- **Height channel:** interactive artifacts can post their content height; v1 uses a computed fixed height and needs no channel.

Keeping these as named extension points means interactivity is additive later, not a rewrite.

---

## Edge / error handling

- **No meeting times** (Banner Advising Profile, or a TBA section): entries with empty `days`/`start` are **not** placed on the grid — rendered as an "Unscheduled / needs times" list beneath it. Never silently dropped.
- **Overlaps:** two entries sharing a day+time window are drawn as overlapping/striped blocks and counted in a "conflicts" note — the core value.
- **Empty or invalid view:** a plain "nothing to show" state inside the frame; never a broken/blank iframe.
- **Odd times / cross-noon / evening:** the time axis is derived from the actual min/max meeting times, so it adapts rather than assuming 8–5.

---

## Testing

- **`renderScheduleGrid`** (pure, fixture-driven, no DOM/network): a MWF 14:30–15:45 block lands on the right day columns and vertical offset; two overlapping entries are flagged as a conflict; a no-times entry appears in the unscheduled list, not the grid; caption shows correct section count + credit sum; output is self-contained (no external URLs).
- **Adapters:** `checkedScheduleToView` / `navigatorToView` map representative inputs to the expected `ScheduleView`.
- **Inline frame** (client, via the existing vm-based `renderChatPage` test harness): a response carrying `artifact` mounts an iframe with `sandbox` set and `srcdoc` assigned (assert the page did **not** use `innerHTML`, and that `allow-scripts` is absent in v1).
- **Producer:** `propose_schedule` structured input → non-empty artifact HTML in the response.

## Success criterion

For a proposed (or Navigator-parsed) schedule with meeting times, the advisor sees an inline weekly grid that correctly places every timed section, highlights any conflict, lists any untimed section separately, and runs in a script-free sandboxed frame — with the same renderer ready to power `/export` and a standalone page.
