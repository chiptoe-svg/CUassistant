import {
  fetchOutlookBodyWithCodex,
  listOutlookWithCodex,
} from "./codex-outlook.js";
import {
  createGraphCliTask,
  findGraphCliTaskByMarker,
  getGraphCliDefaultTodoListId,
} from "./graph-cli-tasks.js";
import { fetchGmailBody, listGmail } from "./gmail.js";
import {
  createMs365Task,
  fetchOutlookBody,
  findMs365TaskByMarker,
  getDefaultTodoListId,
  listOutlook,
} from "./ms365.js";
import { MailReader, TaskWriter } from "./providers.js";
import { OUTLOOK_MAIL_PROVIDER, TASK_PROVIDER } from "./config.js";
import { EmailAccount, ProgressAccount } from "./types.js";

interface MailProvider {
  progressAccount: ProgressAccount;
  reader: MailReader;
}

const gmailReader: MailReader = {
  async listNew(sinceIso) {
    return listGmail(sinceIso);
  },
  async fetchBody(id) {
    return fetchGmailBody(id);
  },
};

const outlookGraphReader: MailReader = {
  listNew: listOutlook,
  fetchBody: fetchOutlookBody,
};

const outlookCodexReader: MailReader = {
  listNew: listOutlookWithCodex,
  fetchBody: fetchOutlookBodyWithCodex,
};

const ms365TaskWriter: TaskWriter = {
  getDefaultListId: getDefaultTodoListId,
  findTaskByMarker: findMs365TaskByMarker,
  createTask: createMs365Task,
};

const graphCliTaskWriter: TaskWriter = {
  getDefaultListId: getGraphCliDefaultTodoListId,
  findTaskByMarker: findGraphCliTaskByMarker,
  createTask: createGraphCliTask,
};

export function mailProviderForAccount(
  account: EmailAccount,
): MailProvider | null {
  if (account.type === "gws") {
    return { progressAccount: "gmail", reader: gmailReader };
  }
  if (account.type === "ms365") {
    return {
      progressAccount: "outlook",
      reader:
        OUTLOOK_MAIL_PROVIDER === "codex"
          ? outlookCodexReader
          : outlookGraphReader,
    };
  }
  return null;
}

export function getTaskWriter(): TaskWriter {
  return TASK_PROVIDER === "graph-cli" ? graphCliTaskWriter : ms365TaskWriter;
}
