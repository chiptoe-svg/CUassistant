// Minimal environment builder for spawned child processes.
//
// After loadDotEnv() runs (src/config.ts), process.env holds the host's
// secrets — MS365/Graph refresh tokens and the OpenAI API key. Spawning a
// child without an explicit `env` makes that child inherit all of them. The
// Codex classifier processes untrusted email bodies, and the optional `gws`
// binary is operator-supplied, so neither should ever see those secrets.
//
// We pass an explicit allow-list instead of process.env (fail-closed): only
// variables a child legitimately needs to find binaries, reach the network,
// render locale/timezone, and locate its own config are forwarded.

// Exact variable names that are safe to forward to a child process.
const ALLOWED_KEYS = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TERM",
  "LANG",
  "LANGUAGE",
  "TZ",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
]);

// Whole families of safe variables: locale (LC_*), Codex CLI config (CODEX_*,
// e.g. CODEX_HOME), XDG base dirs (XDG_*), and operator-set gws config (GWS_*).
const ALLOWED_PREFIXES = ["LC_", "CODEX_", "XDG_", "GWS_"];

// Host secrets that must never reach a child process. Exported so tests can
// assert they are absent from every built child environment.
export const FORBIDDEN_CHILD_ENV_KEYS = [
  "MS365_REFRESH_TOKEN",
  "GRAPH_CLI_REFRESH_TOKEN",
  "OPENAI_API_KEY",
];

// Build a sanitized environment for a spawned child. `extra` is merged last,
// so explicit overrides (e.g. GWS_CREDENTIAL_STORE) always take effect.
export function buildChildEnv(
  extra: Record<string, string> = {},
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (
      ALLOWED_KEYS.has(key) ||
      ALLOWED_PREFIXES.some((p) => key.startsWith(p))
    ) {
      env[key] = value;
    }
  }
  return { ...env, ...extra };
}
