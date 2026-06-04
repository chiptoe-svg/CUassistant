import type { SendArtifact, Sender, SentResult } from "./types.js";

export interface Backends {
  gmail: (a: SendArtifact) => Promise<SentResult>;
  ms365?: (a: SendArtifact) => Promise<SentResult>;
}

/** Routes a frozen artifact to the backend for its account. */
export function makeSender(backends: Backends): Sender {
  return {
    async send(a: SendArtifact): Promise<SentResult> {
      if (a.account === "gmail") return backends.gmail(a);
      if (a.account === "ms365") {
        if (!backends.ms365) {
          throw new Error(
            "ms365 send not enabled (pending Mail.Send consent on the GCassistant app)",
          );
        }
        return backends.ms365(a);
      }
      throw new Error(`unknown account: ${String(a.account)}`);
    },
  };
}
