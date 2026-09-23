import { readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  parseMemoryFrontmatter,
  splitFrontmatterFromBody,
} from './memory-frontmatter.ts';
import type { Memory } from './memory-frontmatter.types.ts';

const FILES_THAT_ARE_NOT_MEMORIES = new Set(['MEMORY.md', 'README.md']);

export function parseMemory(filePath: string, text: string): Memory {
  const { frontmatterLines, body } = splitFrontmatterFromBody(text);
  return {
    filePath,
    fileName: path.basename(filePath),
    frontmatter: parseMemoryFrontmatter(frontmatterLines),
    body: body.trim(),
  };
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
  const memoryFileNames = fileNames
    .filter(
      (fileName) =>
        fileName.endsWith('.md') && !FILES_THAT_ARE_NOT_MEMORIES.has(fileName),
    )
    .sort();
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

async function physicalPath(directory: string): Promise<string> {
  try {
    return await realpath(directory);
  } catch {
    return path.resolve(directory);
  }
}

export async function readMemoriesInEachDirectoryOnce(
  directories: readonly string[],
): Promise<readonly Memory[]> {
  const physicalDirectories = await Promise.all(directories.map(physicalPath));
  return (
    await Promise.all([...new Set(physicalDirectories)].map(readMemoriesIn))
  ).flat();
}
