import type { HerdrAgent } from '../herdr/herdr-inventory.service.ts';
import { buildUnnamedAgentsMessage } from './message.ts';
import { NO_IDLING_REGENT_NAME } from './idle-family.ts';
import type { NoIdlingDependencies } from './no-idling-dependencies.types.ts';
import { ConfirmedObservationTracker } from './confirmed-observation.ts';
import {
  confirmUnnamedAgents,
  sortUnnamedSightingsByScratchPaneMarker,
  type ScratchPaneToReport,
} from './unnamed-agent-confirmation.ts';
import type { UnnamedAgentReport } from './unnamed-agent-report.ts';
import {
  AGENT_LIFECYCLE_STATES,
  type AgentStatusesRosterEntry,
} from '../agent-statuses/agent-statuses.types.ts';
import { readScratchPaneMarkers, writeScratchPaneMarker } from '../scratch-pane/scratch-pane-markers.ts';
import { errorText } from '../shared-policy/error-text.ts';
import {
  writeOut,
  writeErr,
  NO_IDLING_SENDER,
  NO_IDLING_SUBMIT_TIMEOUT_MS,
  regentAcceptsNotice,
} from './no-idling-notify-guard.ts';

export function noIdlingUnnamedAgentsWindowKey(
  target: HerdrAgent,
  paneIds: readonly string[],
  nowMs: number,
): string {
  const ids = [...paneIds].sort().join(',');
  return `no-idling-unnamed-agents:${target.name ?? target.paneId}:${ids}:${Math.floor(nowMs / 60_000)}`;
}

function liveAgentNames(roster: readonly AgentStatusesRosterEntry[]): Set<string> {
  return new Set(
    roster.filter((entry) => entry.lifecycle === AGENT_LIFECYCLE_STATES.LIVE).map((entry) => entry.name),
  );
}

function scratchPaneSighting({ sighting, marker, report }: ScratchPaneToReport<UnnamedAgentReport>) {
  return { ...sighting, scratchPane: { report, owner: marker.owner } };
}

async function markScratchPanesReported(
  scratchPanes: readonly ScratchPaneToReport<UnnamedAgentReport>[],
): Promise<void> {
  await Promise.all(scratchPanes.map(({ marker }) => writeScratchPaneMarker({ ...marker, reported: true })));
}

export async function notifyRegentOfUnnamedAgents(
  deps: NoIdlingDependencies,
  roster: readonly AgentStatusesRosterEntry[],
  dataDir: string,
): Promise<void> {
  const { unregistered, scratchPanesToReport } = sortUnnamedSightingsByScratchPaneMarker(
    await deps.detectUnnamedAgents(dataDir),
    await readScratchPaneMarkers(),
    liveAgentNames(roster),
    deps.now?.() ?? Date.now(),
  );
  const unnamedAgents = [
    ...confirmUnnamedAgents(unregistered, deps.unnamedAgentTracker ?? new ConfirmedObservationTracker()),
    ...scratchPanesToReport.map(scratchPaneSighting),
  ];
  if (unnamedAgents.length === 0) {
    return;
  }
  try {
    const regent = await deps.resolveAgent(NO_IDLING_REGENT_NAME);
    if (!regentAcceptsNotice(regent.agentStatus)) {
      writeOut(deps, `no-idling: Regent is ${regent.agentStatus}; deferred unnamed-agent notice\n`);
      return;
    }
    const paneIds = unnamedAgents.map((pane) => pane.paneId);
    await deps.submitToAgent(
      regent,
      NO_IDLING_SENDER,
      buildUnnamedAgentsMessage({ unnamedAgents }),
      {
        key: noIdlingUnnamedAgentsWindowKey(regent, paneIds, deps.now?.() ?? Date.now()),
        composerWaitMilliseconds: NO_IDLING_SUBMIT_TIMEOUT_MS,
      },
    );
    await markScratchPanesReported(scratchPanesToReport);
    writeOut(deps, `no-idling: notified Regent about unnamed agent pane(s) ${paneIds.join(', ')}\n`);
  } catch (error) {
    writeErr(deps, `no-idling: Regent unnamed-agent notice failed: ${errorText(error)}\n`);
  }
}
