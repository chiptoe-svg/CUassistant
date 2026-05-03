import {
  getGraphCliAccessToken,
  getGraphCliDefaultTodoListId,
} from "../src/graph-cli-tasks.js";
import { setActiveHandler } from "../src/permissions.js";

type TodoTask = {
  id: string;
  title?: string;
  body?: {
    content?: string;
    contentType?: string;
  };
};

async function main() {
  setActiveHandler("triage");
  try {
    const token = await getGraphCliAccessToken();
    const listId = await getGraphCliDefaultTodoListId();
    if (!token || !listId) {
      throw new Error("Graph CLI task provider is not configured");
    }

    const tasks = await listTasks(token, listId);
    let updated = 0;
    for (const task of tasks) {
      const title = cleanTitle(task.title ?? "");
      const content = cleanBody(task.body?.content ?? "");
      if (
        title === (task.title ?? "") &&
        content === (task.body?.content ?? "")
      ) {
        continue;
      }
      await patchTask(token, listId, task.id, {
        title,
        body: { content, contentType: "text" },
      });
      updated += 1;
      console.log(`updated ${title}`);
    }
    console.log(`cleanup complete: updated ${updated} task(s)`);
  } finally {
    setActiveHandler(null);
  }
}

async function listTasks(token: string, listId: string): Promise<TodoTask[]> {
  const params = new URLSearchParams({ $top: "100" });
  let url: string | null =
    `https://graph.microsoft.com/v1.0/me/todo/lists/${listId}/tasks?${params}`;
  const tasks: TodoTask[] = [];
  while (url) {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(
        `Task list failed with HTTP ${response.status}: ${await response.text()}`,
      );
    }
    const body = (await response.json()) as {
      value?: TodoTask[];
      "@odata.nextLink"?: string;
    };
    tasks.push(...(body.value ?? []));
    url = body["@odata.nextLink"] ?? null;
  }
  return tasks;
}

async function patchTask(
  token: string,
  listId: string,
  taskId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(
    `https://graph.microsoft.com/v1.0/me/todo/lists/${listId}/tasks/${taskId}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Task patch failed with HTTP ${response.status}: ${await response.text()}`,
    );
  }
}

function cleanTitle(title: string): string {
  return title
    .replace(/\s+(?:->|\u2192)\s+\/(?:gmail|outlook)\/.*$/i, "")
    .trim();
}

function cleanBody(content: string): string {
  const match = content.match(
    /CUassistant audit marker:\s*cuassistant:([a-f0-9]{12,64})/i,
  );
  if (!match) return content;
  return `CUassistant ref: ${match[1].slice(0, 12)}`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
