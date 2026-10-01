import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AskLintRule } from './ask-lint-rules.ts';
import { lintAsks } from './ask-lint.ts';

export async function temporaryRoot(): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), 'ask-lint-')));
}

export function memoryWithAsk(ask: string | undefined): string {
  const frontmatter = ask === undefined ? ['---', 'kind: trap', '---'] : ['---', `ask: "${ask}"`, 'kind: trap', '---'];
  return [...frontmatter, '# A lesson', '', '- what happened'].join('\n');
}

export async function memoryDirectoryWith(
  memories: Readonly<Record<string, string>>,
  directory: string,
): Promise<string> {
  await mkdir(directory, { recursive: true });
  for (const [fileName, text] of Object.entries(memories)) await writeFile(path.join(directory, fileName), text);
  return directory;
}

export async function rulesFlaggedFor(
  asks: readonly string[],
  repositoryName: string | undefined = 'someone-elses-repository',
): Promise<ReadonlyMap<string, readonly AskLintRule[]>> {
  const memoryFileNames = asks.map((_ask, index) => `MEMORY_${String(index).padStart(3, '0')}.md`);
  const directory = await memoryDirectoryWith(
    Object.fromEntries(asks.map((ask, index) => [memoryFileNames[index], memoryWithAsk(ask)])),
    path.join(await temporaryRoot(), 'memories'),
  );
  const { violations } = await lintAsks([{ path: directory, repositoryName }]);
  return new Map(
    asks.map((ask, index) => [
      ask,
      violations
        .filter((violation) => path.basename(violation.filePath) === memoryFileNames[index])
        .map((violation) => violation.rule),
    ]),
  );
}
