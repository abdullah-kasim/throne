import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  checkoutOfMemoryDirectory,
  repositoryNameOfCheckout,
} from './memory-directory-repository.ts';
import { physicalPath, projectMemoryDirectoriesUnder } from './memory-files.ts';
import { resolvedMemoryDirectoriesOf, type RecallScope } from './recall-scope.ts';

export const REPOSITORY_REGISTRY_FILE_NAME = 'repositories.json';

export interface RegisteredRepository {
  readonly checkout: string;
  readonly repositoryName: string;
  readonly memoryDirectory: string;
  readonly lastSeenAt: string | null;
}

export type RepositoryRegistry = ReadonlyMap<string, RegisteredRepository>;

export interface RepositoryRegistryDependencies {
  dataDirectory: string;
  seedRepositories(): Promise<readonly RegisteredRepository[]>;
}

function registryPath(dataDirectory: string): string {
  return path.join(dataDirectory, REPOSITORY_REGISTRY_FILE_NAME);
}

function isRegisteredRepository(value: unknown): value is RegisteredRepository {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.checkout === 'string' &&
    typeof entry.repositoryName === 'string' &&
    typeof entry.memoryDirectory === 'string' &&
    (typeof entry.lastSeenAt === 'string' || entry.lastSeenAt === null)
  );
}

function registryOf(repositories: readonly RegisteredRepository[]): RepositoryRegistry {
  return new Map(repositories.map((repository) => [repository.checkout, repository]));
}

async function readSavedRegistry(dataDirectory: string): Promise<RepositoryRegistry | undefined> {
  let text: string;
  try {
    text = await readFile(registryPath(dataDirectory), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const saved: unknown = JSON.parse(text);
    return registryOf(Array.isArray(saved) ? saved.filter(isRegisteredRepository) : []);
  } catch {
    return new Map();
  }
}

export async function readRepositoryRegistry(
  dependencies: RepositoryRegistryDependencies,
): Promise<RepositoryRegistry> {
  return (
    (await readSavedRegistry(dependencies.dataDirectory)) ??
    registryOf(await dependencies.seedRepositories())
  );
}

export function registryWithScopedRepositories(
  registry: RepositoryRegistry,
  scope: RecallScope,
  seenAt: Date,
): RepositoryRegistry {
  const updated = new Map(registry);
  for (const memoryDirectory of resolvedMemoryDirectoriesOf(scope)) {
    updated.set(memoryDirectory.checkout, {
      checkout: memoryDirectory.checkout,
      repositoryName: memoryDirectory.repositoryName,
      memoryDirectory: memoryDirectory.path,
      lastSeenAt: seenAt.toISOString(),
    });
  }
  return updated;
}

export async function saveRepositoryRegistry(
  dataDirectory: string,
  registry: RepositoryRegistry,
): Promise<void> {
  const repositories = [...registry.values()].sort((left, right) =>
    left.checkout < right.checkout ? -1 : 1,
  );
  const finalPath = registryPath(dataDirectory);
  const temporaryPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(repositories, null, 1)}\n`);
  await rename(temporaryPath, finalPath);
}

export async function repositoriesOfProjectMemoryDirectories(
  homeDirectory: string,
): Promise<readonly RegisteredRepository[]> {
  const repositories = await Promise.all(
    (await projectMemoryDirectoriesUnder(homeDirectory)).map(async (memoryDirectory) => {
      const checkout = await checkoutOfMemoryDirectory(memoryDirectory);
      if (checkout === undefined) return undefined;
      return {
        checkout,
        repositoryName: repositoryNameOfCheckout(checkout),
        memoryDirectory: await physicalPath(memoryDirectory),
        lastSeenAt: null,
      };
    }),
  );
  return repositories.filter((repository) => repository !== undefined);
}
