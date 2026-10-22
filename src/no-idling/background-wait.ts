import type { AgentStatusesRosterEntry } from '../agent-statuses/agent-statuses.types.ts';
import {
  HARNESS_BACKGROUND_WORK_KINDS,
  type HarnessBackgroundWork,
} from '../process-inspection/harness-background-work.ts';
import { lastMessageBlock } from './idle-pane-tag-classification.ts';

export type ReadRunningWork = (agentName: string) => Promise<HarnessBackgroundWork>;

const WAITING_PHRASE =
  /\b(?:waiting[ \t]+(?:on|for)|queued|still[ \t]+running|when[ \t]+(?:it|they)[ \t]+(?:reports?|finish(?:es)?))\b/i;
const BACKGROUND_SUBJECT = /\b(?:runs?|suites?|monitors?|shells?|background[ \t]+agents?)\b/i;
const SENTENCE_END = /(?<=[.!?])\s+/;
const TRAILING_SENTENCE_PUNCTUATION = /[.!?]+$/;
const UNREADABLE_RUNNING_WORK: HarnessBackgroundWork = { kind: HARNESS_BACKGROUND_WORK_KINDS.UNKNOWN };

function saysItWaitsOnBackgroundWork(sentence: string): boolean {
  return WAITING_PHRASE.test(sentence) && BACKGROUND_SUBJECT.test(sentence);
}

export function waitingSentenceInMessage(message: string): string | undefined {
  const sentence = message
    .replace(/\s+/g, ' ')
    .trim()
    .split(SENTENCE_END)
    .find(saysItWaitsOnBackgroundWork);
  return sentence?.replace(TRAILING_SENTENCE_PUNCTUATION, '');
}

export function waitingSentenceInPane(output: string): string | undefined {
  return waitingSentenceInMessage(lastMessageBlock(output));
}

export function runningWorkDescription(work: HarnessBackgroundWork): string | undefined {
  return work.kind === HARNESS_BACKGROUND_WORK_KINDS.RUNNING ? work.description : undefined;
}

export function runningWorkOfRosterAgents(
  roster: readonly AgentStatusesRosterEntry[],
  readHarnessBackgroundWork: (paneId: string) => Promise<HarnessBackgroundWork>,
): ReadRunningWork {
  const paneIdByName = new Map(roster.map((entry) => [entry.name, entry.paneId]));
  return async (agentName) => {
    const paneId = paneIdByName.get(agentName);
    return paneId === undefined ? UNREADABLE_RUNNING_WORK : readHarnessBackgroundWork(paneId);
  };
}

async function readWaitingSentence(
  name: string,
  readPane: (name: string) => Promise<string>,
): Promise<string | undefined> {
  try {
    return waitingSentenceInPane(await readPane(name));
  } catch {
    return undefined;
  }
}

async function readWhatTheAgentWaitsOn(
  name: string,
  readRunningWork: ReadRunningWork,
  readPane: (name: string) => Promise<string>,
): Promise<string | undefined> {
  return runningWorkDescription(await readRunningWork(name)) ?? readWaitingSentence(name, readPane);
}

export async function withWhatEachAgentWaitsOn<Listed extends { readonly agent: string }>(
  listed: readonly Listed[],
  readRunningWork: ReadRunningWork,
  readPane: (name: string) => Promise<string>,
): Promise<(Listed & { readonly backgroundWork?: string })[]> {
  const described: (Listed & { readonly backgroundWork?: string })[] = [];
  for (const entry of listed) {
    const backgroundWork = await readWhatTheAgentWaitsOn(entry.agent, readRunningWork, readPane);
    described.push(backgroundWork === undefined ? entry : { ...entry, backgroundWork });
  }
  return described;
}
