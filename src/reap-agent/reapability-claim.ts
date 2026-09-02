import type { HerdrAgent } from "../herdr/herdr-inventory.service.ts";
import type { SpawnSpec } from "../agentdata/spawn-data-contracts.ts";
import {
  findLatestQualifyingReapabilityClaim,
  lastMessageBlock,
  readReapabilityClaimStatus,
  type ReapabilityClaimStatus,
} from "../no-idling/idle-pane-tag-classification.ts";
import { errorText } from "../shared-policy/error-text.ts";
import { isTerminalDeliveryShadowName } from "../merge-git-tree/terminal-gate-shadow.ts";
import { BYPASS_MARKER_FLAG, FORCE_FLAG } from "./input.ts";
import type { ReapDeps, ReapRequest } from "./reap-agent.types.ts";

const REAPABILITY_CLAIM_READ_LINES = 300;

export function formatReapabilityClaim(status: ReapabilityClaimStatus): string {
  return JSON.stringify({ reapable: status });
}

export interface VerdictOnlyCompletionProofDeps {
  readAgent?: ReapDeps["readAgent"];
  readSpawnSpec?: (name: string) => Promise<SpawnSpec | null>;
}

export async function hasDurableVerdictOnlyShape(
  name: string,
  deps: VerdictOnlyCompletionProofDeps,
): Promise<boolean> {
  if (deps.readSpawnSpec === undefined) return false;
  try {
    return (
      (await deps.readSpawnSpec(name))?.deliverable_shape === "verdict-only"
    );
  } catch {
    return false;
  }
}

/** Deliberate trade-off: for this agent class there is no artifact anywhere
 *  proving the work happened — no `REPORT.md`, no delivery commit. Proof
 *  rests entirely on the durable spawn-time `deliverable_shape` record plus
 *  the agent's own live reapability claim. This is intentional, not a gap:
 *  a verdict-only agent's deliverable is a verdict, not a diff, so it
 *  produces no artifact by definition and none can be required of it. */
export async function isCompletionProvenVerdictOnlyAgent(
  name: string,
  liveStatus: HerdrAgent["agentStatus"] | undefined,
  deps: VerdictOnlyCompletionProofDeps,
): Promise<boolean> {
  if (
    liveStatus === "working" ||
    deps.readAgent === undefined ||
    deps.readSpawnSpec === undefined
  ) {
    return false;
  }
  try {
    const [verdictOnlyShape, output] = await Promise.all([
      hasDurableVerdictOnlyShape(name, deps),
      deps.readAgent(name, {
        source: "recent",
        lines: REAPABILITY_CLAIM_READ_LINES,
      }),
    ]);
    return (
      verdictOnlyShape &&
      readReapabilityClaimStatus(lastMessageBlock(output)) === "completed"
    );
  } catch {
    return false;
  }
}

/** Widens `verdictOnlyTeardownProven` for the branch-cleanup retention check
 *  only (`preflightBranchCleanup`'s `allowUnadvancedBranch`), never as proof
 *  that the agent is FINISHED -- that is the reapability claim's job and
 *  nothing else's. A terminal-delivery Shadow's own branch never
 *  advances by design (its content lands via `merge-git-tree`), and a
 *  durably verdict-only agent's deliverable is a verdict, not a diff — both
 *  are the same exemptions `checkOwnWorktreeCommittedPrecondition` already
 *  grants for the dirty-tree check. */
export async function allowsUnadvancedBranchTeardown(
  name: string,
  verdictOnlyTeardownProven: boolean,
  deps: VerdictOnlyCompletionProofDeps,
): Promise<boolean> {
  return (
    verdictOnlyTeardownProven ||
    isTerminalDeliveryShadowName(name) ||
    (await hasDurableVerdictOnlyShape(name, deps))
  );
}

export async function requireLiveReapabilityClaim(
  request: ReapRequest,
  live: HerdrAgent | undefined,
  deps: ReapDeps,
): Promise<boolean> {
  if (live === undefined || request.bypassMarker === true) {
    return true;
  }
  // NO ARTIFACT SHORTCUTS (Lord, 2026-08-21: "the only rule we need is
  // {"reapable":"completed"}"). A proven delivery ancestry and a landed
  // REPORT.md used to admit a live agent here without it ever saying it was
  // done. Both are gone: an artifact proves that work happened, never that
  // the agent is finished with it, and conflating the two is what made
  // --force routine. A healthy delivery gate matched none of the artifact
  // shapes and got forced, while a wedged agent that happened to have a
  // REPORT.md sailed through -- the guard stopped the healthy and passed
  // the broken. `--bypass-marker` remains the one deliberate human override.
  try {
    const output = await deps.readAgent?.(request.name, {
      source: "recent",
      lines: REAPABILITY_CLAIM_READ_LINES,
    });
    const claim =
      output === undefined ? undefined : findLatestQualifyingReapabilityClaim(output);
    if (claim !== undefined && claim !== "fail") {
      return true;
    }
  } catch (error) {
    process.stderr.write(
      `reap-agent: could not read the latest message from "${request.name}" ` +
        `(${errorText(error)}).\n`,
    );
  }
  process.stderr.write(
    `reap-agent: refusing to reap live agent "${request.name}" because none ` +
      `of its recent messages carry a still-valid qualifying JSON reapability ` +
      `claim. Message the agent and ask whether it is reapable or merely ` +
      `idle, then retry after it publishes ${formatReapabilityClaim("completed")}; ` +
      `use ${BYPASS_MARKER_FLAG} only to override this claim check. ${FORCE_FLAG} ` +
      `alone does not bypass it.\n`,
  );
  return false;
}
