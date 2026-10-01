import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const MEMORY_VERSIONS_DIRECTORY_NAME = 'memory-versions';

export function contentHashOf(fileText: string): string {
  return createHash('sha256').update(fileText).digest('hex');
}

function isVersionAlreadyKept(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EEXIST';
}

export async function keepMemoryVersions(
  dataDirectory: string,
  fileTexts: readonly string[],
): Promise<void> {
  if (fileTexts.length === 0) return;
  const versionsDirectory = path.join(dataDirectory, MEMORY_VERSIONS_DIRECTORY_NAME);
  await mkdir(versionsDirectory, { recursive: true });
  for (const fileText of new Set(fileTexts)) {
    try {
      await writeFile(path.join(versionsDirectory, contentHashOf(fileText)), fileText, {
        flag: 'wx',
      });
    } catch (error) {
      if (!isVersionAlreadyKept(error)) throw error;
    }
  }
}
