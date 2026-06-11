# MCP Approved-AI Attestation + Capability-Scoped Tokens — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add provider-level approved-AI attestation (pair-time + runtime re-check, fail closed) and capability-scoped per-agent tokens to CUassistant's credentialed MCP server.

**Architecture:** Generalize `data_egress` in policy with an `agent_backends` provider list (mirrors the existing `classifiers` list). Each registry consumer gains `provider` + `scopes`. The HTTP authenticator returns a `Principal {id, scopes, provider}` instead of a bare id: it re-checks the consumer's provider against policy (reject if unattested/unauthorized) and expands scope tokens to an operation set. `buildServer` filters ListTools and gates CallTool by that set, and stamps the consumer id into the audit log via `AsyncLocalStorage`. The `mcp:pair` CLI requires `--provider`; a new `--attest` path adds attestation in place without rotating the token.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers in src), `node:test` + `node:assert/strict` (run via `npm test`), `tsx`, `yaml`, MCP SDK `@modelcontextprotocol/sdk@1.29.0`, `node:async_hooks`.

**Spec:** `docs/superpowers/specs/2026-06-11-approved-ai-attestation-and-capability-scoped-tokens-design.md`

**Conventions to follow:**

- Test files: `test/<name>.test.ts`, `import test from "node:test"; import assert from "node:assert/strict";`, import source with the **`.ts`** extension (e.g. `from "../src/policy.ts"`), matching `test/mcp-consumers.test.ts`.
- Source files: import siblings with the **`.js`** extension (ESM/tsx convention), matching existing `src/` files.
- Run a single test file: `node --import tsx --test test/<name>.test.ts`. Run all: `npm test`. Typecheck: `npm run typecheck`. Format: `npm run format`.
- The policy is loaded **once at module load** (`const ACTION_POLICY = loadPolicyFile()` in `src/policy.ts`); flag changes apply on server restart. This is intended and consistent with all other policy actions.

---

## File Structure

| File                                                   | Responsibility                          | Change                                                                                                                                                             |
| ------------------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `policy/action-policy.yaml`                            | Declared egress providers               | Add `data_egress.agent_backends`                                                                                                                                   |
| `src/policy.ts`                                        | Policy parse + accessors                | Add `AgentBackend`, parse, `agentBackendAuthorizedIn`, `isAgentBackendAuthorized`, `getAgentBackends`                                                              |
| `src/mcp-tools/permissions.ts`                         | Operation allow-list + scope vocabulary | Add `SCOPE_OPERATIONS`, `isValidScopeToken`, `allExposedOperations`, `expandScopes`                                                                                |
| `src/mcp-tools/consumers.ts`                           | Per-agent registry                      | Add `provider`/`egress_basis`/`scopes` fields, `authenticateConsumer`, `attestConsumer`                                                                            |
| `src/config.ts`                                        | Env config                              | Add `MCP_AUTH_TOKEN_PROVIDER`                                                                                                                                      |
| `src/mcp-tools/server.ts`                              | HTTP transport + auth + dispatch        | `Authenticator → Principal`; attestation re-check; scope-filtered ListTools; CallTool scope gate; ALS audit wrap; export `toolsForScope`/`isToolInScope` for tests |
| `src/mcp-tools/audit.ts`                               | Decision-log rows                       | `auditContext` ALS; `withConsumer`; stamp `mcp_consumer_id`                                                                                                        |
| `src/mcp-server.ts`                                    | Credentialed entrypoint                 | Pass `envTokenProvider: MCP_AUTH_TOKEN_PROVIDER`                                                                                                                   |
| `scripts/mcp-consumers.ts`                             | Pair/attest/list CLI                    | `--provider` (required on pair), `--scope`, new `--attest`, enriched `--list`/`--check`                                                                            |
| `skills/add-cuassistant/SKILL.md`, `src/mcp-server.md` | Operator docs                           | Document `--provider`/`--scope`/`--attest` + scope vocabulary                                                                                                      |

---

## Task 1: Policy — `agent_backends` provider list + accessors

**Files:**

- Modify: `src/policy.ts`
- Modify: `policy/action-policy.yaml`
- Test: `test/policy-agent-backends.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/policy-agent-backends.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  agentBackendAuthorizedIn,
  isAgentBackendAuthorized,
  type AgentBackend,
} from "../src/policy.ts";

const backends: AgentBackend[] = [
  { provider: "chatgpt_edu", scope: "external", basis: "x", authorized: true },
  { provider: "openai_api", scope: "external", basis: "x", authorized: true },
  { provider: "anthropic", scope: "external", basis: "x", authorized: false },
];

test("agentBackendAuthorizedIn: authorized providers are true", () => {
  assert.equal(agentBackendAuthorizedIn(backends, "chatgpt_edu"), true);
  assert.equal(agentBackendAuthorizedIn(backends, "openai_api"), true);
});

test("agentBackendAuthorizedIn: unauthorized provider is false", () => {
  assert.equal(agentBackendAuthorizedIn(backends, "anthropic"), false);
});

test("agentBackendAuthorizedIn: fail closed on unknown/empty provider", () => {
  assert.equal(agentBackendAuthorizedIn(backends, "mistral"), false);
  assert.equal(agentBackendAuthorizedIn(backends, ""), false);
});

test("real policy authorizes chatgpt_edu + openai_api, not anthropic", () => {
  assert.equal(isAgentBackendAuthorized("chatgpt_edu"), true);
  assert.equal(isAgentBackendAuthorized("openai_api"), true);
  assert.equal(isAgentBackendAuthorized("anthropic"), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test test/policy-agent-backends.test.ts`
Expected: FAIL — `agentBackendAuthorizedIn`/`isAgentBackendAuthorized`/`AgentBackend` are not exported from `src/policy.ts`.

- [ ] **Step 3: Add the `agent_backends` block to the policy file**

In `policy/action-policy.yaml`, inside the existing `data_egress:` map, add `agent_backends:` as a sibling of `classifiers:` (place it immediately after the last classifier entry, before `audit_requirements:`):

```yaml
# Model backends that a CONSUMING AGENT (a paired MCP client) may attest to.
# An agent's per-agent token is minted only if its --provider is listed here
# with authorized: true, and the server re-checks this on every request. This
# is the IT-reviewable record of which AI providers Clemson data may reach via
# an agent's own reasoning model (distinct from the classifier list above).
agent_backends:
  - provider: chatgpt_edu
    scope: external
    basis: "ChatGPT Edu institutional agreement (Clemson)"
    authorized: true
  - provider: openai_api
    scope: external
    basis: "OpenAI — covered under Clemson institutional contract"
    authorized: true
  - provider: anthropic
    scope: external
    basis: "no Clemson agreement covering Anthropic"
    authorized: false
  - provider: local
    scope: local
    basis: "on-host inference; content does not leave the machine"
    authorized: true
```

- [ ] **Step 4: Add the type, parser, and accessors to `src/policy.ts`**

Add the `AgentBackend` interface after `EgressClassifier` (after line 33):

```ts
/**
 * A model-backend provider that a consuming agent may attest to. Same shape and
 * `provider` vocabulary as EgressClassifier. `authorized` is the operator's
 * attestation (recorded, not proven) that Clemson's agreement covers it.
 */
export interface AgentBackend {
  provider: string;
  scope: "external" | "local";
  basis: string;
  authorized: boolean;
}
```

Change the `DataEgress` interface to include the new list:

```ts
export interface DataEgress {
  classifiers: EgressClassifier[];
  agent_backends: AgentBackend[];
}
```

Add the pure check after `egressAuthorizedIn` (after line 61):

```ts
/**
 * Whether `provider` is an authorized agent backend in the given list.
 * FAIL CLOSED: an unknown or unset provider is not authorized.
 */
export function agentBackendAuthorizedIn(
  backends: AgentBackend[],
  provider: string,
): boolean {
  return backends.find((b) => b.provider === provider)?.authorized === true;
}
```

Replace the body of `parseDataEgress` (lines 86-102) so it parses both lists and only returns `undefined` when neither is present:

```ts
function parseDataEgress(raw: unknown): DataEgress | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const classifiersRaw = (raw as { classifiers?: unknown[] }).classifiers;
  const classifiers = Array.isArray(classifiersRaw)
    ? classifiersRaw
        .filter(
          (c): c is Partial<EgressClassifier> =>
            Boolean(c) && typeof (c as EgressClassifier).provider === "string",
        )
        .map((c) => ({
          provider: String(c.provider),
          scope:
            c.scope === "local" ? ("local" as const) : ("external" as const),
          sends: Array.isArray(c.sends) ? c.sends.map(String) : [],
          basis: typeof c.basis === "string" ? c.basis : "",
          authorized: c.authorized === true,
        }))
    : [];
  const backendsRaw = (raw as { agent_backends?: unknown[] }).agent_backends;
  const agent_backends = Array.isArray(backendsRaw)
    ? backendsRaw
        .filter(
          (b): b is Partial<AgentBackend> =>
            Boolean(b) && typeof (b as AgentBackend).provider === "string",
        )
        .map((b) => ({
          provider: String(b.provider),
          scope:
            b.scope === "local" ? ("local" as const) : ("external" as const),
          basis: typeof b.basis === "string" ? b.basis : "",
          authorized: b.authorized === true,
        }))
    : [];
  if (classifiers.length === 0 && agent_backends.length === 0) return undefined;
  return { classifiers, agent_backends };
}
```

Add the policy-backed accessors after `getEgressClassifiers` (after line 128):

```ts
/** Whether `provider` is an authorized agent backend per policy. Fail closed. */
export function isAgentBackendAuthorized(provider: string): boolean {
  return agentBackendAuthorizedIn(
    ACTION_POLICY.data_egress?.agent_backends ?? [],
    provider,
  );
}

/** The full declared agent-backend list (for tooling/inspection). */
export function getAgentBackends(): AgentBackend[] {
  return ACTION_POLICY.data_egress?.agent_backends ?? [];
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --import tsx --test test/policy-agent-backends.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Verify existing policy tests still pass**

Run: `node --import tsx --test test/policy-egress.test.ts`
Expected: PASS (the `classifiers` parsing is unchanged in behavior).

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/policy.ts policy/action-policy.yaml test/policy-agent-backends.test.ts
git commit -m "feat(policy): add data_egress.agent_backends provider attestation list"
```

---

## Task 2: Scope vocabulary — `SCOPE_OPERATIONS` map + expander

**Files:**

- Modify: `src/mcp-tools/permissions.ts`
- Test: `test/mcp-scopes.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/mcp-scopes.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  SCOPE_OPERATIONS,
  allExposedOperations,
  expandScopes,
  isValidScopeToken,
} from "../src/mcp-tools/permissions.ts";

test("isValidScopeToken accepts known tokens and rejects unknown", () => {
  assert.equal(isValidScopeToken("mail:read"), true);
  assert.equal(isValidScopeToken("mail:send"), true);
  assert.equal(isValidScopeToken("clemson"), true);
  assert.equal(isValidScopeToken("bogus"), false);
});

test("expandScopes(undefined) returns the full exposed set", () => {
  assert.deepEqual(expandScopes(undefined), allExposedOperations());
  assert.deepEqual(expandScopes([]), allExposedOperations());
});

test("expandScopes narrows to the named surfaces only", () => {
  const s = expandScopes(["mail:read", "clemson"]);
  assert.equal(s.has("mail.list_messages"), true);
  assert.equal(s.has("clemson.search_classes"), true);
  assert.equal(s.has("mail.move_message"), false);
  assert.equal(s.has("sheets.read"), false);
});

test("mail:send is a separate scope from mail:write", () => {
  const w = expandScopes(["mail:write"]);
  assert.equal(w.has("mail.move_message"), true);
  assert.equal(w.has("mail.send_with_approval"), false);
  const s = expandScopes(["mail:send"]);
  assert.equal(s.has("mail.send_with_approval"), true);
  assert.equal(s.has("mail.move_message"), false);
});

test("every operation named in SCOPE_OPERATIONS is a real, exposed operation", () => {
  const exposed = allExposedOperations();
  for (const [token, ops] of Object.entries(SCOPE_OPERATIONS)) {
    for (const op of ops) {
      assert.ok(exposed.has(op), `${token} -> ${op} should be exposed`);
    }
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test test/mcp-scopes.test.ts`
Expected: FAIL — `SCOPE_OPERATIONS`/`expandScopes`/`allExposedOperations`/`isValidScopeToken` not exported.

- [ ] **Step 3: Add the scope vocabulary and helpers to `src/mcp-tools/permissions.ts`**

At the end of `src/mcp-tools/permissions.ts` (after `describeMcpOperations`), add:

```ts
/**
 * Capability scope vocabulary: surface + read/write split. Each token maps to
 * the MCP_ALLOWED_OPERATIONS keys it grants. `mail:send` is deliberately its
 * own scope (the highest-risk op). Only EXPOSED operations are reachable; this
 * map never widens beyond the exposed set (enforced by expandScopes).
 */
export const SCOPE_OPERATIONS: Record<string, string[]> = {
  "mail:read": ["mail.list_messages", "mail.get_message", "mail.list_folders"],
  "mail:write": [
    "mail.move_message",
    "mail.update_message",
    "mail.create_draft",
  ],
  "mail:send": ["mail.send_with_approval"],
  "calendar:read": [
    "calendar.list_events",
    "calendar.get_event",
    "calendar.get_view",
  ],
  "calendar:write": ["calendar.create_event", "calendar.update_event"],
  "tasks:read": ["todo.list_lists", "todo.list_tasks", "todo.get_task"],
  "tasks:write": ["todo.create_task", "todo.update_task"],
  "sheets:read": ["sheets.read", "sheets.info"],
  "sheets:write": ["sheets.create", "sheets.update", "sheets.append"],
  "docs:read": ["docs.read"],
  "docs:write": ["docs.create", "docs.append"],
  clemson: [
    "clemson.list_terms",
    "clemson.search_classes",
    "clemson.section_details",
    "clemson.instructor_classes",
    "clemson.room_availability",
  ],
  "host:read": ["host.get_scan_status", "host.get_pending_actions"],
};

/** Whether `token` is a recognized scope token. */
export function isValidScopeToken(token: string): boolean {
  return Object.prototype.hasOwnProperty.call(SCOPE_OPERATIONS, token);
}

/** The set of all currently-exposed operation keys (the implicit full scope). */
export function allExposedOperations(): Set<string> {
  return new Set(
    Object.keys(MCP_ALLOWED_OPERATIONS).filter(isMcpOperationExposed),
  );
}

/**
 * Expand scope tokens to the operation keys they grant, intersected with the
 * exposed set. Undefined/empty tokens => full exposed set (default-allow).
 * Unknown tokens contribute nothing (the CLI rejects them at pair time).
 */
export function expandScopes(tokens: string[] | undefined): Set<string> {
  if (!tokens || tokens.length === 0) return allExposedOperations();
  const exposed = allExposedOperations();
  const out = new Set<string>();
  for (const token of tokens) {
    for (const op of SCOPE_OPERATIONS[token] ?? []) {
      if (exposed.has(op)) out.add(op);
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test test/mcp-scopes.test.ts`
Expected: PASS (5 tests). The last test confirms every scope→operation is exposed (catches a typo or a scope pointing at a gated op).

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/mcp-tools/permissions.ts test/mcp-scopes.test.ts
git commit -m "feat(mcp): add capability scope vocabulary + expander"
```

---

## Task 3: Consumer registry — fields, `authenticateConsumer`, `attestConsumer`

**Files:**

- Modify: `src/mcp-tools/consumers.ts`
- Test: `test/mcp-consumers.test.ts` (append to existing)

- [ ] **Step 1: Write the failing tests**

Append to `test/mcp-consumers.test.ts` (add the new imports to the existing import block: `authenticateConsumer`, `attestConsumer`):

```ts
test("authenticateConsumer returns the full matched consumer", () => {
  const token = "cma_secret-value";
  const consumers: Consumer[] = [
    {
      id: "a",
      token_hash: hashToken(token),
      created_at: "t",
      provider: "chatgpt_edu",
      scopes: ["mail:read"],
    },
  ];
  const got = authenticateConsumer(`Bearer ${token}`, consumers);
  assert.equal(got?.id, "a");
  assert.equal(got?.provider, "chatgpt_edu");
  assert.deepEqual(got?.scopes, ["mail:read"]);
  assert.equal(authenticateConsumer("Bearer wrong", consumers), null);
});

test("parseConsumers preserves provider and scopes", () => {
  const raw = JSON.stringify({
    consumers: [
      {
        id: "a",
        token_hash: "h",
        created_at: "t",
        provider: "openai_api",
        scopes: ["clemson"],
      },
    ],
  });
  const list = parseConsumers(raw);
  assert.equal(list[0].provider, "openai_api");
  assert.deepEqual(list[0].scopes, ["clemson"]);
});

test("attestConsumer sets provider/scopes without touching the token", () => {
  const list: Consumer[] = [
    { id: "a", token_hash: "HASH", created_at: "t", last_seen_at: "s" },
  ];
  attestConsumer(list, "a", "chatgpt_edu", ["mail:read"]);
  assert.equal(list[0].token_hash, "HASH");
  assert.equal(list[0].last_seen_at, "s");
  assert.equal(list[0].provider, "chatgpt_edu");
  assert.deepEqual(list[0].scopes, ["mail:read"]);
});

test("attestConsumer leaves scopes untouched when omitted, and throws on unknown id", () => {
  const list: Consumer[] = [
    { id: "a", token_hash: "h", created_at: "t", scopes: ["mail:read"] },
  ];
  attestConsumer(list, "a", "openai_api");
  assert.deepEqual(list[0].scopes, ["mail:read"]); // unchanged
  assert.equal(list[0].provider, "openai_api");
  assert.throws(() => attestConsumer([], "nope", "chatgpt_edu"));
});
```

Update the import at the top of the file to include the new names:

```ts
import {
  authenticateBearer,
  authenticateConsumer,
  attestConsumer,
  generateToken,
  hashToken,
  parseConsumers,
  staleConsumers,
  type Consumer,
} from "../src/mcp-tools/consumers.ts";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test test/mcp-consumers.test.ts`
Expected: FAIL — `authenticateConsumer`/`attestConsumer` not exported.

- [ ] **Step 3: Add the fields and functions to `src/mcp-tools/consumers.ts`**

Add three optional fields to the `Consumer` interface (after `note?` on line 32):

```ts
  /** Attested model-backend provider (e.g. "chatgpt_edu"). Absent = unattested. */
  provider?: string;
  /** Optional convenience copy of the policy basis text (for `--list`). */
  egress_basis?: string;
  /** Capability scope tokens (see SCOPE_OPERATIONS); absent/empty = full access. */
  scopes?: string[];
```

Add `authenticateConsumer` and refactor `authenticateBearer` to delegate to it (replace the existing `authenticateBearer`, lines 97-111):

```ts
/**
 * Constant-time match of a presented `Authorization` header against the
 * registry. Returns the matched Consumer, or null. Compares fixed-length hex
 * digests so the comparison leaks neither the token nor its length.
 */
export function authenticateConsumer(
  authHeader: string | undefined,
  consumers: Consumer[],
): Consumer | null {
  const prefix = "Bearer ";
  if (!authHeader || !authHeader.startsWith(prefix)) return null;
  const got = Buffer.from(hashToken(authHeader.slice(prefix.length)));
  for (const c of consumers) {
    const exp = Buffer.from(c.token_hash);
    if (got.length === exp.length && crypto.timingSafeEqual(got, exp)) {
      return c;
    }
  }
  return null;
}

/** Backward-compatible: returns just the matched consumer id, or null. */
export function authenticateBearer(
  authHeader: string | undefined,
  consumers: Consumer[],
): string | null {
  return authenticateConsumer(authHeader, consumers)?.id ?? null;
}
```

Add `attestConsumer` after `recordSeen` (after line 124):

```ts
/**
 * Set a consumer's attested provider (and optionally scopes) IN PLACE, without
 * touching its token_hash or last_seen_at. Mutates and returns the list.
 * Throws if the id is not present. This backs `mcp:consumers --attest`.
 */
export function attestConsumer(
  consumers: Consumer[],
  id: string,
  provider: string,
  scopes?: string[],
): Consumer[] {
  const c = consumers.find((x) => x.id === id);
  if (!c) throw new Error(`No consumer "${id}" found.`);
  c.provider = provider;
  if (scopes !== undefined) c.scopes = scopes;
  return consumers;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test test/mcp-consumers.test.ts`
Expected: PASS (all existing tests + 4 new). The existing `authenticateBearer` tests still pass because it now delegates.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/mcp-tools/consumers.ts test/mcp-consumers.test.ts
git commit -m "feat(mcp): consumer provider/scopes fields + authenticateConsumer/attestConsumer"
```

---

## Task 4: Config + server auth — `Principal` with attestation re-check

**Files:**

- Modify: `src/config.ts`
- Modify: `src/mcp-tools/server.ts`
- Modify: `src/mcp-server.ts`
- Test: `test/mcp-auth-principal.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/mcp-auth-principal.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { hashToken, type Consumer } from "../src/mcp-tools/consumers.ts";
import { resolveCredentialedAuth } from "../src/mcp-tools/server.ts";

const TOKEN = "cma_principal-test";
const loadWith = (c: Partial<Consumer>) => (): Consumer[] => [
  { id: "a", token_hash: hashToken(TOKEN), created_at: "t", ...c },
];

test("Principal returned for an attested, authorized, scoped consumer", () => {
  const auth = resolveCredentialedAuth({
    load: loadWith({ provider: "chatgpt_edu", scopes: ["mail:read"] }),
  });
  const p = auth(`Bearer ${TOKEN}`);
  assert.equal(p?.id, "a");
  assert.equal(p?.provider, "chatgpt_edu");
  assert.equal(p?.scopes.has("mail.list_messages"), true);
  assert.equal(p?.scopes.has("mail.move_message"), false);
});

test("unscoped attested consumer gets the full exposed scope", () => {
  const auth = resolveCredentialedAuth({
    load: loadWith({ provider: "openai_api" }),
  });
  const p = auth(`Bearer ${TOKEN}`);
  assert.equal(p?.scopes.has("mail.move_message"), true);
  assert.equal(p?.scopes.has("sheets.read"), true);
});

test("unattested consumer (no provider) is rejected", () => {
  const auth = resolveCredentialedAuth({ load: loadWith({}) });
  assert.equal(auth(`Bearer ${TOKEN}`), null);
});

test("consumer with an unauthorized provider is rejected", () => {
  const auth = resolveCredentialedAuth({
    load: loadWith({ provider: "anthropic" }),
  });
  assert.equal(auth(`Bearer ${TOKEN}`), null);
});

test("wrong token is rejected", () => {
  const auth = resolveCredentialedAuth({
    load: loadWith({ provider: "chatgpt_edu" }),
  });
  assert.equal(auth("Bearer nope"), null);
});

test("env-token uses its configured provider", () => {
  const auth = resolveCredentialedAuth({
    load: (): Consumer[] => [],
    envToken: "cma_env",
    envTokenProvider: "chatgpt_edu",
  });
  assert.equal(auth(`Bearer cma_env`)?.id, "env-token");
  const authBad = resolveCredentialedAuth({
    load: (): Consumer[] => [],
    envToken: "cma_env2",
    envTokenProvider: "anthropic",
  });
  assert.equal(authBad(`Bearer cma_env2`), null);
});
```

> These tests use the **real** policy file, so Task 1 must be complete (`chatgpt_edu`/`openai_api` authorized, `anthropic` not).

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test test/mcp-auth-principal.test.ts`
Expected: FAIL — `resolveCredentialedAuth` currently returns an `Authenticator` that yields a string id, so `.scopes`/`.provider` are undefined and the rejection cases return `"a"` instead of `null`.

- [ ] **Step 3: Add `MCP_AUTH_TOKEN_PROVIDER` to `src/config.ts`**

Find the line exporting `MCP_AUTH_TOKEN` in `src/config.ts` and add directly beneath it:

```ts
export const MCP_AUTH_TOKEN_PROVIDER =
  process.env.MCP_AUTH_TOKEN_PROVIDER ?? "";
```

- [ ] **Step 4: Change the `Authenticator` to return a `Principal` in `src/mcp-tools/server.ts`**

Update the imports at the top of `src/mcp-tools/server.ts`:

```ts
import {
  authenticateConsumer,
  hashToken,
  loadConsumers,
  type Consumer,
} from "./consumers.js";
import type { McpToolDefinition } from "./types.js";
import {
  allExposedOperations,
  expandScopes,
  isMcpOperationExposed,
} from "./permissions.js";
import { isAgentBackendAuthorized } from "../policy.js";
```

Replace the `Authenticator` type and `openAuthenticator` (lines 71-75) with:

```ts
/** The authenticated caller: id (audit identity), allowed operation set, provider. */
export interface Principal {
  id: string;
  scopes: Set<string>;
  provider?: string;
}

/** Authenticates an HTTP request; returns the Principal, or null to reject. */
export type Authenticator = (
  authHeader: string | undefined,
) => Principal | null;

/** Open mode: no credentials (public server, loopback-only). Full public scope. */
export const openAuthenticator: Authenticator = () => ({
  id: "public",
  scopes: allExposedOperations(),
});
```

Add `envTokenProvider` to `ResolveAuthOptions` (inside the interface, after `envToken?`):

```ts
  /** Provider attested for the env-token consumer (MCP_AUTH_TOKEN_PROVIDER). */
  envTokenProvider?: string;
```

Replace the body of `resolveCredentialedAuth` (lines 103-131) with:

```ts
export function resolveCredentialedAuth(
  opts: ResolveAuthOptions = {},
): Authenticator {
  const load = opts.load ?? loadConsumers;
  const envToken = (opts.envToken ?? "").trim();
  const envTokenProvider = (opts.envTokenProvider ?? "").trim();
  const gather = (): Consumer[] => {
    const live = load();
    if (envToken) {
      live.push({
        id: "env-token",
        token_hash: hashToken(envToken),
        created_at: "",
        provider: envTokenProvider || undefined,
      });
    }
    return live;
  };
  if (gather().length === 0) {
    throw new Error(
      "credentialed MCP HTTP server has no authorized consumers — provision " +
        "one with `npm run mcp:pair -- --id <agent> --provider <p>` (or set " +
        "MCP_AUTH_TOKEN + MCP_AUTH_TOKEN_PROVIDER). Refusing to start open.",
    );
  }
  return (authHeader) => {
    const consumer = authenticateConsumer(authHeader, gather());
    if (!consumer) return null;
    // Runtime attestation re-check (fail closed): the consumer must declare a
    // provider that policy currently authorizes. Flipping authorized:false in
    // policy cuts the agent off on the next request after a server restart.
    if (!consumer.provider || !isAgentBackendAuthorized(consumer.provider)) {
      log(
        `auth: rejecting "${consumer.id}" — provider ` +
          `"${consumer.provider ?? "(none)"}" not authorized (model_unauthorized)`,
      );
      return null;
    }
    opts.onSeen?.(consumer.id);
    return {
      id: consumer.id,
      scopes: expandScopes(consumer.scopes),
      provider: consumer.provider,
    };
  };
}
```

Update `createHttpHandler` (lines 155-168) so the variable is a `Principal` and it is passed into `buildServer`. Change the opening lines of the returned listener:

```ts
  return (req, res) => {
    const principal = authenticate(req.headers.authorization);
    if (!principal) {
      log(
        `${name}: 401 unauthorized ${req.method ?? "?"} from ${req.socket.remoteAddress ?? "?"}`,
      );
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
```

And in the same function, change the per-request server construction (line 198) from `const server = buildServer(name);` to:

```ts
const server = buildServer(name, principal);
```

> `buildServer`'s signature change (adding the optional `principal`) and the ListTools/CallTool body changes land in **Task 5**. For this task, make `buildServer` accept and ignore the extra arg so the file compiles: change its signature to `function buildServer(name: string, _principal?: Principal): Server {`. Task 5 replaces the body.

- [ ] **Step 5: Pass the env-token provider from the entrypoint**

In `src/config.ts` import block of `src/mcp-server.ts` (lines 59-70), add `MCP_AUTH_TOKEN_PROVIDER` to the destructured imports. Then in the `startMcpServer({...})` call (lines 125-130), change the `auth` line to:

```ts
  auth: {
    kind: "registry",
    envToken: MCP_AUTH_TOKEN,
    envTokenProvider: MCP_AUTH_TOKEN_PROVIDER,
    onSeen: touchConsumer,
  },
```

Add `envTokenProvider?: string;` to the `registry` variant of the `AuthConfig` union in `src/mcp-tools/server.ts` (line 213-215):

```ts
export type AuthConfig =
  | { kind: "open" }
  | {
      kind: "registry";
      envToken?: string;
      envTokenProvider?: string;
      onSeen?: (id: string) => void;
    };
```

And forward it in `startMcpServer`'s registry branch (line 236-239):

```ts
authenticate = resolveCredentialedAuth({
  envToken: opts.auth.envToken,
  envTokenProvider: opts.auth.envTokenProvider,
  onSeen: opts.auth.onSeen,
});
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --import tsx --test test/mcp-auth-principal.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/config.ts src/mcp-tools/server.ts src/mcp-server.ts test/mcp-auth-principal.test.ts
git commit -m "feat(mcp): authenticator returns Principal + runtime provider attestation re-check"
```

---

## Task 5: Server — scope-filtered ListTools, CallTool gate, ALS audit id

**Files:**

- Modify: `src/mcp-tools/audit.ts`
- Modify: `src/mcp-tools/server.ts`
- Test: `test/mcp-audit-context.test.ts`
- Test: `test/mcp-scope-enforcement.test.ts`

- [ ] **Step 1: Write the failing audit-context test**

Create `test/mcp-audit-context.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { auditContext, withConsumer } from "../src/mcp-tools/audit.ts";

test("withConsumer stamps the ALS consumer id inside a run scope", () => {
  auditContext.run({ consumerId: "agentX" }, () => {
    const row = withConsumer({ a: 1 });
    assert.equal(row.mcp_consumer_id, "agentX");
    assert.equal(row.a, 1);
  });
});

test("withConsumer yields null consumer id outside any run scope", () => {
  assert.equal(withConsumer({}).mcp_consumer_id, null);
});

test("auditContext isolates concurrent run scopes", async () => {
  const seen: Array<string | null> = [];
  await Promise.all([
    auditContext.run({ consumerId: "one" }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      seen.push((withConsumer({}).mcp_consumer_id as string) ?? null);
    }),
    auditContext.run({ consumerId: "two" }, async () => {
      seen.push((withConsumer({}).mcp_consumer_id as string) ?? null);
    }),
  ]);
  assert.deepEqual(seen.sort(), ["one", "two"]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --import tsx --test test/mcp-audit-context.test.ts`
Expected: FAIL — `auditContext`/`withConsumer` not exported.

- [ ] **Step 3: Add the ALS + stamping to `src/mcp-tools/audit.ts`**

Add at the top of `src/mcp-tools/audit.ts` (after the existing `import { appendDecision } ...` line):

```ts
import { AsyncLocalStorage } from "node:async_hooks";

/** Request-scoped store for the authenticated consumer id (set in buildServer). */
export const auditContext = new AsyncLocalStorage<{ consumerId: string }>();

/** Attach the current ALS consumer id (or null) to an audit row. */
export function withConsumer(
  row: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...row,
    mcp_consumer_id: auditContext.getStore()?.consumerId ?? null,
  };
}
```

Wrap both `appendDecision` payloads with `withConsumer(...)`. In `startMcpAudit`, change the `appendDecision({...})` call to `appendDecision(withConsumer({...}))`; do the same in `finishMcpAudit`. Concretely the `startMcpAudit` body becomes:

```ts
appendDecision(
  withConsumer({
    pass: "mcp-tool-intent",
    decision: "mcp-tool-intent",
    mcp_tool: ctx.toolName,
    mcp_operation: ctx.operation,
    mcp_correlation_id: ctx.correlationId,
    mcp_args_summary: ctx.argsSummary,
  }),
);
```

and `finishMcpAudit`:

```ts
appendDecision(
  withConsumer({
    pass: "mcp-tool",
    decision: outcome.result,
    mcp_tool: ctx.toolName,
    mcp_operation: ctx.operation,
    mcp_correlation_id: ctx.correlationId,
    mcp_args_summary: ctx.argsSummary,
    mcp_object_id: outcome.object_id ?? null,
    mcp_detail: outcome.detail ?? null,
  }),
);
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --import tsx --test test/mcp-audit-context.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing scope-enforcement test**

Create `test/mcp-scope-enforcement.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  isToolInScope,
  registerTools,
  toolsForScope,
} from "../src/mcp-tools/server.ts";

// Register two fake tools whose operations are real, exposed operations so
// shouldRegisterMcpTool accepts them.
registerTools([
  {
    operation: "clemson.list_terms",
    tool: {
      name: "x-terms",
      description: "fake",
      inputSchema: { type: "object" },
    },
    handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
  },
  {
    operation: "mail.list_messages",
    tool: {
      name: "x-mail",
      description: "fake",
      inputSchema: { type: "object" },
    },
    handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
  },
]);

test("toolsForScope returns only tools whose operation is in scope", () => {
  const names = toolsForScope(new Set(["clemson.list_terms"])).map(
    (t) => t.name,
  );
  assert.ok(names.includes("x-terms"));
  assert.ok(!names.includes("x-mail"));
});

test("isToolInScope reflects the operation membership", () => {
  assert.equal(isToolInScope("x-mail", new Set(["mail.list_messages"])), true);
  assert.equal(isToolInScope("x-mail", new Set(["clemson.list_terms"])), false);
  assert.equal(isToolInScope("nonexistent", new Set(["anything"])), false);
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `node --import tsx --test test/mcp-scope-enforcement.test.ts`
Expected: FAIL — `toolsForScope`/`isToolInScope` not exported.

- [ ] **Step 7: Implement scope filtering + the audit wrap in `buildServer`**

In `src/mcp-tools/server.ts`, add the `auditContext` import:

```ts
import { auditContext } from "./audit.js";
```

Add two exported helpers (place them just above `buildServer`):

```ts
/** The Tool descriptors whose operation is within `scopes` (for ListTools). */
export function toolsForScope(scopes: Set<string>) {
  return allTools.filter((t) => scopes.has(t.operation)).map((t) => t.tool);
}

/** Whether a registered tool's operation is within `scopes` (for CallTool). */
export function isToolInScope(toolName: string, scopes: Set<string>): boolean {
  const t = toolMap.get(toolName);
  return !!t && scopes.has(t.operation);
}
```

Replace the whole `buildServer` function (currently lines 133-153, signature already widened to `(_principal?)` in Task 4) with:

```ts
function buildServer(name: string, principal?: Principal): Server {
  const scopes = principal?.scopes ?? allExposedOperations();
  const consumerId = principal?.id ?? "stdio";
  const server = new Server(
    { name, version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolsForScope(scopes),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name: toolName, arguments: args } = request.params;
    const tool = toolMap.get(toolName);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
        isError: true,
      };
    }
    if (!scopes.has(tool.operation)) {
      return {
        content: [
          {
            type: "text",
            text: `Error: tool "${toolName}" is not in this agent's scope`,
          },
        ],
        isError: true,
      };
    }
    return auditContext.run({ consumerId }, () => tool.handler(args ?? {}));
  });
  return server;
}
```

- [ ] **Step 8: Run both server tests to verify they pass**

Run: `node --import tsx --test test/mcp-scope-enforcement.test.ts`
Expected: PASS (2 tests).
Run: `node --import tsx --test test/mcp-auth-principal.test.ts`
Expected: PASS (still green — Task 4 unaffected).

- [ ] **Step 9: Typecheck and commit**

```bash
npm run typecheck
git add src/mcp-tools/audit.ts src/mcp-tools/server.ts test/mcp-audit-context.test.ts test/mcp-scope-enforcement.test.ts
git commit -m "feat(mcp): scope-filtered tool list + CallTool gate + consumer-id audit stamping"
```

---

## Task 6: CLI — `--provider`/`--scope` on pair, new `--attest`, enriched `--list`/`--check`

**Files:**

- Modify: `scripts/mcp-consumers.ts`
- Test: covered by `test/mcp-consumers.test.ts` (the pure `attestConsumer` from Task 3) + a new `test/mcp-cli-helpers.test.ts` for scope/provider validation helpers.

> The CLI runs commands at import (it dispatches on `process.argv`), so it isn't directly unit-testable. We extract the two validation helpers into pure exported functions and test those; the command functions are thin wrappers over already-tested logic (`attestConsumer`, `expandScopes`, `isAgentBackendAuthorized`).

- [ ] **Step 1: Write the failing helper test**

Create `test/mcp-cli-helpers.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  invalidScopeTokens,
  providerIsApproved,
} from "../scripts/mcp-consumers-helpers.ts";

test("invalidScopeTokens returns the unrecognized tokens only", () => {
  assert.deepEqual(invalidScopeTokens(["mail:read", "clemson"]), []);
  assert.deepEqual(invalidScopeTokens(["mail:read", "bogus", "nope"]), [
    "bogus",
    "nope",
  ]);
});

test("providerIsApproved reflects the real policy", () => {
  assert.equal(providerIsApproved("chatgpt_edu"), true);
  assert.equal(providerIsApproved("openai_api"), true);
  assert.equal(providerIsApproved("anthropic"), false);
  assert.equal(providerIsApproved(""), false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --import tsx --test test/mcp-cli-helpers.test.ts`
Expected: FAIL — `scripts/mcp-consumers-helpers.ts` does not exist.

- [ ] **Step 3: Create the pure helper module**

Create `scripts/mcp-consumers-helpers.ts`:

```ts
// Pure, testable helpers for the mcp-consumers CLI (no process.argv / exit).

import {
  isValidScopeToken,
  SCOPE_OPERATIONS,
} from "../src/mcp-tools/permissions.js";
import { getAgentBackends, isAgentBackendAuthorized } from "../src/policy.js";

/** The subset of `tokens` that are not recognized scope tokens. */
export function invalidScopeTokens(tokens: string[]): string[] {
  return tokens.filter((t) => !isValidScopeToken(t));
}

/** Whether `provider` is an authorized agent backend per policy. */
export function providerIsApproved(provider: string): boolean {
  return isAgentBackendAuthorized(provider);
}

/** The list of approved provider names (for usage/help text). */
export function approvedProviders(): string[] {
  return getAgentBackends()
    .filter((b) => b.authorized)
    .map((b) => b.provider);
}

/** All valid scope tokens (for usage/help text). */
export function validScopeTokens(): string[] {
  return Object.keys(SCOPE_OPERATIONS);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --import tsx --test test/mcp-cli-helpers.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire the helpers + `--attest` into `scripts/mcp-consumers.ts`**

Update the import block at the top of `scripts/mcp-consumers.ts`:

```ts
import {
  attestConsumer,
  generateToken,
  hashToken,
  loadConsumers,
  saveConsumers,
  staleConsumers,
  type Consumer,
} from "../src/mcp-tools/consumers.js";
import {
  approvedProviders,
  invalidScopeTokens,
  providerIsApproved,
  validScopeTokens,
} from "./mcp-consumers-helpers.js";
```

Add two small parse helpers after the existing `nowIso()` function:

```ts
/** Read + validate --provider against the policy approved list, or exit(1). */
function requireApprovedProvider(): string {
  const provider = arg("--provider");
  if (!provider) {
    console.error("error: --provider <p> is required.");
    console.error(`approved providers: ${approvedProviders().join(", ")}`);
    process.exit(1);
  }
  if (!providerIsApproved(provider)) {
    console.error(
      `error: provider "${provider}" is not authorized in ` +
        `policy/action-policy.yaml (data_egress.agent_backends).`,
    );
    console.error(`approved providers: ${approvedProviders().join(", ")}`);
    process.exit(1);
  }
  return provider;
}

/** Read + validate --scope (optional); undefined when absent; exit(1) on a bad token. */
function parseScopeArg(): string[] | undefined {
  const raw = arg("--scope");
  if (raw === undefined) return undefined;
  const tokens = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = invalidScopeTokens(tokens);
  if (bad.length) {
    console.error(`error: unknown scope token(s): ${bad.join(", ")}`);
    console.error(`valid tokens: ${validScopeTokens().join(", ")}`);
    process.exit(1);
  }
  return tokens;
}
```

Replace `pair()` (lines 52-79) with the provider/scope-aware version:

```ts
function pair(): void {
  const id = arg("--id");
  if (!id) {
    console.error(
      'usage: mcp:pair -- --id <agent> --provider <p> [--scope a,b] [--note "..."]',
    );
    process.exit(1);
  }
  const provider = requireApprovedProvider();
  const scopes = parseScopeArg();
  const note = arg("--note");
  const token = generateToken();
  const list = loadConsumers();
  const existing = list.find((c) => c.id === id);
  if (existing) {
    existing.token_hash = hashToken(token);
    existing.last_seen_at = undefined;
    existing.provider = provider;
    if (scopes !== undefined) existing.scopes = scopes;
    if (note !== undefined) existing.note = note;
    console.log(
      `Rotated token for "${id}" (provider=${provider}, scope=${scopes?.join(",") ?? "full"}).`,
    );
  } else {
    const c: Consumer = {
      id,
      token_hash: hashToken(token),
      created_at: nowIso(),
      provider,
    };
    if (scopes !== undefined) c.scopes = scopes;
    if (note !== undefined) c.note = note;
    list.push(c);
    console.log(
      `Registered "${id}" (provider=${provider}, scope=${scopes?.join(",") ?? "full"}).`,
    );
  }
  saveConsumers(list);
  printRegistrationHelp(id, token);
}
```

Add an `attest()` command after `revoke()`:

```ts
function attest(): void {
  const id = arg("--attest");
  if (!id) {
    console.error(
      "usage: mcp:consumers -- --attest <agent> --provider <p> [--scope a,b]",
    );
    process.exit(1);
  }
  const provider = requireApprovedProvider();
  const scopes = parseScopeArg();
  const list = loadConsumers();
  try {
    attestConsumer(list, id, provider, scopes);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  saveConsumers(list);
  const c = list.find((x) => x.id === id);
  console.log(
    `Attested "${id}": provider=${provider}, scope=${c?.scopes?.join(",") ?? "full"} ` +
      `(token unchanged). Restart the server to apply.`,
  );
}
```

Replace the `list()` body's per-consumer log (lines 90-95) to show provider + scope + unattested flag:

```ts
for (const c of consumers) {
  const att = c.provider
    ? `provider=${c.provider}`
    : "UNATTESTED(run --attest)";
  const scope = c.scopes?.length ? c.scopes.join(",") : "full";
  console.log(
    `- ${c.id}  ${att}  scope=${scope}  created=${c.created_at}  ` +
      `last_seen=${c.last_seen_at ?? "never"}  hash=${c.token_hash.slice(0, 8)}…` +
      `${c.note ? `  note=${c.note}` : ""}`,
  );
}
```

In `check()`, after the staleness output (before the closing brace of the function, after line 137), add an unattested call-out:

```ts
const unattested = loadConsumers()
  .filter((c) => !c.provider)
  .map((c) => c.id);
if (unattested.length) {
  console.log(
    `Unattested (rejected at runtime — run ` +
      `\`mcp:consumers -- --attest <id> --provider <p>\`): ${unattested.join(", ")}`,
  );
}
```

Finally update the command dispatch at the bottom of the file to add `--attest`:

```ts
if (has("--list")) list();
else if (has("--revoke")) revoke();
else if (has("--attest")) attest();
else if (has("--check")) check();
else pair();
```

- [ ] **Step 6: Manually exercise the CLI (no destructive effect)**

Run: `npm run mcp:pair -- --id _smoketest --provider bogus`
Expected: exits non-zero, prints `provider "bogus" is not authorized` and the approved-provider list.

Run: `npm run mcp:pair -- --id _smoketest --provider chatgpt_edu --scope bogus:scope`
Expected: exits non-zero, prints `unknown scope token(s): bogus:scope` and the valid-token list. (No registry write occurs because validation exits before `saveConsumers`.)

- [ ] **Step 7: Typecheck, run the full suite, commit**

```bash
npm run typecheck
npm test
git add scripts/mcp-consumers.ts scripts/mcp-consumers-helpers.ts test/mcp-cli-helpers.test.ts
git commit -m "feat(mcp): pair requires --provider, add --attest, scope flags + enriched list/check"
```

---

## Task 7: Documentation — operator-facing surfaces

**Files:**

- Modify: `skills/add-cuassistant/SKILL.md`
- Modify: `src/mcp-server.md`

- [ ] **Step 1: Update the pairing instructions in `skills/add-cuassistant/SKILL.md`**

In the "Auth (per-agent token, required)" prerequisite (around line 54-62), replace the `npm run mcp:pair -- --id <agent-id>` reference with the provider-required form and a scope note:

```markdown
4. **Auth (per-agent token + provider attestation, required).** The credentialed
   server fails closed — it won't start with no authorized consumers, and it
   rejects any consumer whose attested model **provider** isn't authorized in
   `policy/action-policy.yaml` (`data_egress.agent_backends`). Mint a token for
   THIS agent on the host, declaring its model-backend provider:
   `npm run mcp:pair -- --id <agent-id> --provider <chatgpt_edu|openai_api|local>`
   (prints the token once). Optionally narrow the token with
   `--scope mail:read,calendar:read,clemson` (omit for full access). Inject that
   token into only this agent's container env as `CUASSISTANT_MCP_TOKEN`. Each
   agent gets its own token; revoke with
   `npm run mcp:consumers -- --revoke <agent-id>`. To change a provider/scope
   without re-issuing the token (no container change), use
   `npm run mcp:consumers -- --attest <agent-id> --provider <p> [--scope ...]`.
   The public server (8766) requires no token or attestation.
```

Add a short "Capability scopes" subsection to the agent-docs block (after the tool inventory, before "**Sends are never silent.**"):

```markdown
**Capability scopes (optional token narrowing).** A token may be limited to a set
of surface scopes; out-of-scope tools are hidden from the agent entirely. Tokens:
`mail:read · mail:write · mail:send · calendar:read · calendar:write · tasks:read ·
tasks:write · sheets:read · sheets:write · docs:read · docs:write · clemson ·
host:read`. No `--scope` = full access. `mail:send` is separate from `mail:write`,
so a token can read/triage mail without the ability to submit a send.
```

- [ ] **Step 2: Update `src/mcp-server.md`**

Add a section documenting the attestation + scope model (place it near the auth/registry description). Use this text:

```markdown
## Provider attestation + capability scopes

Each credentialed consumer is paired with an attested model-backend **provider**
and an optional **scope** set:

- `npm run mcp:pair -- --id <agent> --provider <p> [--scope a,b]` — mint a token.
  `--provider` is required and must be authorized in
  `policy/action-policy.yaml` → `data_egress.agent_backends` (fail closed).
- `npm run mcp:consumers -- --attest <agent> --provider <p> [--scope a,b]` —
  set/replace provider and scope IN PLACE without rotating the token (no
  container change). Restart the server to apply.
- `npm run mcp:consumers -- --list` / `--check` — show each consumer's provider
  and scope, and flag UNATTESTED consumers (which are rejected at runtime).

The server re-checks the attested provider against policy on **every request**;
flipping a provider to `authorized: false` (then restarting) cuts that agent off
without touching its token. Scope tokens map to operation groups
(`mail:read`, `mail:send`, `sheets:write`, `clemson`, …); out-of-scope tools are
omitted from the tool list and refused on call. No scope = full access.
The audit log (`state/decisions.jsonl`) records the matched consumer id in
`mcp_consumer_id` on every write row.
```

- [ ] **Step 3: Commit (docs only — no tests)**

```bash
git add skills/add-cuassistant/SKILL.md src/mcp-server.md
git commit -m "docs(mcp): document provider attestation, --attest, and capability scopes"
```

---

## Task 8: Migration + end-to-end verification (operator actions)

**Files:** none (operational). Run on the host where the credentialed server lives.

- [ ] **Step 1: Full suite + typecheck green**

```bash
npm run typecheck && npm test
```

Expected: all tests pass.

> **SEQUENCING — read first.** The running launchd server is on the OLD (pre-
> attestation) code, so the live agents work today with no `provider`. The new
> build enforces attestation: an unattested consumer is rejected (401). Therefore
> **attest every live consumer BEFORE restarting onto the new build** — attest
> writes are forward-compatible (the old code ignores the `provider` field), so
> doing them first means there is no 401 window when the new code comes up. Also
> prefer deploying from merged `main`, not the feature-branch working tree.

- [ ] **Step 2: Inspect current consumers (find the unattested ones)**

Run: `npm run mcp:consumers -- --check` (or `--list`)
Expected: the unattested report lists every live consumer — at time of writing
that is **`nanoclaw-personal` and `nanoclaw-pi-co`** (both show
`UNATTESTED(run --attest)` under `--list`). Attest ALL of them in Step 3.

- [ ] **Step 3: Attest EACH live agent in place (no token rotation, no container change)**

```bash
npm run mcp:consumers -- --attest nanoclaw-personal --provider chatgpt_edu
npm run mcp:consumers -- --attest nanoclaw-pi-co     --provider chatgpt_edu
```

Expected per run: `Attested "<id>": provider=chatgpt_edu, scope=full (token unchanged). Takes effect on the next request — the registry is reloaded per request, so no restart is needed. (A policy change to agent_backends still requires a server restart.)`

> Use each agent's real contract-covered backend provider — `chatgpt_edu` or
> `openai_api` (both authorized). Narrow with `--scope` here if desired. Do this
> for the env-token too via Step 4 if it's in use.

- [ ] **Step 4: If `MCP_AUTH_TOKEN` (env-token) is in use, give it a provider**

Add to `.env` (only if `MCP_AUTH_TOKEN` is set): `MCP_AUTH_TOKEN_PROVIDER=chatgpt_edu`
If `MCP_AUTH_TOKEN` is unset (registry-only setup), skip this step.

- [ ] **Step 5: Deploy the new build (restart the credentialed server)**

This restart is what puts the NEW (attestation-enforcing) code into service — not
what "applies" an attestation (attestation is live per-request as soon as it's
written). With every consumer attested in Step 3, the agents keep working across
the restart.

Run: `launchctl kickstart -k gui/$(id -u)/com.cuassistant.mcp-http`
(or restart `npm run mcp:http` if running manually).

- [ ] **Step 6: Verify the registry and a live call**

Run: `npm run mcp:consumers -- --list`
Expected: `nanoclaw-personal` and `nanoclaw-pi-co` both show
`provider=chatgpt_edu scope=full`, no `UNATTESTED`.

From each agent (or a curl handshake), confirm:

- ListTools returns the expected tool set (full, or only the scoped surfaces if narrowed).
- A tool call succeeds and appends a `state/decisions.jsonl` row carrying its `mcp_consumer_id`.

Run (host): `tail -n 5 state/decisions.jsonl`
Expected: recent `mcp-tool` rows include `"mcp_consumer_id":"<agent-id>"`
(reads are not audited; stdio-path rows carry `"stdio"`).

- [ ] **Step 7: Negative check — attestation kill switch**

Temporarily set `chatgpt_edu` `authorized: false` in `policy/action-policy.yaml`, restart, and confirm the agent's calls now return 401 (`model_unauthorized` in the server log). Then revert the flag and restart. (Optional but recommended to prove the control.)

- [ ] **Step 8: Final review commit (if any docs/notes changed during verification)**

```bash
git status   # commit only intended changes; do NOT commit .env
```

---

## Notes for the implementer

- **Do not commit `.env`** or any token. `MCP_AUTH_TOKEN_PROVIDER` is the only new env var; document it but don't hardcode.
- **Import extensions:** `.ts` in `test/` files, `.js` in `src/`/`scripts/` files. Mismatching these is the most likely build error.
- **No circular imports:** `consumers.ts` stays free of `policy`/`permissions` imports (attestation lives in `server.ts`); `audit.ts` owns the ALS and is imported by `server.ts` (one direction). Keep it that way.
- **Out of scope** (do not build): on-wire bearer injection / host broker, short-lived/OIDC tokens, container network egress lock-down. These are NanoClaw-side and documented as recommendations in `docs/security/2026-06-11-cuassistant-nanoclaw-it-review.md`.

```

```
