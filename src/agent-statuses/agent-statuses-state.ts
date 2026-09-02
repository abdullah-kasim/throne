import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { RUNTIME_DATA_DIR } from '../shared-policy/runtime-data-home.ts';
import {
  AGENT_STATUSES_DESIRED_STATES,
  type AgentStatusesDesiredState,
} from './agent-statuses.types.ts';

export const AGENT_STATUSES_REGENT_DIRECTORY = path.join(RUNTIME_DATA_DIR, 'regent');

export async function readAgentStatusesDesiredState(
  regentDirectory: string = AGENT_STATUSES_REGENT_DIRECTORY,
  readDesiredStateFile: typeof readFile = readFile,
): Promise<AgentStatusesDesiredState> {
  try {
    const value = (
      await readDesiredStateFile(
        path.join(regentDirectory, 'desired-state'),
        'utf8',
      )
    )
      .trim()
      .toLowerCase();
    return value === AGENT_STATUSES_DESIRED_STATES.DISMISSED
      ? AGENT_STATUSES_DESIRED_STATES.DISMISSED
      : AGENT_STATUSES_DESIRED_STATES.RUNNING;
  } catch {
    return AGENT_STATUSES_DESIRED_STATES.RUNNING;
  }
}

export function describeAgentStatusesDesiredState(
  state: AgentStatusesDesiredState,
): string {
  return state === AGENT_STATUSES_DESIRED_STATES.DISMISSED
    ? 'DISMISSED — the keep-going watchdog will NOT resurrect a dead Regent ' +
        '(run `summon-regent` to bring the court back).'
    : 'RUNNING — the keep-going watchdog resurrects a dead Regent ' +
        '(run `dismiss-regent` to stand the court down).';
}
