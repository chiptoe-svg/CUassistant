export type SendAccount = "ms365" | "gmail";
export type SendStatus = "pending" | "sent" | "rejected" | "expired" | "failed";

export interface SendArtifact {
  account: SendAccount;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
}

export interface PendingSend {
  request_id: string;
  artifact: SendArtifact;
  content_hash: string;
  proposer: string;
  status: SendStatus;
  feedback?: string;
  created_at: number;
  expires_at: number;
  sent_message_id?: string;
  error?: string;
}

export interface SentResult {
  id: string;
}

/** Sends a frozen artifact. Throws on failure. */
export interface Sender {
  send(artifact: SendArtifact): Promise<SentResult>;
}

/** Posts an approval request out-of-band. Throws if the approver can't be reached. */
export interface ApprovalChannel {
  post(req: PendingSend, externalRecipients: string[]): Promise<void>;
}

export interface Clock {
  now(): number;
}

export interface IdGen {
  generate(): string;
}

export interface GateConfig {
  ttlMs: number;
  maxOutstanding: number;
  rateLimitPerHour: number;
  internalDomains: string[];
  authorizedUserId: string;
}
