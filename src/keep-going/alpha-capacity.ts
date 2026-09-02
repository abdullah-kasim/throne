export type AlphaActivity =
  'registered-live' | 'executable-active' | 'blocked' | 'dependency-gated';

export interface AlphaBlockedEvidence {
  readonly blockedAt: string;
  readonly observedAt: string;
  readonly liveStatus: 'idle' | 'working' | 'blocked' | 'done' | 'unknown';
}

export interface AlphaReadinessRecord {
  readonly name: string;
  readonly role: 'Alpha';
  readonly live: boolean;
  readonly completed?: boolean;
  readonly dependencyReady: boolean;
  readonly executableWork: boolean;
  readonly blockedEvidence?: AlphaBlockedEvidence;
}

export interface AlphaReadinessDiagnostic {
  readonly name: string;
  readonly activity: AlphaActivity;
  readonly active: boolean;
  readonly detail?: 'waiting on dependency' | 'authoritatively blocked';
}

export interface QueuedAlphaCandidate {
  readonly name: string;
  readonly target: string;
  readonly dependencyReady: boolean;
  readonly executableWork: boolean;
}

export interface AlphaDispatchDecision {
  readonly admitted: boolean;
  readonly reason:
    'released-capacity' | 'at-capacity' | 'dependency-gated' | 'target-overlap';
}

function isRegisteredLive(record: AlphaReadinessRecord): boolean {
  return record.live && record.completed !== true;
}

function isValidTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

export function hasAuthoritativeCurrentBlockedEvidence(
  record: AlphaReadinessRecord,
): boolean {
  const evidence = record.blockedEvidence;
  return (
    isRegisteredLive(record) &&
    evidence !== undefined &&
    evidence.liveStatus === 'blocked' &&
    isValidTimestamp(evidence.blockedAt) &&
    isValidTimestamp(evidence.observedAt) &&
    Date.parse(evidence.blockedAt) <= Date.parse(evidence.observedAt)
  );
}

export function classifyAlphaActivity(
  record: AlphaReadinessRecord,
): AlphaActivity {
  if (!isRegisteredLive(record)) return 'registered-live';
  if (hasAuthoritativeCurrentBlockedEvidence(record)) return 'blocked';
  if (!record.dependencyReady && !record.executableWork) {
    return 'dependency-gated';
  }
  return 'executable-active';
}

export function classifyAlphaReadiness(
  records: readonly AlphaReadinessRecord[],
): AlphaReadinessDiagnostic[] {
  return records.map((record) => {
    const activity = classifyAlphaActivity(record);
    return {
      name: record.name,
      activity,
      active: activity === 'executable-active',
      ...(activity === 'dependency-gated'
        ? { detail: 'waiting on dependency' as const }
        : activity === 'blocked'
          ? { detail: 'authoritatively blocked' as const }
          : {}),
    };
  });
}

export function countExecutableActiveAlphas(
  records: readonly AlphaReadinessRecord[],
): number {
  return classifyAlphaReadiness(records).filter((record) => record.active)
    .length;
}

/** Counts registered-live, non-completed Alphas -- includes dependency-gated
 *  ones, unlike `countExecutableActiveAlphas`. Reuses the same "live" test
 *  every other predicate in this file is built on. */
export function countLiveAlphas(
  records: readonly AlphaReadinessRecord[],
): number {
  return records.filter(isRegisteredLive).length;
}

/** Decide admission without mutating registration or queue state. */
export function admitQueuedAlpha(
  candidate: QueuedAlphaCandidate,
  activeRecords: readonly AlphaReadinessRecord[],
  mutatingTargets: readonly string[],
  capacity: number,
): AlphaDispatchDecision {
  if (!candidate.dependencyReady || !candidate.executableWork) {
    return { admitted: false, reason: 'dependency-gated' };
  }
  if (mutatingTargets.includes(candidate.target)) {
    return { admitted: false, reason: 'target-overlap' };
  }
  if (countExecutableActiveAlphas(activeRecords) >= capacity) {
    return { admitted: false, reason: 'at-capacity' };
  }
  return { admitted: true, reason: 'released-capacity' };
}
