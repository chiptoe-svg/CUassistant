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

export interface ActionPolicy {
  policy_version: number;
  policy_name: string;
  actions: PolicyAction[];
}

const DEFAULT_POLICY: ActionPolicy = {
  policy_version: 0,
  policy_name: "missing_policy",
  actions: [],
};

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
    };
  } catch {
    return DEFAULT_POLICY;
  }
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
