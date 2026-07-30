# MCP OAuth with Clemson SSO — design + phased plan

**Date:** 2026-07-29 · **Status:** ON HOLD — captured as a future option, not
active work. Revisit alongside the UI SSO / Entra registration effort; nothing
here changes current behavior until deliberately picked up (default is bearer).

**Goal:** Add OAuth 2.0 / OIDC auth to the MCP servers, integrated with Clemson
**Entra**, as a **flag-gated** capability. The system operates exactly as it does
today (static bearer tokens) until a flag flips it to OAuth — per server, so it
can roll out one server at a time. Retire long-lived static bearers in favor of
Entra-issued identity, and lay the groundwork for per-user (SSO) identity
reaching the tool layer.

## Why this is a clean fold-in (the backward-compat guarantee)

Both auth choke points are already abstractions, so dual-mode is additive:

- **Server:** auth is a pluggable `Authenticator = (authHeader) => Principal | null`
  (`src/mcp-tools/server.ts`), with `Principal { id, scopes, provider }`. Today the
  server picks `resolveCredentialedAuth` (static-bearer registry). We add
  `resolveOAuthAuth` alongside it and select by `MCP_AUTH_MODE` (**default
  `bearer`**). The `Principal` shape is unchanged, so operation gating and audit
  are identical in both modes.
- **Client (advisor):** `advisorMcpServers()` already parameterizes the auth
  header via `withAuth(url, token)`. We add an OAuth credential provider selected
  by `ADVISOR_MCP_AUTH_MODE` (**default `bearer`**).
- **Per-server opt-in:** flags can be per-server, so you enable OAuth on one
  server (e.g. catalog 8767), verify end-to-end, then the rest. Bearer stays as a
  fallback until you're confident.

**Net: nothing changes until a flag is set.** Default config = today's behavior.

## Two identity models (phasing)

1. **Phase 1 — Machine identity (client-credentials).** The advisor service
   authenticates to Entra *as itself*, gets an access token, and presents it to
   the MCP servers, which validate it. Retires static bearers; **no UI change
   needed**. This is the "fold in behind a flag" MVP.
2. **Phase 2 — User-delegated (after UI SSO lands).** Once advisors log into the
   UI via Entra OIDC, flow the *logged-in advisor's* identity to the MCP calls
   (on-behalf-of / token exchange), enabling per-user authorization and audit at
   the tool layer.

Phase 1 stands alone and delivers the security-review win (no static secrets,
Entra-issued machine identity). Phase 2 is a later enhancement.

## Architecture

### Server side (MCP server becomes an OAuth resource server)
New `resolveOAuthAuth({ tenantId, audience, requiredRole })` — an `Authenticator`
that, per request:
- extracts the Bearer JWT;
- validates it with **`jose`** against Entra's JWKS
  (`https://login.microsoftonline.com/<tenant>/discovery/v2.0/keys`,
  `createRemoteJWKSet` handles caching + rotation), checking `iss` (Clemson
  tenant), `aud` (the MCP resource app id/URI), `exp`, and the required
  `roles`/`scp` claim;
- maps claims → `Principal { id: <appid|oid|sub>, scopes: <mapped>, provider: "entra" }`;
- returns `null` on any failure (**fail closed**).

`startMcpServer` selects the authenticator by `MCP_AUTH_MODE`; default `bearer`.
**New egress:** server → Entra JWKS endpoint.

### Client side (advisor acquires a token)
New `oauthCredential()` — does client-credentials against Entra's token endpoint
(`https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token`,
`grant_type=client_credentials`, `scope=api://<mcp-app>/.default`), caches the
token, and refreshes ~60s before `exp`. `advisorMcpServers()`/`withAuth` selects
static-bearer vs. oauth-token by `ADVISOR_MCP_AUTH_MODE`; the transport sets
`Authorization: Bearer <token>` per request. **New egress:** advisor → Entra
token endpoint (add to the egress allowlist).

> Recommendation: hand-roll validation/acquisition with `jose` + `fetch` rather
> than the SDK's OAuth provider abstraction — fewer moving parts, full control
> over claim mapping, and it doesn't couple us to the SDK's auth API shape.
> (The SDK *does* ship `server/auth` + `client/auth`; we can revisit if useful.)

## Config (every value defaults to today's behavior)

**Server:** `MCP_AUTH_MODE=bearer|oauth` (default `bearer`), `MCP_OAUTH_TENANT_ID`,
`MCP_OAUTH_AUDIENCE`, `MCP_OAUTH_REQUIRED_ROLE`. Optional per-server override
(e.g. `MCP_CATALOG_AUTH_MODE`) for staged rollout.

**Client:** `ADVISOR_MCP_AUTH_MODE=bearer|oauth` (default `bearer`),
`ADVISOR_OAUTH_TENANT_ID`, `ADVISOR_OAUTH_CLIENT_ID`,
`ADVISOR_OAUTH_CLIENT_SECRET` (or certificate), `ADVISOR_OAUTH_SCOPE`.

Secrets stay in gitignored `.env`.

## What's needed from Clemson IT (Entra)

- **MCP resource app registration** — exposes an API; define an app role
  (e.g. `MCP.Invoke`) and/or a scope; note the audience (`api://<id>`).
- **Advisor client** — reuse the advisor's SSO app registration *or* a separate
  one; a client secret/cert; granted the `MCP.Invoke` app role on the resource;
  admin-consented.
- **Tenant ID** (Clemson).
- (Phase 2) a delegated scope for user on-behalf-of.

This is the same low-risk, authentication-only ask as the UI SSO registration.

## Implementation phases

- **Phase 0 — scaffolding (no behavior change).** Add `jose`. Add the config
  flags (default `bearer`). Introduce the `MCP_AUTH_MODE` switch in
  `startMcpServer` and `ADVISOR_MCP_AUTH_MODE` in `advisorMcpServers()` — both
  still resolve to bearer. Ship; confirm zero change.
- **Phase 1 — server OAuth authenticator.** Implement `resolveOAuthAuth` + unit
  tests (valid token → Principal; bad `iss`/`aud`/`exp`/role → null; wrong
  signature → null; mock JWKS/token, no live Entra). Wire selection.
- **Phase 2 — client OAuth credential.** Implement `oauthCredential`
  (client-credentials + cache/refresh) + unit tests against a mocked token
  endpoint. Wire selection.
- **Phase 3 — egress + staged rollout.** Add the Entra token/JWKS endpoints to
  the egress allowlist. Enable `oauth` on one server, verify `tools/list` + a
  live turn end-to-end, then roll to the rest. Keep bearer as fallback.
- **Phase 4 (later) — user-delegated identity.** After UI SSO, flow the user
  token via OBO/token-exchange; MCP servers enforce per-user authz + audit.

## Safety / backward-compat

- Default flags = today's behavior; no restart changes anything until a flag flips.
- Per-server rollout; bearer remains available as a fallback.
- Fail-closed: OAuth mode rejects on any validation failure — a misconfig is a
  clean 401, never an open server.
- The `mcp-public-bridge` forwarder passes `Authorization` through unchanged, so
  it works for both modes without changes.
- **Restart discipline:** MCP servers load auth config at process start —
  flipping `MCP_AUTH_MODE` requires restarting the affected server and
  re-verifying `tools/list` (per CLAUDE.md).

## Open decisions (settle before the executable task-by-task plan)

1. **Machine identity first (recommended)** vs. jump straight to user-delegated.
2. **Client secret vs. certificate** for the advisor client (cert is
   review-preferred).
3. **Reuse the advisor's SSO app registration** for the MCP client, or a
   separate one.
4. **`jose` hand-rolled (recommended)** vs. the SDK's OAuth abstraction.

## Testing

- Server: unit-test `resolveOAuthAuth` with a mocked JWKS + signed test tokens —
  no live Entra required.
- Client: unit-test `oauthCredential` against a mocked token endpoint (acquire,
  cache, refresh, header set).
- Integration: one staged live test against Entra once the app registration
  exists.
