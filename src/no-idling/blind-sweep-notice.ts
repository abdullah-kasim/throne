import {
  AGENT_LIFECYCLE_STATES,
  type AgentStatusesRosterEntry,
} from '../agent-statuses/agent-statuses.types.ts';
import { errorText } from '../shared-policy/error-text.ts';
import { NO_IDLING_REGENT_NAME } from './idle-family.ts';
import type { BlindSweepMemory, NoIdlingDependencies } from './no-idling-dependencies.types.ts';
import {
  NO_IDLING_SENDER,
  NO_IDLING_SUBMIT_TIMEOUT_MS,
  regentAcceptsNotice,
  writeErr,
  writeOut,
} from './no-idling-notify-guard.ts';

export const BLIND_SWEEPS_BEFORE_NOTICE = 10;

function commonestDescription(descriptions: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const description of descriptions) counts.set(description, (counts.get(description) ?? 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]![0];
}

export async function notifyRegentWhenSweepIsBlind(
  deps: NoIdlingDependencies,
  roster: readonly AgentStatusesRosterEntry[],
  memory: BlindSweepMemory,
): Promise<void> {
  if (memory.noticeSent) return;
  const liveWorkers = roster.filter(
    (entry) =>
      entry.lifecycle === AGENT_LIFECYCLE_STATES.LIVE && (entry.role === 'Alpha' || entry.role === 'Shadow'),
  );
  if (liveWorkers.length === 0) return;
  const descriptions = liveWorkers.map((entry) => entry.backgroundWorkCorrection?.description);
  if (descriptions.some((description) => description === undefined)) {
    memory.blindSweepsInARow = 0;
    return;
  }
  memory.blindSweepsInARow += 1;
  if (memory.blindSweepsInARow < BLIND_SWEEPS_BEFORE_NOTICE) return;
  const commonest = commonestDescription(descriptions as string[]);
  try {
    const regent = await deps.resolveAgent(NO_IDLING_REGENT_NAME);
    if (!regentAcceptsNotice(regent.agentStatus)) {
      writeOut(deps, `no-idling: Regent is ${regent.agentStatus}; deferred blind-sweep notice\n`);
      return;
    }
    await deps.submitToAgent(
      regent,
      NO_IDLING_SENDER,
      `no-idling: for ${memory.blindSweepsInARow} sweeps in a row every live Alpha and Shadow was counted as working only because of background work, so the idle sweep cannot see idle agents. The commonest process: ${commonest}`,
      { key: 'no-idling-blind-sweep', composerWaitMilliseconds: NO_IDLING_SUBMIT_TIMEOUT_MS },
    );
    memory.noticeSent = true;
    writeOut(deps, `no-idling: told Regent the sweep is blind; commonest process ${commonest}\n`);
  } catch (error) {
    writeErr(deps, `no-idling: Regent blind-sweep notice failed: ${errorText(error)}\n`);
  }
}
