import { readFile } from 'node:fs/promises';
import { parseMemory } from './memory-files.ts';
import type { LoggedPrompt } from './recall-report-logs.ts';
import { isSameMemoryAsOneOf } from './recall-report-outcomes.ts';

export const JUDGED = 'judged';
export const NEVER_A_CANDIDATE = 'never a candidate';
export const CANDIDACY_UNKNOWN = 'unknown';

export type Candidacy =
  | { readonly kind: typeof JUDGED; readonly probabilityOfYes: number }
  | { readonly kind: typeof NEVER_A_CANDIDATE }
  | { readonly kind: typeof CANDIDACY_UNKNOWN };

export const HAS_ASK = 'has ask';
export const NO_ASK = 'no ask';
export const FILE_UNREADABLE = 'file unreadable';

export type AskOfAMemory =
  | { readonly kind: typeof HAS_ASK; readonly ask: string }
  | { readonly kind: typeof NO_ASK }
  | { readonly kind: typeof FILE_UNREADABLE };

export interface FindCandidacy {
  readonly memoryFile: string;
  readonly candidacy: Candidacy;
  readonly ask: AskOfAMemory;
}

export function candidacyOfFind(
  prompt: LoggedPrompt,
  memoryFile: string,
  physicalPathOfEachMemory: ReadonlyMap<string, string>,
): Candidacy {
  const isTheFind = isSameMemoryAsOneOf([memoryFile], physicalPathOfEachMemory);
  const judgement = [...prompt.probabilityOfYesOfEachJudgedFile].find(([judgedFile]) =>
    isTheFind(judgedFile),
  );
  if (judgement !== undefined) return { kind: JUDGED, probabilityOfYes: judgement[1] };
  return prompt.everyAnswerLogged ? { kind: NEVER_A_CANDIDATE } : { kind: CANDIDACY_UNKNOWN };
}

async function askOfMemory(memoryFile: string): Promise<AskOfAMemory> {
  let text: string;
  try {
    text = await readFile(memoryFile, 'utf8');
  } catch {
    return { kind: FILE_UNREADABLE };
  }
  const { ask } = parseMemory(memoryFile, text).frontmatter;
  return ask === undefined || ask === '' ? { kind: NO_ASK } : { kind: HAS_ASK, ask };
}

export async function askOfEachMemory(
  memoryFiles: readonly string[],
): Promise<ReadonlyMap<string, AskOfAMemory>> {
  return new Map(
    await Promise.all(
      [...new Set(memoryFiles)].map(async (memoryFile) => [memoryFile, await askOfMemory(memoryFile)] as const),
    ),
  );
}
