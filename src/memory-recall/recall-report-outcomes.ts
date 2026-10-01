import path from 'node:path';
import {
  hadDig,
  memoriesTheDigTurnedUp,
  type PromptAndItsDig,
} from './dig-episodes.ts';
import { RELEVANT_TO_PROMPT, gradeKey, isRelevant, type Grade } from './dig-grades.ts';
import { NOTHING_FOUND, type DigScope } from './dig-scope.ts';
import { isFailedHookRun } from './hook-outcome.ts';
import { isCreatedAfter } from './memory-creation-times.ts';

export interface Rate {
  readonly count: number;
  readonly outOf: number;
}

export interface PromptOutcome {
  readonly entry: PromptAndItsDig;
  readonly dug: boolean;
  readonly servedSomethingRelevant: boolean;
  readonly foundRelevantUnserved: readonly string[];
  readonly foundRelevantOutsideTheScope: readonly string[];
  readonly everyOutsideFindFollowedAScopedRecall: boolean;
  readonly someOutsideFindWasInAListedRepository: boolean;
  readonly digFoundSomething: boolean;
  readonly afterAFailedHookRun: boolean;
  readonly foundAfterAFailedHookRun: readonly string[];
  readonly foundItsOwnLaterNote: readonly string[];
  readonly foundAlreadyShown: readonly string[];
}

export interface WhatCountsAsAFind {
  readonly promptGrades: ReadonlyMap<string, Grade>;
  readonly digScopes: ReadonlyMap<PromptAndItsDig, DigScope>;
  readonly memoryCreationTimes: ReadonlyMap<string, number>;
  readonly physicalPathOfEachMemory: ReadonlyMap<string, string>;
}

export function isSameMemoryAsOneOf(
  memoryFiles: Iterable<string>,
  physicalPathOfEachMemory: ReadonlyMap<string, string>,
): (memoryFile: string) => boolean {
  const physicalPathOf = (memoryFile: string): string =>
    physicalPathOfEachMemory.get(memoryFile) ?? memoryFile;
  const physicalMemoryFiles = new Set([...memoryFiles].map(physicalPathOf));
  return (memoryFile) => physicalMemoryFiles.has(physicalPathOf(memoryFile));
}

function shownEarlierInTheSession(
  entries: readonly PromptAndItsDig[],
): ReadonlyMap<PromptAndItsDig, ReadonlySet<string>> {
  const servedBySession = new Map<string, Set<string>>();
  return new Map(
    entries.map((entry) => {
      const { sessionId, servedFiles } = entry.prompt;
      if (sessionId === null) return [entry, new Set<string>()];
      const servedEarlier = new Set(servedBySession.get(sessionId) ?? []);
      servedBySession.set(sessionId, new Set([...servedEarlier, ...servedFiles]));
      return [entry, servedEarlier];
    }),
  );
}

function isInOneOfTheDirectories(
  memoryDirectories: readonly string[],
  physicalPathOfEachMemory: ReadonlyMap<string, string>,
): (memoryFile: string) => boolean {
  const directories = new Set(memoryDirectories);
  return (memoryFile) =>
    directories.has(path.dirname(memoryFile)) ||
    directories.has(path.dirname(physicalPathOfEachMemory.get(memoryFile) ?? memoryFile));
}

function outcomeOf(
  entry: PromptAndItsDig,
  findRules: WhatCountsAsAFind,
  servedEarlierInTheSession: ReadonlySet<string>,
): PromptOutcome {
  const { prompt } = entry;
  const digScope = findRules.digScopes.get(entry) ?? NOTHING_FOUND;
  const isRelevantToThePrompt = (memoryFile: string): boolean =>
    isRelevant(findRules.promptGrades.get(gradeKey(RELEVANT_TO_PROMPT, prompt.inputHash, memoryFile)));
  const isOutsideTheScope = (memoryFile: string): boolean =>
    digScope.memoriesOutsideTheScope.has(memoryFile);
  const wasCreatedAfterThePrompt = (memoryFile: string): boolean =>
    isCreatedAfter(memoryFile, prompt.at, findRules.memoryCreationTimes);
  const wasServed = isSameMemoryAsOneOf(prompt.servedFiles, findRules.physicalPathOfEachMemory);
  const wasAlreadyShown = isSameMemoryAsOneOf(
    [...prompt.suppressedFiles, ...servedEarlierInTheSession],
    findRules.physicalPathOfEachMemory,
  );
  const foundRelevant = memoriesTheDigTurnedUp(entry).filter(isRelevantToThePrompt);
  const foundRelevantThatExisted = foundRelevant.filter(
    (memoryFile) => !wasCreatedAfterThePrompt(memoryFile),
  );
  const afterAFailedHookRun = isFailedHookRun(prompt.hookOutcome);
  const findsThatCount = afterAFailedHookRun ? [] : foundRelevantThatExisted;
  const foundRelevantInsideTheScope = findsThatCount.filter(
    (memoryFile) => !isOutsideTheScope(memoryFile),
  );
  const foundRelevantOutsideTheScope = findsThatCount.filter(isOutsideTheScope);
  return {
    entry,
    dug: hadDig(entry),
    servedSomethingRelevant: prompt.servedFiles.some(isRelevantToThePrompt),
    foundRelevantUnserved: foundRelevantInsideTheScope.filter(
      (memoryFile) => !wasServed(memoryFile) && !wasAlreadyShown(memoryFile),
    ),
    foundRelevantOutsideTheScope,
    everyOutsideFindFollowedAScopedRecall: foundRelevantOutsideTheScope.every((memoryFile) =>
      digScope.memoriesAnEarlierScopedRecallCovered.has(memoryFile),
    ),
    someOutsideFindWasInAListedRepository: foundRelevantOutsideTheScope.some(
      isInOneOfTheDirectories(prompt.listedRepositoryMemoryDirectories, findRules.physicalPathOfEachMemory),
    ),
    digFoundSomething: foundRelevantInsideTheScope.length > 0,
    afterAFailedHookRun,
    foundAfterAFailedHookRun: afterAFailedHookRun ? foundRelevantThatExisted : [],
    foundItsOwnLaterNote: foundRelevant.filter(wasCreatedAfterThePrompt),
    foundAlreadyShown: foundRelevantInsideTheScope.filter(
      (memoryFile) => !wasServed(memoryFile) && wasAlreadyShown(memoryFile),
    ),
  };
}

export function promptOutcomesOf(
  entries: readonly PromptAndItsDig[],
  findRules: WhatCountsAsAFind,
): readonly PromptOutcome[] {
  const shownEarlier = shownEarlierInTheSession(entries);
  return entries.map((entry) => outcomeOf(entry, findRules, shownEarlier.get(entry) ?? new Set()));
}

export function isMissedAndFound(outcome: PromptOutcome): boolean {
  return (
    outcome.dug &&
    !outcome.servedSomethingRelevant &&
    outcome.foundRelevantUnserved.length > 0
  );
}

export function isOutOfScopeFind(outcome: PromptOutcome): boolean {
  return outcome.foundRelevantOutsideTheScope.length > 0;
}

export function isOutOfScopeFindAfterAScopedRecall(outcome: PromptOutcome): boolean {
  return isOutOfScopeFind(outcome) && outcome.everyOutsideFindFollowedAScopedRecall;
}

export function isOutOfScopeFindInAListedRepository(outcome: PromptOutcome): boolean {
  return isOutOfScopeFind(outcome) && outcome.someOutsideFindWasInAListedRepository;
}

export function isJudgedInsideItsScope(outcome: PromptOutcome): boolean {
  return (
    !outcome.afterAFailedHookRun &&
    outcome.dug &&
    (outcome.digFoundSomething || !isOutOfScopeFind(outcome))
  );
}

export function servedAnything(outcome: PromptOutcome): boolean {
  return outcome.entry.prompt.servedFiles.length > 0;
}

export function isEmptyHanded(outcome: PromptOutcome): boolean {
  return !outcome.servedSomethingRelevant && outcome.dug;
}

export function rateOf<Item>(items: readonly Item[], counts: (item: Item) => boolean): Rate {
  return { count: items.filter(counts).length, outOf: items.length };
}
