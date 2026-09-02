import path from 'node:path';
import type { HerdrAgent } from '../herdr/herdr-inventory.service.ts';
import type { AgentStatusesRosterEntry } from '../agent-statuses/agent-statuses.types.ts';
import {
  classifyReapabilityAwareLastMessageTags,
  findFullyIdleFamilies,
  isAlphaRole,
  isReapabilityProtocolCandidate,
  NO_IDLING_REGENT_NAME,
  resolveBlockedTag,
  resolvedSupervisorName,
  type BlockedMarkerLedger,
  type FullyIdleFamily,
  type LastMessageTagState,
  liveBackgroundWork,
} from './idle-family.ts';
import {
  readAgentAges,
  readCwdMissingNames,
  readDurablyAccountedForNames,
  readIdleByDesignChildren,
  readRegisteredSupervisorNames,
  readSupervisors,
} from './idle-family-evidence-assembly.ts';
import { findReapabilityProtocolViolations } from './reapability-protocol.ts';
import { readClaimedButRefusedAgentNames } from '../autoreap/refusal-evidence.ts';
import { ConfirmedObservationTracker } from './confirmed-observation.ts';
import { confirmNoLiveChildrenAlphaNames } from './fully-idle-family-confirmation.ts';
import { buildNoIdlingMessage, buildUntaskedAgentsMessage } from './message.ts';
import {
  notifyClearedDependencyWakes,
  readBlockedAgentDependents,
  resolveClearedDependencyWakes,
} from './dependency-cleared-wake.ts';
import { findUntaskedAgents } from './find-untasked-agents.ts';
import {
  notifyRegentOfStaleTabs,
  notifyRegentOfStrandedSpawns,
  recoverStrandedSpawns,
} from './notify-stale-tabs.ts';
import { RUNTIME_DATA_DIR } from '../shared-policy/runtime-data-home.ts';
import type { NoIdlingDependencies } from './no-idling-dependencies.types.ts';
import { noteExcludedFamilies } from './excluded-family-observations.ts';
import {
  writeOut,
  writeErr,
  withNotifyGuard,
  NO_IDLING_SENDER,
  NO_IDLING_SUBMIT_TIMEOUT_MS,
  regentAcceptsNotice,
  type RunNoIdlingOptions,
} from './no-idling-notify-guard.ts';

export type { NoIdlingDependencies } from './no-idling-dependencies.types.ts';
export type { RunNoIdlingOptions };
export { NO_IDLING_SENDER, NO_IDLING_SUBMIT_TIMEOUT_MS, regentAcceptsNotice };

const NO_IDLING_MARKER_READ_LINES = 200;
export const NO_IDLING_AGENT_READ_TIMEOUT_MS = 2_000;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function noIdlingWindowKey(
  target: HerdrAgent,
  familyNames: readonly string[],
  nowMs: number,
): string {
  const family = [...familyNames].sort().join(',');
  return `no-idling:${target.name ?? target.paneId}:${family}:${Math.floor(nowMs / 60_000)}`;
}

function noIdlingUntaskedWindowKey(
  target: HerdrAgent,
  untaskedNames: readonly string[],
  nowMs: number,
): string {
  const names = [...untaskedNames].sort().join(',');
  return `no-idling-untasked:${target.name ?? target.paneId}:${names}:${Math.floor(nowMs / 60_000)}`;
}

/**
 * Notify the Regent about every live Alpha/Shadow whose assignment was
 * spawned but never sent, using the roster this sweep already fetched.
 * Silent when `findUntaskedAgents` finds none — this is a second, wholly
 * independent notice from the fully-idle-family notice below it (see
 * `no-idling`'s architecture notes for why the two are never merged).
 */
async function notifyRegentOfUntaskedAgents(
  deps: NoIdlingDependencies,
  roster: readonly AgentStatusesRosterEntry[],
  dataDir: string,
): Promise<void> {
  const untasked = await findUntaskedAgents({
    roster,
    readSpawnSpec: (name) => deps.readSpawnSpec(name, dataDir),
    hasFutureScheduledDelivery: deps.hasFutureScheduledDelivery,
    now: deps.now ?? Date.now,
  });
  if (untasked.length === 0) {
    return;
  }
  try {
    const regent = await deps.resolveAgent(NO_IDLING_REGENT_NAME);
    if (!regentAcceptsNotice(regent.agentStatus)) {
      writeOut(
        deps,
        `no-idling: Regent is ${regent.agentStatus}; deferred untasked-agent notice\n`,
      );
      return;
    }
    await deps.submitToAgent(
      regent,
      NO_IDLING_SENDER,
      buildUntaskedAgentsMessage({ untasked }),
      {
        key: noIdlingUntaskedWindowKey(
          regent,
          untasked.map((agent) => agent.name),
          deps.now?.() ?? Date.now(),
        ),
        composerWaitMilliseconds: NO_IDLING_SUBMIT_TIMEOUT_MS,
      },
    );
    writeOut(
      deps,
      `no-idling: notified Regent about untasked agent(s) ${untasked
        .map((agent) => agent.name)
        .join(', ')}\n`,
    );
  } catch (error) {
    writeErr(deps, `no-idling: Regent untasked-agent notice failed: ${errText(error)}\n`);
  }
}

async function readMemberPaneTag(
  member: string,
  deps: NoIdlingDependencies,
): Promise<LastMessageTagState> {
  try {
    const output = await deps.readAgent(member, {
      source: 'recent',
      lines: NO_IDLING_MARKER_READ_LINES,
      timeoutMilliseconds: NO_IDLING_AGENT_READ_TIMEOUT_MS,
    });
    // Live background work outranks the message-marker classification: herdr
    // reports a Claude pane idle whenever the model is not generating, so an
    // agent waiting on a background shell looks idle to the roster while it is
    // demonstrably not. Its last message is usually an ordinary "waiting for the
    // run" sentence, which would classify `unmarked` and flag the whole family.
    const running = liveBackgroundWork(output);
    if (running !== undefined) {
      return { kind: 'busy', running };
    }
    return classifyReapabilityAwareLastMessageTags(output);
  } catch (error) {
    writeErr(deps, `no-idling: could not read ${member} output: ${errText(error)}\n`);
    return { kind: 'unreadable' };
  }
}

async function readMemberLastMessageTags(
  member: string,
  deps: NoIdlingDependencies,
  ledger: BlockedMarkerLedger,
): Promise<LastMessageTagState> {
  return resolveBlockedTag(member, () => readMemberPaneTag(member, deps), ledger);
}

async function readFamilyLastMessageTags(
  family: FullyIdleFamily,
  deps: NoIdlingDependencies,
  ledger: BlockedMarkerLedger,
): Promise<ReadonlyMap<string, LastMessageTagState>> {
  const tags = new Map<string, LastMessageTagState>();
  for (const member of [family.alpha, ...family.idleChildren]) {
    tags.set(member, await readMemberLastMessageTags(member, deps, ledger));
  }
  return tags;
}

/**
 * One per-minute sweep: find every fully-idle Alpha family and notify the
 * Regent every sweep unless the Alpha's latest message is the standalone JSON
 * state {"blocked":true}. The idle Alpha is never messaged directly; the
 * Regent owns inspection and actionable recovery.
 */
export async function runNoIdling(
  rawDeps: NoIdlingDependencies,
  options: RunNoIdlingOptions = {},
): Promise<number> {
  // Every decision below (which families are idle, which are excluded, which
  // agents are untasked) is computed identically in both modes; only the
  // ability to actually send lands here, once, at the boundary. See
  // `withNotifyGuard`'s doc comment.
  const notify = options.notify ?? true;
  const deps = withNotifyGuard(rawDeps, notify);
  const fullyIdleFamilyLiveChildrenTracker =
    rawDeps.fullyIdleFamilyLiveChildrenTracker ?? new ConfirmedObservationTracker();
  // Verb used in this sweep's own after-the-fact summary lines, so a
  // report-only run never claims (past tense) to have done what it actually
  // suppressed -- the stubbed `submitToAgent` above already logs its own
  // per-message "[dry-run] suppressed" line; this only affects the
  // aggregate "notified/nudged Regent about X" summaries below it.
  const notifiedVerb = notify ? 'notified' : '[dry-run] would notify';
  const nudgedVerb = notify ? 'nudged' : '[dry-run] would nudge';
  let root: string;
  try {
    root = await deps.resolveLiveRoot();
  } catch (error) {
    writeErr(deps, `no-idling: ${errText(error)}\n`);
    return 1;
  }
  const dataDir = RUNTIME_DATA_DIR;

  let roster: AgentStatusesRosterEntry[];
  try {
    roster = await deps.getRoster(dataDir);
  } catch (error) {
    writeErr(deps, `no-idling: roster read failed: ${errText(error)}\n`);
    return 1;
  }

  await notifyRegentOfUntaskedAgents(deps, roster, dataDir);
  await notifyRegentOfStaleTabs(deps, dataDir);
  await notifyRegentOfStrandedSpawns(deps, dataDir);
  await recoverStrandedSpawns(deps, dataDir);

  const supervisors = await readSupervisors(roster, dataDir, deps.readAgentSupervisor);
  const agentAgeMs = await readAgentAges(
    roster,
    dataDir,
    deps.readSpawnSpec,
    deps.now ?? Date.now,
  );
  const idleByDesignChildren = await readIdleByDesignChildren(roster, dataDir, deps.isIdleByDesign);
  const cwdMissingNames = await readCwdMissingNames(roster, deps.checkCwdExists);
  const durablyAccountedForNames = await readDurablyAccountedForNames(
    roster,
    dataDir,
    deps.isDurablyAccountedFor,
  );
  const registeredAgentNames = await readRegisteredSupervisorNames(
    supervisors,
    dataDir,
    deps.isRegisteredAgent,
  );
  const confirmedNoLiveChildrenAlphaNames = confirmNoLiveChildrenAlphaNames(
    roster,
    supervisors,
    fullyIdleFamilyLiveChildrenTracker,
  );
  const statusFamilies = findFullyIdleFamilies({
    roster,
    supervisors,
    agentAgeMs,
    idleByDesignChildren,
    cwdMissingNames,
    confirmedNoLiveChildrenAlphaNames,
    durablyAccountedForNames,
    registeredAgentNames,
  });

  const lastMessageTags = new Map<string, LastMessageTagState>();
  for (const family of statusFamilies) {
    for (const [member, state] of await readFamilyLastMessageTags(
      family,
      deps,
      deps.blockedMarkerLedger,
    )) {
      lastMessageTags.set(member, state);
    }
  }
  for (const entry of roster) {
    if (
      !isReapabilityProtocolCandidate(entry) ||
      lastMessageTags.has(entry.name)
    ) {
      continue;
    }
    lastMessageTags.set(
      entry.name,
      await readMemberLastMessageTags(entry.name, deps, deps.blockedMarkerLedger),
    );
  }

  // A blocked agent whose every named child no longer resolves is woken
  // directly here -- never paged to the Regent -- before this sweep decides
  // which families are fully idle. Its `lastMessageTags` entry is left as
  // `blocked` for the rest of THIS sweep on purpose: the family-idle checks
  // below already exclude that kind, so the just-woken agent is correctly
  // silent from the Regent notice this same minute, and its own next pane
  // read (post-wake) is what the following sweep classifies fresh.
  const clearedDependencyWakes = await resolveClearedDependencyWakes(
    readBlockedAgentDependents(lastMessageTags),
    dataDir,
    deps.isRegisteredAgent,
  );
  await notifyClearedDependencyWakes(deps, clearedDependencyWakes);

  const families = findFullyIdleFamilies({
    roster,
    supervisors,
    lastMessageTags,
    agentAgeMs,
    idleByDesignChildren,
    cwdMissingNames,
    confirmedNoLiveChildrenAlphaNames,
    durablyAccountedForNames,
    registeredAgentNames,
  });
  noteExcludedFamilies(
    (text) => writeOut(deps, text),
    statusFamilies,
    families,
    lastMessageTags,
    rawDeps.excludedFamilyObservations ?? new Set<string>(),
  );

  const completedAlphas: AgentStatusesRosterEntry[] = [];
  for (const entry of roster) {
    if (!isAlphaRole(entry.role) || lastMessageTags.get(entry.name)?.kind !== 'reapable') {
      continue;
    }
    if (await deps.hasProvenDelivery(entry.name, dataDir)) {
      completedAlphas.push(entry);
    }
  }
  // `findReapabilityProtocolViolations` (and the `canEvaluateReapabilityClaim`
  // it delegates to, outside this slice's scope) still expects a plain
  // supervisor-name map -- resolve the tristate read down to a name here at
  // the call boundary rather than widening that unrelated module's contract.
  const resolvedSupervisorNames = new Map(
    [...supervisors.entries()]
      .map(([name, read]) => [name, resolvedSupervisorName(read)] as const)
      .filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const reapabilityProtocolViolations = findReapabilityProtocolViolations(
    roster,
    lastMessageTags,
    idleByDesignChildren,
    agentAgeMs,
    readClaimedButRefusedAgentNames(),
    resolvedSupervisorNames,
  );
  if (completedAlphas.length > 0) {
    try {
      const regent = await deps.resolveAgent(NO_IDLING_REGENT_NAME);
      if (!regentAcceptsNotice(regent.agentStatus)) {
        writeOut(
          deps,
          `no-idling: Regent is ${regent.agentStatus}; deferred completed-Alpha notice\n`,
        );
      } else {
        await deps.submitToAgent(
          regent,
          NO_IDLING_SENDER,
          `Completed Alpha(s) may require lifecycle cleanup: ${completedAlphas
            .map((entry) => entry.name)
            .join(
              ', ',
            )}. Use send-agent to message each Alpha directly. If an Alpha is not reapable, tell it to continue its task. A 99e gate finishing is not the same claim as delivery: it can finish by FAILING and sending the campaign back for corrective work. Before reaping any of them, confirm delivery-evidence.json plus a landed commit on the recorded target branch; reap only the ones with both. Do not start a validation round.`,
          {
            key: noIdlingWindowKey(
              regent,
              completedAlphas.map((entry) => entry.name),
              deps.now?.() ?? Date.now(),
            ),
            composerWaitMilliseconds: NO_IDLING_SUBMIT_TIMEOUT_MS,
          },
        );
        writeOut(
          deps,
          `no-idling: ${nudgedVerb} Regent to reap completed Alpha(s) ${completedAlphas
            .map((entry) => entry.name)
            .join(', ')}\n`,
        );
      }
    } catch (error) {
      writeErr(deps, `no-idling: Regent reap nudge failed: ${errText(error)}\n`);
    }
  }

  if (families.length === 0 && reapabilityProtocolViolations.length === 0) {
    writeOut(deps, 'no-idling: no fully-idle Alpha families\n');
    return 0;
  }

  try {
    const regent = await deps.resolveAgent(NO_IDLING_REGENT_NAME);
    if (!regentAcceptsNotice(regent.agentStatus)) {
      writeOut(
        deps,
        `no-idling: Regent is ${regent.agentStatus}; deferred idle-family notice\n`,
      );
      return 0;
    }
    // `FullyIdleFamily.alpha` names carry no role of their own -- the roster
    // this sweep already fetched is the join back to it (FP4: a non-Alpha
    // `findBareEntryPoints` entry, e.g. an orphaned Shadow, was reported
    // under fixed "fully-idle Alpha(s)" wording with Alpha-specific
    // remediation text; `buildNoIdlingMessage` needs each family's real role
    // to pick the right remediation, so this is the boundary that resolves
    // it). A name absent from the roster (should not happen -- every family
    // name came from this same roster) resolves to 'unknown role' rather
    // than defaulting to Alpha, so a roleless entry never inherits
    // Alpha-shaped remediation it was never entitled to.
  const roleByAgentName = new Map(roster.map((entry) => [entry.name, entry.role]));
    await deps.submitToAgent(
      regent,
      NO_IDLING_SENDER,
      buildNoIdlingMessage({
        families: families.map((family) => ({
          alpha: family.alpha,
          idleChildren: family.idleChildren,
          role: roleByAgentName.get(family.alpha) ?? 'unknown role',
          orphanedSupervisorName: family.orphanedSupervisorName,
        })),
        reapabilityProtocolViolations,
      }),
      {
        key: noIdlingWindowKey(
          regent,
          families.flatMap((family) => [family.alpha, ...family.idleChildren]),
          deps.now?.() ?? Date.now(),
        ),
        composerWaitMilliseconds: NO_IDLING_SUBMIT_TIMEOUT_MS,
      },
    );
    writeOut(
      deps,
      `no-idling: ${notifiedVerb} Regent about ${[
        ...(families.length > 0
          ? [`fully-idle Alpha(s) ${families.map((family) => family.alpha).join(', ')}`]
          : []),
        ...(reapabilityProtocolViolations.length > 0
          ? [`reapability protocol violation(s) ${reapabilityProtocolViolations.map(({ agent }) => agent).join(', ')}`]
          : []),
      ].join(' and ')}\n`,
    );
  } catch (error) {
    writeErr(deps, `no-idling: Regent idle-family notice failed: ${errText(error)}\n`);
  }

  return 0;
}
