// Notifier registry — where summaries get delivered.
//
// Only stdout and a local file notifier are wired today.

export interface Notifier {
  name: string;
  send(text: string): Promise<void>;
}

const notifiers: Notifier[] = [];

export function registerNotifier(n: Notifier): void {
  if (notifiers.some((x) => x.name === n.name)) {
    throw new Error(`notifier already registered: ${n.name}`);
  }
  notifiers.push(n);
}

export function getNotifiers(): ReadonlyArray<Notifier> {
  return notifiers;
}

export async function deliver(text: string): Promise<void> {
  for (const n of notifiers) {
    try {
      await n.send(text);
    } catch (err) {
      // Notifier failures are non-fatal — the decisions.jsonl is the source
      // of truth for what happened; a missing summary delivery shouldn't
      // crash the scan.
      process.stderr.write(
        `[notifier:${n.name}] delivery failed: ${String(err)}\n`,
      );
    }
  }
}
