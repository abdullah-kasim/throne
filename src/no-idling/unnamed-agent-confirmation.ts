import type { ConfirmedObservationTracker } from './confirmed-observation.ts';

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
