import type { SpawnSpec } from "../agentdata/spawn-data-contracts.ts";
import { SessionService } from "../session/session.service.ts";
import type { SwitchRequest } from "../session/session.contracts.ts";
import {
  activePlanPresetName,
  classifyPlanRole,
  planRolePool,
  type PlanPresetName,
} from "../config.ts";
import {
  HARNESSES,
  runtimeHarness,
  type Harness,
} from "../harness-routing/harness.ts";
import { resolveSpawnAdmission } from "../harness-routing/policy/admission.ts";
import { resolveFreshEffort } from "../harness-routing/policy/steering.ts";
import { objectiveContractFromStoredEvidence } from "../shared-policy/objective-contract.ts";
import {
  LIVE_ROLE_WORD_UNION,
  resolveCanonicalRoleWord,
} from "../shared-policy/role-word-union.ts";
import { finalQuotaGate } from "../create-agent/native-availability.ts";
import { resolveModelBypassAuthorization } from "../create-agent/model-bypass-authorization.ts";
import type { RegisteredSwitchBypass } from "./command-arguments.ts";

const SESSION = new SessionService();
const validateSwitchTarget = SESSION.validateSwitchTarget.bind(SESSION);

export interface RegisteredSwitchPolicyDeps {
  readClaudeUsage: () => Promise<
    import("../plan-usage-remaining/telemetry.types.ts").UsagePayload
  >;
  readCodexUsage: () => Promise<
    import("../shared-policy/codex-usage.service.ts").CodexUsagePayload
  >;
  /** Reads the same durable `--bypass-model` authorization registry
   *  `create-agent` uses. Defaults to no registrations, so an omitted reader
   *  behaves exactly like an empty/malformed registry: the flag alone never
   *  clears the requested-pool gate. */
  readModelBypassAuthorizations?: () => Promise<unknown>;
  now?: () => string;
  planPresetName?: PlanPresetName;
  targetEffort?: number;
}
export type RegisteredSwitchPolicyResult =
  | { ok: true; request: SwitchRequest; notes: readonly string[] }
  | { ok: false; reason: string };

type RegisteredRole = "alpha" | "shadow" | "agent";

function registeredRole(agentName: string): RegisteredRole | undefined {
  const resolved = resolveCanonicalRoleWord(agentName, LIVE_ROLE_WORD_UNION);
  if (resolved !== null) return resolved.role;
  if (agentName.startsWith("agent-")) return "agent";
  return undefined;
}

function supportedHarness(spawn: SpawnSpec): Harness | undefined {
  return HARNESSES.includes(spawn.harness as Harness)
    ? (spawn.harness as Harness)
    : undefined;
}

export async function resolveRegisteredSwitchPolicy(opts: {
  agentName: string;
  spawn: SpawnSpec;
  requested: SwitchRequest;
  bypass: RegisteredSwitchBypass;
  deps: RegisteredSwitchPolicyDeps;
}): Promise<RegisteredSwitchPolicyResult> {
  const role = registeredRole(opts.agentName);
  if (role === undefined) {
    return {
      ok: false,
      reason: `registered agent "${opts.agentName}" has no recognized role prefix`,
    };
  }
  let objectiveCode: string | undefined;
  if (role !== "agent") {
    const objective = objectiveContractFromStoredEvidence({
      agentName: opts.agentName,
      role,
      evidence: {
        ...(opts.spawn.objective_code === undefined
          ? {}
          : { objective_code: opts.spawn.objective_code }),
        ...(opts.spawn.non_campaign === undefined
          ? {}
          : { non_campaign: opts.spawn.non_campaign }),
      },
    });
    if (!objective.ok) return { ok: false, reason: objective.reason };
    objectiveCode =
      objective.contract?.kind === "campaign"
        ? objective.contract.objectiveCode
        : undefined;
  }
  const harness = supportedHarness(opts.spawn);
  if (harness === undefined) {
    return {
      ok: false,
      reason: `stored harness "${opts.spawn.harness}" is not supported`,
    };
  }
  const validated = validateSwitchTarget(
    { harness, model: opts.spawn.model, effort: opts.spawn.effort },
    opts.requested,
  );
  if (!validated.ok) return { ok: false, reason: validated.message };

  const planRole = classifyPlanRole(role, opts.agentName, objectiveCode);
  const preset = opts.deps.planPresetName ?? activePlanPresetName();
  let modelBypassAuthorized = false;
  if (opts.bypass.model) {
    let registry: unknown;
    try {
      registry = await opts.deps.readModelBypassAuthorizations?.();
    } catch {
      registry = undefined;
    }
    const authorization = resolveModelBypassAuthorization({
      registry,
      objectiveCode,
      recipient: opts.agentName,
      recipientRole: role,
      now: opts.deps.now?.() ?? new Date().toISOString(),
    });
    modelBypassAuthorized = authorization.kind === "authorized";
  }
  const admission = resolveSpawnAdmission({
    requested: { harness, model: validated.target.model },
    name: opts.agentName,
    planRole,
    preset,
    allowedPairs:
      planRole === undefined ? undefined : planRolePool(planRole, preset),
    enforceRolePool: !modelBypassAuthorized,
  });
  if (admission.kind === "refuse")
    return { ok: false, reason: admission.reason };
  const requestedPair = admission.pair;
  if (runtimeHarness(requestedPair.harness) !== runtimeHarness(harness)) {
    return {
      ok: false,
      reason:
        `model admission resolved ${requestedPair.harness}/${requestedPair.model}, but registered model switching ` +
        "must preserve launcher family; request the in-family target instead — no flag, including " +
        "--bypass-model, can cross launcher families for a registered switch",
    };
  }
  const effort = resolveFreshEffort({
    harness: requestedPair.harness,
    model: requestedPair.model,
    requestedEffort: opts.requested.effort,
    bypassEffort: opts.bypass.effort,
    targetEffort: opts.deps.targetEffort,
  });
  if (effort.kind === "refuse") return { ok: false, reason: effort.message };

  const quota = await finalQuotaGate({
    name: opts.agentName,
    resuming: false,
    harness,
    model: requestedPair.model,
    bypassZeroQuota: opts.bypass.zeroQuota,
    readClaude: opts.deps.readClaudeUsage,
    readCodex: opts.deps.readCodexUsage,
  });
  if (quota.refuse)
    return {
      ok: false,
      reason: quota.message?.trim() ?? "target quota refused",
    };
  return {
    ok: true,
    request: { model: requestedPair.model, effort: effort.effort },
    notes: [
      opts.spawn.model_hint === undefined
        ? undefined
        : `active human queue model hint ${opts.spawn.model_hint.harness}/${opts.spawn.model_hint.model}`,
      effort.overrideNote,
      quota.message,
    ].filter(
      (note): note is string => note !== undefined && note.trim() !== "",
    ),
  };
}
