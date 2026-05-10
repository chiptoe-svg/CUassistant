// MS To Do tools — Graph CLI backend.
//
// Tool names mirror CUagent's @softeria/ms-365-mcp-server surface
// (list-todo-task-lists, list-todo-tasks, get-todo-task, create-todo-task,
// update-todo-task, delete-todo-task). All five are active today: the Graph
// CLI client is consented for Tasks.ReadWrite at Clemson and the refresh
// token already lives in CUassistant's .env.
//
// Every write tool wraps its backend call in startMcpAudit/finishMcpAudit
// so state/decisions.jsonl gets a durable intent + terminal pair.

import { startMcpAudit, finishMcpAudit } from "./audit.js";
import {
  createTodoTask,
  deleteTodoTask,
  getTodoTask,
  listTodoLists,
  listTodoTasks,
  updateTodoTask,
} from "./graph-cli-helpers.js";
import { assertMcpOperation } from "./permissions.js";
import { registerTools } from "./server.js";
import { err, okJson, permissionErr, type McpToolDefinition } from "./types.js";

const listTodoTaskLists: McpToolDefinition = {
  tool: {
    name: "list-todo-task-lists",
    description:
      "List the user's MS To Do task lists. Returns id, displayName, and " +
      "wellknownListName. The default list is the one with " +
      "wellknownListName = \"defaultList\".",
    inputSchema: { type: "object" as const, properties: {} },
  },
  async handler(_args) {
    try {
      assertMcpOperation("todo.list_lists");
    } catch (e) {
      return permissionErr(e);
    }
    const lists = await listTodoLists();
    if (lists === null) return err("Graph CLI returned no lists.");
    return okJson({ lists });
  },
};

const listTodoTasksTool: McpToolDefinition = {
  tool: {
    name: "list-todo-tasks",
    description:
      "List tasks in a To Do list, newest first. Pass listId from " +
      "list-todo-task-lists. The optional `top` arg caps the count " +
      "(default 50).",
    inputSchema: {
      type: "object" as const,
      properties: {
        listId: { type: "string", description: "Target list id." },
        top: {
          type: "integer",
          description: "Max tasks to return (default 50).",
        },
      },
      required: ["listId"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("todo.list_tasks");
    } catch (e) {
      return permissionErr(e);
    }
    const listId = args.listId as string | undefined;
    if (!listId) return err("listId is required");
    const top = typeof args.top === "number" ? (args.top as number) : undefined;
    const tasks = await listTodoTasks(listId, { top });
    if (tasks === null) return err("Graph CLI returned no tasks.");
    return okJson({ listId, tasks });
  },
};

const getTodoTaskTool: McpToolDefinition = {
  tool: {
    name: "get-todo-task",
    description: "Fetch a single To Do task by listId + taskId.",
    inputSchema: {
      type: "object" as const,
      properties: {
        listId: { type: "string", description: "Target list id." },
        taskId: { type: "string", description: "Target task id." },
      },
      required: ["listId", "taskId"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("todo.get_task");
    } catch (e) {
      return permissionErr(e);
    }
    const listId = args.listId as string | undefined;
    const taskId = args.taskId as string | undefined;
    if (!listId || !taskId) return err("listId and taskId are required");
    const task = await getTodoTask(listId, taskId);
    if (task === null) return err("Task not found or backend unavailable.");
    return okJson({ task });
  },
};

const createTodoTaskTool: McpToolDefinition = {
  tool: {
    name: "create-todo-task",
    description:
      "Create a new To Do task in the named list. Mirrors CUagent's " +
      "create-todo-task tool — same shape, same audit posture. The body " +
      "is host-built from auditMarker (when supplied) or falls back to the " +
      "literal `bodyContent` you pass.",
    inputSchema: {
      type: "object" as const,
      properties: {
        listId: { type: "string", description: "Target list id." },
        title: { type: "string", description: "Task title." },
        dueIsoLocal: {
          type: "string",
          description:
            "Optional due date as ISO 8601 in the user's local timezone " +
            "(no offset; the host applies TIMEZONE). Example: " +
            "\"2026-05-15T17:00:00\".",
        },
        importance: {
          type: "string",
          enum: ["low", "normal", "high"],
          description: "Task importance (default normal).",
        },
        auditMarker: {
          type: "string",
          description:
            "Optional dedupe marker. When provided, the body is built via " +
            "formatTaskBody() to match CUassistant's idempotency convention.",
        },
        bodyContent: {
          type: "string",
          description:
            "Optional plain-text body. Ignored when auditMarker is set.",
        },
      },
      required: ["listId", "title"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("todo.create_task");
    } catch (e) {
      return permissionErr(e);
    }
    const listId = args.listId as string | undefined;
    const title = args.title as string | undefined;
    if (!listId || !title) return err("listId and title are required");
    const audit = startMcpAudit({
      operation: "todo.create_task",
      toolName: "create-todo-task",
      argsSummary: {
        listId,
        title_length: title.length,
        has_due: Boolean(args.dueIsoLocal),
        has_audit_marker: Boolean(args.auditMarker),
        importance: args.importance ?? "normal",
      },
    });
    try {
      const task = await createTodoTask(listId, {
        title,
        dueIsoLocal: args.dueIsoLocal as string | undefined,
        importance: args.importance as "low" | "normal" | "high" | undefined,
        auditMarker: args.auditMarker as string | undefined,
        bodyContent: args.bodyContent as string | undefined,
      });
      if (!task) {
        finishMcpAudit(audit, {
          result: "error",
          detail: "graph_cli_create_failed",
        });
        return err("Graph CLI failed to create task.");
      }
      finishMcpAudit(audit, { result: "success", object_id: task.id });
      return okJson({ task });
    } catch (e) {
      finishMcpAudit(audit, { result: "error", detail: String(e) });
      throw e;
    }
  },
};

const updateTodoTaskTool: McpToolDefinition = {
  tool: {
    name: "update-todo-task",
    description:
      "Update a To Do task's title, status, importance, due date, or body. " +
      "Mirrors CUagent's update-todo-task tool. To clear a due date, pass " +
      "dueIsoLocal as null.",
    inputSchema: {
      type: "object" as const,
      properties: {
        listId: { type: "string" },
        taskId: { type: "string" },
        title: { type: "string" },
        status: {
          type: "string",
          enum: [
            "notStarted",
            "inProgress",
            "completed",
            "deferred",
            "waitingOnOthers",
          ],
        },
        importance: { type: "string", enum: ["low", "normal", "high"] },
        dueIsoLocal: {
          type: ["string", "null"],
          description: "ISO 8601 in TIMEZONE, or null to clear.",
        },
        bodyContent: { type: "string", description: "Plain-text body." },
      },
      required: ["listId", "taskId"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("todo.update_task");
    } catch (e) {
      return permissionErr(e);
    }
    const listId = args.listId as string | undefined;
    const taskId = args.taskId as string | undefined;
    if (!listId || !taskId) return err("listId and taskId are required");
    const audit = startMcpAudit({
      operation: "todo.update_task",
      toolName: "update-todo-task",
      argsSummary: {
        listId,
        taskId,
        fields_changed: [
          args.title !== undefined && "title",
          args.status !== undefined && "status",
          args.importance !== undefined && "importance",
          args.dueIsoLocal !== undefined && "dueDateTime",
          args.bodyContent !== undefined && "body",
        ].filter(Boolean),
      },
    });
    try {
      const task = await updateTodoTask(listId, taskId, {
        title: args.title as string | undefined,
        status: args.status as
          | "notStarted"
          | "inProgress"
          | "completed"
          | "deferred"
          | "waitingOnOthers"
          | undefined,
        importance: args.importance as "low" | "normal" | "high" | undefined,
        dueIsoLocal: args.dueIsoLocal as string | null | undefined,
        bodyContent: args.bodyContent as string | undefined,
      });
      if (!task) {
        finishMcpAudit(audit, {
          result: "error",
          detail: "graph_cli_update_failed",
        });
        return err("Graph CLI failed to update task.");
      }
      finishMcpAudit(audit, { result: "success", object_id: task.id });
      return okJson({ task });
    } catch (e) {
      finishMcpAudit(audit, { result: "error", detail: String(e) });
      throw e;
    }
  },
};

const deleteTodoTaskTool: McpToolDefinition = {
  tool: {
    name: "delete-todo-task",
    description:
      "Delete a To Do task by listId + taskId. Mirrors CUagent's " +
      "delete-todo-task tool. Tasks.ReadWrite covers task deletion " +
      "without needing additional consent.",
    inputSchema: {
      type: "object" as const,
      properties: {
        listId: { type: "string" },
        taskId: { type: "string" },
      },
      required: ["listId", "taskId"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("todo.delete_task");
    } catch (e) {
      return permissionErr(e);
    }
    const listId = args.listId as string | undefined;
    const taskId = args.taskId as string | undefined;
    if (!listId || !taskId) return err("listId and taskId are required");
    const audit = startMcpAudit({
      operation: "todo.delete_task",
      toolName: "delete-todo-task",
      argsSummary: { listId, taskId },
    });
    try {
      const result = await deleteTodoTask(listId, taskId);
      if (!result.ok) {
        finishMcpAudit(audit, {
          result: "error",
          detail: `graph_cli_delete_failed status=${result.status ?? "null"}`,
        });
        return err(
          `Graph CLI failed to delete task (status ${result.status ?? "null"}).`,
        );
      }
      finishMcpAudit(audit, { result: "success", object_id: taskId });
      return okJson({ deleted: true, taskId });
    } catch (e) {
      finishMcpAudit(audit, { result: "error", detail: String(e) });
      throw e;
    }
  },
};

registerTools([
  listTodoTaskLists,
  listTodoTasksTool,
  getTodoTaskTool,
  createTodoTaskTool,
  updateTodoTaskTool,
  deleteTodoTaskTool,
]);
