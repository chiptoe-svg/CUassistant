// src/approval/ms365-sender.ts
// MS365 Graph sendMail backend for the approval gate. Host-side; uses the
// GCassistant token (Mail.Send consented). Only invoked by the gate after
// human approval — never reachable directly by the agent.
import { getMs365AccessToken } from "../ms365.js";
import type { SendArtifact, SentResult } from "./types.js";

export function buildSendMailPayload(a: SendArtifact) {
  const rcpt = (addr: string) => ({ emailAddress: { address: addr } });
  return {
    message: {
      subject: a.subject,
      body: { contentType: "Text", content: a.body },
      toRecipients: a.to.map(rcpt),
      ccRecipients: (a.cc ?? []).map(rcpt),
    },
    saveToSentItems: true,
  };
}

export async function ms365Send(a: SendArtifact): Promise<SentResult> {
  const token = await getMs365AccessToken();
  if (!token) throw new Error("ms365 send: no access token");
  const r = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildSendMailPayload(a)),
  });
  if (!r.ok) {
    throw new Error(
      `ms365 sendMail failed: ${r.status} ${(await r.text()).slice(0, 200)}`,
    );
  }
  // Graph sendMail returns 202 Accepted with no id.
  return { id: "sent" };
}
