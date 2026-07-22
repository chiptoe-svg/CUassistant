// Narrow the degraded generation to a tool-list property: count, total schema
// size, or one specific offending tool.
//
// The two tools that can actually answer the probe question
// (list-clemson-terms, search-clemson-classes) are held in EVERY variant. A
// slice that omits them makes the model correctly decline to call anything,
// which is not degradation — an earlier version of this probe scored that as a
// failure and pointed at the wrong cause.
//
// Usage: npx tsx scripts/advisor-toolcount-probe.ts [trials]

import { readFileSync } from "node:fs";
import { ADVISOR_BASE_URL } from "../src/config.ts";

const trials = Number(process.argv[2] ?? 3);
const captured = JSON.parse(
  readFileSync("/tmp/advisor-payload.json", "utf8"),
) as Record<string, any>;

async function probe(label: string, tools: any[]) {
  let clean = 0;
  const notes: string[] = [];
  for (let i = 0; i < trials; i++) {
    const body = JSON.parse(JSON.stringify(captured));
    body.stream = true;
    body.tools = tools;
    const res = await fetch(`${ADVISOR_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer local" },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    let tc = 0;
    let finish: unknown = null;
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const p = line.slice(6).trim();
      if (p === "[DONE]") continue;
      let chunk: any;
      try {
        chunk = JSON.parse(p);
      } catch {
        continue;
      }
      const c = chunk.choices?.[0];
      if (!c) continue;
      if (c.delta?.tool_calls) tc += c.delta.tool_calls.length;
      if (c.finish_reason) finish = c.finish_reason;
    }
    if (tc > 0) clean++;
    notes.push(String(finish));
  }
  const bytes = JSON.stringify(tools).length;
  console.log(
    `${label.padEnd(38)} n=${String(tools.length).padStart(2)} ${String(bytes).padStart(6)}B  clean=${clean}/${trials}  [${notes.join(" ")}]`,
  );
}

const all = captured.tools as any[];
const keep = all.slice(0, 2); // list-clemson-terms, search-clemson-classes
const rest = all.slice(2);

for (const n of [0, 2, 4, 6, 8, 10, 15]) {
  await probe(`2 answering tools + ${n} others`, [...keep, ...rest.slice(0, n)]);
}
// Same COUNT as the full set, but the extra tools are byte-for-byte clones of a
// tool that is known clean, differing only in name. If count alone is the
// cause, this degrades like the real 17.
const clones = Array.from({ length: 15 }, (_, i) => ({
  ...keep[0],
  function: { ...keep[0].function, name: `filler_tool_${i}` },
}));
await probe("2 answering tools + 15 clones", [...keep, ...clones]);
