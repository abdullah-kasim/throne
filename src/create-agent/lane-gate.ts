import {
  modelPairInPool,
  planRolePool,
  type ModelPair,
  type PlanRole,
} from "../config.ts";
import type { LaneEvidence } from "./create.types.ts";

/**
 * Refuses a balanced-role (Alpha/Shadow/ShadowSlice99) spawn whose final
 * harness/model pair falls outside its recorded lane evidence's pool.
 * `laneEvidence` is `undefined` when the spawn was never lane-gated (kill
 * switch off, operator setting off, blocked verdict, non-balanced role, or a
 * resume) — always a pass-through. A recorded `{mandate: true}` — an
 * explicit per-campaign model mandate — always wins over the lane and is
 * never refused here; this is a distinct bypass from `--bypass-model`/
 * `--bypass-preset-agent`, which this gate does not consult.
 */
export function laneGateRefusal(opts: {
  role: PlanRole;
  name: string;
  pair: ModelPair;
  laneEvidence: LaneEvidence | undefined;
}): string | undefined {
  if (opts.laneEvidence === undefined) return undefined;
  if ("mandate" in opts.laneEvidence) return undefined;
  const lanePool = planRolePool(opts.role, opts.laneEvidence.lane);
  if (modelPairInPool(lanePool, opts.pair)) return undefined;
  const allowed = lanePool
    .map(({ harness, model }) => `${harness}/${model}`)
    .join(", ");
  return (
    `the token-lane balancer routes ${opts.role} agent "${opts.name}" to the ` +
    `${opts.laneEvidence.lane} lane; ${opts.pair.harness}/${opts.pair.model} ` +
    `is outside it. That lane's allowed pool is: ${allowed || "(empty)"}. ` +
    `The requested pair will not be silently substituted. To use this pair ` +
    `anyway, record an explicit per-campaign model mandate for this campaign ` +
    `— that bypasses the lane gate entirely, distinct from --bypass-model. ` +
    `Nothing was registered or launched.`
  );
}
