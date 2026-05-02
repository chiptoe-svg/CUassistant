import {
  GRAPH_CLI_CLIENT_ID,
  GRAPH_CLI_REFRESH_TOKEN,
  GRAPH_CLI_TENANT_ID,
  TIMEZONE,
} from "./config.js";
import { log } from "./log.js";
import { assertGraphOperation } from "./permissions.js";

let cachedToken: { value: string; expiresAtMs: number } | null = null;

async function getGraphCliAccessToken(): Promise<string | null> {
  if (!GRAPH_CLI_REFRESH_TOKEN) {
    log.debug("graph-cli tasks: not configured (missing refresh token)");
    return null;
  }
  if (cachedToken && cachedToken.expiresAtMs > Date.now() + 60_000) {
    return cachedToken.value;
  }
  try {
    const resp = await fetch(
      `https://login.microsoftonline.com/${GRAPH_CLI_TENANT_ID}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: GRAPH_CLI_CLIENT_ID,
          refresh_token: GRAPH_CLI_REFRESH_TOKEN,
          scope:
            "https://graph.microsoft.com/Tasks.ReadWrite " + "offline_access",
        }).toString(),
      },
    );
    if (!resp.ok) {
      log.warn("graph-cli tasks: token refresh failed", {
        status: resp.status,
        body: (await resp.text()).slice(0, 200),
      });
      return null;
    }
    const data = (await resp.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!data.access_token) return null;
    cachedToken = {
      value: data.access_token,
      expiresAtMs: Date.now() + (data.expires_in ?? 3600) * 1000,
    };
    return cachedToken.value;
  } catch (err) {
    log.warn("graph-cli tasks: token endpoint unreachable", {
      err: String(err),
    });
    return null;
  }
}

export async function getGraphCliDefaultTodoListId(): Promise<string | null> {
  assertGraphOperation("todo.listLists");
  const token = await getGraphCliAccessToken();
  if (!token) return null;
  try {
    const r = await fetch("https://graph.microsoft.com/v1.0/me/todo/lists", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const body = (await r.json()) as {
      value?: Array<{
        id: string;
        displayName?: string;
        wellknownListName?: string;
      }>;
    };
    const lists = body.value || [];
    const preferred =
      lists.find((l) => l.wellknownListName === "defaultList") ||
      lists.find((l) => l.displayName === "Tasks") ||
      lists[0];
    return preferred?.id ?? null;
  } catch {
    return null;
  }
}

export async function createGraphCliTask(
  listId: string,
  title: string,
  dueIsoLocal?: string,
  auditMarker?: string,
): Promise<string | null> {
  assertGraphOperation("todo.createTask");
  const token = await getGraphCliAccessToken();
  if (!token) return null;
  const body: Record<string, unknown> = {
    title,
    body: {
      content: auditMarker ? `CUassistant audit marker: ${auditMarker}` : "",
      contentType: "text",
    },
    importance: "normal",
  };
  if (dueIsoLocal) {
    body.dueDateTime = { dateTime: dueIsoLocal, timeZone: TIMEZONE };
  }
  try {
    const r = await fetch(
      `https://graph.microsoft.com/v1.0/me/todo/lists/${listId}/tasks`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    if (!r.ok) {
      log.warn("graph-cli task creation failed", { status: r.status, title });
      return null;
    }
    const created = (await r.json()) as { id?: string };
    return created.id ?? null;
  } catch (err) {
    log.warn("graph-cli task creation threw", { err: String(err) });
    return null;
  }
}

export async function findGraphCliTaskByMarker(
  listId: string,
  auditMarker: string,
): Promise<string | null> {
  assertGraphOperation("todo.findTaskByMarker");
  const token = await getGraphCliAccessToken();
  if (!token) return null;
  const params = new URLSearchParams({
    $select: "id,title,body",
    $top: "100",
  });
  let url: string | null =
    `https://graph.microsoft.com/v1.0/me/todo/lists/${listId}/tasks?${params}`;
  try {
    while (url) {
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) return null;
      const body = (await r.json()) as {
        value?: Array<{ id: string; body?: { content?: string } }>;
        "@odata.nextLink"?: string;
      };
      for (const task of body.value || []) {
        if (task.body?.content?.includes(auditMarker)) {
          return task.id;
        }
      }
      url = body["@odata.nextLink"] ?? null;
    }
  } catch (err) {
    log.debug("graph-cli marker lookup threw", { err: String(err) });
  }
  return null;
}
