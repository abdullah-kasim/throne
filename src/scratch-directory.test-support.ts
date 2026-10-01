import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after } from 'node:test';

const directoriesRemovedAfterTheTests: string[] = [];

after(() =>
  Promise.all(
    directoriesRemovedAfterTheTests.map((scratch) => rm(scratch, { recursive: true, force: true })),
  ),
);

export async function makeScratchDirectory(namePrefix: string): Promise<string> {
  const scratch = await mkdtemp(path.join(tmpdir(), namePrefix));
  directoriesRemovedAfterTheTests.push(scratch);
  return scratch;
}
