import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { RankItem } from '../item-rank/rank-items.ts';
import {
  NO,
  YES,
  yesOrNoQuestion,
  type ClassifierBackend,
  type ClassifierBackendName,
  type FailOpenQuestion,
} from '../relevance-classifier/classifier.types.ts';
import { askFailingOpen } from '../relevance-classifier/fail-open-classifier.ts';
import { RULES_BACKEND } from '../relevance-classifier/rules-backend.ts';
import { parseMemory } from './memory-files.ts';
import { MEMORY_VERSIONS_DIRECTORY_NAME } from './memory-versions.ts';
import { readLogLines, type LogLine } from './recall-report-logs.ts';
import { relevanceRuleOf } from './select-memories.ts';

export const GRADES_FILE_NAME = 'grades.jsonl';
export const RELEVANT_TO_PROMPT = 'relevant-to-prompt';
export const SAME_LESSON = 'same-lesson';
export const SAME_INCIDENT = 'same-incident';
export const COVERS_THE_CORRECTION = 'covers-the-correction';
export const ACTED_ON = 'acted-on';
export type GradeQuestion =
  | typeof RELEVANT_TO_PROMPT
  | typeof SAME_LESSON
  | typeof SAME_INCIDENT
  | typeof COVERS_THE_CORRECTION
  | typeof ACTED_ON;

const MEMORY_STATE_FIELD = 'memory';
const GRADES_ASKED_AT_ONCE = 8;

const JUDGE_QUESTIONS: Readonly<
  Record<GradeQuestion, { readonly field: string; readonly instructions: string }>
> = {
  [RELEVANT_TO_PROMPT]: {
    field: 'task',
    instructions: `Does the recorded lesson in \`${MEMORY_STATE_FIELD}\` apply to the work described in \`task\`?`,
  },
  [SAME_LESSON]: {
    field: 'new_lesson',
    instructions: `Does the recorded lesson in \`${MEMORY_STATE_FIELD}\` already teach the lesson recorded in \`new_lesson\`?`,
  },
  [SAME_INCIDENT]: {
    field: 'new_note',
    instructions: `Does the note in \`${MEMORY_STATE_FIELD}\` record the same incident as the note in \`new_note\`?`,
  },
  [COVERS_THE_CORRECTION]: {
    field: 'correction',
    instructions: `Does the recorded lesson in \`${MEMORY_STATE_FIELD}\` already teach what the person corrects or overrules in \`correction\`?`,
  },
  [ACTED_ON]: {
    field: 'assistant_turns',
    instructions: `Do the agent's turns in \`assistant_turns\` cite the recorded lesson in \`${MEMORY_STATE_FIELD}\` or follow its "How to apply"?`,
  },
};

export interface Grade {
  readonly at: string;
  readonly question: GradeQuestion;
  readonly against: string;
  readonly memoryFile: string;
  readonly pick: string;
  readonly probability: number;
  readonly backend: ClassifierBackendName;
  readonly failedOpen: boolean;
  readonly contentHash?: string;
}

export interface GradeRequest {
  readonly question: GradeQuestion;
  readonly against: string;
  readonly againstText: string;
  readonly memoryFile: string;
  readonly contentHash?: string;
}

export interface Judge {
  readonly backend: ClassifierBackend;
  readonly dataDirectory: string;
  now(): Date;
}

export function gradeKey(
  question: GradeQuestion,
  against: string,
  memoryFile: string,
): string {
  return `${question}\n${against}\n${memoryFile}`;
}

function keyOf(grade: Grade | GradeRequest): string {
  return gradeKey(grade.question, grade.against, grade.memoryFile);
}

function versionedKeyOf(grade: Grade | GradeRequest): string {
  return `${keyOf(grade)}\n${grade.contentHash ?? ''}`;
}

export function isRelevant(grade: Grade | undefined): boolean {
  return grade?.pick === YES;
}

function isGradeQuestion(value: unknown): value is GradeQuestion {
  return typeof value === 'string' && Object.hasOwn(JUDGE_QUESTIONS, value);
}

function isGrade(line: LogLine): line is LogLine & Grade {
  return (
    isGradeQuestion(line.question) &&
    typeof line.against === 'string' &&
    typeof line.memoryFile === 'string' &&
    typeof line.pick === 'string'
  );
}

export async function readStoredGrades(
  dataDirectory: string,
): Promise<ReadonlyMap<string, Grade>> {
  const lines = await readLogLines(path.join(dataDirectory, GRADES_FILE_NAME));
  return new Map(
    lines.filter(isGrade).map((grade) => [versionedKeyOf(grade), grade]),
  );
}

function judgeQuestion(request: GradeRequest, memory: RankItem): FailOpenQuestion {
  const { field, instructions } = JUDGE_QUESTIONS[request.question];
  return {
    ...yesOrNoQuestion(
      request.memoryFile,
      instructions,
      relevanceRuleOf(parseMemory(memory.id, memory.text)),
      field,
    ),
    safePick: NO,
    minimumProbabilityOfSafePick: 1,
  };
}

async function memoryItemReadFrom(
  memoryFile: string,
  textPath: string,
): Promise<RankItem | undefined> {
  try {
    return { id: memoryFile, text: await readFile(textPath, 'utf8'), mayBeSentToJev: true };
  } catch {
    return undefined;
  }
}

export function memoryItemOf(memoryFile: string): Promise<RankItem | undefined> {
  return memoryItemReadFrom(memoryFile, memoryFile);
}

async function memoryItemAsSeen(
  request: GradeRequest,
  dataDirectory: string,
): Promise<RankItem | undefined> {
  const keptVersion =
    request.contentHash === undefined
      ? undefined
      : await memoryItemReadFrom(
          request.memoryFile,
          path.join(dataDirectory, MEMORY_VERSIONS_DIRECTORY_NAME, request.contentHash),
        );
  return keptVersion ?? (await memoryItemOf(request.memoryFile));
}

async function askTheJudge(
  request: GradeRequest,
  judge: Judge,
): Promise<Grade | undefined> {
  const memory = await memoryItemAsSeen(request, judge.dataDirectory);
  if (memory === undefined) return undefined;
  const [answer] = await askFailingOpen(
    judge.backend,
    {
      [JUDGE_QUESTIONS[request.question].field]: request.againstText,
      [MEMORY_STATE_FIELD]: memory.text,
    },
    [judgeQuestion(request, memory)],
    { writeStderr: () => undefined },
    { backendWhenTheFirstFails: judge.backend === RULES_BACKEND ? undefined : RULES_BACKEND },
  );
  if (answer === undefined) return undefined;
  return {
    at: judge.now().toISOString(),
    question: request.question,
    against: request.against,
    memoryFile: request.memoryFile,
    pick: answer.pick,
    probability: answer.probability,
    backend: answer.backend,
    failedOpen: answer.failedOpen,
    ...(request.contentHash === undefined ? {} : { contentHash: request.contentHash }),
  };
}

async function storeGrades(dataDirectory: string, grades: readonly Grade[]): Promise<void> {
  if (grades.length === 0) return;
  await mkdir(dataDirectory, { recursive: true });
  await appendFile(
    path.join(dataDirectory, GRADES_FILE_NAME),
    grades.map((grade) => `${JSON.stringify(grade)}\n`).join(''),
  );
}

export async function gradeEach(
  requests: readonly GradeRequest[],
  judge: Judge,
): Promise<ReadonlyMap<string, Grade>> {
  const stored = await readStoredGrades(judge.dataDirectory);
  const unasked = [
    ...new Map(
      requests
        .filter((request) => !stored.has(versionedKeyOf(request)))
        .map((request) => [versionedKeyOf(request), request]),
    ).values(),
  ];
  const newGrades: Grade[] = [];
  for (let start = 0; start < unasked.length; start += GRADES_ASKED_AT_ONCE) {
    const group = unasked.slice(start, start + GRADES_ASKED_AT_ONCE);
    const answers = await Promise.all(group.map((request) => askTheJudge(request, judge)));
    newGrades.push(...answers.filter((grade) => grade !== undefined));
  }
  await storeGrades(judge.dataDirectory, newGrades);
  const allGrades = new Map([
    ...stored,
    ...newGrades.map((grade) => [versionedKeyOf(grade), grade] as const),
  ]);
  return new Map(
    requests.flatMap((request) => {
      const grade = allGrades.get(versionedKeyOf(request));
      return grade === undefined ? [] : [[keyOf(request), grade] as const];
    }),
  );
}
