import { cpSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  NO,
  YES,
  type ClassifierBackend,
} from '../relevance-classifier/classifier.types.ts';
import {
  SERVE_ARM,
  SHADOW_ARM,
  SPLIT_HOOK_MODE,
  type RecallArm,
} from '../relevance-classifier/recall-user-config.ts';
import {
  COMMAND_SOURCE,
  HOOK_SOURCE,
  PROMPT_LOG_FILE_NAME,
  RECALL_LEDGER_FILE_NAME,
  inputHash,
} from './recall-records.ts';
import {
  MEMORY_READ_FAILURE_LOG_FILE_NAME,
  MEMORY_READ_LOG_FILE_NAME,
} from './recall-report-logs.ts';
import type { HookOutcome } from './hook-outcome.ts';
import type { PromptKind } from './prompt-kind.ts';
import { MEMORY_LIKELY_EXISTS, NO_RELEVANT_MEMORY } from './recall-verdict.ts';
import { runRecall } from './recall.command.ts';
import { harness } from './recall.command.test-support.ts';

export const REPORT_TIME = new Date('2026-10-02T09:00:00Z');
const OLD_MEMORY_TIME = new Date('2026-09-01T00:00:00Z');
const NEW_MEMORY_TIME = new Date('2026-10-01T12:00:00Z');

interface FixtureRead {
  readonly minute: string;
  readonly tool: 'Read' | 'Grep' | 'Glob' | 'Bash';
  readonly memory: string;
  readonly readInFull?: boolean;
  readonly returnedSomething?: boolean;
  readonly contentHash?: string;
}

export interface FixtureAnswer {
  readonly memory: string;
  readonly pick: typeof YES | typeof NO;
  readonly probability: number;
}

export interface FixturePrompt {
  readonly label: string;
  readonly at: string;
  readonly sessionId: string;
  readonly topic: string;
  readonly arm: RecallArm;
  readonly served: readonly string[];
  readonly verdict: typeof MEMORY_LIKELY_EXISTS | typeof NO_RELEVANT_MEMORY;
  readonly confidence: number;
  readonly reads: readonly FixtureRead[];
  readonly promptKind?: PromptKind;
  readonly hookOutcome?: HookOutcome;
  readonly suppressed?: readonly string[];
  readonly correction?: boolean;
  readonly transcriptPath?: string;
  readonly compactAnswers?: readonly FixtureAnswer[];
  readonly everyAnswerLogged?: boolean;
}

export interface ReportFixture {
  readonly memoriesDirectory: string;
  readonly dataDirectory: string;
  memoryPath(fileName: string): string;
}

const MEMORY_TEXTS: Readonly<Record<string, string>> = {
  'RED.md': '# Red builds need the cache cleared topic-red\n\n- clear it first\n',
  'BLUE.md': '# Blue deploys need a dry run topic-blue\n\n- dry run first\n',
  'GREEN.md': '# Green tests need the fake clock topic-green\n\n- freeze time\n',
  'MEMORY.md': '# Index of topic-red topic-blue topic-green\n',
  'NEW_BLUE_AGAIN.md': '# Blue deploys want a dry run again topic-blue\n\n- dry run\n',
  'NEW_ORANGE.md': '# Orange queues drain slowly topic-orange\n\n- wait\n',
};

const NEW_MEMORIES = new Set(['NEW_BLUE_AGAIN.md', 'NEW_ORANGE.md']);

function fullRead(minute: string, memory: string): FixtureRead {
  return { minute, tool: 'Read', memory, readInFull: true };
}

function repeated(
  count: number,
  make: (number: number) => FixturePrompt,
): readonly FixturePrompt[] {
  return Array.from({ length: count }, (_, index) => make(index + 1));
}

function twoDigits(number: number): string {
  return String(number).padStart(2, '0');
}

export const FIXTURE_PROMPTS: readonly FixturePrompt[] = [
  { label: 'EARLY1', at: '2026-09-30T10:00:00.000Z', sessionId: 'e-1', topic: 'red', arm: SERVE_ARM, served: ['RED.md'], verdict: MEMORY_LIKELY_EXISTS, confidence: 0.8, reads: [] },
  { label: 'EARLY2', at: '2026-09-30T10:05:00.000Z', sessionId: 'e-2', topic: 'red', arm: SERVE_ARM, served: ['RED.md'], verdict: MEMORY_LIKELY_EXISTS, confidence: 0.8, reads: [] },
  ...repeated(32, (number) => ({
    label: `N${number}`,
    at: `2026-10-01T09:${twoDigits(number)}:00.000Z`,
    sessionId: `n-${number}`,
    topic: 'none',
    arm: SERVE_ARM,
    served: [],
    verdict: NO_RELEVANT_MEMORY,
    confidence: 0.95,
    reads: [fullRead(`09:${twoDigits(number)}:30`, 'RED.md')],
    promptKind: 'typed',
  })),
  { label: 'A', at: '2026-10-01T10:00:00.000Z', sessionId: 's1', topic: 'red', arm: SERVE_ARM, served: ['RED.md'], verdict: MEMORY_LIKELY_EXISTS, confidence: 0.8, reads: [], promptKind: 'relayed' },
  { label: 'B', at: '2026-10-01T10:10:00.000Z', sessionId: 's1', topic: 'blue', arm: SERVE_ARM, served: ['RED.md'], verdict: MEMORY_LIKELY_EXISTS, confidence: 0.7, reads: [fullRead('10:12:00', 'BLUE.md')], promptKind: 'relayed' },
  {
    label: 'C',
    at: '2026-10-01T10:20:00.000Z',
    sessionId: 's2',
    topic: 'green',
    arm: SERVE_ARM,
    served: [],
    verdict: NO_RELEVANT_MEMORY,
    confidence: 0.95,
    reads: [
      fullRead('10:21:00', 'RED.md'),
      { minute: '10:22:00', tool: 'Read', memory: 'GREEN.md', readInFull: false },
      { minute: '10:23:00', tool: 'Glob', memory: 'GREEN.md', returnedSomething: true },
      { minute: '10:24:00', tool: 'Grep', memory: 'GREEN.md', returnedSomething: false },
    ],
    promptKind: 'task-notification',
  },
  {
    label: 'D',
    at: '2026-10-01T11:00:00.000Z',
    sessionId: 's3',
    topic: 'blue',
    arm: SHADOW_ARM,
    served: [],
    verdict: NO_RELEVANT_MEMORY,
    confidence: 0.6,
    reads: [
      { minute: '11:01:00', tool: 'Grep', memory: 'BLUE.md', returnedSomething: true },
      { minute: '11:02:00', tool: 'Glob', memory: 'BLUE.md', returnedSomething: true },
    ],
    promptKind: 'relayed',
  },
  { label: 'E', at: '2026-10-01T11:10:00.000Z', sessionId: 's3', topic: 'red', arm: SHADOW_ARM, served: ['RED.md'], verdict: MEMORY_LIKELY_EXISTS, confidence: 0.9, reads: [fullRead('11:11:00', 'MEMORY.md')], promptKind: 'typed' },
  { label: 'F', at: '2026-10-01T11:20:00.000Z', sessionId: 's4', topic: 'red', arm: SHADOW_ARM, served: [], verdict: NO_RELEVANT_MEMORY, confidence: 0.99, reads: [], promptKind: 'task-notification' },
  ...repeated(11, (number) => ({
    label: `G${number}`,
    at: `2026-10-01T12:${twoDigits(number)}:00.000Z`,
    sessionId: `g-${number}`,
    topic: 'green',
    arm: SHADOW_ARM,
    served: [],
    verdict: NO_RELEVANT_MEMORY,
    confidence: 0.75,
    reads: [fullRead(`12:${twoDigits(number)}:30`, 'GREEN.md')],
    promptKind: 'typed',
  })),
];

export function promptTextOf(prompt: Pick<FixturePrompt, 'label' | 'topic'>): string {
  return `${prompt.label}: fix the topic-${prompt.topic} problem`;
}

function jsonLines(lines: readonly object[]): string {
  return lines.map((line) => `${JSON.stringify(line)}\n`).join('');
}

function ledgerLinesOf(
  prompt: FixturePrompt,
  memoriesDirectory: string,
  memoryPath: (fileName: string) => string,
): object[] {
  const hash = inputHash(promptTextOf(prompt));
  const suppressed = prompt.suppressed ?? [];
  const decisionFiles = [...(prompt.served.length > 0 ? prompt.served : ['RED.md']), ...suppressed];
  return [
    {
      at: prompt.at,
      inputHash: hash,
      source: HOOK_SOURCE,
      sessionId: prompt.sessionId,
      arm: prompt.arm,
      hookMode: SPLIT_HOOK_MODE,
      verdict: prompt.verdict,
      verdictConfidence: prompt.confidence,
      searchedMemoryDirectories: [memoriesDirectory],
      promptKind: prompt.promptKind,
      hookOutcome: prompt.hookOutcome,
      questionsAsked: 3,
      served: prompt.served.length,
      confidentNoAnswersLeftOut: 2,
      ...(prompt.everyAnswerLogged === true ? { everyAnswerLogged: true } : {}),
    },
    ...decisionFiles.map((fileName) => ({
      at: prompt.at,
      questionId: memoryPath(fileName),
      inputHash: hash,
      pick: prompt.served.includes(fileName) ? YES : NO,
      probability: 0.8,
      backend: 'jev',
      failedOpen: false,
      served: prompt.served.includes(fileName),
      ...(suppressed.includes(fileName) ? { suppressed: true, servedEarlierAt: null } : {}),
      arm: prompt.arm,
      sessionId: prompt.sessionId,
    })),
    ...(prompt.compactAnswers ?? []).map((answer) => ({
      at: prompt.at,
      inputHash: hash,
      questionId: memoryPath(answer.memory),
      pick: answer.pick,
      probability: answer.probability,
    })),
  ];
}

function memoryReadLine(
  sessionId: string | null,
  at: string,
  read: FixtureRead,
  memoryPath: (fileName: string) => string,
): object {
  const kind = read.tool === 'Read' ? 'read' : read.tool === 'Glob' ? 'list' : 'search';
  const namesTheFile = read.tool === 'Read' || read.returnedSomething === true;
  return {
    at,
    sessionId,
    agentName: null,
    tool: read.tool,
    kind,
    target: read.tool === 'Read' ? memoryPath(read.memory) : 'topic',
    memoryFiles: namesTheFile ? [memoryPath(read.memory)] : [],
    returnedSomething: read.tool === 'Read' || read.returnedSomething === true,
    readInFull: read.readInFull === true,
    transcriptPath: null,
    cwd: null,
    ...(read.contentHash === undefined
      ? {}
      : { memoryFileHashes: { [memoryPath(read.memory)]: read.contentHash } }),
  };
}

function unattributedReadLines(memoryPath: (fileName: string) => string): object[] {
  return [
    memoryReadLine(null, '2026-10-01T10:30:00.000Z', fullRead('', 'BLUE.md'), memoryPath),
    memoryReadLine('lonely', '2026-10-01T10:31:00.000Z', fullRead('', 'BLUE.md'), memoryPath),
    memoryReadLine('s3', '2026-10-01T10:59:00.000Z', fullRead('', 'BLUE.md'), memoryPath),
  ];
}

function correctionVerdictLineOf(prompt: FixturePrompt): object {
  if (prompt.correction === undefined) return {};
  return {
    correction: { pick: prompt.correction ? YES : NO, probability: 0.9, backend: 'jev', failedOpen: false },
  };
}

function writeMemories(
  memoriesDirectory: string,
  extraMemoryTexts: Readonly<Record<string, string>>,
): void {
  for (const [fileName, text] of Object.entries({ ...MEMORY_TEXTS, ...extraMemoryTexts })) {
    const filePath = path.join(memoriesDirectory, fileName);
    writeFileSync(filePath, text);
    const modifiedAt = NEW_MEMORIES.has(fileName) ? NEW_MEMORY_TIME : OLD_MEMORY_TIME;
    utimesSync(filePath, modifiedAt, modifiedAt);
  }
}

export function buildReportFixture(
  prompts: readonly FixturePrompt[] = FIXTURE_PROMPTS,
  extraMemoryTexts: Readonly<Record<string, string>> = {},
): ReportFixture {
  const root = mkdtempSync(path.join(tmpdir(), 'recall-report-'));
  const memoriesDirectory = path.join(root, 'memories');
  const dataDirectory = path.join(root, 'data');
  mkdirSync(memoriesDirectory);
  mkdirSync(dataDirectory);
  writeMemories(memoriesDirectory, extraMemoryTexts);
  const memoryPath = (fileName: string): string => path.join(memoriesDirectory, fileName);
  const commandSummary = { at: '2026-10-01T10:40:00.000Z', inputHash: 'command', source: COMMAND_SOURCE, sessionId: null, arm: SERVE_ARM, verdict: NO_RELEVANT_MEMORY, verdictConfidence: 1, questionsAsked: 3, served: 0, confidentNoAnswersLeftOut: 3 };
  const rankLine = { at: '2026-10-01T10:41:00.000Z', command: 'rank', questionId: memoryPath('RED.md'), inputHash: 'rank', probability: 0.5, backend: 'jev' };
  writeFileSync(
    path.join(dataDirectory, RECALL_LEDGER_FILE_NAME),
    jsonLines([...prompts.flatMap((prompt) => ledgerLinesOf(prompt, memoriesDirectory, memoryPath)), commandSummary, rankLine]),
  );
  writeFileSync(
    path.join(dataDirectory, PROMPT_LOG_FILE_NAME),
    jsonLines(
      prompts.map((prompt) => ({
        at: prompt.at,
        sessionId: prompt.sessionId,
        inputHash: inputHash(promptTextOf(prompt)),
        prompt: promptTextOf(prompt),
        promptKind: prompt.promptKind,
        transcriptPath: prompt.transcriptPath ?? null,
        ...correctionVerdictLineOf(prompt),
      })),
    ),
  );
  writeFileSync(
    path.join(dataDirectory, MEMORY_READ_LOG_FILE_NAME),
    jsonLines([
      ...unattributedReadLines(memoryPath),
      ...prompts.flatMap((prompt) =>
        prompt.reads.map((read) =>
          memoryReadLine(prompt.sessionId, `${prompt.at.slice(0, 11)}${read.minute}.000Z`, read, memoryPath),
        ),
      ),
    ]),
  );
  writeFileSync(
    path.join(dataDirectory, MEMORY_READ_FAILURE_LOG_FILE_NAME),
    jsonLines([
      { at: '2026-09-30T12:00:00.000Z', error: 'disk full' },
      { at: '2026-10-01T12:00:00.000Z', error: 'disk full' },
    ]),
  );
  return { memoriesDirectory, dataDirectory, memoryPath };
}

function topicsIn(text: string | undefined): ReadonlySet<string> {
  return new Set(text?.match(/topic-[a-z]+/g) ?? []);
}

function shareATopic(left: string | undefined, right: string | undefined): boolean {
  const rightTopics = topicsIn(right);
  return [...topicsIn(left)].some((topic) => rightTopics.has(topic));
}

export interface TopicBackend extends ClassifierBackend {
  judgeQuestionCount(): number;
}

export function topicBackend(): TopicBackend {
  let judgeQuestions = 0;
  return {
    name: 'jev',
    judgeQuestionCount: () => judgeQuestions,
    answer: (state, questions) => {
      const fields = typeof state === 'string' ? { task: state } : state;
      const isJudgeRequest = 'memory' in fields;
      if (isJudgeRequest) judgeQuestions += questions.length;
      return Promise.resolve(
        questions.map((question) => {
          const field = question.stateField ?? '';
          const judged = isJudgeRequest ? fields.memory : fields[field];
          const against = isJudgeRequest ? fields[field] : question.instructions;
          return {
            questionId: question.id,
            pick: shareATopic(judged, against) ? YES : NO,
            probability: 0.9,
          };
        }),
      );
    },
  };
}

export const FAILING_JEV_BACKEND: ClassifierBackend = {
  name: 'jev',
  answer: () => Promise.reject(new Error('Jev is down')),
};

export interface ReportRun {
  readonly exitCode: number;
  readonly output: string;
  readonly dataDirectory: string;
}

export function copyOfFixtureData(fixture: ReportFixture): string {
  const dataDirectory = mkdtempSync(path.join(tmpdir(), 'recall-report-data-'));
  cpSync(fixture.dataDirectory, dataDirectory, { recursive: true });
  return dataDirectory;
}

export async function reportOn(
  fixture: ReportFixture,
  options: {
    readonly backend: ClassifierBackend;
    readonly flags?: readonly string[];
    readonly dataDirectory?: string;
    readonly rankAllowedRoots?: readonly string[];
    readonly agentLedgerDirectory?: string;
    readonly everyMemoryDirectory?: readonly string[];
    readonly jevDataHome?: string;
  },
): Promise<ReportRun> {
  const dataDirectory = options.dataDirectory ?? copyOfFixtureData(fixture);
  const run = harness({ rankAllowedRoots: options.rankAllowedRoots ?? [] });
  const exitCode = await runRecall(['--report', ...(options.flags ?? [])], {
    ...run.dependencies,
    dataDirectory,
    chooseBackend: () => Promise.resolve(options.backend),
    memoryDirectoriesForRepeats: () =>
      Promise.resolve(options.everyMemoryDirectory ?? [fixture.memoriesDirectory]),
    now: () => REPORT_TIME,
    ...(options.agentLedgerDirectory === undefined
      ? {}
      : { agentLedgerDirectory: options.agentLedgerDirectory }),
    ...(options.jevDataHome === undefined ? {} : { jevDataHome: options.jevDataHome }),
  });
  return { exitCode, output: run.stdout.join(''), dataDirectory };
}
