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
