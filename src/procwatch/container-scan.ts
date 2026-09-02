import { execFile } from 'node:child_process';
import { formatDuration } from '../process-inspection/process-age.ts';

export const SUITE_CONTAINER_NAME_PREFIX = 'throne-suite-';
export const SUITE_CONTAINER_AGE_THRESHOLD_SECONDS = 2 * 60 * 60;

export interface AgedContainer {
  name: string;
  ageSeconds: number;
  ageText: string;
}

export type ContainerScanResult =
  | { readonly state: 'scanned'; readonly aged: AgedContainer[]; readonly total: number }
  | { readonly state: 'unavailable'; readonly reason: string };

export type ListContainersJson = () => Promise<string>;

export const REAL_LIST_CONTAINERS_JSON: ListContainersJson = () =>
  new Promise((resolve, reject) => {
    execFile(
      'podman',
      ['ps', '--format', 'json'],
      { encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024 },
      // eslint-disable-next-line promise/prefer-await-to-callbacks
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve(stdout);
      },
    );
  });

function containerNames(entry: Record<string, unknown>): string[] {
  const names = entry.Names;
  if (Array.isArray(names)) return names.filter((name): name is string => typeof name === 'string');
  return typeof names === 'string' ? [names] : [];
}

/** Podman reports `Created` as UNIX seconds; some versions emit an ISO
 *  string. Both are accepted, and an unparseable one is skipped rather than
 *  defaulted to "now" (which would hide the oldest offenders) or to epoch
 *  zero (which would report every container as two decades old). */
function createdEpochSeconds(entry: Record<string, unknown>): number | undefined {
  const created = entry.Created;
  if (typeof created === 'number' && Number.isFinite(created)) return created;
  if (typeof created === 'string') {
    const parsed = Date.parse(created);
    if (Number.isFinite(parsed)) return parsed / 1_000;
  }
  return undefined;
}

/**
 * Aged suite fixture containers, REPORT ONLY. Returns `unavailable` (never
 * an empty list) when podman cannot be asked, so "no containers" and "could
 * not look" never render identically in the report.
 */
export async function scanSuiteContainers(
  nowEpochSeconds: number,
  listJson: ListContainersJson = REAL_LIST_CONTAINERS_JSON,
  ageThresholdSeconds: number = SUITE_CONTAINER_AGE_THRESHOLD_SECONDS,
): Promise<ContainerScanResult> {
  let raw: string;
  try {
    raw = await listJson();
  } catch (error) {
    return {
      state: 'unavailable',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: 'unavailable', reason: 'podman ps --format json returned unparseable output' };
  }
  if (!Array.isArray(parsed)) {
    return { state: 'unavailable', reason: 'podman ps --format json returned a non-array' };
  }
  const entries = parsed.filter(
    (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
  );
  const suite = entries.filter((entry) =>
    containerNames(entry).some((name) => name.startsWith(SUITE_CONTAINER_NAME_PREFIX)),
  );
  const aged = suite.flatMap((entry) => {
    const created = createdEpochSeconds(entry);
    if (created === undefined) return [];
    const ageSeconds = nowEpochSeconds - created;
    if (ageSeconds < ageThresholdSeconds) return [];
    return [
      {
        name: containerNames(entry)[0] ?? '(unnamed)',
        ageSeconds,
        ageText: formatDuration(ageSeconds),
      },
    ];
  });
  return { state: 'scanned', aged: aged.sort((a, b) => b.ageSeconds - a.ageSeconds), total: suite.length };
}
