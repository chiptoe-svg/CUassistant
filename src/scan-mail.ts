import { fetchGmailBody, listGmail } from "./gmail.js";
import { loadAccounts } from "./loaders.js";
import { fetchOutlookBody, listOutlook } from "./ms365.js";
import { writeProgress } from "./state.js";
import {
  EmailAccount,
  EmailMinimal,
  LlmCandidate,
  MailListing,
  Progress,
  ProgressAccount,
} from "./types.js";

export async function listAllNewMail(progress: {
  gmail?: string;
  outlook?: string;
}): Promise<MailListing> {
  const accounts = loadAccounts();
  const out: EmailMinimal[] = [];
  const completedAccounts = new Set<ProgressAccount>();
  const errors: string[] = [];
  for (const acc of accounts) {
    if (acc.type === "gws") {
      const messages = listGmail(progress.gmail ?? null);
      if (messages) {
        out.push(...messages);
        completedAccounts.add("gmail");
      } else {
        errors.push(`gmail:${acc.id}: list failed or GWS unavailable`);
      }
    } else if (acc.type === "ms365") {
      const messages = await listOutlook(progress.outlook ?? null);
      if (messages) {
        out.push(...messages);
        completedAccounts.add("outlook");
      } else {
        errors.push(`outlook:${acc.id}: list failed or MS365 unavailable`);
      }
    }
  }
  return { emails: out, completedAccounts, errors };
}

export async function fetchBodies(candidates: LlmCandidate[]): Promise<void> {
  for (const c of candidates) {
    if (c.account === "gmail") {
      c.body = fetchGmailBody(c.id);
    } else if (c.account === "outlook") {
      c.body = await fetchOutlookBody(c.id);
    }
  }
}

function latestReceivedIso(
  emails: EmailMinimal[],
  account: EmailMinimal["account"],
): string | null {
  const times = emails
    .filter((e) => e.account === account && e.receivedIso)
    .map((e) => e.receivedIso as string)
    .sort();
  return times.at(-1) ?? null;
}

export function writeCompletedProgress(
  previous: Progress,
  accounts: EmailAccount[],
  listedEmails: EmailMinimal[],
  completedAccounts: Set<ProgressAccount>,
  scanStartedIso: string,
  scanRunId: string,
): void {
  const last_scan_date = { ...(previous.last_scan_date ?? {}) };
  if (
    completedAccounts.has("gmail") &&
    accounts.some((a) => a.type === "gws")
  ) {
    last_scan_date.gmail =
      latestReceivedIso(listedEmails, "gmail") ?? scanStartedIso;
  }
  if (
    completedAccounts.has("outlook") &&
    accounts.some((a) => a.type === "ms365")
  ) {
    last_scan_date.outlook =
      latestReceivedIso(listedEmails, "outlook") ?? scanStartedIso;
  }
  writeProgress({
    ...previous,
    last_scan_date,
    last_scan_run_id: scanRunId,
  });
}
