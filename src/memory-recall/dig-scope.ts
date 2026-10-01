import path from 'node:path';
import { REAPED_DIR_NAME } from '../agentdata/ledger-data.service.ts';
import { TREE_BASE_DATA } from '../agentdata/tree-base-data.service.ts';
import {
  pathWithHomeExpanded,
  type RecallConfig,
} from '../relevance-classifier/recall-user-config.ts';
import { isFindingRead, memoriesTheDigTurnedUp, type PromptAndItsDig } from './dig-episodes.ts';
import { physicalPath } from './memory-files.ts';
import { parseRecallArguments, type ParsedRecallArguments } from './recall-arguments.ts';
import type { LoggedMemoryRead } from './recall-report-logs.ts';
import {
  recallScopeOf,
  searchedMemoryDirectoriesOf,
  type RecallScopeDependencies,
  type RecallScopeRequest,
} from './recall-scope.ts';

type ProjectMemoryDirectoryResolver =
  RecallScopeDependencies['resolveProjectMemoryDirectory'];

export interface DigScopeDependencies
  extends Pick<RecallScopeDependencies, 'resolveProjectMemoryDirectory'> {
  agentLedgerDirectory: string;
}

export interface DigScope {
  readonly memoriesOutsideTheScope: ReadonlySet<string>;
  readonly memoriesAnEarlierScopedRecallCovered: ReadonlySet<string>;
}

export const NOTHING_FOUND: DigScope = {
  memoriesOutsideTheScope: new Set(),
  memoriesAnEarlierScopedRecallCovered: new Set(),
};

const ANY_BASE_FOR_ABSOLUTE_DIRECTORIES = path.sep;

export function isInsideScope(memoryFile: string, scopeDirectories: readonly string[]): boolean {
  return scopeDirectories.some((directory) => memoryFile.startsWith(`${directory}${path.sep}`));
}

async function physicalPaths(filePaths: readonly string[]): Promise<readonly string[]> {
  return Promise.all(filePaths.map(physicalPath));
}

async function memoryDirectoriesSearchedFrom(
  request: RecallScopeRequest,
  currentDirectory: string,
  config: RecallConfig,
  resolveProjectMemoryDirectory: ProjectMemoryDirectoryResolver,
): Promise<readonly string[]> {
  const scope = await recallScopeOf(request, config, {
    resolveProjectMemoryDirectory,
    currentDirectory: () => currentDirectory,
  });
  return physicalPaths(searchedMemoryDirectoriesOf(scope));
}

async function repositoryRecordedForAgent(
  agentName: string,
  agentLedgerDirectory: string,
): Promise<string | undefined> {
  const treeBase =
    (await TREE_BASE_DATA.read(agentName, agentLedgerDirectory)) ??
    (await TREE_BASE_DATA.read(agentName, path.join(agentLedgerDirectory, REAPED_DIR_NAME)));
  return typeof treeBase?.repo === 'string' ? treeBase.repo : undefined;
}

async function sessionDirectoriesOf(
  entry: PromptAndItsDig,
  dependencies: DigScopeDependencies,
): Promise<readonly string[]> {
  const sessionRead = entry.digReads.find((read) => read.cwd !== null);
  if (sessionRead === undefined || sessionRead.cwd === null) return [];
  if ((await dependencies.resolveProjectMemoryDirectory(sessionRead.cwd)) !== undefined) {
    return [sessionRead.cwd];
  }
  const recordedRepository =
    sessionRead.agentName === null
      ? undefined
      : await repositoryRecordedForAgent(sessionRead.agentName, dependencies.agentLedgerDirectory);
  return recordedRepository === undefined ? [] : [recordedRepository];
}

async function scopeOfLoggedPrompt(
  entry: PromptAndItsDig,
  config: RecallConfig,
  dependencies: DigScopeDependencies,
): Promise<readonly string[]> {
  const recordedScope = entry.prompt.searchedMemoryDirectories;
  if (recordedScope !== undefined) return physicalPaths(recordedScope);
  return memoryDirectoriesSearchedFrom(
    {
      directories: await sessionDirectoriesOf(entry, dependencies),
      memoryDirectories: [],
      includeGlobal: true,
    },
    ANY_BASE_FOR_ABSOLUTE_DIRECTORIES,
    config,
    dependencies.resolveProjectMemoryDirectory,
  );
}

function isHandRecall(parsed: ParsedRecallArguments): boolean {
  return !parsed.hook && !parsed.status && !parsed.report;
}

function scopeRequestOfAHandRecall(
  recallArguments: readonly string[],
  currentDirectory: string,
): RecallScopeRequest | undefined {
  let parsed: ParsedRecallArguments;
  try {
    parsed = parseRecallArguments(recallArguments, currentDirectory);
  } catch {
    return undefined;
  }
  if (!isHandRecall(parsed)) return undefined;
  return {
    directories: parsed.directories.map((directory) => pathWithHomeExpanded(directory)),
    memoryDirectories: parsed.memoryDirectories.map((directory) => pathWithHomeExpanded(directory)),
    includeGlobal: false,
  };
}

async function memoryDirectoriesAHandRecallNamed(
  read: LoggedMemoryRead,
  config: RecallConfig,
  resolveProjectMemoryDirectory: ProjectMemoryDirectoryResolver,
): Promise<readonly string[]> {
  if (read.recallArguments === undefined || read.cwd === null) return [];
  const request = scopeRequestOfAHandRecall(read.recallArguments, read.cwd);
  if (request === undefined) return [];
  return memoryDirectoriesSearchedFrom(request, read.cwd, config, resolveProjectMemoryDirectory);
}

function indexOfTheFirstReadThatFound(entry: PromptAndItsDig, memoryFile: string): number {
  return entry.digReads.findIndex(
    (read) => isFindingRead(read) && read.memoryFiles.includes(memoryFile),
  );
}

export async function digScopeOf(
  entry: PromptAndItsDig,
  config: RecallConfig,
  dependencies: DigScopeDependencies,
): Promise<DigScope> {
  const foundMemories = memoriesTheDigTurnedUp(entry);
  if (foundMemories.length === 0) return NOTHING_FOUND;
  const scope = await scopeOfLoggedPrompt(entry, config, dependencies);
  const namedByEachRead = await Promise.all(
    entry.digReads.map((read) =>
      memoryDirectoriesAHandRecallNamed(read, config, dependencies.resolveProjectMemoryDirectory),
    ),
  );
  const memoriesOutsideTheScope = new Set<string>();
  const memoriesAnEarlierScopedRecallCovered = new Set<string>();
  for (const memoryFile of foundMemories) {
    const physicalMemoryFile = await physicalPath(memoryFile);
    if (!isInsideScope(physicalMemoryFile, scope)) memoriesOutsideTheScope.add(memoryFile);
    const namedBeforeTheFind = namedByEachRead
      .slice(0, indexOfTheFirstReadThatFound(entry, memoryFile))
      .flat();
    if (isInsideScope(physicalMemoryFile, namedBeforeTheFind)) {
      memoriesAnEarlierScopedRecallCovered.add(memoryFile);
    }
  }
  return { memoriesOutsideTheScope, memoriesAnEarlierScopedRecallCovered };
}
