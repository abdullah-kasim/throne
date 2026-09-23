import { glob, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

export interface RankItem {
  readonly id: string;
  readonly text: string;
  readonly mayBeSentToJev: boolean;
}

export interface UnreadableItem {
  readonly id: string;
}

export interface GatheredItems {
  readonly items: readonly RankItem[];
  readonly unreadable: readonly UnreadableItem[];
}

const GLOB_CHARACTERS = /[*?[\]{}]/;

async function physicalPathOrUndefined(
  filePath: string,
): Promise<string | undefined> {
  try {
    return await realpath(filePath);
  } catch {
    return undefined;
  }
}

export function isUnderAnyRoot(
  physicalFilePath: string,
  physicalRoots: readonly string[],
): boolean {
  return physicalRoots.some((root) => {
    const relative = path.relative(root, physicalFilePath);
    return (
      relative.length > 0 &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative)
    );
  });
}

async function pathsMatching(pathOrGlob: string): Promise<readonly string[]> {
  if (!GLOB_CHARACTERS.test(pathOrGlob)) return [pathOrGlob];
  const matches: string[] = [];
  for await (const match of glob(pathOrGlob)) matches.push(match);
  return matches.sort();
}

export async function gatherFileItems(
  pathsOrGlobs: readonly string[],
  allowedRoots: readonly string[],
): Promise<GatheredItems> {
  const physicalRoots = (
    await Promise.all(allowedRoots.map(physicalPathOrUndefined))
  ).filter((root) => root !== undefined);
  const filePaths = [
    ...new Set((await Promise.all(pathsOrGlobs.map(pathsMatching))).flat()),
  ];
  const items: RankItem[] = [];
  const unreadable: UnreadableItem[] = [];
  for (const filePath of filePaths) {
    try {
      const text = await readFile(filePath, 'utf8');
      const physicalFilePath = await physicalPathOrUndefined(filePath);
      items.push({
        id: filePath,
        text,
        mayBeSentToJev:
          physicalFilePath !== undefined &&
          isUnderAnyRoot(physicalFilePath, physicalRoots),
      });
    } catch {
      unreadable.push({ id: filePath });
    }
  }
  return { items, unreadable };
}

function itemFromStdinLine(
  line: string,
  lineNumber: number,
  mayBeSentToJev: boolean,
): RankItem {
  if (line.trimStart().startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === 'object' && parsed !== null) {
        const { id, text } = parsed as Record<string, unknown>;
        if (typeof id === 'string' && typeof text === 'string') {
          return { id, text, mayBeSentToJev };
        }
      }
    } catch {
      return { id: `line ${lineNumber}`, text: line, mayBeSentToJev };
    }
  }
  return { id: `line ${lineNumber}`, text: line, mayBeSentToJev };
}

export function gatherStdinItems(
  stdinText: string,
  mayBeSentToJev: boolean,
): GatheredItems {
  const items = stdinText
    .split('\n')
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => line.trim().length > 0)
    .map(({ line, lineNumber }) =>
      itemFromStdinLine(line, lineNumber, mayBeSentToJev),
    );
  return { items, unreadable: [] };
}
