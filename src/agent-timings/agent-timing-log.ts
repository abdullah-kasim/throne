import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { RUNTIME_DATA_DIR } from '../shared-policy/runtime-data-home.ts';
import { serializeAgentTimingRow, type AgentTimingRow } from './agent-timing.types.ts';

export const AGENT_TIMINGS_DIR = path.join(RUNTIME_DATA_DIR, 'stats');
export const AGENT_TIMINGS_FILE = path.join(AGENT_TIMINGS_DIR, 'agent-timings.jsonl');

export type AppendAgentTiming = (row: AgentTimingRow) => Promise<void>;
export type ReadAgentTimings = () => Promise<string>;

export function realAppendAgentTiming(file: string = AGENT_TIMINGS_FILE): AppendAgentTiming {
  return async (row) => {
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, serializeAgentTimingRow(row), 'utf8');
  };
}

export async function readAgentTimingsRaw(file: string = AGENT_TIMINGS_FILE): Promise<string> {
  try { return await readFile(file, 'utf8'); }
  catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') return '';
    throw err;
  }
}
