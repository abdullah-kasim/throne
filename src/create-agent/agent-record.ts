import {
  composeCodexOpeningPrompt,
  composeOpeningPrompt,
  readOpeningPrompt,
  type AgentIdentity,
} from "../agentdata/identity-data.service.ts";
import { HARNESS_NAMES } from "../harness-routing/harness.ts";
import { type CreateAgentDeps, type PolicyResolution } from "./create.types.ts";
import { currentIsoTime, stderrWriter } from "./command-context.ts";
import { appendLaunchLedgerEntry as appendLaunchLedgerEntryDefault } from "../alpha-launch-queue/launch-ledger.ts";
import { DEFAULT_LAUNCH_LEDGER_PATH } from "../alpha-launch-queue/paths.ts";
import { TREE_BASE_DATA } from "../agentdata/tree-base-data.service.ts";
import type { MemoryResolution } from "../memory-dir/memory-dir-resolver.ts";
import { composeSituationBriefForObjective } from "../situation-brief/situation-brief-runtime.ts";
import { SITUATION_BRIEF_HEADING } from "../situation-brief/situation-brief-composer.ts";
import { readForkBriefFile, type ReadForkBrief } from "./fork-origin.ts";

export interface AgentOpeningPrompts {
  complete: string;
  delivered: string;
}

export function createAgentIdentity(
  request: PolicyResolution,
  defaultEscalation: string,
  spawnedTabLabel?: string,
  memory?: MemoryResolution,
): AgentIdentity {
  const policyOverride = [
    request.capabilityOverrideNote,
    request.effortOverrideNote,
    request.harnessOverrideNote,
  ]
    .filter(Boolean)
    .join("; ");
  return {
    supervisor: request.flags.supervisor as string,
    escalation: request.flags.escalation ?? defaultEscalation,
    role: request.role,
    ...(request.objectiveContract?.kind === "campaign"
      ? { objectiveCode: request.objectiveContract.objectiveCode }
      : request.objectiveContract?.kind === "non-campaign"
        ? { nonCampaign: true as const }
        : {}),
    ...(policyOverride === "" ? {} : { policyOverride }),
    ...(request.emptyWorktree ? { emptyWorktree: true as const } : {}),
    ...(request.shadowless === true ? { shadowless: true as const } : {}),
    ...(request.sliceless === true ? { sliceless: true as const } : {}),
    ...(request.forkedFrom === undefined ? {} : { forkedFrom: request.forkedFrom }),
    ...(spawnedTabLabel === undefined ? {} : { spawnedTabLabel }),
    ...(memory === undefined ? {} : { memory }),
  };
}

export type SituationBriefComposer = (objectiveCode: string) => Promise<string>;

function queuedObjectiveOfFreshAlpha(request: PolicyResolution): string | undefined {
  if (request.resuming || request.role.trim().toLowerCase() !== "alpha") return undefined;
  return request.objectiveContract?.kind === "campaign"
    ? request.objectiveContract.objectiveCode
    : undefined;
}

async function situationBriefOrNotice(
  objectiveCode: string,
  composeBrief: SituationBriefComposer,
): Promise<string> {
  try {
    return await composeBrief(objectiveCode);
  } catch (error) {
    return (
      `${SITUATION_BRIEF_HEADING}\n\nUnavailable at launch (${error instanceof Error ? error.message : String(error)}). ` +
      `Run \`throne situation-brief --objective-code ${objectiveCode}\` yourself before you plan.`
    );
  }
}

async function promptWithSituationBrief(
  request: PolicyResolution,
  composeBrief: SituationBriefComposer,
): Promise<string | undefined> {
  const objectiveCode = queuedObjectiveOfFreshAlpha(request);
  if (objectiveCode === undefined) return request.flags.prompt;
  const brief = await situationBriefOrNotice(objectiveCode, composeBrief);
  const prompt = request.flags.prompt ?? "";
  return prompt === "" ? brief : `${prompt}\n\n${brief}`;
}

async function promptWithForkBrief(
  request: PolicyResolution,
  readBrief: ReadForkBrief,
): Promise<string | undefined> {
  if (request.forkedFrom === undefined) return undefined;
  const brief = await readBrief(request.name);
  if (brief === undefined) return undefined;
  const prompt = request.flags.prompt ?? "";
  return prompt === "" ? brief : `${prompt}\n\n${brief}`;
}

export async function createAgentOpeningPrompts(
  request: PolicyResolution,
  identity: AgentIdentity,
  composeBrief: SituationBriefComposer = composeSituationBriefForObjective,
  readBrief: ReadForkBrief = readForkBriefFile,
): Promise<AgentOpeningPrompts> {
  const complete = composeOpeningPrompt(
    request.name,
    identity,
    (await promptWithForkBrief(request, readBrief)) ??
      (await promptWithSituationBrief(request, composeBrief)),
  );
  const hasDurableOpeningPrompt =
    !request.resuming || (await readOpeningPrompt(request.name)) !== null;
  const delivered =
    request.launchHarness === HARNESS_NAMES.CODEX &&
    request.customExecutable === undefined &&
    hasDurableOpeningPrompt
      ? composeCodexOpeningPrompt(request.name)
      : complete;
  return { complete, delivered };
}

/**
 * Appends the durable launch-ledger entry for a fresh campaign Alpha or
 * Shadow, as part of the launch act itself — the ledger's own contract
 * requires this, not a separate bookkeeping step a caller could forget.
 * Non-campaign spawns and ad-hoc roles (Regent infra, review-loop's Fable
 * reviewer) never carry an objective code and are not ledgered; there is
 * nothing for the ledger's duplicate-launch question to answer for them.
 */
async function recordCampaignLaunch(
  request: PolicyResolution,
  deps: CreateAgentDeps,
): Promise<void> {
  if (request.objectiveContract?.kind !== "campaign") return;
  const readTreeBase =
    deps.readTreeBase ?? TREE_BASE_DATA.read.bind(TREE_BASE_DATA);
  const tree = await readTreeBase(request.name);
  if (tree === null || typeof tree.repo !== "string" || tree.repo === "")
    return;
  const appendEntry =
    deps.appendLaunchLedgerEntry ?? appendLaunchLedgerEntryDefault;
  await appendEntry(deps.launchLedgerPath ?? DEFAULT_LAUNCH_LEDGER_PATH, {
    name: request.name,
    objectiveCode: request.objectiveContract.objectiveCode,
    targetRepo: tree.repo,
    targetBranch: tree.branch,
    baseCommit: tree.commit,
    spawnedAt: currentIsoTime(deps),
    ...(request.bypassedObjectiveCode
      ? { bypassedObjectiveCode: true as const }
      : {}),
  });
}

export async function persistNewAgentRecord(
  request: PolicyResolution,
  deps: CreateAgentDeps,
  identity: AgentIdentity,
  completeOpeningPrompt: string,
): Promise<boolean> {
  if (request.resuming) {
    return true;
  }
  try {
    await deps.writeIdentity(request.name, identity);
    await deps.writeOpeningPrompt(request.name, completeOpeningPrompt);
    await deps.writeSpawnSpec(request.name, {
      harness: request.launchHarness,
      model: request.launchModel,
      ...(request.modelHint === undefined ? {} : { model_hint: request.modelHint }),
      effort: request.launchEffort,
      cwd: request.cwd,
      spawned_at: currentIsoTime(deps),
      ...(request.customExecutable === undefined
        ? {}
        : {
            harness_executable: request.customExecutable,
            passthrough_argv: request.customPassthrough,
          }),
      ...(!request.durableRoutingNote
        ? {}
        : { routing_note: request.routingNote }),
      ...(request.capabilityEvidence === undefined
        ? {}
        : { capability: request.capabilityEvidence }),
      ...(request.usageBypassAuthorization === undefined
        ? {}
        : {
            usage_bypass_authorization: request.usageBypassAuthorization,
          }),
      ...(request.stagerRouteAuthorization === undefined
        ? {}
        : { stager_route_authorization: request.stagerRouteAuthorization }),
      ...(request.objectiveContract?.kind === "campaign"
        ? { objective_code: request.objectiveContract.objectiveCode }
        : request.objectiveContract?.kind === "non-campaign"
          ? { non_campaign: true as const }
          : {}),
      ...(request.emptyWorktree ? { empty_worktree: true as const } : {}),
      ...(request.deliverableShape === undefined
        ? {}
        : { deliverable_shape: request.deliverableShape }),
      ...(request.shadowless === true ? { shadowless: true as const } : {}),
      ...(request.sliceless === true ? { sliceless: true as const } : {}),
      ...(request.forkedFrom === undefined
        ? {}
        : { forked_from: request.forkedFrom }),
      ...(request.laneEvidence === undefined
        ? {}
        : "lane" in request.laneEvidence
            ? { token_balance_lane: request.laneEvidence.lane }
            : { token_balance_mandate: true as const }),
      // Only Alpha/Shadow ever require a follow-up `send-agent` task —
      // one-shot custom-harness spawns carry their own task on the launch
      // command line and never reach this resident path; ad-hoc `Agent`
      // roles (e.g. review-loop's Fable reviewer) are outside the
      // create-agent -> send-agent handoff this field tracks. `null` marks
      // "registered, not yet tasked" so `find-untasked-agents` can flag it;
      // `send-agent`'s `markAgentTasked` fills in the instant it is tasked.
      ...(identity.role === "Alpha" || identity.role === "Shadow"
        ? { tasked_at: null }
        : {}),
    });
    await deps.writeModelAllowlist({
      role: request.role,
      name: request.name,
      supervisor: request.flags.supervisor as string | undefined,
      objectiveContract: request.objectiveContract,
      preset: deps.planPresetName,
      ...(request.modelHint === undefined ? {} : { modelHint: request.modelHint }),
    });
    await recordCampaignLaunch(request, deps);
  } catch (error) {
    await deps.removeRegistration(request.name).catch(() => undefined);
    stderrWriter(deps)(
      `create-agent: could not register "${request.name}" before launch ` +
        `(${error instanceof Error ? error.message : String(error)}); nothing was spawned\n`,
    );
    return false;
  }
  await deps.afterRegistration?.();
  return true;
}
