// Checks detectMalformedToolCall against generations captured LIVE from the
// spark endpoint while it was in the degraded state, rather than against
// hand-written samples that might only match the detector by construction.

import { detectMalformedToolCall, initAdvisorTools, advisorToolNames, shutdownAdvisorTools } from "../src/advisor-agent.ts";

const LIVE_SAMPLES = [
  '\n\n<tool_call>\n{"name": "cu_public__search-clemson-classes", "parameters": {"term": "202608", "subject": "CPSC", "max": 500}}\n{"name": "cu_public__list-clemson-terms", "parameters": {"max": 10}}\n',
  '\n\n<tool_call>\n{"type": "function", "name": "cu_public__list-clemson-terms", "parameters": {"max": 10}}\n</tool_call>',
  '\n\n<tool_call>\n{"type": "function", "function": {"name": "cu_public__list-clemson-terms", "parameters": {"max": 5}}\n</tool_call>',
  '\n\n<parameter name="cu_public__list-clemson-terms">\n<parameter name="max">5</parameter>\n</parameter>\n</function>',
  'Let me look up the available terms first.\n\n<tool_code>\n```json\n{\n  "name": "cu_public__list-clemson-terms",\n  "arguments": {"max": 10}\n}\n```',
  "I'll search for CPSC classes. Let me start by listing terms.\n\n<cu_public__list-clemson-terms>\n{\"max\": 20}\n</cu_public__list-clemson-terms>",
];

// A genuine answer that merely MENTIONS tools must not be flagged.
const CONTROL_SAMPLES = [
  "Fall 2026 has three CPSC 3000-level classes: CPSC 3300, CPSC 3600, and CPSC 3720.",
  "I looked this up with the class search tool and found nothing for that term.",
];

await initAdvisorTools();
const names = advisorToolNames();
console.log(`tool names available to the detector: ${names.length}\n`);

let missed = 0;
for (const [i, s] of LIVE_SAMPLES.entries()) {
  const hit = detectMalformedToolCall(s, 0, names);
  if (!hit) missed++;
  console.log(`live sample ${i + 1}: ${hit ? "DETECTED" : "MISSED   "}  ${JSON.stringify(s.slice(0, 60))}`);
}
console.log("");
let falsePositives = 0;
for (const [i, s] of CONTROL_SAMPLES.entries()) {
  const hit = detectMalformedToolCall(s, 0, names);
  if (hit) falsePositives++;
  console.log(`control ${i + 1}: ${hit ? "FALSE POSITIVE" : "clean"}`);
}
console.log(`\nmissed=${missed} falsePositives=${falsePositives}`);
await shutdownAdvisorTools();
