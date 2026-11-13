import path from 'node:path';
import type { HerdrAgent } from '../herdr/herdr-inventory.service.ts';
import type { AgentStatusesRosterEntry } from '../agent-statuses/agent-statuses.types.ts';
import {
  findFullyIdleFamilies,
  isAlphaRole,
  isReapabilityProtocolCandidate,
  NO_IDLING_REGENT_NAME,
  resolvedSupervisorName,
  type FullyIdleFamily,
  type LastMessageTagState,
} from './idle-family.ts';
import {
  readAgentsWithinSpawnGrace,
  readCwdMissingNames,
  readDurablyAccountedForNames,
  readIdleByDesignChildren,
  readRegisteredSupervisorNames,
  readSupervisors,
} from './idle-family-evidence-assembly.ts';
import { readDeclaredTag } from './blocked-marker-resolution.ts';
import { findReapabilityProtocolViolations } from './reapability-protocol.ts';
import { handleClaimWaits, isAcceptedLiveAgent, readSupervisorWaits } from './claim-wait.ts';
import {
  runningWorkDescription,
  runningWorkOfRosterAgents,
  withWhatEachAgentWaitsOn,
  type ReadRunningWork,
} from './background-wait.ts';
import { ConfirmedObservationTracker } from './confirmed-observation.ts';
import { confirmNoLiveChildrenAlphaNames } from './fully-idle-family-confirmation.ts';
import {
  buildNoIdlingMessage,
  buildUntaskedAgentsMessage,
  familiesWithNoMemberWaitingOnBackgroundWork,
} from './message.ts';
import {
  countStillBlockedSweeps,
  notifyClearedDependencyWakes,
  notifyRegentOfStillBlockedAgents,
  readBlockedAgentDependents,
  resolveClearedDependencyWakes,
} from './dependency-cleared-wake.ts';
import { findUntaskedAgents, type UntaskedAgent } from './find-untasked-agents.ts';
import { inMemoryPageLedger, rosterOfPresentFacts, submitUnlessAlreadyPaged } from './present-facts.ts';
import type { NoIdlingPageLedger } from './no-idling-dependencies.types.ts';
import {
  notifyRegentOfStaleTabs,
  notifyRegentOfStrandedSpawns,
  recoverStrandedSpawns,
} from './notify-stale-tabs.ts';
import { notifyRegentOfUnnamedAgents } from './notify-unnamed-agents.ts';
import { THRONE_DATA_DIR } from '../shared-policy/throne-home.ts';
import { inOneProcessTablePass } from '../process-inspection/harness-background-work.ts';
import { isRegentOrStagerRoleName } from '../shared-policy/objective-contract.ts';
import type { NoIdlingDependencies } from './no-idling-dependencies.types.ts';
import { noteExcludedFamilies } from './excluded-family-observations.ts';
import { notifyRegentOfDeferredRows } from './deferred-row-belt.ts';
import { noteAgentsCorrectedToWorking } from './corrected-to-working-log.ts';
import { notifyRegentWhenSweepIsBlind } from './blind-sweep-notice.ts';
import { sweepStuckDrafts } from './stuck-draft-sweep.ts';
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


function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function noIdlingPageKey(target: HerdrAgent, familyNames: readonly string[]): string {
  const family = [...familyNames].sort().join(',');
  return `no-idling:${target.name ?? target.paneId}:${family}`;
}

function noIdlingUntaskedPageKey(target: HerdrAgent, untasked: readonly UntaskedAgent[]): string {
  const names = untasked
    .map((agent) => (agent.finished === true ? `${agent.name}(finished)` : agent.name))
    .sort()
    .join(',');
  return `no-idling-untasked:${target.name ?? target.paneId}:${names}`;
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
  readRunningWork: ReadRunningWork,
  ledger: NoIdlingPageLedger,
): Promise<void> {
  const untasked = await findUntaskedAgents({
    roster,
    readSpawnSpec: (name) => deps.readSpawnSpec(name, dataDir),
    hasFutureScheduledDelivery: deps.hasFutureScheduledDelivery,
    readAgentState: deps.readAgentState,
    readRunningWork,
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
    const paged = await submitUnlessAlreadyPaged(
      deps,
      ledger,
      regent,
      buildUntaskedAgentsMessage({ untasked }),
      noIdlingUntaskedPageKey(regent, untasked),
      { composerWaitMilliseconds: NO_IDLING_SUBMIT_TIMEOUT_MS },
    );
    if (!paged) return;
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

function readMemberLastMessageTags(
  member: string,
  deps: NoIdlingDependencies,
  readRunningWork: ReadRunningWork,
): Promise<LastMessageTagState> {
  return readDeclaredTag(member, deps.readAgentState, async () =>
    runningWorkDescription(await readRunningWork(member)),
  );
}

async function readFamilyLastMessageTags(
  family: FullyIdleFamily,
  deps: NoIdlingDependencies,
  readRunningWork: ReadRunningWork,
): Promise<ReadonlyMap<string, LastMessageTagState>> {
  const tags = new Map<string, LastMessageTagState>();
  for (const member of [family.alpha, ...family.idleChildren]) {
    tags.set(member, await readMemberLastMessageTags(member, deps, readRunningWork));
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
  return inOneProcessTablePass(() => runNoIdlingInOnePass(rawDeps, options));
}

async function runNoIdlingInOnePass(
  rawDeps: NoIdlingDependencies,
  options: RunNoIdlingOptions,
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
  const dataDir = THRONE_DATA_DIR;

  let roster: AgentStatusesRosterEntry[];
  try {
    roster = await rosterOfPresentFacts(
      await deps.getRoster(dataDir),
      deps,
      dataDir,
      deps.now?.() ?? Date.now(),
    );
  } catch (error) {
    writeErr(deps, `no-idling: roster read failed: ${errText(error)}\n`);
    return 1;
  }

  noteAgentsCorrectedToWorking(
    (text) => writeOut(deps, text),
    roster,
    deps.now?.() ?? Date.now(),
    rawDeps.correctedToWorkingLogTimes ?? new Map<string, number>(),
  );
  await notifyRegentWhenSweepIsBlind(
    deps,
    roster,
    rawDeps.blindSweepMemory ?? { blindSweepsInARow: 0, noticeSent: false },
  );
  const readRunningWork = runningWorkOfRosterAgents(roster, deps.readHarnessBackgroundWork);
  const ledger = notify ? (rawDeps.pageLedger ?? inMemoryPageLedger()) : inMemoryPageLedger();
  await notifyRegentOfUntaskedAgents(deps, roster, dataDir, readRunningWork, ledger);
  await notifyRegentOfStaleTabs(deps, dataDir, ledger);
  await notifyRegentOfUnnamedAgents(deps, roster, dataDir);
  await notifyRegentOfStrandedSpawns(deps, dataDir, ledger);
  await sweepStuckDrafts(deps, roster, await recoverStrandedSpawns(deps, dataDir), notify);
  await notifyRegentOfDeferredRows(deps, notify);

  const supervisors = await readSupervisors(roster, dataDir, deps.readAgentSupervisor);
  const withinSpawnGrace = await readAgentsWithinSpawnGrace(
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
    withinSpawnGrace,
    idleByDesignChildren,
    cwdMissingNames,
    confirmedNoLiveChildrenAlphaNames,
    durablyAccountedForNames,
    registeredAgentNames,
  });

  const supervisorWaits = await readSupervisorWaits(roster, dataDir);
  const lastMessageTags = new Map<string, LastMessageTagState>();
  for (const family of statusFamilies) {
    for (const [member, state] of await readFamilyLastMessageTags(
      family,
      deps,
      readRunningWork,
    )) {
      lastMessageTags.set(member, state);
    }
  }
  for (const entry of roster) {
    if (
      lastMessageTags.has(entry.name) ||
      isRegentOrStagerRoleName(entry.role) ||
      !(isReapabilityProtocolCandidate(entry) || (await isAcceptedLiveAgent(entry, dataDir)))
    ) {
      continue;
    }
    lastMessageTags.set(
      entry.name,
      await readMemberLastMessageTags(entry.name, deps, readRunningWork),
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
    lastMessageTags,
  );
  const stillBlockedSweepCounts = countStillBlockedSweeps(
    rawDeps.stillBlockedObservations ?? new Map<string, number>(),
    clearedDependencyWakes,
  );
  await notifyClearedDependencyWakes(deps, clearedDependencyWakes);
  await notifyRegentOfStillBlockedAgents(deps, clearedDependencyWakes, stillBlockedSweepCounts);

  const families = findFullyIdleFamilies({
    roster,
    supervisors,
    lastMessageTags,
    withinSpawnGrace,
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
  const resolvedSupervisorNames = new Map(
    [...supervisors.entries()]
      .map(([name, read]) => [name, resolvedSupervisorName(read)] as const)
      .filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const nowMs = deps.now?.() ?? Date.now();
  await handleClaimWaits(
    { deps, lastMessageTags, supervisorNames: resolvedSupervisorNames, dataDir, nowMs,
      recordNotices: notify, clearedDependencyWakes },
    supervisorWaits,
  );
  const reapabilityProtocolViolations = await withWhatEachAgentWaitsOn(
    findReapabilityProtocolViolations(
      roster,
      lastMessageTags,
      idleByDesignChildren,
      withinSpawnGrace,
      resolvedSupervisorNames,
      supervisorWaits,
      nowMs,
    ),
    readRunningWork,
    deps.readAgentState,
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
        await submitUnlessAlreadyPaged(
          deps,
          ledger,
          regent,
          `Completed Alpha(s) may require lifecycle cleanup: ${completedAlphas
            .map((entry) => entry.name)
            .join(
              ', ',
            )}. Use send-agent to message each Alpha directly. If an Alpha is not reapable, tell it to continue its task. A 99e gate finishing is not the same claim as delivery: it can finish by FAILING and sending the campaign back for corrective work. Before reaping any of them, confirm delivery-evidence.json plus a landed commit on the recorded target branch; reap only the ones with both. Do not start a validation round.`,
          noIdlingPageKey(regent, completedAlphas.map((entry) => entry.name)),
          { composerWaitMilliseconds: NO_IDLING_SUBMIT_TIMEOUT_MS },
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
    const paged = await submitUnlessAlreadyPaged(
      deps,
      ledger,
      regent,
      buildNoIdlingMessage({
        families: families.map((family) => ({
          alpha: family.alpha,
          idleChildren: family.idleChildren,
          role: roleByAgentName.get(family.alpha) ?? 'unknown role',
          orphanedSupervisorName: family.orphanedSupervisorName,
        })),
        reapabilityProtocolViolations,
      }),
      noIdlingPageKey(regent, [
        ...families.flatMap((family) => [family.alpha, ...family.idleChildren]),
        ...reapabilityProtocolViolations.map(({ agent }) => agent),
      ]),
      { composerWaitMilliseconds: NO_IDLING_SUBMIT_TIMEOUT_MS },
    );
    if (!paged) return 0;
    const notifiedIdleFamilies = familiesWithNoMemberWaitingOnBackgroundWork(
      families,
      reapabilityProtocolViolations,
    );
    writeOut(
      deps,
      `no-idling: ${notifiedVerb} Regent about ${[
        ...(notifiedIdleFamilies.length > 0
          ? [`fully-idle Alpha(s) ${notifiedIdleFamilies.map((family) => family.alpha).join(', ')}`]
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
