import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runRecall, type RecallDependencies } from './recall.command.ts';
import { harness, type Harness } from './recall.command.test-support.ts';

const LINT_MODULE = fileURLToPath(new URL('./ask-lint.ts', import.meta.url));
const CLASSIFIER_DIRECTORY = fileURLToPath(new URL('../relevance-classifier/', import.meta.url));
const RELATIVE_IMPORT = /from\s+'(\.{1,2}\/[^']+)'/g;
const NETWORK_MODULES = /from\s+'node:(?:http|https|net|tls|dns)'/;

function withoutAnyClassifier(fixture: Harness): RecallDependencies {
  return {
    ...fixture.dependencies,
    chooseBackend: () => {
      throw new Error('the lint asked for a classifier backend');
    },
    readJevSwitch: () => {
      throw new Error('the lint read the Jev switch');
    },
  };
}

async function modulesImportedFrom(entryModule: string): Promise<ReadonlySet<string>> {
  const seen = new Set<string>();
  const pending = [entryModule];
  while (pending.length > 0) {
    const modulePath = pending.pop() as string;
    if (seen.has(modulePath)) continue;
    seen.add(modulePath);
    for (const match of (await readFile(modulePath, 'utf8')).matchAll(RELATIVE_IMPORT)) {
      pending.push(path.resolve(path.dirname(modulePath), match[1] as string));
    }
  }
  return seen;
}

test('the lint makes no classifier call at all', async () => {
  const fixture = harness();
  const exitCode = await runRecall(['--lint-asks', '--global'], withoutAnyClassifier(fixture));
  assert.equal(exitCode, 1);
  assert.equal(fixture.backendCallCount(), 0);

  const lintModules = [...(await modulesImportedFrom(LINT_MODULE))];
  assert.deepEqual(lintModules.filter((modulePath) => modulePath.startsWith(CLASSIFIER_DIRECTORY)), []);
  const lintSources = await Promise.all(lintModules.map((modulePath) => readFile(modulePath, 'utf8')));
  assert.deepEqual(lintSources.filter((source) => NETWORK_MODULES.test(source)), []);
});

test('the lint with no scope flag reads the project memory directories and prints path, rule and ask per violation', async () => {
  const fixture = harness();
  const exitCode = await runRecall(['--lint-asks'], withoutAnyClassifier(fixture));
  assert.equal(exitCode, 1);
  assert.deepEqual(fixture.stdout, [
    `${path.join(fixture.projectMemories, 'NEVER_REPUBLISH.md')}\tbare-narrow-ask\tDoes the task edit a GitHub pull request description?\n`,
  ]);
  assert.deepEqual(fixture.stderr, [
    'recall --lint-asks: 1 violations; 1 of 1 memories flagged; 1 memory directories read\n',
  ]);
});

test('the lint exits 0 and prints no violation line when every ask passes', async () => {
  const fixture = harness();
  const exitCode = await runRecall(['--lint-asks'], {
    ...withoutAnyClassifier(fixture),
    projectMemoryDirectoriesToLint: () => Promise.resolve([]),
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(fixture.stdout, []);
  assert.match(fixture.stderr.join(''), /0 violations; 0 of 0 memories flagged; 0 memory directories read/);
});

test('--global lints exactly the configured global memory directories', async () => {
  const fixture = harness();
  await runRecall(['--lint-asks', '--global'], withoutAnyClassifier(fixture));
  assert.deepEqual(fixture.stdout, [
    `${path.join(fixture.globalMemories, 'ELSEWHERE.md')}\tbare-narrow-ask\tDoes the task edit a GitHub pull request description?\n`,
    `${path.join(fixture.globalMemories, 'NETWORK_SAFETY.md')}\tmissing-ask\t(no ask)\n`,
  ]);
});

test('--directory lints that repository memory directory and adds the global ones only with --global', async () => {
  const fixture = harness();
  await runRecall(['--lint-asks', '--directory', 'other-repository'], withoutAnyClassifier(fixture));
  assert.deepEqual(fixture.stdout, [
    `${path.join(fixture.otherRepositoryMemories, 'PULL_REQUEST_TEMPLATE.md')}\tbare-narrow-ask\tDoes the task edit a GitHub pull request description?\n`,
  ]);

  const withGlobal = harness();
  await runRecall(['--lint-asks', '--directory', 'project', '--global'], withoutAnyClassifier(withGlobal));
  assert.match(withGlobal.stderr.join(''), /3 violations; 3 of 3 memories flagged; 2 memory directories read/);
});

test('--directory with no findable memory directory is refused with exit 2', async () => {
  const fixture = harness();
  const exitCode = await runRecall(['--lint-asks', '--directory', 'nowhere'], {
    ...withoutAnyClassifier(fixture),
    resolveProjectMemoryDirectory: () => Promise.resolve(undefined),
  });
  assert.equal(exitCode, 2);
  assert.match(fixture.stderr.join(''), /no memory directory could be found for --directory/);
  assert.deepEqual(fixture.stdout, []);
});

test('the lint refuses task text and every recall flag but --directory and --global', async () => {
  const refusedInvocations = [
    ['--lint-asks', 'some task'],
    ['--lint-asks', '--status'],
    ['--lint-asks', '--report'],
    ['--lint-asks', '--memory-dir', 'somewhere'],
    ['--lint-asks', '--no-global'],
    ['--lint-asks', '--session', 'abc'],
    ['--lint-asks', '--spot-check'],
    ['--lint-asks', '--agree', 'abc'],
    ['--lint-asks', '--since', '2026-09-01'],
    ['--global', '--directory', 'project', 'some task'],
  ];
  for (const invocation of refusedInvocations) {
    const fixture = harness();
    assert.equal(await runRecall(invocation, withoutAnyClassifier(fixture)), 2, invocation.join(' '));
    assert.deepEqual(fixture.stdout, [], invocation.join(' '));
    assert.match(fixture.stderr.join(''), /recall entrance validation refused/, invocation.join(' '));
  }
});

test('the lint with --hook runs nothing and exits 0, because the hook never exits non-zero', async () => {
  const fixture = harness();
  assert.equal(await runRecall(['--lint-asks', '--hook'], withoutAnyClassifier(fixture)), 0);
  assert.deepEqual(fixture.stdout, []);
  assert.deepEqual(fixture.stderr, []);
});
