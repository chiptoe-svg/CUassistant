/**
 * TCP forwarder: <container-bridge-gateway>:{8765,8766,8767,8011,10255} → 127.0.0.1:{...}
 *
 * CUassistant MCP servers (and the OneCLI credential proxy) are loopback-only by
 * design (127.0.0.1). Apple Container VMs reach the host only via the bridge
 * gateway, not via 127.0.0.1. This forwarder bridges both without requiring those
 * services to bind a non-loopback interface.
 *
 * Port map:
 *   8765  — credentialed MCP server (requires Authorization bearer)
 *   8766  — public MCP server (Clemson class schedule, requires bearer)
 *   8767  — catalog MCP server (GC curriculum/degree plan, requires bearer)
 *   8011  — gc-alumni MCP server (GC alumni outcomes, no auth)
 *   10255 — OneCLI credential proxy (containers fetch API credentials through it)
 *
 * ── Why the gateway is resolved at runtime (2026-07-10) ──────────────────────
 * Apple Container 1.0 moved the bridge subnet from 192.168.64.0/24 to
 * 192.168.65.0/24. This script hardcoded `192.168.64.1`. After the upgrade that
 * address no longer exists on any interface, so every listener here was bound to
 * a dead address: containers (now on 192.168.65.x) could reach neither the MCP
 * servers nor — worse — the OneCLI credential proxy on 10255.
 *
 * A hardcoded address is exactly what turned a documented network change into a
 * silent outage, so there is deliberately no hardcoded fallback. Resolution order:
 *   1. BRIDGE_HOST env var (explicit operator override)
 *   2. `container network inspect default` → [0].status.ipv4Gateway
 *   3. os.networkInterfaces() scan of bridge100 / bridge0
 * If all three fail we wait and retry rather than guess.
 *
 * ── Why we supervise instead of binding once ────────────────────────────────
 * The gateway interface (bridge100) exists only while the Apple Container network
 * is up. At boot, or during a quiet period with no containers, the address is
 * absent and bind() fails with EADDRNOTAVAIL. The old code called process.exit(1)
 * on any listen error, so one transient failure killed every forwarder. Each port
 * is now supervised independently and rebinds when the address appears — or
 * reappears at a different value after a runtime upgrade.
 *
 * ── Why we never bind 0.0.0.0 ───────────────────────────────────────────────
 * 8765 is credentialed and 10255 is a credential proxy. Binding all interfaces
 * would expose both to the campus LAN. Gateway-only is the entire point of this
 * file; widening the bind would trade a connectivity bug for a security hole.
 *
 * (8766/8767 now bind 0.0.0.0 themselves, in their own processes, behind a
 * bearer each. That is deliberate and scoped to those two servers — it is not a
 * reason to widen anything here. This forwarder is a raw TCP pipe: it copies
 * bytes between sockets and never parses or rewrites HTTP, so Authorization
 * headers pass through untouched and containers using it need no change.)
 */
import net from 'net';
import os from 'os';
import { execFileSync } from 'child_process';

// Two cadences. A container starting the moment the gateway appears cannot
// reach a forwarder that has not bound yet, so while any port is unbound we
// poll fast to close that window. Once everything is bound there is nothing to
// react to quickly, so we drop back to the slow cadence.
//
// This is affordable because the two checks cost very different amounts:
// addressIsLive() is a pure os.networkInterfaces() read, while
// gatewayFromRuntime() spawns `container network inspect`. Only the cheap check
// runs at FAST_MS; the declared gateway is re-read on the slow cadence, which is
// correct because it is static configuration that changes when a network is
// recreated, not moment to moment.
const RETRY_MS = 5000;
const FAST_MS = 250;
const DECLARED_TTL_MS = 30_000;
const PORTS = [
  8765, // cuassistant-credentialed MCP server
  8766, // cuassistant-public MCP server (Clemson class schedule)
  8767, // cuassistant-catalog MCP server (GC curriculum)
  8011, // gc-alumni MCP server (GC alumni outcomes, no auth)
  10255, // OneCLI credential proxy
];

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isIpv4(value) {
  const m = IPV4_RE.exec(value ?? '');
  return !!m && m.slice(1).every((o) => Number(o) >= 0 && Number(o) <= 255);
}

/** Ask the container runtime for the default network's gateway. */
function gatewayFromRuntime() {
  try {
    const out = execFileSync('container', ['network', 'inspect', 'default'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parsed = JSON.parse(out);
    const entry = Array.isArray(parsed) ? parsed[0] : parsed;
    const gw = entry?.status?.ipv4Gateway;
    return isIpv4(gw) ? gw : null;
  } catch {
    return null;
  }
}

/** Fall back to whatever IPv4 the container bridge interface currently holds. */
function gatewayFromInterfaces() {
  const ifaces = os.networkInterfaces();
  for (const name of ['bridge100', 'bridge0']) {
    const addr = (ifaces[name] ?? []).find((a) => a.family === 'IPv4')?.address;
    if (isIpv4(addr)) return addr;
  }
  return null;
}

/** Is this address actually configured on some interface right now? */
function addressIsLive(addr) {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && a.address === addr) return true;
    }
  }
  return false;
}

/**
 * `container network inspect` reports the network's CONFIGURED gateway, which
 * outlives the interface: vmnet only creates the address while a container is
 * running, and the config still names it long after it is gone. Trusting that
 * value unchecked is how this process spent two days bound to a dead
 * 192.168.64.1 — the socket stayed in LISTEN, so connections hung instead of
 * being refused, and supervise()'s "gateway disappeared" branch could never
 * fire because its input never changed.
 *
 * So a declared gateway counts only while it is actually on an interface.
 * When it is not, return null and let supervise() close the listener: a
 * refused connection is a detectable failure, a hung one is not.
 *
 * We deliberately do NOT fall back to gatewayFromInterfaces() here. A declared
 * gateway means the container network exists but is down; binding some other
 * bridge interface instead would put 8765 (credentialed) and 10255 (the
 * credential proxy) on a network nobody chose. Waiting is the safe failure.
 */
let declaredCache = { value: null, at: 0 };

/** The runtime's declared gateway, re-read at most every DECLARED_TTL_MS. */
function declaredGateway(now) {
  if (now - declaredCache.at < DECLARED_TTL_MS) return declaredCache.value;
  declaredCache = { value: gatewayFromRuntime(), at: now };
  return declaredCache.value;
}

function resolveGateway(now = Date.now()) {
  const override = process.env.BRIDGE_HOST;
  if (override) {
    if (!isIpv4(override)) throw new Error(`BRIDGE_HOST is not an IPv4 address: ${override}`);
    return override;
  }
  const declared = declaredGateway(now);
  if (declared) return addressIsLive(declared) ? declared : null;
  return gatewayFromInterfaces() ?? null;
}

function log(msg) {
  process.stdout.write(`[mcp-bridge] ${msg}\n`);
}

/**
 * Keep one forwarder alive on `port`, rebinding whenever the gateway address
 * becomes available or changes. Never exits the process.
 */
/** Ports currently without a listener. Drives the polling cadence. */
const unbound = new Set(PORTS);

function supervise(port) {
  let server = null;
  let boundHost = null;
  let lastComplaint = null;

  const tick = () => {
    let host;
    try {
      host = resolveGateway();
    } catch (err) {
      if (lastComplaint !== err.message) {
        log(`port ${port}: ${err.message}`);
        lastComplaint = err.message;
      }
      return;
    }

    if (!host) {
      if (server) {
        log(`port ${port}: gateway disappeared, closing listener`);
        server.close();
        server = null;
        boundHost = null;
        unbound.add(port);
      } else if (lastComplaint !== 'no-gateway') {
        log(`port ${port}: no container bridge gateway yet, waiting`);
        lastComplaint = 'no-gateway';
      }
      return;
    }

    if (server && boundHost === host) return; // already bound correctly

    if (server) {
      log(`port ${port}: gateway moved ${boundHost} → ${host}, rebinding`);
      server.close();
      server = null;
      boundHost = null;
      unbound.add(port);
    }

    const s = net.createServer((client) => {
      const target = net.createConnection(port, '127.0.0.1');
      client.pipe(target);
      target.pipe(client);
      client.on('error', () => target.destroy());
      target.on('error', () => client.destroy());
    });

    // EADDRNOTAVAIL: gateway interface not up yet. EADDRINUSE: a stale listener
    // still holds the port. Both are transient — retry on the next tick rather
    // than killing the process (which used to take every other port down too).
    s.on('error', (err) => {
      const code = err.code ?? err.message;
      if (lastComplaint !== code) {
        log(`port ${port}: ${code}, will retry`);
        lastComplaint = code;
      }
      s.close();
      if (server === s) {
        server = null;
        boundHost = null;
        unbound.add(port);
      }
    });

    s.listen(port, host, () => {
      server = s;
      boundHost = host;
      lastComplaint = null;
      unbound.delete(port);
      log(`${host}:${port} → 127.0.0.1:${port}`);
    });
  };

  tick();
  return tick;
}

const ticks = PORTS.map((port) => supervise(port));

// One scheduler for all ports: fast while anything is unbound, slow otherwise.
(function schedule() {
  const delay = unbound.size > 0 ? FAST_MS : RETRY_MS;
  setTimeout(() => {
    for (const tick of ticks) tick();
    schedule();
  }, delay).unref?.();
})();
