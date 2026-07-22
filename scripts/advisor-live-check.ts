// Live verification for the advisor fix wave.
//
// Runs ONE real turn against the real spark endpoint through the real MCP tool
// bridge, with a loopback proxy in front of the endpoint that captures the
// outgoing request body verbatim. The point is to observe what actually reaches
// the wire rather than to infer it from the configuration — the whole reason
// item 5 existed is that the configuration was once assumed to imply the
// payload and did not.
//
// Usage: npx tsx scripts/advisor-live-check.ts

import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  __resolveProviderForTest,
  __runWithProviderForTest,
  initAdvisorTools,
  shutdownAdvisorTools,
  advisorToolNames,
} from "../src/advisor-agent.ts";
import { ADVISOR_BASE_URL } from "../src/config.ts";
import type { AdvisorSession } from "../src/advisor-session.ts";

const upstream = new URL(ADVISOR_BASE_URL);
const captured: Record<string, unknown>[] = [];
const responses: string[] = [];

const proxy = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    try {
      captured.push(JSON.parse(body.toString("utf8")));
    } catch {
      /* non-JSON request; not one we care about */
    }
    const fwd = http.request(
      {
        hostname: upstream.hostname,
        port: upstream.port || 80,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: upstream.host },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 200, up.headers);
        up.on("data", (c: Buffer) => responses.push(c.toString("utf8")));
        up.pipe(res);
      },
    );
    fwd.on("error", (err) => {
      res.writeHead(502);
      res.end(String(err));
    });
    fwd.end(body);
  });
});

await new Promise<void>((r) => proxy.listen(9099, "127.0.0.1", r));

const session: AdvisorSession = {
  id: "live-check",
  advisorId: "shared",
  workDir: mkdtempSync(path.join(tmpdir(), "advisor-live-work-")),
  piSessionRoot: mkdtempSync(path.join(tmpdir(), "advisor-live-pi-")),
  history: [],
  lastTouched: Date.now(),
};

try {
  await initAdvisorTools();
  console.log(`tools loaded: ${advisorToolNames().length}`);

  const target = __resolveProviderForTest("spark")!;
  const realBase = (target.model as unknown as { baseUrl: string }).baseUrl;
  // Route through the capturing proxy. Same host, same model, same everything
  // else — only the hop is different.
  (target.model as unknown as { baseUrl: string }).baseUrl =
    `http://127.0.0.1:9099${upstream.pathname}`;
  console.log(`upstream: ${realBase} (via capturing proxy)`);

  const started = Date.now();
  const result = await __runWithProviderForTest(
    target,
    session,
    "What CPSC 3000-level classes are offered in Fall 2026? Use your tools.",
  );

  console.log(`\n--- turn result (${Date.now() - started}ms) ---`);
  console.log(`outcome:   ${result.outcome}`);
  console.log(`toolCalls: ${result.toolCalls}`);
  console.log(`text:      ${result.text.slice(0, 400)}`);

  console.log(`\n--- on the wire (${captured.length} request(s)) ---`);
  const first = captured[0] ?? {};
  console.log(`model:                ${JSON.stringify(first.model)}`);
  console.log(`temperature:          ${JSON.stringify(first.temperature)}`);
  console.log(
    `chat_template_kwargs: ${JSON.stringify(first.chat_template_kwargs)}`,
  );
  console.log(`tool_choice:          ${JSON.stringify(first.tool_choice)}`);
  console.log(
    `tools offered:        ${Array.isArray(first.tools) ? first.tools.length : 0}`,
  );
  const { writeFileSync } = await import("node:fs");
  writeFileSync("/tmp/advisor-payload.json", JSON.stringify(captured[0] ?? {}, null, 2));
  const raw = responses.join("");
  console.log(`\n--- response sample (${raw.length} bytes) ---`);
  console.log("...TAIL...");
  console.log(raw.slice(-2500));
  for (const [i, req] of captured.entries()) {
    const size = Math.ceil(JSON.stringify(req).length / 4);
    console.log(`request ${i + 1}: ~${size} tokens`);
  }
} finally {
  await shutdownAdvisorTools();
  proxy.close();
  rmSync(session.workDir, { recursive: true, force: true });
  rmSync(session.piSessionRoot, { recursive: true, force: true });
}
