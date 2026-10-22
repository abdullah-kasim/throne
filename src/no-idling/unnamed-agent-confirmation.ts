import type { ConfirmedObservationTracker } from './confirmed-observation.ts';
import type { ScratchPaneMarker } from '../scratch-pane/scratch-pane-markers.ts';

const UNNAMED_AGENT_SUBJECT_PREFIX = 'unnamed-agent:';

export interface UnnamedPaneSighting {
  paneId: string;
  agentSessionId?: string;
}

function unnamedAgentSubjectKey(sighting: UnnamedPaneSighting): string {
  return `${UNNAMED_AGENT_SUBJECT_PREFIX}${JSON.stringify([sighting.paneId, sighting.agentSessionId ?? null])}`;
}

export function confirmUnnamedAgents<Sighting extends UnnamedPaneSighting>(
  sightings: readonly Sighting[],
  tracker: ConfirmedObservationTracker,
): Sighting[] {
  const subjectKeys = sightings.map(unnamedAgentSubjectKey);
  tracker.endStreaksNotObserved(UNNAMED_AGENT_SUBJECT_PREFIX, new Set(subjectKeys));
  return sightings.filter((_sighting, index) => tracker.recordObservation(subjectKeys[index], true, false));
}

export const SCRATCH_PANE_REPORT = {
  EXPIRED: 'expired',
  ORPHANED: 'orphaned',
} as const;

export type ScratchPaneReport = (typeof SCRATCH_PANE_REPORT)[keyof typeof SCRATCH_PANE_REPORT];

export interface ScratchPaneToReport<Sighting extends UnnamedPaneSighting> {
  readonly sighting: Sighting;
  readonly marker: ScratchPaneMarker;
  readonly report: ScratchPaneReport;
}

export interface SortedUnnamedSightings<Sighting extends UnnamedPaneSighting> {
  readonly unregistered: Sighting[];
  readonly scratchPanesToReport: ScratchPaneToReport<Sighting>[];
}

function scratchPaneReportFor(
  marker: ScratchPaneMarker,
  liveAgentNames: ReadonlySet<string>,
  nowMs: number,
): ScratchPaneReport | undefined {
  if (marker.reported) return undefined;
  if (!liveAgentNames.has(marker.owner)) return SCRATCH_PANE_REPORT.ORPHANED;
  if (Date.parse(marker.until) <= nowMs) return SCRATCH_PANE_REPORT.EXPIRED;
  return undefined;
}

export function sortUnnamedSightingsByScratchPaneMarker<Sighting extends UnnamedPaneSighting>(
  sightings: readonly Sighting[],
  markers: readonly ScratchPaneMarker[],
  liveAgentNames: ReadonlySet<string>,
  nowMs: number,
): SortedUnnamedSightings<Sighting> {
  const markersByPane = new Map(markers.map((marker) => [marker.paneId, marker]));
  const sorted: SortedUnnamedSightings<Sighting> = { unregistered: [], scratchPanesToReport: [] };
  for (const sighting of sightings) {
    const marker = markersByPane.get(sighting.paneId);
    if (marker === undefined) {
      sorted.unregistered.push(sighting);
      continue;
    }
    const report = scratchPaneReportFor(marker, liveAgentNames, nowMs);
    if (report !== undefined) sorted.scratchPanesToReport.push({ sighting, marker, report });
  }
  return sorted;
}
