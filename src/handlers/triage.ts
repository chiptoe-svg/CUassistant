// Triage handler: classify new mail, optionally apply deterministic shortcuts,
// and create MS365 To Do tasks. The shipping capability today.

import { runScan } from "../scan.js";
import { registerHandler } from "./registry.js";

registerHandler({
  name: "triage",
  scopes: { graph: ["Mail.ReadWrite", "Tasks.ReadWrite"] },
  run: async () => {
    const summary = await runScan();
    return { summary };
  },
});
