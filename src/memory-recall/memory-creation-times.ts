import { stat } from 'node:fs/promises';

async function timesOnDisk(memoryFile: string): Promise<readonly number[]> {
  try {
    const { birthtimeMs, mtimeMs } = await stat(memoryFile);
    return birthtimeMs > 0 ? [birthtimeMs, mtimeMs] : [mtimeMs];
  } catch {
    return [];
  }
}

async function earliestEvidenceOfExistence(
  memoryFile: string,
  firstSighting: number | undefined,
): Promise<number | undefined> {
  const evidence = [
    ...(await timesOnDisk(memoryFile)),
    ...(firstSighting === undefined ? [] : [firstSighting]),
  ];
  return evidence.length === 0 ? undefined : Math.min(...evidence);
}

export async function creationTimesOf(
  memoryFiles: readonly string[],
  firstSightingOfEachMemory: ReadonlyMap<string, number>,
): Promise<ReadonlyMap<string, number>> {
  const creationTimes = await Promise.all(
    [...new Set(memoryFiles)].map(
      async (memoryFile) =>
        [
          memoryFile,
          await earliestEvidenceOfExistence(memoryFile, firstSightingOfEachMemory.get(memoryFile)),
        ] as const,
    ),
  );
  return new Map(
    creationTimes.filter((entry): entry is readonly [string, number] => entry[1] !== undefined),
  );
}

export function isCreatedAfter(
  memoryFile: string,
  at: string,
  creationTimes: ReadonlyMap<string, number>,
): boolean {
  const createdAt = creationTimes.get(memoryFile);
  return createdAt !== undefined && createdAt > Date.parse(at);
}
