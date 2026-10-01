import { glob, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  parseMemoryFrontmatter,
  splitFrontmatterFromBody,
} from './memory-frontmatter.ts';
import type { Memory } from './memory-frontmatter.types.ts';

export const REPOSITORY_FILE_NAME = 'REPOSITORY.md';
const FILES_THAT_ARE_NOT_MEMORIES = new Set(['MEMORY.md', 'README.md', REPOSITORY_FILE_NAME]);
const MEMORY_FILE_EXTENSION = '.md';
const PROJECT_MEMORY_ROOT_NAME = '.memories';

export function projectMemoryDirectoryPattern(homeDirectory: string): string {
  return path.join(homeDirectory, PROJECT_MEMORY_ROOT_NAME, '*');
}

export async function projectMemoryDirectoriesUnder(homeDirectory: string): Promise<readonly string[]> {
  const directories: string[] = [];
  for await (const directory of glob(projectMemoryDirectoryPattern(homeDirectory))) directories.push(directory);
  return directories.sort();
}

export function isMemoryFileName(fileName: string): boolean {
  return fileName.endsWith(MEMORY_FILE_EXTENSION) && !FILES_THAT_ARE_NOT_MEMORIES.has(fileName);
}

export function fileNameAsWords(fileName: string): string {
  return fileName.replace(/\.md$/, '').replaceAll(/[_-]+/g, ' ');
}

export function parseMemory(filePath: string, text: string): Memory {
  const { frontmatterLines, body } = splitFrontmatterFromBody(text);
  return {
    filePath,
    fileName: path.basename(filePath),
    frontmatter: parseMemoryFrontmatter(frontmatterLines),
    body: body.trim(),
    fileText: text,
  };
}

export function isSuperseded(memory: Memory): boolean {
  return memory.frontmatter.status === 'superseded';
}

export async function readMemoriesIn(
  directory: string,
): Promise<readonly Memory[]> {
  let fileNames: string[];
  try {
    fileNames = await readdir(directory);
  } catch {
    return [];
  }
  const memoryFileNames = fileNames.filter(isMemoryFileName).sort();
  const memories = await Promise.all(
    memoryFileNames.map(async (fileName) => {
      const filePath = path.join(directory, fileName);
      try {
        return parseMemory(filePath, await readFile(filePath, 'utf8'));
      } catch {
        return undefined;
      }
    }),
  );
  return memories.filter((memory) => memory !== undefined);
}

export async function readRepositoryFile(memoryDirectory: string): Promise<Memory | undefined> {
  const filePath = path.join(memoryDirectory, REPOSITORY_FILE_NAME);
  try {
    return parseMemory(filePath, await readFile(filePath, 'utf8'));
  } catch {
    return undefined;
  }
}

export async function physicalPath(filePath: string): Promise<string> {
  try {
    return await realpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

export async function physicalPathOfEach(
  filePaths: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  return new Map(
    await Promise.all(
      [...new Set(filePaths)].map(async (filePath) => [filePath, await physicalPath(filePath)] as const),
    ),
  );
}

export async function readMemoriesInEachDirectoryOnce(
  directories: readonly string[],
): Promise<readonly Memory[]> {
  const physicalDirectories = await Promise.all(directories.map(physicalPath));
  return (
    await Promise.all([...new Set(physicalDirectories)].map(readMemoriesIn))
  ).flat();
}
