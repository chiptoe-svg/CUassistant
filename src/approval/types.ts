export type SendAccount = "ms365" | "gmail";
/**
 * `sending` is the in-flight window between "the human approved" and "the
 * provider answered". It is persisted BEFORE the send so a crash mid-send is
 * distinguishable from a send that never started — without it, hydration would
 * restore a half-sent request as `pending` and a second button tap would
 * deliver the email twice.
 */
export type SendStatus =
  | "pending"
  | "sending"
  | "sent"
  | "rejected"
  | "expired"
  | "failed";

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

/**
 * Durable backing for gate state. Synchronous by contract: `getStatus()` and
 * `reject()` are sync, and an async store would change their signatures.
 */
export interface ApprovalStore {
  /** All persisted sends, for hydrating a fresh gate at construction. */
  loadAll(): PendingSend[];
  /** Insert or replace one send after any state transition. */
  upsert(req: PendingSend): void;
  /** Submit timestamps at or after `sinceMs`, for the hourly rate limiter. */
  loadSubmitTimes(sinceMs: number): number[];
  recordSubmitTime(ts: number): void;
  /** Epoch ms of the last watchdog-triggered exit, or null if never. */
  getLastWatchdogExit(): number | null;
  recordWatchdogExit(ts: number): void;
}
