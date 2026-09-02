import { Injectable, Optional } from '@nestjs/common';
import type { LongLivedHostedWorker } from '../throne-backend/hosted-worker.types.ts';
import {
  subscribeToPaneAgentStatusChanged,
  DEFAULT_PANE_AGENT_STATUS_SUBSCRIPTION_DEPENDENCIES,
  defaultHerdrClient,
  type PaneAgentStatusChangedEvent,
} from './pane-agent-status-subscription.ts';
import {
  classifyBlockedTransition,
  BLOCKED_TRANSITION_VERDICTS,
} from './classify-blocked-transition.ts';
import { buildBlockedAgentPagingMessage } from './blocked-agent-paging-message.ts';
import type { BlockedAgentPagingDependencies } from './blocked-agent-paging-dependencies.types.ts';
import { decideConfirmation } from '../no-idling/confirmed-observation.ts';
import { AGENT_LIFECYCLE_STATES } from '../agent-statuses/agent-statuses.types.ts';
import type { AgentStatusesRosterEntry } from '../agent-statuses/agent-statuses.types.ts';
import { sameAgentName } from '../herdr/herdr-identity-contracts.ts';
import { NO_IDLING_REGENT_NAME } from '../no-idling/idle-family.ts';
import { NO_IDLING_SUBMIT_TIMEOUT_MS } from '../no-idling/no-idling-run.ts';
import { RUNTIME_DATA_DIR } from '../shared-policy/runtime-data-home.ts';
import { getAgentStatusesRoster } from '../agent-statuses/agent-statuses-roster.ts';
import {
  readAgentSupervisor,
  IdentityLineReadStatus,
} from '../agentdata/identity-data.service.ts';
import { readAgent } from '../herdr/herdr-runtime.service.ts';
import { clearBlockedMarker, readBlockedMarker, writeBlockedMarker } from '../agentdata/blocked-marker.service.ts';
import { resolveAgent } from '../herdr/herdr-runtime.service.ts';
import { submitToAgentViaQueue } from '../throne-work/enqueue-heartbeat-message.ts';
import { listLiveAgentStatuses } from '../agent-statuses/agent-statuses-herdr.ts';
import { runNotifyLord } from '../notify-lord/notify-lord.command.ts';
import { classifyLastMessageTags, lastMessageBlock, resolveBlockedTag } from '../no-idling/idle-family.ts';
import {
  appendBlockedPageLedgerEntry,
  blockedPageEscalationState,
  BLOCKED_PAGE_ESCALATION_BOUND,
  hasBlockedPageCredit,
  readBlockedPageLedger,
} from './blocked-agent-escalation-ledger.ts';

export const BLOCKED_AGENT_PAGING_HOSTED_WORKER_NAME = 'blocked-agent-paging';
const BLOCKED_AGENT_PAGING_SENDER = '';
/** How long a genuine `blocked` transition waits for a fresh confirming
 *  re-check before it is allowed to page -- long enough for a mid-exit
 *  Shadow to land its verdict and be reaped. */
export const BLOCKED_PAGING_CONFIRMATION_DELAY_MS = 30_000;
export const BLOCKED_PAGING_RECONCILIATION_INTERVAL_MS = 60_000;

/**
 * Adapts the corrected tristate `readAgentSupervisor` down to
 * `BlockedAgentPagingDependencies['readAgentSupervisor']`'s pre-existing
 * `Promise<string>` contract (out of this slice's scope to widen). A
 * field-absent or unresolved read both resolve to "" here -- the same value
 * the pre-tristate read already produced on any failure, so the name-equality
 * check `classifyBlockedTransition`/`hasLiveChildren` build on this map
 * never falsely matches a real agent name and this file's runtime behavior
 * at this boundary is unchanged.
 */
async function resolvedSupervisorNameForPaging(
  name: string,
  dataDir: string,
): Promise<string> {
  const read = await readAgentSupervisor(name, dataDir);
  return read.status === IdentityLineReadStatus.Found ? read.value : '';
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveAgentNameForPane(
  paneId: string,
  roster: readonly AgentStatusesRosterEntry[],
): string | null {
  return roster.find((entry) => entry.paneId === paneId)?.name ?? null;
}

async function buildSupervisorMap(
  roster: readonly AgentStatusesRosterEntry[],
  dataDir: string,
  readAgentSupervisorFn: BlockedAgentPagingDependencies['readAgentSupervisor'],
): Promise<ReadonlyMap<string, string>> {
  const supervisors = new Map<string, string>();
  for (const entry of roster) {
    supervisors.set(entry.name, await readAgentSupervisorFn(entry.name, dataDir));
  }
  return supervisors;
}

function blockedAgentPagingWindowKey(agentName: string, nowMs: number): string {
  return `blocked-agent-paging:${agentName}:${Math.floor(nowMs / 60_000)}`;
}

interface BlockedConfirmationSample {
  /** Fresh evidence still reads this agent as live, pane-blocked, and
   *  BLOCKED-AND-STUCK -- the same test the first observation applied. */
  readonly isStillBlockedAndStuck: boolean;
  /** The ledger moved since the first observation: the agent landed its
   *  verdict, or exited/was reaped. Ends the confirmation window in the
   *  agent's favor even if some other read still says "blocked". */
  readonly ledgerMotionSinceFirstObservation: boolean;
}

/**
 * Re-derives the STUCK test against fresh roster evidence for the confirming
 * re-check -- never the snapshot that produced the first observation.
 */
function readBlockedConfirmationSample(
  agentName: string,
  roster: readonly AgentStatusesRosterEntry[],
  supervisors: ReadonlyMap<string, string>,
): BlockedConfirmationSample {
  const entry = roster.find((candidate) => sameAgentName(candidate.name, agentName));
  const hasLanded = entry === undefined || entry.reportLanded;
  const hasExited = entry === undefined || entry.lifecycle !== AGENT_LIFECYCLE_STATES.LIVE;
  const isStillPaneBlocked = entry !== undefined && entry.liveStatus === 'blocked';
  return {
    isStillBlockedAndStuck:
      isStillPaneBlocked &&
      classifyBlockedTransition(agentName, roster, supervisors) === BLOCKED_TRANSITION_VERDICTS.STUCK,
    ledgerMotionSinceFirstObservation: hasLanded || hasExited,
  };
}

async function pageRegentForStuckBlock(
  agentName: string,
  event: PaneAgentStatusChangedEvent,
  roster: readonly AgentStatusesRosterEntry[],
  deps: BlockedAgentPagingDependencies,
): Promise<void> {
  const priorState = blockedPageEscalationState(agentName, await deps.readEscalationLedger());
  if (priorState.pageCount >= BLOCKED_PAGE_ESCALATION_BOUND) {
    if (!priorState.lordNotified) {
      await notifyLordOfBoundedBlockedEscalation(agentName, priorState.pageCount, deps);
    }
    return;
  }
  const regent = await deps.resolveAgent(NO_IDLING_REGENT_NAME);
  const rosterEntry = roster.find((entry) => sameAgentName(entry.name, agentName));
  const pageKey = blockedAgentPagingWindowKey(agentName, deps.now?.() ?? Date.now());
  await deps.submitToAgent(
    regent,
    BLOCKED_AGENT_PAGING_SENDER,
    buildBlockedAgentPagingMessage({
      agentName,
      cwd: rosterEntry?.cwd,
      paneId: event.paneId,
      title: event.title,
      stateLabels: event.stateLabels,
    }),
    {
      key: pageKey,
      composerWaitMilliseconds: NO_IDLING_SUBMIT_TIMEOUT_MS,
    },
  );
  const observedAt = new Date(deps.now?.() ?? Date.now()).toISOString();
  const entriesAfterEnqueue = await deps.readEscalationLedger();
  if (!hasBlockedPageCredit(agentName, pageKey, entriesAfterEnqueue)) {
    await deps.appendEscalationLedger({ agentName, observedAt, kind: 'page-enqueued', pageKey });
  }
  const state = blockedPageEscalationState(agentName, await deps.readEscalationLedger());
  if (state.pageCount >= BLOCKED_PAGE_ESCALATION_BOUND && !state.lordNotified) {
    await notifyLordOfBoundedBlockedEscalation(agentName, state.pageCount, deps, observedAt);
  }
}

async function notifyLordOfBoundedBlockedEscalation(
  agentName: string,
  pageCount: number,
  deps: BlockedAgentPagingDependencies,
  observedAt = new Date(deps.now?.() ?? Date.now()).toISOString(),
): Promise<void> {
  const delivered = await deps.notifyLord(
    `${agentName} remains blocked after ${pageCount} Regent pages; inspect the durable blocked-agent paging ledger.`,
  );
  if (delivered) {
    await deps.appendEscalationLedger({ agentName, observedAt, kind: 'lord-notified' });
  }
}

export async function reconcileBlockedAgentPages(
  deps: BlockedAgentPagingDependencies,
): Promise<void> {
  const roster = await deps.getRoster(RUNTIME_DATA_DIR);
  const supervisors = await buildSupervisorMap(roster, RUNTIME_DATA_DIR, deps.readAgentSupervisor);
  for (const entry of roster) {
    if (
      entry.lifecycle !== AGENT_LIFECYCLE_STATES.LIVE ||
      entry.reportLanded ||
      classifyBlockedTransition(entry.name, roster, supervisors) !== BLOCKED_TRANSITION_VERDICTS.STUCK ||
      entry.paneId === undefined
    ) {
      continue;
    }
    const blockedTag = await resolveBlockedTag(
      entry.name,
      async () => classifyLastMessageTags(lastMessageBlock(await deps.readAgent(entry.name))),
      deps.blockedMarkerLedger,
    );
    if (
      entry.liveStatus !== 'blocked' && blockedTag.kind !== 'blocked'
    ) {
      continue;
    }
    await pageRegentForStuckBlock(
      entry.name,
      { paneId: entry.paneId, workspaceId: '', agentStatus: 'blocked', agent: '', displayAgent: '', title: null, stateLabels: {} },
      roster,
      deps,
    );
  }
}

/**
 * On a genuine `blocked` transition (i.e. not a repeat for a pane already
 * known blocked), resolves the pane to a roster agent and classifies it. A
 * BLOCKED-AND-STUCK verdict is not immediately actionable: a single sample
 * cannot tell a genuinely stuck agent from one that is mid-exit, so this
 * waits out `BLOCKED_PAGING_CONFIRMATION_DELAY_MS` and re-derives the verdict
 * from fresh roster evidence before paging, via the shared confirmed-
 * observation contract. If the agent lands its verdict, exits, or its pane
 * status moves away from `blocked` in that window, the page is cancelled
 * outright, never merely delayed. Any non-`blocked` status clears the pane's
 * debounce entry so a later genuine transition into `blocked` pages again.
 */
export async function handlePaneAgentStatusChangedEvent(
  event: PaneAgentStatusChangedEvent,
  deps: BlockedAgentPagingDependencies,
  knownBlockedPaneIds: Set<string>,
): Promise<void> {
  if (event.agentStatus !== 'blocked') {
    knownBlockedPaneIds.delete(event.paneId);
    return;
  }
  if (knownBlockedPaneIds.has(event.paneId)) {
    return;
  }
  knownBlockedPaneIds.add(event.paneId);

  const dataDir = RUNTIME_DATA_DIR;
  const roster = await deps.getRoster(dataDir);
  const agentName = resolveAgentNameForPane(event.paneId, roster);
  if (agentName === null) {
    return;
  }
  const supervisors = await buildSupervisorMap(roster, dataDir, deps.readAgentSupervisor);
  const verdict = classifyBlockedTransition(agentName, roster, supervisors);
  if (verdict !== BLOCKED_TRANSITION_VERDICTS.STUCK) {
    return;
  }

  await deps.sleep(BLOCKED_PAGING_CONFIRMATION_DELAY_MS);
  const confirmationRoster = await deps.getRoster(dataDir);
  const confirmationSupervisors = await buildSupervisorMap(
    confirmationRoster,
    dataDir,
    deps.readAgentSupervisor,
  );
  const sample = readBlockedConfirmationSample(agentName, confirmationRoster, confirmationSupervisors);
  const { confirmed } = decideConfirmation(
    true,
    sample.isStillBlockedAndStuck,
    sample.ledgerMotionSinceFirstObservation,
  );
  if (!confirmed) {
    return;
  }
  await pageRegentForStuckBlock(agentName, event, confirmationRoster, deps);
}

export const REAL_BLOCKED_AGENT_PAGING_DEPENDENCIES: BlockedAgentPagingDependencies = {
  herdrClient: defaultHerdrClient(),
  listKnownPaneIds: async () => (await listLiveAgentStatuses()).map((agent) => agent.paneId),
  getRoster: async () => getAgentStatusesRoster(),
  readAgentSupervisor: resolvedSupervisorNameForPaging,
  readAgent: async (name) => readAgent(name, { lines: 200 }),
  blockedMarkerLedger: {
    readBlockedMarker: (name) => readBlockedMarker(name),
    writeBlockedMarker: (name) => writeBlockedMarker(name),
    clearBlockedMarker: (name) => clearBlockedMarker(name),
  },
  resolveAgent,
  // Regent pages route through the same durable queue no-idling already
  // uses -- a busy Regent composer becomes a server-side retry, not a
  // dropped page. See `enqueue-heartbeat-message.ts`.
  submitToAgent: submitToAgentViaQueue,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  readEscalationLedger: () => readBlockedPageLedger(),
  appendEscalationLedger: (entry) => appendBlockedPageLedgerEntry(entry),
  notifyLord: async (message) => (await runNotifyLord([message])) === 0,
  now: () => Date.now(),
};

/**
 * A long-lived `throne-backend` worker that keeps herdr's
 * `pane.agent_status_changed` subscription open and, on a genuine transition
 * into `blocked` classified BLOCKED-AND-STUCK, pages the Regent via the same
 * `submitToAgent` path `no-idling` already uses.
 *
 * **A missed or dropped subscription event produces a missed page.** This
 * worker is best-effort push chrome layered on top of the existing
 * `no-idling` poll sweep, never a replacement for it -- the poll remains the
 * authoritative reconciling floor for anything a dropped connection, a
 * worker restart, or a socket outage causes this path to miss. This worker
 * adds no reconciliation logic of its own.
 */
@Injectable()
export class BlockedAgentPagingHostedWorker implements LongLivedHostedWorker {
  readonly kind = 'long-lived' as const;
  readonly workerName = BLOCKED_AGENT_PAGING_HOSTED_WORKER_NAME;

  constructor(
    @Optional()
    private readonly dependencies: BlockedAgentPagingDependencies = REAL_BLOCKED_AGENT_PAGING_DEPENDENCIES,
  ) {}

  async start(shouldStop: () => boolean): Promise<void> {
    const knownBlockedPaneIds = new Set<string>();
    const subscription = subscribeToPaneAgentStatusChanged({
      herdrClient: this.dependencies.herdrClient,
      listKnownPaneIds: this.dependencies.listKnownPaneIds,
      onEvent: (event) => {
        handlePaneAgentStatusChangedEvent(event, this.dependencies, knownBlockedPaneIds).catch(
          (error: unknown) => {
            (this.dependencies.stderr ?? ((text: string) => process.stderr.write(text)))(
              `blocked-agent-paging: ${errText(error)}\n`,
            );
          },
        );
      },
      shouldStop,
      connect: DEFAULT_PANE_AGENT_STATUS_SUBSCRIPTION_DEPENDENCIES.connect,
      sleep: DEFAULT_PANE_AGENT_STATUS_SUBSCRIPTION_DEPENDENCIES.sleep,
    });
    const reconciliation = (async () => {
      while (!shouldStop()) {
        await this.dependencies.sleep(BLOCKED_PAGING_RECONCILIATION_INTERVAL_MS);
        if (shouldStop()) break;
        try {
          await reconcileBlockedAgentPages(this.dependencies);
        } catch (error) {
          (this.dependencies.stderr ?? ((text: string) => process.stderr.write(text)))(
            `blocked-agent-paging: reconciliation failed: ${errText(error)}\n`,
          );
        }
      }
    })();
    await Promise.all([subscription, reconciliation]);
  }
}
