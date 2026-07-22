// Replay the EXACT payload the harness put on the wire (captured by
// scripts/advisor-live-check.ts into /tmp/advisor-payload.json) directly at the
// endpoint, optionally with an added max_tokens, and report which output
// channel the generation landed in.
//
// Usage: npx tsx scripts/advisor-replay-probe.ts [maxTokens] [trials]

import { readFileSync } from "node:fs";
import { ADVISOR_BASE_URL } from "../src/config.ts";

const maxTokens = process.argv[2] && process.argv[2] !== "none" ? Number(process.argv[2]) : undefined;
const trials = Number(process.argv[3] ?? 4);

const captured = JSON.parse(
  readFileSync("/tmp/advisor-payload.json", "utf8"),
) as Record<string, unknown>;

for (let i = 1; i <= trials; i++) {
  const body = { ...captured, stream: true } as Record<string, unknown>;
  if (maxTokens) body.max_tokens = maxTokens;
  else delete body.max_tokens;

  const res = await fetch(`${ADVISOR_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer local" },
    body: JSON.stringify(body),
  });
  const raw = await res.text();

  let reasoning = "";
  let content = "";
  let toolCallDeltas = 0;
  let finish: unknown = null;
  let usage: any = null;

  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (payload === "[DONE]") continue;
    let chunk: any;
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue;
    }
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.delta?.reasoning) reasoning += choice.delta.reasoning;
    if (choice.delta?.reasoning_content) reasoning += choice.delta.reasoning_content;
    if (choice.delta?.content) content += choice.delta.content;
    if (choice.delta?.tool_calls) toolCallDeltas += choice.delta.tool_calls.length;
    if (choice.finish_reason) finish = choice.finish_reason;
  }

  console.log(
    `trial ${i}: status=${res.status} finish=${JSON.stringify(finish)} ` +
      `completion_tokens=${usage?.completion_tokens} reasoning=${reasoning.length}ch ` +
      `content=${content.length}ch toolCallDeltas=${toolCallDeltas}`,
  );
  if (content.length) console.log(`   content head: ${JSON.stringify(content.slice(0, 200))}`);
}
