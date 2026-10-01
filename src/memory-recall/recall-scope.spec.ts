import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runRecall } from './recall.command.ts';
import {
  HOOK_PAYLOAD,
  IN_OTHER_REPOSITORY,
  IN_PROJECT,
  PULL_REQUEST_TASK,
  harness,
  ledgerLines,
  sureNoBackend,
} from './recall.command.test-support.ts';
import { PROMPT_LOG_FILE_NAME } from './recall-records.ts';

const HOOK_REPOSITORY = '/somewhere';

function summaryLines(dataDirectory: string): Record<string, unknown>[] {
  return ledgerLines(dataDirectory).filter((line) => 'questionsAsked' in line);
}

function scopeLineOf(printed: string): string {
  return printed.split('\n').find((line) => line.startsWith('Searched: ')) ?? '';
}

test('a hand recall without --directory or --memory-dir refuses and names both flags and the current directory', async () => {
  const fixture = harness();
  assert.equal(await runRecall([PULL_REQUEST_TASK], fixture.dependencies), 2);
  const refusal = fixture.stderr.join('');
  assert.match(refusal, /--directory/);
  assert.match(refusal, /--memory-dir/);
  assert.ok(refusal.includes(`current directory ${fixture.currentDirectory}`));
  assert.deepEqual(fixture.stdout, []);
  assert.equal(fixture.backendCallCount(), 0);
  assert.equal(existsSync(fixture.dataDirectory), false);
});

test('a hand recall with two --directory flags searches both repositories and names each in the scope line', async () => {
  const fixture = harness();
  await runRecall([...IN_PROJECT, ...IN_OTHER_REPOSITORY, PULL_REQUEST_TASK], fixture.dependencies);
  const printed = fixture.stdout.join('');
  assert.match(printed, /## NEVER_REPUBLISH\.md/);
  assert.match(printed, /## PULL_REQUEST_TEMPLATE\.md/);
  const scopeLine = scopeLineOf(printed);
  assert.ok(scopeLine.includes(`repository ${path.join(fixture.currentDirectory, 'project')} (memories in ${fixture.projectMemories})`));
  assert.ok(scopeLine.includes(`repository ${path.join(fixture.currentDirectory, 'other-repository')} (memories in ${fixture.otherRepositoryMemories})`));

  const oneRepository = harness();
  await runRecall([...IN_PROJECT, PULL_REQUEST_TASK], oneRepository.dependencies);
  assert.doesNotMatch(oneRepository.stdout.join(''), /PULL_REQUEST_TEMPLATE/);
});

test('a hand recall with --memory-dir searches that memory directory as given', async () => {
  const fixture = harness();
  await runRecall(['--memory-dir', fixture.otherRepositoryMemories, PULL_REQUEST_TASK], fixture.dependencies);
  const printed = fixture.stdout.join('');
  assert.match(printed, /## PULL_REQUEST_TEMPLATE\.md/);
  assert.doesNotMatch(printed, /NEVER_REPUBLISH/);
  assert.ok(scopeLineOf(printed).includes(`memory directory ${fixture.otherRepositoryMemories}`));
  assert.deepEqual(summaryLines(fixture.dataDirectory)[0]?.searchedMemoryDirectories, [
    fixture.otherRepositoryMemories,
    fixture.globalMemories,
  ]);
});

test('a hand recall whose --directory has no findable memory directory is refused naming it', async () => {
  const fixture = harness();
  const unfindable = path.join(fixture.currentDirectory, 'no-memories-here');
  const exitCode = await runRecall([...IN_PROJECT, '--directory', 'no-memories-here', PULL_REQUEST_TASK], {
    ...fixture.dependencies,
    resolveProjectMemoryDirectory: (directory) =>
      directory === unfindable
        ? Promise.resolve(undefined)
        : fixture.dependencies.resolveProjectMemoryDirectory(directory),
  });
  assert.equal(exitCode, 2);
  assert.ok(fixture.stderr.join('').includes(`no memory directory could be found for --directory ${unfindable}`));
  assert.deepEqual(fixture.stdout, []);
  assert.equal(fixture.backendCallCount(), 0);
  assert.equal(existsSync(fixture.dataDirectory), false);
});

test('the global memories are searched unless --no-global is passed', async () => {
  const withGlobal = harness();
  await runRecall([...IN_PROJECT, PULL_REQUEST_TASK], withGlobal.dependencies);
  assert.ok(scopeLineOf(withGlobal.stdout.join('')).includes(`global memories in ${withGlobal.globalMemories}`));
  assert.deepEqual(
    summaryLines(withGlobal.dataDirectory).map((line) => [line.questionsAsked, line.searchedMemoryDirectories]),
    [[2, [withGlobal.projectMemories, withGlobal.globalMemories]]],
  );

  const withoutGlobal = harness();
  await runRecall([...IN_PROJECT, '--no-global', PULL_REQUEST_TASK], withoutGlobal.dependencies);
  assert.ok(scopeLineOf(withoutGlobal.stdout.join('')).includes('global memories left out'));
  assert.deepEqual(
    summaryLines(withoutGlobal.dataDirectory).map((line) => [line.questionsAsked, line.searchedMemoryDirectories]),
    [[1, [withoutGlobal.projectMemories]]],
  );
});

test('the hook output states the repository, its memory directory and the global directories on their own line', async () => {
  const fixture = harness({ hookEnabled: true }, { stdin: HOOK_PAYLOAD });
  await runRecall(['--hook'], fixture.dependencies);
  assert.equal(
    scopeLineOf(fixture.stdout.join('')),
    `Searched: repository ${HOOK_REPOSITORY} (memories in ${fixture.projectMemories}); global memories in ${fixture.globalMemories}.`,
  );
});

test('the hook output tells the agent to run throne recall --directory for any other repository', async () => {
  const fixture = harness({ hookEnabled: true }, { stdin: HOOK_PAYLOAD });
  await runRecall(['--hook'], fixture.dependencies);
  assert.ok(fixture.stdout.join('').includes('throne recall --directory <path> "<task>"'));
});

test('the verdict line names the scope it covers and is never an unqualified no relevant memory', async () => {
  const nothingRelevant = harness({ hookEnabled: true, verdictLineThreshold: 0.9 }, { stdin: HOOK_PAYLOAD, backend: sureNoBackend(0.95) });
  await runRecall(['--hook'], nothingRelevant.dependencies);
  const relevant = harness({ hookEnabled: true }, { stdin: HOOK_PAYLOAD });
  await runRecall(['--hook'], relevant.dependencies);
  const printed = nothingRelevant.stdout.join('') + relevant.stdout.join('');
  assert.match(printed, /Jev \(95% sure\): no relevant memory in project's memories and the global memories\.\n/);
  assert.match(printed, /rules: a relevant memory likely exists in project's memories and the global memories\.\n/);
  assert.doesNotMatch(printed, /no relevant memory(?! in )/);
});

test('the shadow arm prints nothing but records the searched memory directories in the ledger', async () => {
  const fixture = harness({ hookEnabled: true, hookMode: 'shadow' }, { stdin: HOOK_PAYLOAD });
  await runRecall(['--hook'], fixture.dependencies);
  assert.deepEqual(fixture.stdout, []);
  assert.deepEqual(
    summaryLines(fixture.dataDirectory).map((line) => [line.arm, line.searchedMemoryDirectories]),
    [['shadow', [fixture.projectMemories, fixture.globalMemories]]],
  );
});

test('the ledger summary and the prompt log record the searched memory directories', async () => {
  const fixture = harness({ hookEnabled: true }, { stdin: HOOK_PAYLOAD });
  await runRecall(['--hook'], fixture.dependencies);
  await runRecall([...IN_PROJECT, ...IN_OTHER_REPOSITORY, PULL_REQUEST_TASK], fixture.dependencies);
  const hookScope = [fixture.projectMemories, fixture.globalMemories];
  assert.deepEqual(
    summaryLines(fixture.dataDirectory).map((line) => [line.source, line.searchedMemoryDirectories]),
    [
      ['hook', hookScope],
      ['command', [fixture.projectMemories, fixture.otherRepositoryMemories, fixture.globalMemories]],
    ],
  );
  const promptLog = readFileSync(path.join(fixture.dataDirectory, PROMPT_LOG_FILE_NAME), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(promptLog.map((line) => line.searchedMemoryDirectories), [hookScope]);
});
