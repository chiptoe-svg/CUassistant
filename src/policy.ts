import fs from "fs";
import path from "path";

import YAML from "yaml";

export type PolicyApproval = "none" | "human_required";

export interface PolicyAction {
  id: string;
  surface: string;
  risk: string;
  reversibility: string;
  approval: PolicyApproval;
  constraints?: string[];
}

/**
 * A declared LLM provider the classifier may send mailbox content to. The list
 * holds as many providers as needed.
 *
 * - `scope: "external"` — content leaves the M365 envelope; `basis` must cite
 *   the DPA / institutional agreement (recorded, not proven, here) that covers
 *   it, and `authorized` is the operator's attestation that it does.
 * - `scope: "local"` — on-host inference (a local LLM); content does not leave
 *   the machine, so no data agreement is required.
 */
export interface EgressClassifier {
  provider: string;
  scope: "external" | "local";
  sends: string[];
  basis: string;
  authorized: boolean;
}

export interface DataEgress {
  classifiers: EgressClassifier[];
}

export interface ActionPolicy {
  policy_version: number;
  policy_name: string;
  actions: PolicyAction[];
  data_egress?: DataEgress;
}

const DEFAULT_POLICY: ActionPolicy = {
  policy_version: 0,
  policy_name: "missing_policy",
  actions: [],
};

/**
 * Whether `provider` is authorized for mailbox-content egress in the given
 * classifier list. FAIL CLOSED: an unknown or unset provider is not authorized.
 */
export function egressAuthorizedIn(
  classifiers: EgressClassifier[],
  provider: string,
): boolean {
  return classifiers.find((c) => c.provider === provider)?.authorized === true;
}

function loadPolicyFile(): ActionPolicy {
  const policyDir = path.resolve(
    process.env.POLICY_DIR || path.join(process.cwd(), "policy"),
  );
  const p = path.join(policyDir, "action-policy.yaml");
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const parsed = YAML.parse(raw) as Partial<ActionPolicy> | null;
    return {
      policy_version: Number(parsed?.policy_version || 0),
      policy_name: String(parsed?.policy_name || "unnamed_policy"),
      actions: Array.isArray(parsed?.actions)
        ? parsed.actions.filter((action): action is PolicyAction =>
            Boolean(action && typeof action.id === "string"),
          )
        : [],
      data_egress: parseDataEgress(parsed?.data_egress),
    };
  } catch {
    return DEFAULT_POLICY;
  }
}

function parseDataEgress(raw: unknown): DataEgress | undefined {
  const list = (raw as { classifiers?: unknown[] })?.classifiers;
  if (!Array.isArray(list)) return undefined;
  const classifiers = list
    .filter(
      (c): c is Partial<EgressClassifier> =>
        Boolean(c) && typeof (c as EgressClassifier).provider === "string",
    )
    .map((c) => ({
      provider: String(c.provider),
      scope: c.scope === "local" ? ("local" as const) : ("external" as const),
      sends: Array.isArray(c.sends) ? c.sends.map(String) : [],
      basis: typeof c.basis === "string" ? c.basis : "",
      authorized: c.authorized === true, // fail closed: anything but true is false
    }));
  return { classifiers };
}

const ACTION_POLICY = loadPolicyFile();
const ACTION_INDEX = new Map(
  ACTION_POLICY.actions.map((action) => [action.id, action] as const),
);

export function getActionPolicy(): ActionPolicy {
  return ACTION_POLICY;
}

export function getPolicyAction(actionId: string): PolicyAction | undefined {
  return ACTION_INDEX.get(actionId);
}

/** Whether `provider` is authorized for mailbox-content egress per policy. */
export function isEgressAuthorized(provider: string): boolean {
  return egressAuthorizedIn(
    ACTION_POLICY.data_egress?.classifiers ?? [],
    provider,
  );
}

/** The full declared classifier-provider list (for tooling/inspection). */
export function getEgressClassifiers(): EgressClassifier[] {
  return ACTION_POLICY.data_egress?.classifiers ?? [];
}
