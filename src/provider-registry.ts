import { fetchGmailBody, listGmail } from "./gmail.js";
import {
  createMs365Task,
  fetchOutlookBody,
  findMs365TaskByMarker,
  getDefaultTodoListId,
  listOutlook,
} from "./ms365.js";
import { MailReader, TaskWriter } from "./providers.js";
import { EmailAccount, ProgressAccount } from "./types.js";

interface MailProvider {
  progressAccount: ProgressAccount;
  reader: MailReader;
}

const gmailReader: MailReader = {
  async listNew(sinceIso, untilIso) {
    return listGmail(sinceIso, untilIso);
  },
  async fetchBody(id) {
    return fetchGmailBody(id);
  },
};

const outlookGraphReader: MailReader = {
  listNew: listOutlook,
  fetchBody: fetchOutlookBody,
};

const ms365TaskWriter: TaskWriter = {
  getDefaultListId: getDefaultTodoListId,
  findTaskByMarker: findMs365TaskByMarker,
  createTask: createMs365Task,
};

export function mailProviderForAccount(
  account: EmailAccount,
): MailProvider | null {
  if (account.type === "gws") {
    return { progressAccount: "gmail", reader: gmailReader };
  }
  if (account.type === "ms365") {
    return { progressAccount: "outlook", reader: outlookGraphReader };
  }
  return null;
}

export function getTaskWriter(): TaskWriter {
  return ms365TaskWriter;
}
