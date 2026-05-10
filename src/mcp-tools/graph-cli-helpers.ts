// Thin Graph CLI helpers used by the MCP tools.
//
// The token refresh in src/graph-cli-tasks.ts (getGraphCliAccessToken) is
// reused as-is — it has no policy gate, only token caching. The HTTP wrapper
// here adds the MCP-side policy gate via assertMcpOperation() before each
// call, parallel to the scan flow's assertGraphOperation() gate. The two
// gates are deliberately separate: the scan flow runs in a handler context;
// the MCP server runs its own operation allow-list.
//
// All calls run host-side. Refresh tokens never cross any boundary.

import { TIMEZONE } from "../config.js";
import { getGraphCliAccessToken } from "../graph-cli-tasks.js";
import { log } from "../log.js";
import { formatTaskBody, taskMarkerNeedles } from "../task-body.js";
import { assertMcpOperation } from "./permissions.js";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

async function authedFetch(
  path: string,
  init?: RequestInit,
): Promise<Response | null> {
  const token = await getGraphCliAccessToken();
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
  const body = t.body as
    | { content?: string; contentType?: string }
    | undefined;
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
    status?: "notStarted" | "inProgress" | "completed" | "deferred" | "waitingOnOthers";
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

export { taskMarkerNeedles };
