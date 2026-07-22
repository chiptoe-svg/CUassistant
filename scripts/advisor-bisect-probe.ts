// Bisect the degraded generation: replay the captured harness payload with one
// variable changed at a time, so "the endpoint is degraded, restart it" is only
// concluded after the things WE control have been ruled out.
//
// Usage: npx tsx scripts/advisor-bisect-probe.ts [trials]

import { readFileSync } from "node:fs";
import { ADVISOR_BASE_URL } from "../src/config.ts";

const trials = Number(process.argv[2] ?? 4);
const captured = JSON.parse(
  readFileSync("/tmp/advisor-payload.json", "utf8"),
) as Record<string, any>;

async function run(label: string, mutate: (p: Record<string, any>) => void) {
  let clean = 0;
  let degraded = 0;
  const notes: string[] = [];
  for (let i = 0; i < trials; i++) {
    const body = JSON.parse(JSON.stringify(captured));
    body.stream = true;
    mutate(body);
    const res = await fetch(`${ADVISOR_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer local" },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    let content = "";
    let toolCallDeltas = 0;
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
      if (c.delta?.content) content += c.delta.content;
      if (c.delta?.tool_calls) toolCallDeltas += c.delta.tool_calls.length;
      if (c.finish_reason) finish = c.finish_reason;
    }
    if (toolCallDeltas > 0) clean++;
    else degraded++;
    notes.push(`${finish}/${toolCallDeltas}tc/${content.length}ch`);
  }
  console.log(
    `${label.padEnd(42)} clean=${clean}/${trials} degraded=${degraded}/${trials}  [${notes.join(" ")}]`,
  );
}

await run("baseline (as the harness sends it)", () => {});
await run("system role instead of developer", (p) => {
  for (const m of p.messages) if (m.role === "developer") m.role = "system";
});
await run("no chat_template_kwargs", (p) => {
  delete p.chat_template_kwargs;
});
await run("enable_thinking:false", (p) => {
  p.chat_template_kwargs = { enable_thinking: false };
});
await run("no preserve_thinking", (p) => {
  p.chat_template_kwargs = { enable_thinking: true };
});
await run("only 1 tool", (p) => {
  p.tools = p.tools.slice(0, 1);
});
await run("only 4 tools", (p) => {
  p.tools = p.tools.slice(0, 4);
});
await run("no system/developer prompt", (p) => {
  p.messages = p.messages.filter((m: any) => m.role === "user");
});
await run("tool_choice:auto", (p) => {
  p.tool_choice = "auto";
});
