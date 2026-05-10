import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

import {
  McpPermissionDeniedError,
  McpStubPendingError,
} from "./permissions.js";

export interface McpToolDefinition {
  tool: Tool;
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
}

export function ok(text: string): CallToolResult {
  return { content: [{ type: "text" as const, text }] };
}

export function okJson(data: unknown): CallToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

export function err(text: string): CallToolResult {
  return {
    content: [{ type: "text" as const, text: `Error: ${text}` }],
    isError: true,
  };
}

export function stubError(operation: string, pendingScope: string): CallToolResult {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            error: "stub_pending_approval",
            operation,
            pending_scope: pendingScope,
            message:
              `This operation is implemented but disabled at the policy ` +
              `boundary until IT grants ${pendingScope} to the Graph CLI ` +
              `client. Remove the stub guard in the tool file to activate ` +
              `once the consent is in place.`,
          },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

/** Render a permission/stub error from assertMcpOperation as a tool result. */
export function permissionErr(e: unknown): CallToolResult {
  if (e instanceof McpStubPendingError) {
    return stubError(e.operation, e.pendingScope);
  }
  if (e instanceof McpPermissionDeniedError) {
    return err(e.message);
  }
  return err(`unexpected permission error: ${String(e)}`);
}
