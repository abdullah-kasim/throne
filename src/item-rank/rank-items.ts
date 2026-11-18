import { glob, readFile } from 'node:fs/promises';

export interface RankItem {
  readonly id: string;
  readonly text: string;
}

export interface UnreadableItem {
  readonly id: string;
}

export interface GatheredItems {
  readonly items: readonly RankItem[];
  readonly unreadable: readonly UnreadableItem[];
}

const GLOB_CHARACTERS = /[*?[\]{}]/;

async function pathsMatching(pathOrGlob: string): Promise<readonly string[]> {
  if (!GLOB_CHARACTERS.test(pathOrGlob)) return [pathOrGlob];
  const matches: string[] = [];
  for await (const match of glob(pathOrGlob)) matches.push(match);
  return matches.sort();
}

export async function gatherFileItems(
  pathsOrGlobs: readonly string[],
): Promise<GatheredItems> {
  const filePaths = [
    ...new Set((await Promise.all(pathsOrGlobs.map(pathsMatching))).flat()),
  ];
  const items: RankItem[] = [];
  const unreadable: UnreadableItem[] = [];
  for (const filePath of filePaths) {
    try {
      items.push({ id: filePath, text: await readFile(filePath, 'utf8') });
    } catch {
      unreadable.push({ id: filePath });
    }
  }
  return { items, unreadable };
}

function itemFromStdinLine(line: string, lineNumber: number): RankItem {
  if (line.trimStart().startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === 'object' && parsed !== null) {
        const { id, text } = parsed as Record<string, unknown>;
        if (typeof id === 'string' && typeof text === 'string') {
          return { id, text };
        }
      }
    } catch {
      return { id: `line ${lineNumber}`, text: line };
    }
  }
  return { id: `line ${lineNumber}`, text: line };
}

export function gatherStdinItems(stdinText: string): GatheredItems {
  const items = stdinText
    .split('\n')
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => line.trim().length > 0)
    .map(({ line, lineNumber }) => itemFromStdinLine(line, lineNumber));
  return { items, unreadable: [] };
}
