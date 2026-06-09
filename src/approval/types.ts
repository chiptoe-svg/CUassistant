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

/** A security-relevant gate event that is not a normal state transition. */
export interface SecurityEvent {
  kind: "unauthorized_approval_attempt";
  request_id: string;
  user_id: string;
  action: "approve" | "reject";
}

/** Receives the PendingSend after each gate state transition for audit logging. */
export interface AuditSink {
  record(req: PendingSend): void;
  /** Records a security event (e.g. an approval tap from an unauthorized user). */
  recordSecurity?(event: SecurityEvent): void;
}
