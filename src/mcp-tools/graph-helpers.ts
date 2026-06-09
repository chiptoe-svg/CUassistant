// Shared Microsoft Graph helpers for the MCP tools.
//
// These call Graph v1.0 host-side using the GCassistant Azure AD app token
// (getMs365AccessToken from src/ms365.ts) — the same delegated app the scan
// flow uses. The app's consented envelope is Mail.ReadWrite + Tasks.ReadWrite
// + Calendars.ReadWrite, so mail, To Do, and calendar surfaces are all
// reachable with one refresh token.
//
// Two gate systems are deliberately separate:
//   - src/permissions.ts (assertGraphOperation) gates the SCAN flow via an
//     active-handler context.
//   - src/mcp-tools/permissions.ts (assertMcpOperation) gates the MCP server
//     via its own operation allow-list.
// The MCP server runs as a separate stdio process and never sets a scan
// handler, so MCP tool handlers gate with assertMcpOperation(...) before
// calling the pure-I/O helpers below. (The To Do helpers also assert
// internally for historical reasons; the mail/calendar helpers do not, because
// their policy constraints need the per-call input that only the tool handler
// has.)
//
// All calls run host-side. Refresh tokens never cross any boundary.

import { TIMEZONE } from "../config.js";
import { log } from "../log.js";
import {
  buildFolderPaths,
  normalizeMailPath,
  type RawFolder,
} from "../mail-paths.js";
import { getMs365AccessToken } from "../ms365.js";
import { formatTaskBody, taskMarkerNeedles } from "../task-body.js";
import { assertMcpOperation } from "./permissions.js";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export async function authedFetch(
  path: string,
  init?: RequestInit,
): Promise<Response | null> {
  const token = await getMs365AccessToken();
  if (!token) return null;
  const headers = new Headers(init?.headers ?? {});
  headers.set("Authorization", `Bearer ${token}`);
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(`${GRAPH_BASE}${path}`, { ...init, headers });
}

// --- Todo list discovery ---

export interface TodoListSummary {
  id: string;
  displayName: string;
  wellknownListName: string | null;
}

export async function listTodoLists(): Promise<TodoListSummary[] | null> {
  assertMcpOperation("todo.list_lists");
  const r = await authedFetch("/me/todo/lists");
  if (!r || !r.ok) return null;
  const body = (await r.json()) as {
    value?: Array<{
      id: string;
      displayName?: string;
      wellknownListName?: string;
    }>;
  };
  return (body.value ?? []).map((l) => ({
    id: l.id,
    displayName: l.displayName ?? "",
    wellknownListName: l.wellknownListName ?? null,
  }));
}

// --- Todo tasks ---

export interface TodoTaskSummary {
  id: string;
  title: string;
  status: string | null;
  importance: string | null;
  dueDateTime: { dateTime: string; timeZone: string } | null;
  createdDateTime: string | null;
  body: { content: string; contentType: string } | null;
}

function asTaskSummary(t: Record<string, unknown>): TodoTaskSummary {
  const dt = t.dueDateTime as
    | { dateTime?: string; timeZone?: string }
    | undefined;
  const body = t.body as { content?: string; contentType?: string } | undefined;
  return {
    id: String(t.id ?? ""),
    title: String(t.title ?? ""),
    status: t.status ? String(t.status) : null,
    importance: t.importance ? String(t.importance) : null,
    dueDateTime:
      dt?.dateTime && dt?.timeZone
        ? { dateTime: dt.dateTime, timeZone: dt.timeZone }
        : null,
    createdDateTime: t.createdDateTime ? String(t.createdDateTime) : null,
    body:
      body?.content !== undefined && body?.contentType !== undefined
        ? { content: body.content, contentType: body.contentType }
        : null,
  };
}

export async function listTodoTasks(
  listId: string,
  opts: { top?: number } = {},
): Promise<TodoTaskSummary[] | null> {
  assertMcpOperation("todo.list_tasks");
  const params = new URLSearchParams({
    $top: String(opts.top ?? 50),
    $orderby: "createdDateTime desc",
  });
  const r = await authedFetch(`/me/todo/lists/${listId}/tasks?${params}`);
  if (!r || !r.ok) return null;
  const body = (await r.json()) as { value?: Array<Record<string, unknown>> };
  return (body.value ?? []).map(asTaskSummary);
}

export async function getTodoTask(
  listId: string,
  taskId: string,
): Promise<TodoTaskSummary | null> {
  assertMcpOperation("todo.get_task");
  const r = await authedFetch(`/me/todo/lists/${listId}/tasks/${taskId}`);
  if (!r || !r.ok) return null;
  const t = (await r.json()) as Record<string, unknown>;
  return asTaskSummary(t);
}

export async function createTodoTask(
  listId: string,
  input: {
    title: string;
    dueIsoLocal?: string;
    auditMarker?: string;
    importance?: "low" | "normal" | "high";
    bodyContent?: string;
  },
): Promise<TodoTaskSummary | null> {
  assertMcpOperation("todo.create_task");
  const payload: Record<string, unknown> = {
    title: input.title,
    importance: input.importance ?? "normal",
  };
  if (input.bodyContent) {
    payload.body = { content: input.bodyContent, contentType: "text" };
  } else if (input.auditMarker) {
    payload.body = {
      content: formatTaskBody(input.auditMarker),
      contentType: "text",
    };
  }
  if (input.dueIsoLocal) {
    payload.dueDateTime = {
      dateTime: input.dueIsoLocal,
      timeZone: TIMEZONE,
    };
  }
  const r = await authedFetch(`/me/todo/lists/${listId}/tasks`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (!r || !r.ok) {
    log.warn("mcp todo create failed", {
      status: r?.status,
      title: input.title,
    });
    return null;
  }
  const t = (await r.json()) as Record<string, unknown>;
  return asTaskSummary(t);
}

export async function updateTodoTask(
  listId: string,
  taskId: string,
  patch: {
    title?: string;
    status?:
      | "notStarted"
      | "inProgress"
      | "completed"
      | "deferred"
      | "waitingOnOthers";
    importance?: "low" | "normal" | "high";
    dueIsoLocal?: string | null;
    bodyContent?: string;
  },
): Promise<TodoTaskSummary | null> {
  assertMcpOperation("todo.update_task");
  const payload: Record<string, unknown> = {};
  if (patch.title !== undefined) payload.title = patch.title;
  if (patch.status !== undefined) payload.status = patch.status;
  if (patch.importance !== undefined) payload.importance = patch.importance;
  if (patch.dueIsoLocal === null) {
    payload.dueDateTime = null;
  } else if (patch.dueIsoLocal !== undefined) {
    payload.dueDateTime = {
      dateTime: patch.dueIsoLocal,
      timeZone: TIMEZONE,
    };
  }
  if (patch.bodyContent !== undefined) {
    payload.body = { content: patch.bodyContent, contentType: "text" };
  }
  const r = await authedFetch(`/me/todo/lists/${listId}/tasks/${taskId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
  if (!r || !r.ok) return null;
  const t = (await r.json()) as Record<string, unknown>;
  return asTaskSummary(t);
}

export async function deleteTodoTask(
  listId: string,
  taskId: string,
): Promise<{ ok: boolean; status: number | null }> {
  assertMcpOperation("todo.delete_task");
  const r = await authedFetch(`/me/todo/lists/${listId}/tasks/${taskId}`, {
    method: "DELETE",
  });
  return { ok: Boolean(r?.ok), status: r?.status ?? null };
}

// --- Mail (read + write) ---
//
// Pure I/O. The caller (tool handler) gates with assertMcpOperation(operation,
// { input }) so policy constraints (own_mailbox_only, destination allow-list,
// metadata_only/no_body_rewrite, draft_only/no_send) are checked against the
// real arguments before any of these run.

export interface MailMessageSummary {
  id: string;
  subject: string;
  from: string;
  conversationId: string | null;
  receivedIso: string | null;
  isRead: boolean | null;
}

function asMailSummary(m: Record<string, unknown>): MailMessageSummary {
  const from = m.from as { emailAddress?: { address?: string } } | undefined;
  return {
    id: String(m.id ?? ""),
    subject: typeof m.subject === "string" ? m.subject : "",
    from: from?.emailAddress?.address ?? "",
    conversationId:
      typeof m.conversationId === "string" ? m.conversationId : null,
    receivedIso:
      typeof m.receivedDateTime === "string" ? m.receivedDateTime : null,
    isRead: typeof m.isRead === "boolean" ? m.isRead : null,
  };
}

export async function listMailMessages(opts: {
  sinceIso?: string | null;
  untilIso?: string | null;
  top?: number;
}): Promise<MailMessageSummary[] | null> {
  const params = new URLSearchParams({
    $select: "id,subject,from,conversationId,receivedDateTime,isRead",
    $top: String(opts.top ?? 50),
    $orderby: "receivedDateTime desc",
  });
  const filters: string[] = [];
  if (opts.sinceIso) filters.push(`receivedDateTime ge ${opts.sinceIso}`);
  if (opts.untilIso) filters.push(`receivedDateTime lt ${opts.untilIso}`);
  if (filters.length > 0) params.set("$filter", filters.join(" and "));
  const r = await authedFetch(`/me/mailFolders/Inbox/messages?${params}`);
  if (!r || !r.ok) return null;
  const body = (await r.json()) as { value?: Array<Record<string, unknown>> };
  return (body.value ?? []).map(asMailSummary);
}

export async function getMailMessageBody(
  id: string,
): Promise<{ id: string; subject: string; body: string } | null> {
  const r = await authedFetch(
    `/me/messages/${id}?$select=id,subject,body,bodyPreview`,
  );
  if (!r || !r.ok) return null;
  const m = (await r.json()) as {
    id?: string;
    subject?: string;
    body?: { content?: string };
    bodyPreview?: string;
  };
  return {
    id: m.id ?? id,
    subject: m.subject ?? "",
    body: m.body?.content ?? m.bodyPreview ?? "",
  };
}

// --- Mail folders (for subtree-allow-listed moves) ---

async function fetchFolderLevel(
  parentId: string | null,
): Promise<Array<RawFolder & { childCount: number }> | null> {
  const base =
    parentId === null
      ? "/me/mailFolders"
      : `/me/mailFolders/${parentId}/childFolders`;
  const r = await authedFetch(
    `${base}?$top=200&$select=id,displayName,parentFolderId,childFolderCount`,
  );
  if (!r || !r.ok) return null;
  const body = (await r.json()) as {
    value?: Array<{
      id?: string;
      displayName?: string;
      parentFolderId?: string;
      childFolderCount?: number;
    }>;
  };
  return (body.value ?? []).map((f) => ({
    id: String(f.id ?? ""),
    displayName: f.displayName ?? "",
    parentFolderId: f.parentFolderId,
    childCount: f.childFolderCount ?? 0,
  }));
}

/** All mail folders as {id, path}, walking the full hierarchy breadth-first. */
export async function listMs365MailFolders(): Promise<Array<{
  id: string;
  path: string;
}> | null> {
  const all: RawFolder[] = [];
  const queue: Array<string | null> = [null];
  let guard = 0;
  while (queue.length && guard < 1000) {
    guard++;
    const parent = queue.shift() ?? null;
    const level = await fetchFolderLevel(parent);
    if (level === null) {
      if (parent === null) return null; // top-level failure is fatal
      continue; // a child-level failure just prunes that branch
    }
    for (const f of level) {
      all.push({
        id: f.id,
        displayName: f.displayName,
        parentFolderId: f.parentFolderId,
      });
      if (f.childCount > 0) queue.push(f.id);
    }
  }
  return buildFolderPaths(all);
}

/** Resolve a folder path (e.g. "sorted/News") to its Graph folder id. */
export async function resolveMs365FolderByPath(
  path: string,
): Promise<string | null> {
  const folders = await listMs365MailFolders();
  if (!folders) return null;
  const target = normalizeMailPath(path).toLowerCase();
  return (
    folders.find((f) => normalizeMailPath(f.path).toLowerCase() === target)
      ?.id ?? null
  );
}

export async function moveMailMessage(
  id: string,
  destinationId: string,
): Promise<MailMessageSummary | null> {
  const r = await authedFetch(`/me/messages/${id}/move`, {
    method: "POST",
    body: JSON.stringify({ destinationId }),
  });
  if (!r || !r.ok) {
    log.warn("mcp mail move failed", { status: r?.status });
    return null;
  }
  const m = (await r.json()) as Record<string, unknown>;
  return asMailSummary(m);
}

export async function updateMailMessage(
  id: string,
  patch: {
    isRead?: boolean;
    importance?: "low" | "normal" | "high";
    flag?: Record<string, unknown>;
    categories?: string[];
  },
): Promise<MailMessageSummary | null> {
  const payload: Record<string, unknown> = {};
  if (patch.isRead !== undefined) payload.isRead = patch.isRead;
  if (patch.importance !== undefined) payload.importance = patch.importance;
  if (patch.flag !== undefined) payload.flag = patch.flag;
  if (patch.categories !== undefined) payload.categories = patch.categories;
  const r = await authedFetch(`/me/messages/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
  if (!r || !r.ok) {
    log.warn("mcp mail update failed", { status: r?.status });
    return null;
  }
  const m = (await r.json()) as Record<string, unknown>;
  return asMailSummary(m);
}

function toRecipientList(
  addresses: string[],
): Array<{ emailAddress: { address: string } }> {
  return addresses.map((address) => ({ emailAddress: { address } }));
}

export async function createDraftEmail(input: {
  subject: string;
  bodyContent?: string;
  bodyContentType?: "text" | "html";
  toRecipients?: string[];
  ccRecipients?: string[];
  bccRecipients?: string[];
}): Promise<{ id: string; webLink: string | null } | null> {
  const payload: Record<string, unknown> = {
    subject: input.subject,
    body: {
      contentType: input.bodyContentType ?? "text",
      content: input.bodyContent ?? "",
    },
  };
  if (input.toRecipients?.length) {
    payload.toRecipients = toRecipientList(input.toRecipients);
  }
  if (input.ccRecipients?.length) {
    payload.ccRecipients = toRecipientList(input.ccRecipients);
  }
  if (input.bccRecipients?.length) {
    payload.bccRecipients = toRecipientList(input.bccRecipients);
  }
  const r = await authedFetch("/me/messages", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (!r || !r.ok) {
    log.warn("mcp draft create failed", { status: r?.status });
    return null;
  }
  const m = (await r.json()) as { id?: string; webLink?: string };
  return { id: m.id ?? "", webLink: m.webLink ?? null };
}

// --- Calendar (read + write) ---

export interface CalendarEventSummary {
  id: string;
  subject: string;
  start: { dateTime: string; timeZone: string } | null;
  end: { dateTime: string; timeZone: string } | null;
  location: string | null;
  isAllDay: boolean | null;
  organizer: string | null;
  webLink: string | null;
  bodyPreview: string | null;
}

const EVENT_SELECT =
  "id,subject,start,end,location,isAllDay,organizer,webLink,bodyPreview";

function asEventSummary(e: Record<string, unknown>): CalendarEventSummary {
  const asWindow = (
    v: unknown,
  ): { dateTime: string; timeZone: string } | null => {
    const w = v as { dateTime?: string; timeZone?: string } | undefined;
    return w?.dateTime
      ? { dateTime: w.dateTime, timeZone: w.timeZone ?? "UTC" }
      : null;
  };
  const location = e.location as { displayName?: string } | undefined;
  const organizer = e.organizer as
    | { emailAddress?: { address?: string } }
    | undefined;
  return {
    id: String(e.id ?? ""),
    subject: typeof e.subject === "string" ? e.subject : "",
    start: asWindow(e.start),
    end: asWindow(e.end),
    location: location?.displayName ?? null,
    isAllDay: typeof e.isAllDay === "boolean" ? e.isAllDay : null,
    organizer: organizer?.emailAddress?.address ?? null,
    webLink: typeof e.webLink === "string" ? e.webLink : null,
    bodyPreview: typeof e.bodyPreview === "string" ? e.bodyPreview : null,
  };
}

export async function listCalendarEvents(opts: {
  fromIso?: string | null;
  toIso?: string | null;
  top?: number;
}): Promise<CalendarEventSummary[] | null> {
  const params = new URLSearchParams({
    $select: EVENT_SELECT,
    $top: String(opts.top ?? 50),
    $orderby: "start/dateTime",
  });
  const filters: string[] = [];
  if (opts.fromIso) filters.push(`start/dateTime ge '${opts.fromIso}'`);
  if (opts.toIso) filters.push(`start/dateTime le '${opts.toIso}'`);
  if (filters.length > 0) params.set("$filter", filters.join(" and "));
  const r = await authedFetch(`/me/events?${params}`);
  if (!r || !r.ok) return null;
  const body = (await r.json()) as { value?: Array<Record<string, unknown>> };
  return (body.value ?? []).map(asEventSummary);
}

export async function getCalendarEvent(
  id: string,
): Promise<CalendarEventSummary | null> {
  const r = await authedFetch(`/me/events/${id}?$select=${EVENT_SELECT}`);
  if (!r || !r.ok) return null;
  const e = (await r.json()) as Record<string, unknown>;
  return asEventSummary(e);
}

export async function getCalendarView(opts: {
  startIso: string;
  endIso: string;
  top?: number;
}): Promise<CalendarEventSummary[] | null> {
  const params = new URLSearchParams({
    startDateTime: opts.startIso,
    endDateTime: opts.endIso,
    $select: EVENT_SELECT,
    $top: String(opts.top ?? 100),
    $orderby: "start/dateTime",
  });
  const r = await authedFetch(`/me/calendarView?${params}`);
  if (!r || !r.ok) return null;
  const body = (await r.json()) as { value?: Array<Record<string, unknown>> };
  return (body.value ?? []).map(asEventSummary);
}

export async function createCalendarEvent(input: {
  subject: string;
  startIso: string;
  endIso: string;
  location?: string;
  bodyContent?: string;
}): Promise<CalendarEventSummary | null> {
  const payload: Record<string, unknown> = {
    subject: input.subject,
    start: { dateTime: input.startIso, timeZone: TIMEZONE },
    end: { dateTime: input.endIso, timeZone: TIMEZONE },
  };
  if (input.location) payload.location = { displayName: input.location };
  if (input.bodyContent) {
    payload.body = { contentType: "text", content: input.bodyContent };
  }
  const r = await authedFetch("/me/events", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (!r || !r.ok) {
    log.warn("mcp calendar create failed", { status: r?.status });
    return null;
  }
  const e = (await r.json()) as Record<string, unknown>;
  return asEventSummary(e);
}

export async function updateCalendarEvent(
  id: string,
  patch: {
    subject?: string;
    startIso?: string;
    endIso?: string;
    location?: string;
    bodyContent?: string;
  },
): Promise<CalendarEventSummary | null> {
  const payload: Record<string, unknown> = {};
  if (patch.subject !== undefined) payload.subject = patch.subject;
  if (patch.startIso !== undefined) {
    payload.start = { dateTime: patch.startIso, timeZone: TIMEZONE };
  }
  if (patch.endIso !== undefined) {
    payload.end = { dateTime: patch.endIso, timeZone: TIMEZONE };
  }
  if (patch.location !== undefined) {
    payload.location = { displayName: patch.location };
  }
  if (patch.bodyContent !== undefined) {
    payload.body = { contentType: "text", content: patch.bodyContent };
  }
  const r = await authedFetch(`/me/events/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
  if (!r || !r.ok) {
    log.warn("mcp calendar update failed", { status: r?.status });
    return null;
  }
  const e = (await r.json()) as Record<string, unknown>;
  return asEventSummary(e);
}

export async function deleteCalendarEvent(
  id: string,
): Promise<{ ok: boolean; status: number | null }> {
  const r = await authedFetch(`/me/events/${id}`, { method: "DELETE" });
  return { ok: Boolean(r?.ok), status: r?.status ?? null };
}

export async function rsvpCalendarEvent(
  id: string,
  action: "accept" | "decline" | "tentativelyAccept",
  opts: { comment?: string; sendResponse?: boolean } = {},
): Promise<{ ok: boolean; status: number | null }> {
  const payload: Record<string, unknown> = {
    sendResponse: opts.sendResponse ?? true,
  };
  if (opts.comment !== undefined) payload.comment = opts.comment;
  const r = await authedFetch(`/me/events/${id}/${action}`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return { ok: Boolean(r?.ok), status: r?.status ?? null };
}

export { taskMarkerNeedles };
