import path from 'node:path';
import {
  pathWithHomeExpanded,
  type RecallConfig,
} from '../relevance-classifier/recall-user-config.ts';
import { COMMAND_SOURCE, type PromptJudgement } from './recall-records.ts';

export interface ProjectMemoryDirectory {
  readonly path: string;
  readonly checkout: string;
  readonly repositoryName: string;
  readonly repositoryScopes: readonly string[];
}

export interface ScopedRepository {
  readonly directory: string;
  readonly memoryDirectory: ProjectMemoryDirectory | undefined;
}

export interface RecallScope {
  readonly repositories: readonly ScopedRepository[];
  readonly namedMemoryDirectories: readonly string[];
  readonly globalMemoryDirectories: readonly string[];
  readonly includesGlobal: boolean;
}

export interface RecallScopeRequest {
  readonly directories: readonly string[];
  readonly memoryDirectories: readonly string[];
  readonly includeGlobal: boolean;
}

export interface RecallScopeDependencies {
  resolveProjectMemoryDirectory(directory: string): Promise<ProjectMemoryDirectory | undefined>;
  currentDirectory(): string;
}

export async function recallScopeOf(
  request: RecallScopeRequest,
  config: RecallConfig,
  dependencies: RecallScopeDependencies,
): Promise<RecallScope> {
  const currentDirectory = dependencies.currentDirectory();
  const repositories = await Promise.all(
    request.directories.map(async (directory) => {
      const absoluteDirectory = path.resolve(currentDirectory, directory);
      return {
        directory: absoluteDirectory,
        memoryDirectory: await dependencies.resolveProjectMemoryDirectory(absoluteDirectory),
      };
    }),
  );
  return {
    repositories,
    namedMemoryDirectories: request.memoryDirectories.map((directory) =>
      path.resolve(currentDirectory, directory),
    ),
    globalMemoryDirectories: request.includeGlobal
      ? config.globalMemoryDirectories.map((directory) => pathWithHomeExpanded(directory))
      : [],
    includesGlobal: request.includeGlobal,
  };
}

export function resolvedMemoryDirectoriesOf(scope: RecallScope): readonly ProjectMemoryDirectory[] {
  return scope.repositories.flatMap((repository) =>
    repository.memoryDirectory === undefined ? [] : [repository.memoryDirectory],
  );
}

export function unresolvedRepositoriesOf(scope: RecallScope): readonly string[] {
  return scope.repositories
    .filter((repository) => repository.memoryDirectory === undefined)
    .map((repository) => repository.directory);
}

export function searchedMemoryDirectoriesOf(scope: RecallScope): readonly string[] {
  return [
    ...resolvedMemoryDirectoriesOf(scope).map((memoryDirectory) => memoryDirectory.path),
    ...scope.namedMemoryDirectories,
    ...scope.globalMemoryDirectories,
  ];
}

export function repositoryScopesOf(scope: RecallScope): readonly string[] {
  return [
    ...resolvedMemoryDirectoriesOf(scope).flatMap((memoryDirectory) => memoryDirectory.repositoryScopes),
    ...scope.namedMemoryDirectories.map((directory) => path.basename(directory)),
  ];
}

export function repositoryNameOf(scope: RecallScope): string | undefined {
  const names = resolvedMemoryDirectoriesOf(scope).map((memoryDirectory) => memoryDirectory.repositoryName);
  return names.length === 0 ? undefined : names.join(', ');
}

function inPlainEnglishList(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

export function scopePhraseOf(scope: RecallScope): string {
  const parts = [
    ...resolvedMemoryDirectoriesOf(scope).map((memoryDirectory) => `${memoryDirectory.repositoryName}'s memories`),
    ...scope.namedMemoryDirectories.map((directory) => `the memories in ${directory}`),
    ...(scope.globalMemoryDirectories.length > 0 ? ['the global memories'] : []),
  ];
  return parts.length === 0 ? 'no memory directory at all' : inPlainEnglishList(parts);
}

function renderedRepository(repository: ScopedRepository): string {
  return repository.memoryDirectory === undefined
    ? `repository ${repository.directory} (its memory directory could not be found, so none of its memories were searched)`
    : `repository ${repository.directory} (memories in ${repository.memoryDirectory.path})`;
}

function renderedGlobalMemories(scope: RecallScope): string {
  if (!scope.includesGlobal) return 'global memories left out';
  if (scope.globalMemoryDirectories.length === 0) return 'no global memory directory configured';
  return `global memories in ${scope.globalMemoryDirectories.join(', ')}`;
}

export const OTHER_REPOSITORY_SENTENCE =
  'Memories for any other repository are not searched here: run `throne recall --directory <path> "<task>"` to get them.\n';

export function renderedScopeLine(scope: RecallScope): string {
  const searched = [
    ...scope.repositories.map(renderedRepository),
    ...scope.namedMemoryDirectories.map((directory) => `memory directory ${directory}`),
    renderedGlobalMemories(scope),
  ];
  return `Searched: ${searched.join('; ')}.\n${OTHER_REPOSITORY_SENTENCE}`;
}

export function isScopeLineWorthShowing(
  source: PromptJudgement['source'],
  anythingElsePrinted: boolean,
): boolean {
  return source === COMMAND_SOURCE || anythingElsePrinted;
}
