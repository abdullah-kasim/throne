import { REAP_REASON } from "../agent-timings/reap-reason.ts";
import { sameAgentName } from "../herdr/herdr-identity-contracts.ts";
import type { HerdrAgent } from "../herdr/herdr-inventory.service.ts";
import { REGENT_NAME } from "../regent-state/regent-state.service.ts";
import {
  describeUnmetEvidenceForceSkip,
  describeUnmetEvidenceRefusal,
} from "../slice-evidence/agent-evidence-gate.ts";
import { errorText } from "../shared-policy/error-text.ts";
import {
  discoverChildAgents,
  refuseForLiveChildren,
  writeNonLiveChildren,
  type ChildAgents,
} from "./children.ts";
import { FORCE_FLAG } from "./input.ts";
import type { ReapDeps, ReapRequest } from "./reap-agent.types.ts";
import { refuseForOccupiedTree } from "./occupancy.ts";
import { verifyNoStrandedTree } from "./strand.ts";
import { executeTeardown } from "./teardown.ts";
import {
  appendLaunchLedgerStatus,
  type LaunchTerminalStatus,
} from "../alpha-launch-queue/launch-ledger.ts";
import { DEFAULT_LAUNCH_LEDGER_PATH } from "../alpha-launch-queue/paths.ts";
import { checkDeliveryVerdict } from "../verify-delivery/verify-delivery-runtime.ts";
import {
  allowsUnadvancedBranchTeardown,
  isCompletionProvenVerdictOnlyAgent,
  requireLiveReapabilityClaim,
} from "./reapability-claim.ts";
import {
  readQueueLinkage,
  resolveQueueReapDeliveryCommit,
} from "./queue-reap-writeback.ts";

/** Applies the same stated-evidence gate `complete-agent` applies, scoped to
 *  `--reason completed` — the case where a completion claim can carry an
 *  unmet evidence requirement. `--force` still tears the agent down, but
 *  never silently: it prints a loud, named-missing-evidence warning instead
 *  of the refusal a plain reap would show. Returns true when the caller
 *  must refuse (unmet requirement, no `--force`). */
async function refuseOrWarnForUnmetEvidence(
  request: ReapRequest,
  deps: ReapDeps,
): Promise<boolean> {
  if (request.reason !== REAP_REASON.COMPLETED) {
    return false;
  }
  const result = await deps.checkEvidenceRequirement?.(request.name);
  if (result === undefined || result.ok) {
    return false;
  }
  if (request.force) {
    process.stderr.write(
      `reap-agent: ${describeUnmetEvidenceForceSkip(request.name, result)}\n`,
    );
    return false;
  }
  process.stderr.write(
    `reap-agent: ${describeUnmetEvidenceRefusal(request.name, result)}\n`,
  );
  return true;
}

function sameLiveIdentity(agent: HerdrAgent, requestedName: string): boolean {
  const label = agent.tabLabel?.trim().toLowerCase();
  return (
    label === requestedName.trim().toLowerCase() ||
    (label === undefined && sameAgentName(agent.name, requestedName))
  );
}

function agentIdentityKey(agent: HerdrAgent): string | undefined {
  return agent.tabLabel?.trim().toLowerCase() ?? agent.name ?? agent.paneId;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const LIVENESS_CONFIRM_SAMPLES = 2;
const LIVENESS_CONFIRM_INTERVAL_MS = 2_000;
/**
 * A single herdr snapshot can transiently miss a genuinely live agent — the
 * same flake `no-idling`'s confirmed-observation tracker
 * (`idle-family.ts`'s `confirmedNoLiveChildrenAlphaNames`, guarding
 * `alpha-nid-no-indeterminate`/`alpha-lnb-lane-budget`'s false "fully idle"
 * reports) and `throne-startup-reconciliation.service.ts`'s
 * `confirmGenuinelyAbsent` already resample against for their own reads.
 * `reapAgent`'s "is this name live" / "does it have live children" reads had
 * no equivalent confirmation: one missed sample was enough to let both
 * `refuseUnprovenLiveAgent` and `refuseForLiveChildren` skip straight past a
 * genuinely working Alpha and its live 99e child, running `executeTeardown`
 * (tab close, worktree removal) against it — ALPHADEATH's DEAD half. Union a
 * couple of quick resamples instead of trusting the first: any ONE sample
 * catching an agent live is enough to keep it counted as live for this
 * decision; a name that is genuinely gone stays gone across every sample.
 * Never called under `--force`, which already means "cascade past whatever
 * is live" — `cascadeLiveChildren` handles that path explicitly.
 */
async function confirmedAgents(
  initial: HerdrAgent[],
  deps: ReapDeps,
): Promise<HerdrAgent[]> {
  const union = new Map<string, HerdrAgent>();
  for (const agent of initial) {
    const key = agentIdentityKey(agent);
    if (key !== undefined) union.set(key, agent);
  }
  const sleep = deps.sleep ?? defaultSleep;
  for (let sample = 1; sample < LIVENESS_CONFIRM_SAMPLES; sample++) {
    await sleep(LIVENESS_CONFIRM_INTERVAL_MS);
    let resampled: HerdrAgent[];
    try {
      resampled = await deps.listAgents();
    } catch {
      // A resample that can't reach the roster is not evidence of absence —
      // keep whatever union has already been built rather than let a
      // transient read failure masquerade as more proof of "gone".
      continue;
    }
    for (const agent of resampled) {
      const key = agentIdentityKey(agent);
      if (key !== undefined && !union.has(key)) union.set(key, agent);
    }
  }
  return [...union.values()];
}

async function readRoster(
  request: ReapRequest,
  deps: ReapDeps,
): Promise<
  | {
      status: "known";
      agents: HerdrAgent[];
      live: HerdrAgent | undefined;
    }
  | { status: "unreachable" }
  | { status: "refused" }
> {
  try {
    const agents = await deps.listAgents();
    return {
      status: "known",
      agents,
      live: agents.find((agent) => sameLiveIdentity(agent, request.name)),
    };
  } catch (error) {
    if (request.force) {
      return { status: "unreachable" };
    }
    process.stderr.write(
      `reap-agent: cannot reach the herdr roster to confirm "${request.name}" is ` +
        `not live (${errorText(error)}) — refusing without ${FORCE_FLAG}.\n`,
    );
    return { status: "refused" };
  }
}

async function readChildren(
  request: ReapRequest,
  agents: HerdrAgent[],
  deps: ReapDeps,
): Promise<ChildAgents | undefined> {
  try {
    return await discoverChildAgents(request.name, agents, deps);
  } catch (error) {
    process.stderr.write(
      `reap-agent: cannot inspect registered children of "${request.name}" ` +
        `(${errorText(error)}) — refusing teardown.\n`,
    );
    return undefined;
  }
}

async function cascadeLiveChildren(
  request: ReapRequest,
  children: ChildAgents,
  deps: ReapDeps,
  visited: Set<string>,
): Promise<boolean> {
  for (const child of children.live) {
    const childName = child.name as string;
    const childCode = await reapAgent(
      {
        name: childName,
        force: true,
        bypassMarker: request.bypassMarker,
        forceDiscardMemories: request.forceDiscardMemories,
        reason: "force",
        archiveCancelledUnmerged: false,
      },
      deps,
      visited,
    );
    if (childCode !== 0) {
      process.stderr.write(
        `reap-agent: force cascade for "${request.name}" aborted because live child ` +
          `"${childName}" failed to reap; parent "${request.name}" is untouched.\n`,
      );
      return false;
    }
  }
  return true;
}

function writeSuccessfulOutcome(
  request: ReapRequest,
  actions: string[],
  rosterKnown: boolean,
  cancelledDisposition:
    | {
        ref: string;
        tip: string;
      }
    | undefined,
): number {
  if (actions.length === 0) {
    const note = rosterKnown ? "" : " (roster unreachable)";
    process.stdout.write(
      `reap-agent: "${request.name}" is already gone — nothing to reap${note}.\n`,
    );
    return 0;
  }
  if (cancelledDisposition !== undefined) {
    // The teardown mechanism is identical whether the branch was genuinely
    // cancelled-unmerged (--reason cancelled --archive-cancelled-unmerged) or
    // whether it failed the ancestry guard on a --force reap carrying some
    // other reason (e.g. a transplant campaign whose content already landed
    // via history rewrite). Only the label may differ — the timing row
    // already records the caller's actual `request.reason` untouched.
    const label =
      request.reason === "cancelled"
        ? "CANCELLED-UNMERGED"
        : "UNMERGED-RETAINED";
    const explanation =
      request.reason === "cancelled"
        ? "The branch was not merged or deleted, and its retained ref blocks exact-name reuse.\n"
        : "The branch's commits are not reachable from the target (commonly a " +
          "history-rewrite transplant whose content already landed) so it was " +
          "retained rather than merged or deleted; its retained ref blocks " +
          "exact-name reuse.\n";
    process.stdout.write(
      `${label} "${request.name}": retained ${cancelledDisposition.ref} at ` +
        `${cancelledDisposition.tip}; ${actions.join("; ")}. ${explanation}`,
    );
    return 0;
  }
  process.stdout.write(`Reaped "${request.name}": ${actions.join("; ")}.\n`);
  return 0;
}

/**
 * Appends the launch ledger's terminal-status line for `request.name`, as
 * part of the pre-teardown path where branch and `tree-base.json` provenance
 * still exist. It reuses the same path-wise `checkDeliveryVerdict` decision as
 * queue writeback. Only an explicit error reap maps a non-delivered verdict to
 * `failed`; other reasons map it to `abandoned`. Unmatched launch-ledger names
 * remain unaffected because status rows surface only when joined to a launch.
 */
/** Resolves the launch-ledger terminal status BEFORE teardown — the
 *  delivery verdict reads `tree-base.json`, which teardown archives. */
async function resolveLaunchLedgerStatus(
  request: ReapRequest,
  deps: ReapDeps,
): Promise<LaunchTerminalStatus | undefined> {
  try {
    const verdict = await (deps.checkDeliveryVerdict ?? checkDeliveryVerdict)(
      request.name,
      undefined,
    );
    return verdict.status === "delivered"
      ? "delivered"
      : request.reason === REAP_REASON.ERROR ||
          request.reason === REAP_REASON.COMPLETED_UNPUBLISHABLE
        ? "failed"
        : "abandoned";
  } catch (error) {
    process.stderr.write(
      `reap-agent: could not resolve launch-ledger status for "${request.name}" ` +
        `(${errorText(error)}) — continuing teardown.\n`,
    );
    return undefined;
  }
}

/** Appends the launch-ledger line AFTER teardown succeeded, so the ledger
 *  never records an ending for an agent that is still alive. */
async function recordLaunchLedgerStatus(
  request: ReapRequest,
  status: LaunchTerminalStatus | undefined,
  deps: ReapDeps,
): Promise<void> {
  if (status === undefined) return;
  try {
    await (deps.appendLaunchLedgerStatus ?? appendLaunchLedgerStatus)(
      deps.launchLedgerPath ?? DEFAULT_LAUNCH_LEDGER_PATH,
      {
        name: request.name,
        status,
        endedAt: (deps.now ?? (() => new Date().toISOString()))(),
      },
    );
  } catch (error) {
    process.stderr.write(
      `reap-agent: could not record launch-ledger status for "${request.name}" ` +
        `(${errorText(error)}).\n`,
    );
  }
}

export async function reapAgent(
  request: ReapRequest,
  deps: ReapDeps,
  visited: Set<string>,
): Promise<number> {
  if (sameAgentName(request.name, REGENT_NAME)) {
    process.stderr.write(
      `reap-agent: refusing to reap the Regent — it is managed by the ` +
        `self-heal watchdog (summon/dismiss), not reaped, and data/regent/ ` +
        `holds the durable QUEUE. Use dismiss-regent to stand the court down.\n`,
    );
    return 1;
  }
  if (visited.has(request.name)) {
    process.stderr.write(
      `reap-agent: supervisor cycle detected while force-cascading through ` +
        `"${request.name}" — refusing to recurse again.\n`,
    );
    return 1;
  }
  visited.add(request.name);

  // A queue-linked agent's row moves only on `completed`, `cancelled`, or
  // `force`; `scratch` is a deliberate no-op for the row. That silent no-op is
  // how a queued Alpha got reaped as scratch and its row stayed in flight
  // forever (hiregent2, 2026-09-02). Scratch stays legal for what it is for —
  // unlinked probes and canaries — and refuses on a linked row, naming it.
  if (request.reason === REAP_REASON.SCRATCH) {
    const linkage = await (deps.readQueueLinkage ?? readQueueLinkage)(
      request.name,
    );
    if (linkage !== undefined) {
      process.stderr.write(
        `reap-agent: refusing --reason scratch for "${request.name}" — it is the ` +
          `recorded launcher of in-flight queue item "${linkage.itemId}"` +
          `${linkage.objectiveCode === null ? "" : ` (objective ${linkage.objectiveCode})`}. ` +
          `A scratch reap leaves that row in flight forever. Use --reason completed ` +
          `(closes the row), --reason cancelled (reopens it), or ${FORCE_FLAG} ` +
          `(abandons it). Nothing was torn down.\n`,
      );
      return 1;
    }
  }

  if (await refuseOrWarnForUnmetEvidence(request, deps)) {
    return 1;
  }

  const roster = await readRoster(request, deps);
  if (roster.status === "refused") {
    return 1;
  }
  const rosterKnown = roster.status === "known";
  let agentsForChildren = roster.status === "known" ? roster.agents : [];
  let live = roster.status === "known" ? roster.live : undefined;
  let children =
    roster.status === "known"
      ? await readChildren(request, agentsForChildren, deps)
      : { live: [], nonLive: [] };
  if (children === undefined) {
    return 1;
  }
  // Only worth re-checking when the first sample already concluded "safe to
  // proceed" (no live entry, or no live children) — see `confirmedAgents`'s
  // doc comment for why a single such read cannot be trusted on its own.
  if (
    !request.force &&
    rosterKnown &&
    (live === undefined || children.live.length === 0)
  ) {
    agentsForChildren = await confirmedAgents(agentsForChildren, deps);
    live = agentsForChildren.find((agent) =>
      sameLiveIdentity(agent, request.name),
    );
    const confirmedChildren = await readChildren(
      request,
      agentsForChildren,
      deps,
    );
    if (confirmedChildren === undefined) {
      return 1;
    }
    children = confirmedChildren;
  }
  if (children.live.length > 0 && !request.force) {
    return refuseForLiveChildren(request.name, children.live, deps);
  }
  if (!(await requireLiveReapabilityClaim(request, live, deps))) {
    return 1;
  }
  if (
    request.force &&
    !(await cascadeLiveChildren(request, children, deps, visited))
  ) {
    return 1;
  }
  // This permits answer-shaped teardown, not campaign delivery; queue and
  // launch-ledger writeback retain their independent path-wise decision.
  const verdictOnlyTeardownProven =
    live !== undefined &&
    (await isCompletionProvenVerdictOnlyAgent(
      request.name,
      live.agentStatus,
      deps,
    ));
  // LIVENESS, NOT COMPLETION EVIDENCE. An agent the harness still reports as
  // `working` is refused, claim or no claim. This is NOT one of the artifact
  // proofs the Lord's ruling removed: those answered "did this agent finish?"
  // from a leftover file or commit, whereas this answers "is it typing right
  // now?" -- the very thing the guard exists to protect. The distinction is
  // load-bearing: a claim can be published and then scrolled past by an agent
  // that picked the work back up, and reaping it there destroys live work.
  // Deleting `refuseUnprovenLiveAgent` took this check with it by accident,
  // and two tests caught it reaping a working Shadow.
  if (live !== undefined && !request.force && live.agentStatus === "working") {
    process.stderr.write(
      `reap-agent: "${request.name}" is LIVE and still WORKING (pane ` +
        `${live.paneId}) — refusing to reap it whatever it has published. ` +
        `Pass ${FORCE_FLAG} to reap it anyway.\n`,
    );
    return 1;
  }

  // NOTHING FURTHER GATES COMPLETION HERE (Lord, 2026-08-21: "remove all
  // other rule, the only rule we need is {"reapable":"completed"}").
  // `refuseUnprovenLiveAgent` used to run at this point and accept three
  // artifact proofs -- a landed REPORT.md, a `Deliver <name>` commit, and a
  // durable verdict-only shape -- any of which admitted a live agent that
  // had never said it was done. All three are deleted. An artifact proves
  // that WORK HAPPENED; it never proves the agent is FINISHED with it, and
  // conflating those is what made --force routine: a healthy delivery gate
  // matched none of the three shapes and got forced, while a wedged agent
  // holding a stale REPORT.md was waved through. The claim gate above is now
  // the only completion authority, and `--bypass-marker` -- not `--force` --
  // is the deliberate override for an agent that genuinely cannot speak.
  // OCCUPANCY, not parentage: a live agent with no supervisor/child
  // relationship to `request.name` at all can still have its `cwd` sitting
  // inside the worktree about to be removed (a probe/canary spawned with a
  // borrowed --cwd). `refuseForLiveChildren` above cannot see this — it only
  // ever looks at registered children. Runs whether or not `--force` cascaded
  // children above: cascading a live child is a decision about a known
  // relationship, never license to blow away an unrelated third party's
  // working directory silently.
  if (
    roster.status === "known" &&
    (await refuseForOccupiedTree(request, agentsForChildren, deps))
  ) {
    return 1;
  }

  // RESOLVE before teardown, WRITE after it. Teardown deletes the merged
  // branch and archives data/<name>/tree-base.json, and both `--reason
  // completed`'s delivery-commit lookup and the path-wise blob delivery proof
  // `checkDeliveryVerdict` performs need both to still exist — so the
  // evidence is gathered here. But the queue row and the launch ledger are
  // written only once teardown has actually succeeded: writing them first
  // let a `completed` reap mark the row `complete`, then have teardown
  // refuse, leaving a queue that said "done" about an agent still alive
  // (hiregent, 2026-09-02). A refused teardown now writes nothing, which is
  // the truth: the row stays in flight because the agent is.
  const queueDeliveryCommit = await (
    deps.resolveQueueReapDeliveryCommit ?? resolveQueueReapDeliveryCommit
  )(request.name, request.reason);
  const launchLedgerStatus = await resolveLaunchLedgerStatus(request, deps);

  try {
    const outcome = await executeTeardown(
      request,
      live,
      deps,
      await allowsUnadvancedBranchTeardown(
        request.name,
        verdictOnlyTeardownProven,
        deps,
      ),
    );
    if (outcome.status === "refused") {
      return 1;
    }
    await deps.writeQueueReapOutcome?.(request.name, request.reason, {
      deliveryCommit: queueDeliveryCommit,
    });
    await recordLaunchLedgerStatus(request, launchLedgerStatus, deps);
    if (!(await verifyNoStrandedTree(request.name, outcome.spawnCwd, deps))) {
      return 1;
    }
    writeNonLiveChildren(request.name, children.nonLive);
    return writeSuccessfulOutcome(
      request,
      outcome.actions,
      rosterKnown,
      outcome.cancelledDisposition,
    );
  } catch (error) {
    process.stderr.write(
      `reap-agent: tearing down "${request.name}" failed: ${errorText(error)}\n`,
    );
    return 1;
  }
}
