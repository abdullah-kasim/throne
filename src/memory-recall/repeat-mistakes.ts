import { glob, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { mostLikelyFirst, rankItemsByQuestion } from '../item-rank/rank-by-question.ts';
import type { RankItem } from '../item-rank/rank-items.ts';
import {
  pathWithHomeExpanded,
  type RecallConfig,
} from '../relevance-classifier/recall-user-config.ts';
import {
  SAME_INCIDENT,
  SAME_LESSON,
  gradeEach,
  gradeKey,
  isRelevant,
  memoryItemOf,
  type Grade,
  type GradeQuestion,
  type Judge,
} from './dig-grades.ts';
import { creationTimesOf } from './memory-creation-times.ts';
import {
  parseMemory,
  projectMemoryDirectoryPattern,
  readMemoriesInEachDirectoryOnce,
} from './memory-files.ts';

export interface MemoryPair {
  readonly newMemory: string;
  readonly existingMemory: string;
}

export interface RepeatMistakeFindings {
  readonly checkedMemoryCount: number;
  readonly repeats: readonly MemoryPair[];
  readonly duplicates: readonly MemoryPair[];
  readonly grades: readonly Grade[];
}

export const NO_REPEAT_MISTAKE_FINDINGS: RepeatMistakeFindings = {
  checkedMemoryCount: 0,
  repeats: [],
  duplicates: [],
  grades: [],
};

const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

interface DatedMemory {
  readonly item: RankItem;
  readonly modifiedAt: number;
}

export async function productionMemoryDirectoriesForRepeats(
  config: RecallConfig,
  homeDirectory: string = homedir(),
): Promise<readonly string[]> {
  const patterns = [
    projectMemoryDirectoryPattern(homeDirectory),
    path.join(homeDirectory, '.throne', 'memories', '*'),
    path.join(homeDirectory, '.claude', 'projects', '*', 'memory'),
  ];
  const directories: string[] = [];
  for (const pattern of patterns) {
    for await (const match of glob(pattern)) directories.push(match);
  }
  return [
    ...directories,
    ...config.globalMemoryDirectories.map((directory) => pathWithHomeExpanded(directory)),
  ];
}

async function datedMemoriesIn(
  directories: readonly string[],
): Promise<readonly DatedMemory[]> {
  const memories = await readMemoriesInEachDirectoryOnce(directories);
  const items = (
    await Promise.all(memories.map((memory) => memoryItemOf(memory.filePath)))
  ).filter((item) => item !== undefined);
  return Promise.all(
    items.map(async (item) => ({ item, modifiedAt: (await stat(item.id)).mtimeMs })),
  );
}

function titleOf(item: RankItem): string {
  const memory = parseMemory(item.id, item.text);
  const firstLine = memory.body.split('\n').find((line) => line.trim().length > 0);
  return firstLine?.replace(/^#+\s*/, '').trim() ?? memory.fileName;
}

async function closestEarlierMemory(
  newMemory: DatedMemory,
  earlierMemories: readonly DatedMemory[],
  judge: Judge,
): Promise<string | undefined> {
  const question = `Does this recorded lesson teach the same thing as "${titleOf(newMemory.item)}"?`;
  const outcome = await rankItemsByQuestion(
    judge.backend,
    question,
    earlierMemories.map((memory) => memory.item),
  );
  if (outcome.failed) return undefined;
  return [...outcome.ranked].sort(mostLikelyFirst)[0]?.id;
}

interface SameLessonPair {
  readonly newMemory: DatedMemory;
  readonly existingMemory: string;
}

interface DatedPair extends SameLessonPair {
  readonly incidentDay: string;
  readonly existingMemoryDay: string;
}

function dayOf(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

function incidentDayOf(
  memory: DatedMemory,
  creationTimes: ReadonlyMap<string, number>,
): string {
  const { learned } = parseMemory(memory.item.id, memory.item.text).frontmatter;
  if (learned !== undefined && CALENDAR_DAY.test(learned)) return learned;
  return dayOf(creationTimes.get(memory.item.id) ?? memory.modifiedAt);
}

function gradeRequestFor(question: GradeQuestion, { newMemory, existingMemory }: SameLessonPair) {
  return {
    question,
    against: newMemory.item.id,
    againstText: newMemory.item.text,
    memoryFile: existingMemory,
  };
}

function isAnswerYes(
  grades: ReadonlyMap<string, Grade>,
  question: GradeQuestion,
  { newMemory, existingMemory }: SameLessonPair,
): boolean {
  return isRelevant(grades.get(gradeKey(question, newMemory.item.id, existingMemory)));
}

function namesOf({ newMemory, existingMemory }: SameLessonPair): MemoryPair {
  return { newMemory: newMemory.item.id, existingMemory };
}

export async function repeatMistakesSince(
  windowStart: Date,
  memoryDirectories: readonly string[],
  firstSightingOfEachMemory: ReadonlyMap<string, number>,
  judge: Judge,
): Promise<RepeatMistakeFindings> {
  const memories = await datedMemoriesIn(memoryDirectories);
  const newMemories = memories.filter(
    (memory) => memory.modifiedAt >= windowStart.getTime(),
  );
  const candidates: SameLessonPair[] = [];
  for (const newMemory of newMemories) {
    const existingMemory = await closestEarlierMemory(
      newMemory,
      memories.filter((memory) => memory.modifiedAt < newMemory.modifiedAt),
      judge,
    );
    if (existingMemory !== undefined) candidates.push({ newMemory, existingMemory });
  }
  const lessonGrades = await gradeEach(
    candidates.map((pair) => gradeRequestFor(SAME_LESSON, pair)),
    judge,
  );
  const sameLessonPairs = candidates.filter((pair) => isAnswerYes(lessonGrades, SAME_LESSON, pair));
  const creationTimes = await creationTimesOf(
    sameLessonPairs.flatMap(({ newMemory, existingMemory }) => [newMemory.item.id, existingMemory]),
    firstSightingOfEachMemory,
  );
  const datedPairs: readonly DatedPair[] = sameLessonPairs.flatMap((pair) => {
    const existingMemoryCreatedAt = creationTimes.get(pair.existingMemory);
    if (existingMemoryCreatedAt === undefined) return [];
    return [
      {
        ...pair,
        incidentDay: incidentDayOf(pair.newMemory, creationTimes),
        existingMemoryDay: dayOf(existingMemoryCreatedAt),
      },
    ];
  });
  const sameDayPairs = datedPairs.filter((pair) => pair.existingMemoryDay === pair.incidentDay);
  const incidentGrades = await gradeEach(
    sameDayPairs.map((pair) => gradeRequestFor(SAME_INCIDENT, pair)),
    judge,
  );
  const duplicates = sameDayPairs.filter((pair) => isAnswerYes(incidentGrades, SAME_INCIDENT, pair));
  return {
    checkedMemoryCount: newMemories.length,
    repeats: datedPairs
      .filter(
        (pair) =>
          pair.existingMemoryDay < pair.incidentDay ||
          (pair.existingMemoryDay === pair.incidentDay && !duplicates.includes(pair)),
      )
      .map(namesOf),
    duplicates: duplicates.map(namesOf),
    grades: [...lessonGrades.values(), ...incidentGrades.values()],
  };
}
