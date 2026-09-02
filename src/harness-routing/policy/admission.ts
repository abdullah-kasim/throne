import { HARNESSES, type Harness } from "../harness.ts";
import {
  canonicalForwardModelPair,
  isShadowSlice99Name,
  type ModelPair,
  type ModelPairPool,
  type PlanPresetName,
  type PlanRole,
} from "../../config.ts";
import { isModelPairAllowed } from "./capabilities.ts";
import { pickShadowHarness, type HarnessUsage } from "./usage.ts";
import { planRolePoolRefusal } from "../../shared-policy/plan-role-policy.ts";

export const PRESET_ROLES: readonly string[] = ["alpha", "shadow", "stager"];

const ROLE_NAME_PREFIXES: readonly string[] = [
  "shadow-",
  "alpha-",
  "agent-",
  "stager-",
];

export type ShadowLaunchPlan =
  | { kind: "launch"; harness: Harness; model: string; note: string }
  | { kind: "pause"; reason: string }
  | { kind: "remap-error"; reason: string };

export type SpawnAdmission =
  | { kind: "admit"; pair: ModelPair; note: string }
  | { kind: "refuse"; reason: string };

export function resolveSpawnAdmission(opts: {
  requested: ModelPair;
  planRole?: PlanRole;
  preset: PlanPresetName;
  name: string;
  allowedPairs?: ModelPairPool;
  enforceRolePool: boolean;
  poolSource?: { label: string; hint: string };
  ownerAllowlist?: boolean;
}): SpawnAdmission {
  const canonicalPair = canonicalForwardModelPair(opts.requested);
  if (canonicalPair === undefined) {
    return {
      kind: "refuse",
      reason:
        `MODEL_REGISTRY declares no forward harness for ${opts.requested.harness}/` +
        `${opts.requested.model}. Exact stored registrations still resume their ` +
        "recorded recipe.",
    };
  }
  const pair =
    opts.enforceRolePool && opts.allowedPairs !== undefined
      ? (opts.allowedPairs.find(
          (candidate) => candidate.model === canonicalPair.model,
        ) ?? canonicalPair)
      : canonicalPair;
  if (
    opts.enforceRolePool &&
    opts.planRole !== undefined &&
    opts.allowedPairs !== undefined
  ) {
    const refusal = planRolePoolRefusal({
      preset: opts.preset,
      role: opts.planRole,
      name: opts.name,
      pair,
      pool: opts.allowedPairs,
      phase: "requested",
      poolSource: opts.poolSource,
      ownerAllowlist: opts.ownerAllowlist,
    });
    if (refusal !== undefined) return { kind: "refuse", reason: refusal };
  }
  return {
    kind: "admit",
    pair,
    note: `mechanically spawnable ${pair.harness}/${pair.model} kept as requested`,
  };
}

export function shouldRouteShadow(opts: { role: string }): boolean {
  return opts.role.trim().toLowerCase() === "shadow";
}

export function isValidateGateShadow(
  name: string,
  objectiveCode?: string,
): boolean {
  return isShadowSlice99Name(name, objectiveCode);
}

export function presetRoleGate(opts: { role: string; bypass: boolean }): {
  refuse: boolean;
  reason?: string;
} {
  if (opts.bypass) return { refuse: false };
  if (PRESET_ROLES.includes(opts.role.trim().toLowerCase())) {
    return { refuse: false };
  }
  return {
    refuse: true,
    reason:
      `create-agent spawns only the preset roles Alpha, Shadow, and Stager ` +
      `without --bypass-preset-agent; role "${opts.role.trim() || "(none)"}" is not a ` +
      `preset. Spawn an Alpha, a Shadow, or a Stager, or pass --bypass-preset-agent ` +
      `for an ad-hoc agent (canary, probe, one-off).`,
  };
}

// `PRESET_ROLES` are matched case-insensitively above so a differently-cased
// spelling (`alpha`, `ALPHA`) still counts as a valid preset -- but a
// differently-cased value that reaches identity write (`writeIdentity`,
// `identity-role-casing.ts`) is exactly the source of the casing regression
// that produced a real Alpha misclassified as non-Alpha, and a real live
// Shadow misclassified as an orphan, in the no-idling sweep. Reject it
// loudly at the CLI edge -- before any identity is written -- rather than
// silently accept-and-canonicalize it: an operator who typed `--role alpha`
// finds out immediately, not from a stale-looking notice hours later.
const CANONICAL_PRESET_ROLES: readonly string[] = PRESET_ROLES.map(
  (role) => role[0].toUpperCase() + role.slice(1),
);

export function presetRoleCasingGate(opts: { role: string }): {
  refuse: boolean;
  reason?: string;
} {
  const trimmed = opts.role.trim();
  const canonical = CANONICAL_PRESET_ROLES.find(
    (name) => name.toLowerCase() === trimmed.toLowerCase(),
  );
  if (canonical === undefined || canonical === trimmed) {
    return { refuse: false };
  }
  return {
    refuse: true,
    reason:
      `--role "${trimmed}" is not valid -- the preset role vocabulary is exact-case ` +
      `${CANONICAL_PRESET_ROLES.join("/")}. Use --role ${canonical}.`,
  };
}

export function crossRolePrefixGuard(opts: { role: string; name: string }): {
  refuse: boolean;
  foreignPrefix?: string;
  cleaned?: string;
} {
  const roleNorm = opts.role.trim().toLowerCase();
  if (roleNorm === "" || roleNorm === "none") {
    return { refuse: false };
  }
  const ownPrefix = `${roleNorm}-`;
  const nameNorm = opts.name.trim().toLowerCase();
  for (const prefix of ROLE_NAME_PREFIXES) {
    if (prefix === ownPrefix) continue;
    if (nameNorm.startsWith(prefix)) {
      return {
        refuse: true,
        foreignPrefix: prefix,
        cleaned: opts.name.trim().slice(prefix.length),
      };
    }
  }
  return { refuse: false };
}

function harnessRepresentedInPool(
  harness: Harness,
  allowedPairs?: ModelPairPool,
): boolean {
  return (
    allowedPairs === undefined ||
    allowedPairs.some((pair) => pair.harness === harness)
  );
}

function enforceAllowedPair(
  plan: ShadowLaunchPlan,
  allowedPairs?: ModelPairPool,
): ShadowLaunchPlan {
  if (
    plan.kind !== "launch" ||
    isModelPairAllowed(plan.harness, plan.model, allowedPairs)
  ) {
    return plan;
  }
  return {
    kind: "remap-error",
    reason:
      `cannot launch ${plan.harness}/${plan.model}: the allowed model pool excludes ` +
      `that pair (${plan.note})`,
  };
}

export function planShadowLaunch(
  req: { harness: Harness; model: string },
  claude: HarnessUsage,
  codex: HarnessUsage,
  isValidateGate: boolean,
  allowedPairs?: ModelPairPool,
): ShadowLaunchPlan {
  const allowedHarnesses = HARNESSES.filter((harness) =>
    harnessRepresentedInPool(harness, allowedPairs),
  );
  const route = pickShadowHarness(claude, codex, allowedHarnesses);
  let plan: ShadowLaunchPlan;

  if (route.kind === "pause") {
    plan = { kind: "pause", reason: route.reason };
  } else if (route.kind === "no-signal") {
    plan = {
      kind: "launch",
      harness: req.harness,
      model: req.model,
      note: "usage unavailable — kept requested harness",
    };
  } else if (route.harness === req.harness) {
    plan = {
      kind: "launch",
      harness: route.harness,
      model: req.model,
      note: route.reason,
    };
  } else {
    plan = {
      kind: "remap-error",
      reason: `usage routing selected ${route.harness}, but the requested ${req.harness}/${req.model} must not be automatically remapped; choose an admitted pair explicitly`,
    };
  }

  return enforceAllowedPair(plan, allowedPairs);
}

export function resolveShadowLaunch(opts: {
  role: string;
  req: { harness: Harness; model: string };
  usage?: { claude: HarnessUsage; codex: HarnessUsage };
  isValidateGate: boolean;
  allowedPairs?: ModelPairPool;
}): ShadowLaunchPlan {
  const { role, req, usage, isValidateGate, allowedPairs } = opts;

  const routingApplies = shouldRouteShadow({ role });
  if (!routingApplies || usage === undefined) {
    const unroutedCause = !routingApplies
      ? `role "${role}" is not usage-routed`
      : "no usage readings provided";
    const plan: ShadowLaunchPlan = {
      kind: "launch",
      harness: req.harness,
      model: req.model,
      note: `${unroutedCause} — launching as requested`,
    };
    return enforceAllowedPair(plan, allowedPairs);
  }

  return planShadowLaunch(
    req,
    usage.claude,
    usage.codex,
    isValidateGate,
    allowedPairs,
  );
}
