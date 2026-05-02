import { EmailMinimal } from "./types.js";

export interface MailReader {
  listNew(sinceIso: string | null): Promise<EmailMinimal[] | null>;
  fetchBody(id: string): Promise<string>;
}

export interface TaskWriter {
  getDefaultListId(): Promise<string | null>;
  findTaskByMarker(listId: string, auditMarker: string): Promise<string | null>;
  createTask(
    listId: string,
    title: string,
    dueIsoLocal?: string,
    auditMarker?: string,
  ): Promise<string | null>;
}
