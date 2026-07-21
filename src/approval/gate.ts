import { hashArtifact, externalRecipients } from "./freeze.js";
import type {
  ApprovalChannel,
  ApprovalStore,
  AuditSink,
  Clock,
  GateConfig,
  IdGen,
  PendingSend,
  SendArtifact,
  Sender,
  SendStatus,
} from "./types.js";

export interface SubmitResult {
  request_id: string;
  status: SendStatus;
}

export type StatusView =
  | { status: "pending" | "expired" }
  | { status: "sent"; sent_message_id?: string }
  | { status: "rejected"; feedback?: string }
  | { status: "failed"; error?: string };

interface Ports {
  sender: Sender;
  channel: ApprovalChannel;
  clock: Clock;
  idGen: IdGen;
  audit?: AuditSink;
  store?: ApprovalStore;
}

const HOUR_MS = 3_600_000;

export class ApprovalGate {
  private readonly pending = new Map<string, PendingSend>();
  private submitTimes: number[] = [];

  constructor(
    private readonly ports: Ports,
    private readonly config: GateConfig,
  ) {
    // Hydrate from the store so a restart doesn't void in-flight approvals.
    // better-sqlite3 is synchronous, so this is safe in a constructor.
    for (const req of this.ports.store?.loadAll() ?? []) {
      this.pending.set(req.request_id, req);
    }
    const now = this.ports.clock.now();
    this.submitTimes = this.ports.store?.loadSubmitTimes(now - HOUR_MS) ?? [];
    // Anything whose TTL elapsed while the process was down is expired now.
    this.sweepExpired();
  }

  // The gate posts to the channel and the channel's receiver calls back into
  // the gate — a cycle. Construct the gate with a no-op channel, build the real
  // channel with the gate, then inject it here. `ports.channel` is a mutable
  // field, so this compiles even though `ports` itself is readonly.
  setChannel(channel: ApprovalChannel): void {
    this.ports.channel = channel;
  }

  async submit(
    artifact: SendArtifact,
    proposer: string,
  ): Promise<SubmitResult> {
    this.sweepExpired();
    const now = this.ports.clock.now();

    this.submitTimes = this.submitTimes.filter((t) => now - t < HOUR_MS);
    if (this.submitTimes.length >= this.config.rateLimitPerHour) {
      throw new Error("rate_limited");
    }
    const outstanding = [...this.pending.values()].filter(
      (p) => p.status === "pending",
    ).length;
    if (outstanding >= this.config.maxOutstanding) {
      throw new Error("too_many_pending");
    }

    const request_id = this.ports.idGen.generate();
    const req: PendingSend = {
      request_id,
      artifact,
      content_hash: hashArtifact(artifact),
      proposer,
      status: "pending",
      created_at: now,
      expires_at: now + this.config.ttlMs,
    };
    this.pending.set(request_id, req);
    this.ports.store?.upsert(req);
    this.submitTimes.push(now);
    this.ports.store?.recordSubmitTime(now);
    this.ports.audit?.record(req);

    const externals = externalRecipients(artifact, this.config.internalDomains);
    try {
      await this.ports.channel.post(req, externals);
    } catch (e) {
      req.status = "failed";
      req.error = `notify_failed: ${String(e)}`;
      this.ports.store?.upsert(req);
      this.ports.audit?.record(req);
      return { request_id, status: "failed" };
    }
    return { request_id, status: "pending" };
  }

  getStatus(request_id: string): StatusView | null {
    this.sweepExpired();
    const req = this.pending.get(request_id);
    if (!req) return null;
    switch (req.status) {
      case "sent":
        return { status: "sent", sent_message_id: req.sent_message_id };
      case "rejected":
        return { status: "rejected", feedback: req.feedback };
      case "failed":
        return { status: "failed", error: req.error };
      default:
        return { status: req.status };
    }
  }

  async approve(request_id: string, userId: string): Promise<void> {
    this.sweepExpired();
    if (userId !== this.config.authorizedUserId) {
      this.ports.audit?.recordSecurity?.({
        kind: "unauthorized_approval_attempt",
        request_id,
        user_id: userId,
        action: "approve",
      });
      return;
    }
    const req = this.pending.get(request_id);
    if (!req || req.status !== "pending") return;
    try {
      const res = await this.ports.sender.send(req.artifact);
      req.status = "sent";
      req.sent_message_id = res.id;
    } catch (e) {
      req.status = "failed";
      req.error = String(e);
    }
    this.ports.store?.upsert(req);
    this.ports.audit?.record(req);
  }

  reject(request_id: string, userId: string, feedback?: string): void {
    this.sweepExpired();
    if (userId !== this.config.authorizedUserId) {
      this.ports.audit?.recordSecurity?.({
        kind: "unauthorized_approval_attempt",
        request_id,
        user_id: userId,
        action: "reject",
      });
      return;
    }
    const req = this.pending.get(request_id);
    if (!req || req.status !== "pending") return;
    req.status = "rejected";
    if (feedback) req.feedback = feedback;
    this.ports.store?.upsert(req);
    this.ports.audit?.record(req);
  }

  private sweepExpired(): void {
    const now = this.ports.clock.now();
    for (const req of this.pending.values()) {
      if (req.status === "pending" && now >= req.expires_at) {
        req.status = "expired";
        this.ports.store?.upsert(req);
        this.ports.audit?.record(req);
      }
    }
  }
}
