import crypto from "crypto";

import { OUTLOOK_MAIL_PROVIDER, TASK_PROVIDER } from "../src/config.js";
import { setActiveHandler } from "../src/permissions.js";
import {
  getTaskWriter,
  mailProviderForAccount,
} from "../src/provider-registry.js";

async function main() {
  setActiveHandler("triage");
  try {
    if (process.env.PROVIDER_SMOKE_MAIL !== "0") {
      const provider = mailProviderForAccount({
        id: "outlook-smoke",
        type: "ms365",
        address: "smoke",
        enabled: true,
      });
      if (!provider) throw new Error("No Outlook provider configured");

      const since = process.env.PROVIDER_SMOKE_SINCE || todayStartIso();
      const messages = await provider.reader.listNew(since);
      if (!messages) {
        console.log(
          `mail provider=${OUTLOOK_MAIL_PROVIDER} status=fail since=${since}`,
        );
        process.exit(1);
      }
      console.log(
        `mail provider=${OUTLOOK_MAIL_PROVIDER} status=ok since=${since} count=${messages.length}`,
      );
      const first = messages[0];
      if (first) {
        console.log(
          `mail first id=${first.id.slice(0, 12)} received=${first.receivedIso || "unknown"}`,
        );
      }

      if (first && process.env.PROVIDER_SMOKE_FETCH_BODY === "1") {
        const body = await provider.reader.fetchBody(first.id);
        const hash = crypto.createHash("sha256").update(body).digest("hex");
        console.log(`body status=ok chars=${body.length} sha256=${hash}`);
      }
    }

    if (process.env.PROVIDER_SMOKE_TASKS === "1") {
      const writer = getTaskWriter();
      const listId = await writer.getDefaultListId();
      console.log(
        `tasks provider=${TASK_PROVIDER} status=${listId ? "ok" : "fail"} list=${listId ? listId.slice(0, 12) : "none"}`,
      );
      if (!listId) process.exit(1);
    }
  } finally {
    setActiveHandler(null);
  }
}

function todayStartIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
