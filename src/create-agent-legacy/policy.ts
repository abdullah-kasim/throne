import { HARNESSES, type Harness } from "../harness-routing/harness.ts";
import {
  isValidateGateShadow,
  resolveSpawnAdmission,
} from "../harness-routing/policy/admission.ts";
import {
  evaluateFinalCapability,
  modelPlanningScore,
  PLANNING_FLOOR,
  thinkingRoleCapabilityGuard,
} from "./legacy-capabilities.ts";
import {
  describeUnusableHarnessUsage,
  isHarnessUsageUsable,
} from "../harness-routing/policy/usage.ts";
import { resolveFreshEffort, steerSpawn } from "./legacy-steering.ts";
import {
  activePlanPresetName,
  canonicalForwardModelPair,
  classifyPlanRole,
  planRolePool,
  type ModelPair,
  type ModelPairPool,
  type PlanPresetName,
  type PlanRole,
} from "../config.ts";
import {
  type CreateAgentDeps,
  type PolicyResolution,
  type RegistrationResolution,
  type StageResult,
} from "./create.types.ts";
import { currentIsoTime, stderrWriter } from "./command-context.ts";
import {
  buildOpenCodeGoCanaryUsage,
  buildRoutingUsage,
  usageReaders,
} from "./policy-usage.ts";
import { finalQuotaGate } from "./native-availability.ts";
import {
  deepSeekTelemetryOverride,
  isExplicitDeepSeekAdmission,
  resolveExplicitDeepSeekCanaryEffort,
} from "./deepseek-canary.ts";
import { planRolePoolRefusal } from "../shared-policy/plan-role-policy.ts";
import { authorizeUsageBypass } from "./usage-bypass-authorization.ts";
import { authorizeModelBypass } from "./model-bypass-authorization.ts";
import {
  MODEL_ALLOWLIST_FILE_NAME,
  modelAllowlistOwner,
} from "./model-allowlist.ts";
import {
  parseFreshCapabilityRequirements,
  resolveObjectiveCodeQueueGate,
  resolveObjectiveContract,
} from "./policy-objective.ts";
import { resolveStagerRouteAuthorization } from "./stager-route-authorization.ts";
export async function resolveSpawnPolicy(
  request: RegistrationResolution,
  deps: CreateAgentDeps,
): Promise<StageResult<PolicyResolution>> {
  const writeStderr = stderrWriter(deps);
  const requirementsResult = parseFreshCapabilityRequirements(request, deps);
  if (!requirementsResult.ok) return requirementsResult;
  const capabilityRequirements = requirementsResult.value;
  const objectiveResult = await resolveObjectiveContract(request, deps);
  if (!objectiveResult.ok) return objectiveResult;
  const objectiveContract = objectiveResult.value;
  const queueLinkageGate = await resolveObjectiveCodeQueueGate(
    request,
    objectiveContract,
    deps,
  );
  if (!queueLinkageGate.ok) return queueLinkageGate;
  const bypassedObjectiveCode = queueLinkageGate.value;
  const usageAuthorization = await authorizeUsageBypass(
    request,
    objectiveContract,
    deps,
  );
  if (!usageAuthorization.ok) return usageAuthorization;
  const usageBypassAuthorization = usageAuthorization.value;
  const modelBypassAuthorization = await authorizeModelBypass(
    request,
    objectiveContract,
    deps,
  );
  if (request.emptyWorktree && objectiveContract?.kind !== "campaign") {
    stderrWriter(deps)(
      `create-agent-legacy: refusing --empty-worktree for "${request.name}" — it requires a campaign Alpha or Shadow objective and cannot be used as the non-campaign or mutation exemption. Nothing was registered or launched.\n`,
    );
    return { ok: false, code: 1 };
  }
  const campaignObjectiveCode =
    objectiveContract?.kind === "campaign"
      ? objectiveContract.objectiveCode
      : undefined;
  const isValidateGate =
    request.role.trim().toLowerCase() === "shadow" &&
    isValidateGateShadow(request.name, campaignObjectiveCode);
  const requestedPolicyPair = canonicalForwardModelPair({
    harness: request.harness,
    model: request.model,
  });
  if (!request.resuming && requestedPolicyPair === undefined) {
    writeStderr(
      `create-agent-legacy: refusing new ${request.harness}/${request.model} registration for "${request.name}" — ` +
        `MODEL_REGISTRY declares no forward harness for that pair. Exact stored ` +
        `registrations still resume their recorded recipe. Nothing was ` +
        `registered or launched.\n`,
    );
    return { ok: false, code: 1 };
  }
  let requestedPair =
    !request.resuming && requestedPolicyPair !== undefined
      ? requestedPolicyPair
      : { harness: request.harness, model: request.model };
  let stagerRouteAuthorization;
  if (!request.resuming && request.role.trim().toLowerCase() === "stager") {
    let registry: unknown;
    try {
      registry = await deps.readStagerRouteAuthorizations?.();
    } catch {
      registry = undefined;
    }
    stagerRouteAuthorization = resolveStagerRouteAuthorization({
      registry,
      recipient: request.name,
      harness: request.harness,
      model: request.model,
      now: currentIsoTime(deps),
    });
  }
  const explicitDeepSeekAdmission = isExplicitDeepSeekAdmission({
    resuming: request.resuming,
    objectiveContract,
    pair: requestedPair,
    role: request.role,
    bypassAlphaGuardrail: request.flags["bypass-alpha-guardrail"] === true,
    bypassPresetAgent: request.flags["bypass-preset-agent"] === true,
    bypassModel: request.flags["bypass-model"] === true,
  });
  const explicitModelBypassAuthorized = modelBypassAuthorization !== undefined;
  const activePreset = deps.planPresetName ?? activePlanPresetName();
  const planRole = request.resuming
    ? undefined
    : classifyPlanRole(request.role, request.name, campaignObjectiveCode);
  let allowedPairs =
    planRole === undefined ? undefined : planRolePool(planRole, activePreset);
  let allowlistRoutingNote = "";
  let allowlistPoolSource: { label: string; hint: string } | undefined;
  if (planRole !== undefined) {
    const allowlistOwnerName = modelAllowlistOwner({
      role: request.role,
      name: request.name,
      supervisor: request.flags.supervisor as string | undefined,
      objectiveContract,
    });
    if (allowlistOwnerName !== undefined) {
      const ownerAllowlist =
        await deps.readModelAllowlist?.(allowlistOwnerName);
      if (ownerAllowlist !== undefined && ownerAllowlist.length > 0) {
        allowedPairs = ownerAllowlist;
        allowlistRoutingNote =
          `${allowlistOwnerName}-owned ${MODEL_ALLOWLIST_FILE_NAME} overrode ` +
          `the ${activePreset}/${planRole} role pool for this spawn`;
        allowlistPoolSource = {
          label: `campaign model allowlist for "${allowlistOwnerName}"`,
          hint: `<throne data home>/${allowlistOwnerName}/${MODEL_ALLOWLIST_FILE_NAME}`,
        };
      }
    }
  }
  if (!request.resuming) {
    const admission = resolveSpawnAdmission({
      requested: requestedPair,
      planRole,
      preset: activePreset,
      name: request.name,
      allowedPairs,
      enforceRolePool:
        !explicitDeepSeekAdmission &&
        !explicitModelBypassAuthorized &&
        stagerRouteAuthorization === undefined,
      poolSource: allowlistPoolSource,
    });
    if (admission.kind === "refuse") {
      writeStderr(`create-agent-legacy: ${admission.reason}\n`);
      return { ok: false, code: 1 };
    }
    requestedPair = admission.pair;
  }
  let launchHarness = request.launchHarness;
  let launchModel = request.launchModel;
  let launchEffort = request.launchEffort;
  let routingNote = "";
  let durableRoutingNote = false;
  let effortOverrideNote = "";
  let capabilityOverrideNote = "";
  let desperationLaunch = false;
  let harnessOverrideNote = "";
  let zeroQuotaOverrideNote = "";
  const normalizedRole = request.role.trim().toLowerCase();
  const steeredRole =
    normalizedRole === "alpha" || normalizedRole === "shadow"
      ? normalizedRole
      : undefined;
  const readers = usageReaders(deps);
  if (explicitDeepSeekAdmission) {
    const opencodeGoUsage = await buildOpenCodeGoCanaryUsage(readers, deps);
    if (!isHarnessUsageUsable(opencodeGoUsage)) {
      const telemetryOverride = deepSeekTelemetryOverride(
        opencodeGoUsage,
        request.flags["bypass-opencode-telemetry-unavailable"] === true,
        request.flags["bypass-zero-quota"] === true,
      );
      if (telemetryOverride.admitted) {
        routingNote = telemetryOverride.note;
        durableRoutingNote = true;
      } else {
        const bypassFlag = telemetryOverride.exactZero
          ? "--bypass-zero-quota only for this trustworthy exact-zero quota"
          : "--bypass-opencode-telemetry-unavailable only to override unavailable telemetry";
        writeStderr(
          `create-agent-legacy: refusing explicit DeepSeek admission ` +
            `"${request.name}": OpenCode Go telemetry is ` +
            `${describeUnusableHarnessUsage(opencodeGoUsage, false)}; fresh, ` +
            `semantically complete, positive remaining quota is mandatory. ` +
            `Pass ${bypassFlag}. Nothing was registered, trusted, or launched.\n`,
        );
        return { ok: false, code: 1 };
      }
    }
    launchHarness = requestedPair.harness;
    launchModel = requestedPair.model;
    launchEffort = resolveExplicitDeepSeekCanaryEffort(
      request.requestedEffort,
      deps.targetEffort,
    );
    routingNote = [
      routingNote,
      objectiveContract?.kind === "campaign"
        ? "explicit DeepSeek campaign admission; default role pools remain unchanged"
        : "explicit --non-campaign DeepSeek canary admission; default role pools remain unchanged",
    ]
      .filter(Boolean)
      .join("; ");
    durableRoutingNote = true;
  } else if (
    !request.resuming &&
    steeredRole !== undefined &&
    allowedPairs !== undefined
  ) {
    const bypass = {
      model: request.flags["bypass-model"] === true,
      effort: request.flags["bypass-effort"] === true,
      zeroQuota: request.flags["bypass-zero-quota"] === true,
      usage: request.flags["bypass-usage"] === true,
    };
    const usage =
      !bypass.usage &&
      (!(steeredRole === "shadow" && isValidateGate) || !bypass.model)
        ? await buildRoutingUsage(readers, deps)
        : undefined;
    let supervisorPair: ModelPair | undefined;
    if (steeredRole === "shadow" && isValidateGate) {
      const supervisorSpec = await deps
        .readSpawnSpec(request.flags.supervisor as string)
        .catch(() => null);
      if (
        supervisorSpec !== null &&
        HARNESSES.includes(supervisorSpec.harness as Harness)
      ) {
        supervisorPair = {
          harness: supervisorSpec.harness as Harness,
          model: supervisorSpec.model,
        };
      }
    }
    const steer = steerSpawn({
      role: steeredRole,
      isValidateGate,
      requested: requestedPair,
      requestedEffort: request.requestedEffort,
      supervisorPair,
      usage,
      bypass,
      allowedPairs,
      targetEffort: deps.targetEffort,
    });
    if (steer.kind === "refuse") {
      writeStderr(
        `create-agent-legacy: refusing new ${request.harness}/${request.model} ${request.role} "${request.name}" — ` +
          `${steer.message}. Nothing was registered, trusted, or launched.\n`,
      );
      return { ok: false, code: 1 };
    }
    launchHarness = steer.harness;
    launchModel = steer.model;
    launchEffort = steer.effort;
    routingNote = steer.note;
    durableRoutingNote = steer.durableRoutingNote === true;
    effortOverrideNote = steer.effortOverrideNote ?? "";
    desperationLaunch = steer.desperation === true;
  } else if (!request.resuming) {
    const effortSteer = resolveFreshEffort({
      harness: requestedPair.harness,
      model: request.model,
      requestedEffort: request.requestedEffort,
      bypassEffort: request.flags["bypass-effort"] === true,
      targetEffort: deps.targetEffort,
    });
    if (effortSteer.kind === "refuse") {
      writeStderr(
        `create-agent-legacy: refusing new ${request.harness}/${request.model} agent "${request.name}" — ` +
          `${effortSteer.message}. Nothing was registered, trusted, routed, ` +
          `or launched.\n`,
      );
      return { ok: false, code: 1 };
    }
    launchEffort = effortSteer.effort;
    effortOverrideNote = effortSteer.overrideNote ?? "";
  }
  if (launchEffort === undefined) {
    writeStderr(
      `create-agent-legacy: internal error — a launch effort could not be resolved for ` +
        `${request.harness}/${request.model}. Nothing was registered, trusted, routed, or ` +
        `launched.\n`,
    );
    return { ok: false, code: 1 };
  }
  let capabilityEvidence;
  if (!request.resuming && capabilityRequirements.length > 0) {
    const verdict = evaluateFinalCapability({
      requirements: capabilityRequirements,
      harness: launchHarness,
      model: launchModel,
    });
    if (verdict.kind === "refuse") {
      writeStderr(
        `create-agent-legacy: refusing final selected route — ${verdict.reason}. ` +
          `Nothing was registered, trusted, or launched.\n`,
      );
      return { ok: false, code: 1 };
    }
    capabilityEvidence = verdict.evidence;
  }
  if (!request.resuming) {
    const capabilityGuard = thinkingRoleCapabilityGuard({
      role: request.role,
      isValidateGate,
      harness: launchHarness,
      model: launchModel,
      bypassAlphaGuardrail: request.flags["bypass-alpha-guardrail"] === true,
    });
    if (capabilityGuard.refuse && desperationLaunch) {
      capabilityOverrideNote =
        `the desperation steer's redirect to ${launchHarness}/${launchModel} ` +
        `carries the Alpha planning-floor exception automatically for this one ` +
        `spawn (planning ` +
        `${modelPlanningScore(launchHarness, launchModel) ?? "unscored"} < ` +
        `floor ${PLANNING_FLOOR}; no --bypass-alpha-guardrail needed on the ` +
        `automatic desperation path)`;
    } else if (capabilityGuard.refuse) {
      writeStderr(`create-agent-legacy: ${capabilityGuard.reason}\n`);
      return { ok: false, code: 1 };
    } else {
      capabilityOverrideNote = capabilityGuard.overrideNote ?? "";
    }
  }
  if (
    !request.resuming &&
    !explicitDeepSeekAdmission &&
    !explicitModelBypassAuthorized &&
    stagerRouteAuthorization === undefined &&
    planRole !== undefined &&
    allowedPairs !== undefined
  ) {
    const finalPolicyPair = { harness: launchHarness, model: launchModel };
    const refusal = planRolePoolRefusal({
      preset: activePreset,
      role: planRole,
      name: request.name,
      pair: finalPolicyPair,
      pool: allowedPairs,
      phase: "resolved final",
      poolSource: allowlistPoolSource,
    });
    if (refusal !== undefined) {
      writeStderr(`create-agent-legacy: ${refusal}\n`);
      return { ok: false, code: 1 };
    }
  }
  const quotaGate = await finalQuotaGate({
    name: request.name,
    resuming: request.resuming,
    harness: launchHarness,
    model: launchModel,
    bypassZeroQuota: request.flags["bypass-zero-quota"] === true,
    readClaude: deps.nativeClaudeUsageReader ?? readers.claude,
    readCodex: readers.codex,
  });
  if (quotaGate.message !== undefined) writeStderr(quotaGate.message);
  if (quotaGate.refuse) return { ok: false, code: 1 };
  if (quotaGate.overrideApplied)
    zeroQuotaOverrideNote =
      "--bypass-zero-quota admitted a fresh trustworthy exact-zero final target";
  if (zeroQuotaOverrideNote !== "") {
    routingNote = [routingNote, zeroQuotaOverrideNote]
      .filter(Boolean)
      .join("; ");
    durableRoutingNote = true;
  }
  if (allowlistRoutingNote !== "") {
    routingNote = [routingNote, allowlistRoutingNote]
      .filter(Boolean)
      .join("; ");
    durableRoutingNote = true;
  }
  if (stagerRouteAuthorization !== undefined) {
    routingNote = [
      routingNote,
      `Lord-authorized Stager route ${stagerRouteAuthorization.harness}/${stagerRouteAuthorization.model} for ${stagerRouteAuthorization.recipient} (${stagerRouteAuthorization.evidence_locator}); fixed default Stager pool remains unchanged`,
    ]
      .filter(Boolean)
      .join("; ");
    durableRoutingNote = true;
  }
  return {
    ok: true,
    value: {
      ...request,
      objectiveContract,
      launchHarness,
      launchModel,
      launchEffort,
      routingNote,
      durableRoutingNote,
      capabilityEvidence,
      capabilityOverrideNote,
      effortOverrideNote,
      harnessOverrideNote,
      usageBypassAuthorization,
      modelBypassAuthorization,
      stagerRouteAuthorization,
      bypassedObjectiveCode,
    },
  };
}
