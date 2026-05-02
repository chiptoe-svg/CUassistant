import { loadAccounts } from "./loaders.js";
import { mailProviderForAccount } from "./provider-registry.js";
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
    const provider = mailProviderForAccount(acc);
    if (!provider) continue;
    const messages = await provider.reader.listNew(
      progress[provider.progressAccount] ?? null,
    );
    if (messages) {
      out.push(...messages);
      completedAccounts.add(provider.progressAccount);
    } else {
      errors.push(`${provider.progressAccount}:${acc.id}: list failed`);
    }
  }
  return { emails: out, completedAccounts, errors };
}

export async function fetchBodies(candidates: LlmCandidate[]): Promise<void> {
  const providers = new Map(
    loadAccounts()
      .map((acc) => mailProviderForAccount(acc))
      .filter((p): p is NonNullable<typeof p> => Boolean(p))
      .map((p) => [p.progressAccount, p.reader]),
  );
  for (const c of candidates) {
    const reader = providers.get(c.account);
    if (reader) c.body = await reader.fetchBody(c.id);
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
