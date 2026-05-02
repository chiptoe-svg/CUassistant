import { spawn } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import {
  CODEX_BIN,
  CODEX_MODEL,
  OUTLOOK_CODEX_MAX_RESULTS,
  OUTLOOK_CODEX_TIMEOUT_MS,
} from "./config.js";
import { log } from "./log.js";
import { normalizeBody } from "./normalize.js";
import { EmailMinimal } from "./types.js";

interface CodexExecResult {
  agentMessage: string;
}

interface OutlookListResult {
  messages?: Array<{
    id?: string;
    from?: string;
    subject?: string;
    conversationId?: string | null;
    receivedIso?: string | null;
  }>;
}

interface OutlookBodyResult {
  body?: string;
}

function runCodexConnector(
  prompt: string,
  schemaFile: "outlook-list.schema.json" | "outlook-body.schema.json",
): Promise<CodexExecResult> {
  return new Promise((resolve, reject) => {
    const isolatedCwd = mkdtempSync(path.join(tmpdir(), "cuassistant-app-"));
    const schemaPath = path.resolve(process.cwd(), "schemas", schemaFile);
    let settled = false;
    const proc = spawn(
      CODEX_BIN,
      [
        "exec",
        "--model",
        CODEX_MODEL,
        "--json",
        "--skip-git-repo-check",
        "--ephemeral",
        "--sandbox",
        "workspace-write",
        "--ignore-rules",
        "--output-schema",
        schemaPath,
        "--cd",
        isolatedCwd,
        "-",
      ],
      { stdio: ["pipe", "pipe", "pipe"], cwd: isolatedCwd },
    );
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        rmSync(isolatedCwd, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
      fn();
    };
    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      finish(() =>
        reject(
          new Error(
            `codex outlook connector timed out after ${OUTLOOK_CODEX_TIMEOUT_MS}ms`,
          ),
        ),
      );
    }, OUTLOOK_CODEX_TIMEOUT_MS);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    proc.on("error", (err) => finish(() => reject(err)));
    proc.on("close", (code) => {
      if (code !== 0) {
        finish(() =>
          reject(
            new Error(
              `codex outlook connector exited ${code}: ${stderr.slice(0, 2000)}`,
            ),
          ),
        );
        return;
      }
      finish(() => resolve(parseCodexJsonl(stdout)));
    });
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

function parseCodexJsonl(raw: string): CodexExecResult {
  let agentMessage = "";
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (evt.type !== "item.completed") continue;
    const item = evt.item as { type?: string; text?: string } | undefined;
    if (item?.type === "agent_message" && typeof item.text === "string") {
      agentMessage = item.text;
    }
  }
  return { agentMessage };
}

function parseJsonObject<T>(raw: string): T | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = fenced ? fenced[1].trim() : raw.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

function sinceInstruction(sinceIso: string | null): string {
  if (!sinceIso) return "No saved cursor exists; list recent Inbox mail.";
  return `List Inbox mail received at or after this ISO timestamp: ${sinceIso}.`;
}

export async function listOutlookWithCodex(
  sinceIso: string | null,
): Promise<EmailMinimal[] | null> {
  const prompt = [
    "Use the Outlook Email connector only. Do not use shell commands.",
    "List messages from the signed-in user's Outlook Inbox, newest first.",
    sinceInstruction(sinceIso),
    `Return at most ${OUTLOOK_CODEX_MAX_RESULTS} messages.`,
    "Return only JSON matching the provided schema.",
    "For each message include id, from email address, subject, conversationId when available, and receivedIso when available.",
  ].join("\n");
  try {
    const exec = await runCodexConnector(prompt, "outlook-list.schema.json");
    const parsed = parseJsonObject<OutlookListResult>(exec.agentMessage);
    if (!parsed?.messages) return null;
    return parsed.messages
      .filter((m) => m.id)
      .map((m) => ({
        id: String(m.id),
        account: "outlook" as const,
        from: String(m.from || ""),
        subject: String(m.subject || ""),
        conversationId: m.conversationId ? String(m.conversationId) : undefined,
        receivedIso: m.receivedIso ? String(m.receivedIso) : undefined,
      }));
  } catch (err) {
    log.warn("codex outlook list failed", { err: String(err) });
    return null;
  }
}

export async function fetchOutlookBodyWithCodex(id: string): Promise<string> {
  const prompt = [
    "Use the Outlook Email connector only. Do not use shell commands.",
    "Fetch the Outlook message with this exact message id:",
    id,
    "Return only JSON matching the provided schema.",
    "The body field should contain the useful readable body text for classification. Prefer plain text when available.",
  ].join("\n");
  try {
    const exec = await runCodexConnector(prompt, "outlook-body.schema.json");
    const parsed = parseJsonObject<OutlookBodyResult>(exec.agentMessage);
    return normalizeBody(parsed?.body || "");
  } catch (err) {
    log.warn("codex outlook body fetch failed", { id, err: String(err) });
    return "";
  }
}
