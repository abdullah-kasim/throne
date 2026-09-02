import { isTokenBalanceKillSwitchOn } from "../token-balance/token-balance-kill-switch.ts";
import type { LaneBalanceVerdict } from "../token-balance/token-balance-report.ts";
import type { ObjectiveContract } from "../shared-policy/objective-contract.ts";
import type { SpawnSpec } from "../agentdata/spawn-data-contracts.ts";
import type {
  CreateAgentDeps,
  LaneEvidence,
  RegistrationResolution,
  StageResult,
} from "./create.types.ts";
import { stderrWriter } from "./command-context.ts";

/**
 * Decides what lane evidence (if any) a fresh Alpha campaign spawn records.
 * An explicit per-campaign model mandate always wins and is recorded in
 * place of a lane. Otherwise a lane is recorded only when both the kill
 * switch and the operator setting are on and the balancer produced an
 * unblocked verdict — a blocked verdict, an unavailable verdict, or either
 * gate off all reproduce today's unbalanced behavior exactly: no lane
 * evidence recorded. This function does not refuse the spawn on a blocked
 * verdict; that gating belongs to the entrance-refusal consumer, not to
 * recording.
 */
export function resolveAlphaLaneEvidence(opts: {
  role: string;
  objectiveContract: ObjectiveContract | undefined;
  explicitModelMandate: boolean;
  killSwitchOn: boolean;
  operatorEnabled: boolean;
  verdict: LaneBalanceVerdict | undefined;
}): LaneEvidence | undefined {
  if (opts.role.trim().toLowerCase() !== "alpha") return undefined;
  if (opts.objectiveContract?.kind !== "campaign") return undefined;
  if (opts.explicitModelMandate) return { mandate: true };
  if (!opts.killSwitchOn || !opts.operatorEnabled) return undefined;
  if (opts.verdict === undefined || opts.verdict.blocked) return undefined;
  return { lane: opts.verdict.chosenLane };
}

/**
 * Extracts lane evidence already recorded on a supervising Alpha's
 * `spawn.json`, verbatim — the one place a descendant Shadow/ShadowSlice99
 * reads it from. Absence of both fields is not an error: it means the
 * Alpha's campaign was never lane-gated.
 */
export function laneEvidenceFromAlphaSpawnSpec(
  spec: SpawnSpec,
): LaneEvidence | undefined {
  if (spec.token_balance_mandate === true) return { mandate: true };
  if (typeof spec.token_balance_lane === "string") {
    return { lane: spec.token_balance_lane };
  }
  return undefined;
}

/**
 * Resolves the lane evidence a fresh Shadow (including ShadowSlice99)
 * campaign spawn inherits: read verbatim from the supervising Alpha's
 * `spawn.json`, never re-derived — mirrors
 * `objectiveContractFromAlphaEvidence`'s "read supervisor evidence, refuse
 * on missing/unreadable evidence" shape. A non-campaign or non-Shadow spawn
 * never reaches this decision.
 */
export function descendantLaneEvidence(opts: {
  role: string;
  objectiveContract: ObjectiveContract | undefined;
  supervisorName: string;
  supervisorSpec: SpawnSpec | null;
}): { ok: true; value: LaneEvidence | undefined } | { ok: false; reason: string } {
  if (opts.role.trim().toLowerCase() !== "shadow") return { ok: true, value: undefined };
  if (opts.objectiveContract?.kind !== "campaign") return { ok: true, value: undefined };
  if (opts.supervisorSpec === null) {
    return {
      ok: false,
      reason:
        `supervising Alpha "${opts.supervisorName}" has no readable spawn ` +
        "evidence for lane inheritance",
    };
  }
  return { ok: true, value: laneEvidenceFromAlphaSpawnSpec(opts.supervisorSpec) };
}

/**
 * Full stage entry point for `resolveSpawnPolicy`: resolves lane evidence
 * for a fresh balanced-role (Alpha or Shadow) spawn and returns the
 * standard refusal shape on missing supervisor evidence. Resumes and
 * non-campaign/non-balanced roles always pass through with no lane
 * evidence — lane balancing never touches them.
 *
 * The verdict and the durable operator-disable setting are both read
 * through injectable `deps` hooks (`deps.resolveTokenBalanceVerdict`,
 * `deps.isTokenBalanceOperatorEnabled`), which in production read
 * `usage-log.jsonl` into a `LaneBalanceVerdict` and resolve the durable
 * operator setting that can disable lane balancing entirely. Injecting
 * them keeps this stage testable without touching the real usage log or
 * config file.
 */
export async function resolveLaneEvidenceStage(
  request: RegistrationResolution,
  deps: CreateAgentDeps,
  objectiveContract: ObjectiveContract | undefined,
  explicitModelMandate: boolean,
): Promise<StageResult<LaneEvidence | undefined>> {
  if (request.resuming) return { ok: true, value: undefined };
  const normalizedRole = request.role.trim().toLowerCase();
  if (normalizedRole === "alpha") {
    return {
      ok: true,
      value: resolveAlphaLaneEvidence({
        role: request.role,
        objectiveContract,
        explicitModelMandate,
        killSwitchOn: isTokenBalanceKillSwitchOn(),
        operatorEnabled: deps.isTokenBalanceOperatorEnabled?.() ?? false,
        verdict: deps.resolveTokenBalanceVerdict?.(),
      }),
    };
  }
  if (normalizedRole !== "shadow" || objectiveContract?.kind !== "campaign") {
    return { ok: true, value: undefined };
  }
  const supervisorName = request.flags.supervisor as string;
  const supervisorSpec = await deps.readSpawnSpec(supervisorName);
  const resolution = descendantLaneEvidence({
    role: request.role,
    objectiveContract,
    supervisorName,
    supervisorSpec,
  });
  if (resolution.ok) return { ok: true, value: resolution.value };
  stderrWriter(deps)(
    `create-agent: refusing lane inheritance for "${request.name}" — ` +
      `${resolution.reason}. Nothing was registered or launched.\n`,
  );
  return { ok: false, code: 1 };
}
