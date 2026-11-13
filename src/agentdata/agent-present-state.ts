import { stat } from 'node:fs/promises';
import path from 'node:path';
import { claudeProjectsFolderOf } from '../account/agent-account.ts';
import { modifiedTimeOf, transcriptTextOf } from '../delivery-receipt/delivery-receipt-check.ts';
import { isClaudeBranchHarness } from '../herdr/herdr-send.helpers.ts';
import { lastAssistantText } from '../memory-recall/transcript-turns.ts';
import { claudeTranscriptPathFor } from '../session/runtime-model-acceptance.ts';
import { DEFAULT_DATA_DIR, isArchivedOnReap } from './ledger-data.service.ts';
import { readSpawnSpec, type SpawnSpec } from './spawn-data-contracts.ts';
import { isWithinSpawnGrace, spawnedAtAgeMs } from './spawn-starting.ts';

export interface AgentPresentState {
  readonly reaped: boolean;
  readonly lastTranscriptWriteMs?: number;
  readonly lastText?: string;
  readonly spawnAgeMs?: number;
  readonly withinSpawnGrace: boolean;
}

export interface AgentPresentStateSources {
  readonly dataDir?: string;
  readonly claudeProjectsDirectory?: string;
}

async function hasLiveLedger(name: string, dataDir: string): Promise<boolean> {
  try {
    await stat(path.join(dataDir, name));
    return true;
  } catch {
    return false;
  }
}

async function transcriptPathOf(
  spec: SpawnSpec | null,
  claudeProjectsDirectory: string | undefined,
): Promise<string | undefined> {
  if (spec === null || !isClaudeBranchHarness(spec.harness)) return undefined;
  return claudeTranscriptPathFor(
    spec.cwd,
    spec.session_id,
    claudeProjectsDirectory ?? claudeProjectsFolderOf(spec.account),
  );
}

export async function readAgentPresentState(
  name: string,
  nowMs: number,
  sources: AgentPresentStateSources = {},
): Promise<AgentPresentState> {
  const dataDir = sources.dataDir ?? DEFAULT_DATA_DIR;
  const reaped = !(await hasLiveLedger(name, dataDir)) && (await isArchivedOnReap(name, dataDir));
  const spec = reaped ? null : await readSpawnSpec(name, dataDir);
  const transcriptPath = await transcriptPathOf(spec, sources.claudeProjectsDirectory);
  const lastTranscriptWriteMs =
    transcriptPath === undefined ? undefined : await modifiedTimeOf(transcriptPath);
  const lastText =
    transcriptPath === undefined ? undefined : lastAssistantText(await transcriptTextOf(transcriptPath));
  const spawnAgeMs = spawnedAtAgeMs(spec?.spawned_at, nowMs);
  return {
    reaped,
    ...(lastTranscriptWriteMs === undefined ? {} : { lastTranscriptWriteMs }),
    ...(lastText === undefined ? {} : { lastText }),
    ...(spawnAgeMs === undefined ? {} : { spawnAgeMs }),
    withinSpawnGrace: isWithinSpawnGrace(spec, nowMs),
  };
}

export const TRANSCRIPT_ACTIVITY_WINDOW_MS = 2 * 60 * 1000;

export function wroteTranscriptWithinActivityWindow(state: AgentPresentState, nowMs: number): boolean {
  return state.lastTranscriptWriteMs !== undefined && nowMs - state.lastTranscriptWriteMs < TRANSCRIPT_ACTIVITY_WINDOW_MS;
}
