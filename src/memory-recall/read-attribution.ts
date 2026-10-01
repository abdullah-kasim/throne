import path from 'node:path';
import { claudeProjectDirectory } from '../session/runtime-model-acceptance.ts';
import type { AgentSpawnRecord } from './agent-spawn-records.ts';
import type { LoggedMemoryRead } from './recall-report-logs.ts';

export interface ReadAttribution {
  readonly attributedThroughPaneOrTranscriptDirectory: number;
  readonly stillUnattributed: number;
}

function millisecondsApart(left: LoggedMemoryRead, right: LoggedMemoryRead): number {
  return Math.abs(Date.parse(left.at) - Date.parse(right.at));
}

function agentNameThroughPane(
  read: LoggedMemoryRead,
  memoryReads: readonly LoggedMemoryRead[],
): string | undefined {
  if (read.herdrPaneId === null) return undefined;
  const namedReadsInThePane = memoryReads.filter(
    (other) => other.herdrPaneId === read.herdrPaneId && other.agentName !== null,
  );
  const nearest = namedReadsInThePane.sort(
    (left, right) => millisecondsApart(left, read) - millisecondsApart(right, read),
  )[0];
  return nearest?.agentName ?? undefined;
}

function agentNameThroughTranscriptDirectory(
  read: LoggedMemoryRead,
  agents: readonly AgentSpawnRecord[],
): string | undefined {
  if (read.transcriptPath === null) return undefined;
  const transcriptDirectory = path.dirname(read.transcriptPath);
  const projectsDirectory = path.dirname(transcriptDirectory);
  const agentNames = new Set(
    agents
      .filter(({ spawn }) => claudeProjectDirectory(spawn.cwd, projectsDirectory) === transcriptDirectory)
      .map(({ name }) => name),
  );
  return agentNames.size === 1 ? [...agentNames][0] : undefined;
}

export function readAttributionOf(
  memoryReads: readonly LoggedMemoryRead[],
  agents: readonly AgentSpawnRecord[],
): ReadAttribution {
  const readsWithNoAgentName = memoryReads.filter((read) => read.agentName === null);
  const attributed = readsWithNoAgentName.filter(
    (read) =>
      (agentNameThroughPane(read, memoryReads) ??
        agentNameThroughTranscriptDirectory(read, agents)) !== undefined,
  ).length;
  return {
    attributedThroughPaneOrTranscriptDirectory: attributed,
    stillUnattributed: readsWithNoAgentName.length - attributed,
  };
}
