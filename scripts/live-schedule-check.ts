// Live check for host-side schedule verification.
// Run: npx tsx scripts/live-schedule-check.ts
//
// 1. A real advisor turn that produces a schedule → the document still renders.
// 2. The same turn's payload with one section corrupted → the tool refuses it.
import { createSession } from "../src/advisor-session.ts";
import {
  initAdvisorTools,
  runAdvisorTurn,
  shutdownAdvisorTools,
} from "../src/advisor-agent.ts";
import {
  createProposeScheduleTool,
  renderSchedule,
} from "../src/advisor-artifacts.ts";

const PROMPT =
  "Build me a printable proposed schedule for term 202608 with GC1040 " +
  "section 001 and GC1010 section 001. Look them up with the schedule tools " +
  "first, then call propose_schedule with the exact CRNs, credits, days, " +
  "times, building and room you got back.";

async function main() {
  await initAdvisorTools();
  const session = createSession("shared");
  try {
    const result = await runAdvisorTurn(session, PROMPT);
    console.log("outcome:", result.outcome);
    console.log("toolCalls:", JSON.stringify(result.toolCalls));

    const s = session.lastSchedule;
    if (!s) {
      console.log("LIVE 1: FAIL — no schedule was proposed");
      console.log(result.text?.slice(0, 800));
      return;
    }
    console.log("LIVE 1: verifiedAgainst =", s.verifiedAgainst);
    console.log("LIVE 1: sections =", s.sections.map((x) => `${x.crn} ${x.subjectCourse} ${x.days} ${x.beginTime}-${x.endTime}`).join(" | "));
    const html = renderSchedule(s);
    console.log(
      "LIVE 1:",
      html.includes("<!DOCTYPE html>") && html.includes(s.sections[0]!.crn)
        ? `PASS — document renders (${html.length} bytes, banner=${html.includes("NOT VERIFIED") ? "NOT VERIFIED" : "verified"})`
        : "FAIL — document did not render",
    );

    // 2. Same payload, one section corrupted at the source the model controls.
    const corrupted = JSON.parse(JSON.stringify(s)) as typeof s & Record<string, unknown>;
    delete corrupted.verifiedAgainst;
    corrupted.sections[0]!.beginTime = "0900";
    corrupted.sections[0]!.endTime = "0950";
    const holder: { lastSchedule?: typeof s } = {};
    const tool = createProposeScheduleTool(holder);
    try {
      await tool.execute("live-2", corrupted);
      console.log("LIVE 2: FAIL — corrupted section was accepted");
    } catch (err) {
      console.log("LIVE 2: PASS — refused:", (err as Error).message);
      console.log("LIVE 2: nothing stored:", holder.lastSchedule === undefined);
    }
  } finally {
    await shutdownAdvisorTools();
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
