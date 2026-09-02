import { resolveSpawnAdmission } from "../harness-routing/policy/admission.ts";
import {
  describeUnusableHarnessUsage,
  isHarnessUsageUsable,
} from "../harness-routing/policy/usage.ts";
import { resolveFreshEffort } from "../harness-routing/policy/steering.ts";
import {
  activePlanPresetName,
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
import { buildOpenCodeGoCanaryUsage, usageReaders } from "./policy-usage.ts";
import { finalQuotaGate } from "./native-availability.ts";
import {
  deepSeekTelemetryOverride,
  isExplicitDeepSeekAdmission,
  resolveExplicitDeepSeekCanaryEffort,
} from "./deepseek-canary.ts";
import { authorizeUsageBypass } from "./usage-bypass-authorization.ts";
import { authorizeModelBypass } from "./model-bypass-authorization.ts";
import {
  MODEL_ALLOWLIST_FILE_NAME,
  modelAllowlistOwner,
} from "./model-allowlist.ts";
import { RUNTIME_DATA_DIR } from "../shared-policy/runtime-data-home.ts";
import path from "node:path";
import {
  resolveObjectiveCodeQueueGate,
  resolveObjectiveContract,
} from "./policy-objective.ts";
import { resolveStagerRouteAuthorization } from "./stager-route-authorization.ts";
import { resolveLaneEvidenceStage } from "./lane-inheritance.ts";
import { laneGateRefusal } from "./lane-gate.ts";
import { parseQueueModelHint } from "../regent-queue/model-hint.ts";

export async function resolveSpawnPolicy(
  request: RegistrationResolution,
  deps: CreateAgentDeps,
): Promise<StageResult<PolicyResolution>> {
  const writeStderr = stderrWriter(deps);
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
      `create-agent: refusing --empty-worktree for "${request.name}" — it requires a campaign Alpha or Shadow objective and cannot be used as the non-campaign or mutation exemption. Nothing was registered or launched.\n`,
    );
    return { ok: false, code: 1 };
  }
  const campaignObjectiveCode =
    objectiveContract?.kind === "campaign"
      ? objectiveContract.objectiveCode
      : undefined;
  let requestedPair: ModelPair = {
    harness: request.harness,
    model: request.model,
  };
  let modelHint: ModelPair | undefined;
  try {
    modelHint = parseQueueModelHint(request.flags["model-hint"]);
  } catch (error) {
    writeStderr(`create-agent: ${error instanceof Error ? error.message : String(error)}. Nothing was registered or launched.\n`);
    return { ok: false, code: 1 };
  }
  if (
    modelHint === undefined &&
    objectiveContract?.kind === "campaign" &&
    request.role.trim().toLowerCase() === "shadow"
  ) {
    const supervisor = await deps.readSpawnSpec(request.flags.supervisor as string);
    if (supervisor?.model_hint !== undefined) modelHint = supervisor.model_hint;
  }
  if (
    modelHint !== undefined &&
    (modelHint.harness !== requestedPair.harness ||
      modelHint.model !== requestedPair.model)
  ) {
    writeStderr(
      `create-agent: refusing "${request.name}" — explicit --model ${requestedPair.model} ` +
        `does not match human queue model hint ${modelHint.harness}/${modelHint.model}. ` +
        "Pass the hinted model through --model or omit the hint; create-agent never substitutes an explicit --model. Nothing was registered or launched.\n",
    );
    return { ok: false, code: 1 };
  }
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
  const laneEvidenceResult = await resolveLaneEvidenceStage(
    request,
    deps,
    objectiveContract,
    explicitModelBypassAuthorized,
  );
  if (!laneEvidenceResult.ok) return laneEvidenceResult;
  const laneEvidence = laneEvidenceResult.value;
  const activePreset = deps.planPresetName ?? activePlanPresetName();
  const planRole = request.resuming
    ? undefined
    : classifyPlanRole(request.role, request.name, campaignObjectiveCode);
  let allowedPairs =
    planRole === undefined ? undefined : planRolePool(planRole, activePreset);
  let allowlistRoutingNote = "";
  let allowlistPoolSource: { label: string; hint: string } | undefined;
  let ownerAllowlist: ModelPairPool | undefined;
  if (planRole !== undefined) {
    const allowlistOwnerName = modelAllowlistOwner({
      role: request.role,
      name: request.name,
      supervisor: request.flags.supervisor as string | undefined,
      objectiveContract,
    });
    if (allowlistOwnerName !== undefined) {
      ownerAllowlist = await deps.readModelAllowlist?.(allowlistOwnerName);
      if (ownerAllowlist !== undefined && ownerAllowlist.length > 0) {
        allowedPairs = ownerAllowlist;
        allowlistRoutingNote =
          `${allowlistOwnerName}-owned ${MODEL_ALLOWLIST_FILE_NAME} overrode ` +
          `the ${activePreset}/${planRole} role pool for this spawn`;
        allowlistPoolSource = {
          label: `campaign model allowlist for "${allowlistOwnerName}"`,
          hint: path.join(
            RUNTIME_DATA_DIR,
            allowlistOwnerName,
            MODEL_ALLOWLIST_FILE_NAME,
          ),
        };
      }
    }
  }
  if (!request.resuming) {
    if (ownerAllowlist !== undefined) {
      const ownerAdmission = resolveSpawnAdmission({
        requested: requestedPair,
        planRole,
        preset: activePreset,
        name: request.name,
        allowedPairs: ownerAllowlist,
        enforceRolePool: true,
        poolSource: allowlistPoolSource,
        ownerAllowlist: true,
      });
      if (ownerAdmission.kind === "refuse") {
        writeStderr(
          `create-agent: refusing new ${request.harness}/${request.model} registration for "${request.name}" — ` +
            `${ownerAdmission.reason} Nothing was registered or launched.\n`,
        );
        return { ok: false, code: 1 };
      }
      requestedPair = ownerAdmission.pair;
    }
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
      writeStderr(
        `create-agent: refusing new ${request.harness}/${request.model} registration for "${request.name}" — ` +
          `${admission.reason} Nothing was registered or launched.\n`,
      );
      return { ok: false, code: 1 };
    }
    requestedPair = admission.pair;
    if (planRole !== undefined) {
      const laneRefusal = laneGateRefusal({
        role: planRole,
        name: request.name,
        pair: requestedPair,
        laneEvidence,
      });
      if (laneRefusal !== undefined) {
        writeStderr(`create-agent: ${laneRefusal}\n`);
        return { ok: false, code: 1 };
      }
    }
  }
  let launchHarness = request.launchHarness;
  let launchModel = request.launchModel;
  let launchEffort = request.launchEffort;
  let routingNote = "";
  let durableRoutingNote = false;
  if (modelHint !== undefined) {
    routingNote = `human queue model hint ${modelHint.harness}/${modelHint.model}`;
    durableRoutingNote = true;
  }
  let effortOverrideNote = "";
  let harnessOverrideNote = "";
  let zeroQuotaOverrideNote = "";
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
          `create-agent: refusing explicit DeepSeek admission ` +
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
        `create-agent: refusing new ${request.harness}/${request.model} agent "${request.name}" — ` +
          `${effortSteer.message}. Nothing was registered, trusted, routed, ` +
          `or launched.\n`,
      );
      return { ok: false, code: 1 };
    }
    launchHarness = requestedPair.harness;
    launchModel = requestedPair.model;
    launchEffort = effortSteer.effort;
    effortOverrideNote = effortSteer.overrideNote ?? "";
  }
  if (launchEffort === undefined) {
    writeStderr(
      `create-agent: internal error — a launch effort could not be resolved for ` +
        `${request.harness}/${request.model}. Nothing was registered, trusted, routed, or ` +
        `launched.\n`,
    );
    return { ok: false, code: 1 };
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
      capabilityOverrideNote: "",
      effortOverrideNote,
      harnessOverrideNote,
      usageBypassAuthorization,
      modelBypassAuthorization,
      stagerRouteAuthorization,
      bypassedObjectiveCode,
      laneEvidence,
      modelHint,
    },
  };
}
