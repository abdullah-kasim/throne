import type { AgentStatusesRosterEntry } from '../agent-statuses/agent-statuses.types.ts';

const ONE_HOUR_MS = 60 * 60 * 1000;

export function noteAgentsCorrectedToWorking(
  write: (text: string) => void,
  roster: readonly AgentStatusesRosterEntry[],
  nowMs: number,
  lastLoggedAt: Map<string, number>,
): void {
  for (const entry of roster) {
    const correction = entry.backgroundWorkCorrection;
    if (correction === undefined) continue;
    const loggedAt = lastLoggedAt.get(entry.name);
    if (loggedAt !== undefined && nowMs - loggedAt < ONE_HOUR_MS) continue;
    lastLoggedAt.set(entry.name, nowMs);
    write(
      `no-idling: ${entry.name} reported ${correction.reportedStatus} by herdr, counted as working because it is running ${correction.description}\n`,
    );
  }
}
