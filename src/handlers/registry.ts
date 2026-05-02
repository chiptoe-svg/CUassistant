// Handler registry. The only registered handler today is triage.

export interface HandlerScopes {
  // Consent scopes needed by the handler's Graph calls. The stricter list of
  // executable host operations lives in src/permissions.ts.
  graph: string[];
  // Reserved for future expansion:
  //   gmail?: string[]    -- Google Workspace scopes
  //   ai?: string         -- host-side AI op label
}

export interface HandlerResult {
  /** Human-readable text to deliver via registered notifiers. */
  summary: string;
  /** If true, skip notifier delivery (e.g. the handler had nothing to report). */
  silent?: boolean;
}

export interface Handler {
  name: string;
  scopes: HandlerScopes;
  run(): Promise<HandlerResult>;
}

const handlers: Handler[] = [];

export function registerHandler(handler: Handler): void {
  if (handlers.some((h) => h.name === handler.name)) {
    throw new Error(`handler already registered: ${handler.name}`);
  }
  handlers.push(handler);
}

export function getHandlers(): ReadonlyArray<Handler> {
  return handlers;
}
