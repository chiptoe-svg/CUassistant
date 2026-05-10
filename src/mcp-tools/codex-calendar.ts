// Codex CLI Outlook connector — calendar read helpers.
//
// Mirrors the shape of src/codex-outlook.ts (which covers mail reads) without
// modifying that file. The Outlook Email connector exposes both mail and
// calendar surfaces; this module is the calendar-side wrapper.
//
// Read-only by design. No write/cancel/RSVP path here — those live in the
// stub-pending-approval calendar-write tools.

import { spawn } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import {
  CODEX_BIN,
  CODEX_MODEL,
  OUTLOOK_CODEX_MAX_RESULTS,
  OUTLOOK_CODEX_TIMEOUT_MS,
} from "../config.js";
import { log } from "../log.js";

interface CalendarListResult {
  events?: Array<Record<string, unknown>>;
}

interface CalendarEventResult {
  event?: Record<string, unknown>;
}

const EVENT_LIST_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Outlook calendar event list",
  type: "object",
  additionalProperties: true,
  properties: {
    events: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
  },
} as const;

const EVENT_ONE_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Outlook calendar event",
  type: "object",
  additionalProperties: true,
  properties: {
    event: { type: "object", additionalProperties: true },
  },
} as const;

function runConnector(prompt: string, schema: object): Promise<string> {
  return new Promise((resolve, reject) => {
    const isolatedCwd = mkdtempSync(path.join(tmpdir(), "cuassistant-cal-"));
    const schemaPath = path.join(isolatedCwd, "schema.json");
    writeFileSync(schemaPath, JSON.stringify(schema));
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
            `codex calendar connector timed out after ${OUTLOOK_CODEX_TIMEOUT_MS}ms`,
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
    proc.on("error", (e) => finish(() => reject(e)));
    proc.on("close", (code) => {
      if (code !== 0) {
        finish(() =>
          reject(
            new Error(
              `codex calendar connector exited ${code}: ${stderr.slice(0, 2000)}`,
            ),
          ),
        );
        return;
      }
      finish(() => resolve(stdout));
    });
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

function parseAgentMessage(raw: string): string {
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
  return agentMessage;
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

export async function listCalendarEventsWithCodex(opts: {
  fromIso?: string | null;
  toIso?: string | null;
}): Promise<Array<Record<string, unknown>> | null> {
  const lines = [
    "Use the Outlook Email connector only. Do not use shell commands.",
    "List the signed-in user's calendar events ordered by start time ascending.",
  ];
  if (opts.fromIso) lines.push(`Start window at or after: ${opts.fromIso}.`);
  if (opts.toIso) lines.push(`End window before: ${opts.toIso}.`);
  lines.push(`Return at most ${OUTLOOK_CODEX_MAX_RESULTS} events.`);
  lines.push(
    "For each event include id, subject, start (with timeZone if available), end, location, organizer, attendees, isOnlineMeeting, and webLink when available.",
  );
  lines.push("Return only JSON matching the provided schema.");
  try {
    const raw = await runConnector(lines.join("\n"), EVENT_LIST_SCHEMA);
    const agentMessage = parseAgentMessage(raw);
    const parsed = parseJsonObject<CalendarListResult>(agentMessage);
    return parsed?.events ?? null;
  } catch (e) {
    log.warn("codex calendar list failed", { err: String(e) });
    return null;
  }
}

export async function getCalendarEventWithCodex(
  id: string,
): Promise<Record<string, unknown> | null> {
  const prompt = [
    "Use the Outlook Email connector only. Do not use shell commands.",
    "Fetch the calendar event with this exact id:",
    id,
    "Return only JSON matching the provided schema.",
    "Include id, subject, body (plain text), start, end, location, organizer, attendees, isOnlineMeeting, onlineMeetingUrl, and webLink when available.",
  ].join("\n");
  try {
    const raw = await runConnector(prompt, EVENT_ONE_SCHEMA);
    const agentMessage = parseAgentMessage(raw);
    const parsed = parseJsonObject<CalendarEventResult>(agentMessage);
    return parsed?.event ?? null;
  } catch (e) {
    log.warn("codex calendar get failed", { id, err: String(e) });
    return null;
  }
}

export async function getCalendarViewWithCodex(opts: {
  startIso: string;
  endIso: string;
}): Promise<Array<Record<string, unknown>> | null> {
  const prompt = [
    "Use the Outlook Email connector only. Do not use shell commands.",
    "Return calendar events in the user's calendar that fall in this window:",
    `from ${opts.startIso} to ${opts.endIso}.`,
    "Expand recurring events into their occurrences (use the calendarView semantics).",
    `Return at most ${OUTLOOK_CODEX_MAX_RESULTS} occurrences ordered by start ascending.`,
    "For each event include id, subject, start, end, location, organizer, attendees, and webLink when available.",
    "Return only JSON matching the provided schema.",
  ].join("\n");
  try {
    const raw = await runConnector(prompt, EVENT_LIST_SCHEMA);
    const agentMessage = parseAgentMessage(raw);
    const parsed = parseJsonObject<CalendarListResult>(agentMessage);
    return parsed?.events ?? null;
  } catch (e) {
    log.warn("codex calendar view failed", { err: String(e) });
    return null;
  }
}
