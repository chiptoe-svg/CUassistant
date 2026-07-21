// src/notifiers/reachability.ts
// Network reachability probe for the Telegram poll-loop watchdog.
//
// Deliberately uses a raw node:net socket, NOT fetch. If the probe went
// through fetch/undici, a wedged connection pool would fail the probe too, we
// would misread that as "network down", and the watchdog would never fire in
// exactly the case it exists for. A raw socket is an independent signal.
//
// A DNS-only probe is not sufficient: resolver caching can make it succeed
// during a real outage.
import net from "node:net";

export const TELEGRAM_PROBE_HOST = "api.telegram.org";
export const TELEGRAM_PROBE_PORT = 443;
export const PROBE_TIMEOUT_MS = 5_000;

export interface Reachability {
  /** True if a TCP connection can be established. Never throws. */
  check(): Promise<boolean>;
}

export function makeTcpReachability(
  host: string,
  port: number,
  timeoutMs: number,
): Reachability {
  return {
    check(): Promise<boolean> {
      return new Promise<boolean>((resolve) => {
        const socket = new net.Socket();
        let settled = false;
        const finish = (ok: boolean): void => {
          if (settled) return;
          settled = true;
          socket.destroy();
          resolve(ok);
        };
        socket.setTimeout(timeoutMs);
        socket.once("connect", () => finish(true));
        socket.once("timeout", () => finish(false));
        socket.once("error", () => finish(false));
        socket.connect(port, host);
      });
    },
  };
}
