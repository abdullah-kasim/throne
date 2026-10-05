import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { estimatedRequestTokens } from '../relevance-classifier/jev-backend.ts';
import { RULES_BACKEND } from '../relevance-classifier/rules-backend.ts';
import { lintAsks } from './ask-lint.ts';
import { readMemoriesIn } from './memory-files.ts';
import { memoryFileNamesMostRecentFirst } from './other-repositories.ts';
import {
  fakeRepositoriesUnder,
  jevBackendAnswering,
  scratchRoot,
} from './other-repositories.test-support.ts';
import { runRecall } from './recall.command.ts';
import {
  HOOK_PAYLOAD,
  IN_PROJECT,
  PULL_REQUEST_TASK,
  harness,
  ledgerLines,
} from './recall.command.test-support.ts';
import {
  REPOSITORY_REGISTRY_FILE_NAME,
  readRepositoryRegistry,
  repositoriesOfProjectMemoryDirectories,
  type RegisteredRepository,
} from './repository-registry.ts';

function savedRegistry(dataDirectory: string): RegisteredRepository[] {
  return JSON.parse(readFileSync(path.join(dataDirectory, REPOSITORY_REGISTRY_FILE_NAME), 'utf8')) as RegisteredRepository[];
}

function repositoryQuestionIdsOf(questions: readonly { id: string }[]): string[] {
  return questions.map((question) => question.id).filter((id) => id.startsWith('other repository: '));
}

test('a hand recall records the repository it searched, with its checkout, name, memory directory and when it was seen', async () => {
  const fixture = harness();
  await runRecall([...IN_PROJECT, PULL_REQUEST_TASK], fixture.dependencies);
  assert.deepEqual(savedRegistry(fixture.dataDirectory), [
    {
      checkout: path.join(fixture.currentDirectory, 'project'),
      repositoryName: 'project',
      memoryDirectory: fixture.projectMemories,
      lastSeenAt: '2026-09-21T00:00:00.000Z',
    },
  ]);
});

test('the prompt hook records the session repository too', async () => {
  const fixture = harness({ hookEnabled: true }, { stdin: HOOK_PAYLOAD });
  await runRecall(['--hook'], fixture.dependencies);
  assert.deepEqual(
    savedRegistry(fixture.dataDirectory).map((repository) => repository.repositoryName),
    ['project'],
  );
});

test('the registry is seeded once from the project memory directories whose slug spells an existing checkout', async () => {
  const root = scratchRoot();
  const checkout = path.join(root, 'code', 'bakery');
  mkdirSync(checkout, { recursive: true });
  const home = path.join(root, 'home');
  const slugOfCheckout = checkout.replaceAll(path.sep, '-');
  mkdirSync(path.join(home, '.memories', slugOfCheckout), { recursive: true });
  mkdirSync(path.join(home, '.memories', '-no-such-checkout-anywhere'), { recursive: true });
  const seeded = await repositoriesOfProjectMemoryDirectories(home);
  assert.deepEqual(
    seeded.map(({ checkout: seededCheckout, repositoryName, lastSeenAt }) => ({ seededCheckout, repositoryName, lastSeenAt })),
    [{ seededCheckout: checkout, repositoryName: 'bakery', lastSeenAt: null }],
  );
  const dataDirectory = path.join(root, 'data');
  let seedCalls = 0;
  const dependencies = {
    dataDirectory,
    seedRepositories: () => {
      seedCalls += 1;
      return Promise.resolve(seeded);
    },
  };
  assert.equal((await readRepositoryRegistry(dependencies)).size, 1);
  mkdirSync(dataDirectory);
  writeFileSync(path.join(dataDirectory, REPOSITORY_REGISTRY_FILE_NAME), '[]\n');
  assert.equal((await readRepositoryRegistry(dependencies)).size, 0);
  assert.equal(seedCalls, 1);
});

test('recall registers the repositories of home-relative memory directories when it seeds its registry', async () => {
  const home = path.join(await realpath(scratchRoot()), 'home');
  const checkout = path.join(home, 'repos', 'bakery');
  await mkdir(checkout, { recursive: true });
  await mkdir(path.join(home, '.memories', 'repos-bakery'), { recursive: true });
  await mkdir(path.join(home, '.memories', 'repos-no-such-checkout'), { recursive: true });
  const seeded = await repositoriesOfProjectMemoryDirectories(home);
  assert.deepEqual(
    seeded.map(({ checkout: seededCheckout, repositoryName, memoryDirectory }) => ({ seededCheckout, repositoryName, memoryDirectory })),
    [{ seededCheckout: checkout, repositoryName: 'bakery', memoryDirectory: path.join(home, '.memories', 'repos-bakery') }],
  );
});

test('a hand recall seeds the registry and keeps the seeded repositories beside the one it searched', async () => {
  const root = scratchRoot();
  const seededRepositories = fakeRepositoriesUnder(root, [{ name: 'bakery' }]);
  const fixture = harness({}, { seededRepositories });
  await runRecall([...IN_PROJECT, PULL_REQUEST_TASK], fixture.dependencies);
  assert.deepEqual(
    savedRegistry(fixture.dataDirectory)
      .map((repository) => [repository.repositoryName, repository.lastSeenAt])
      .sort(),
    [
      ['bakery', null],
      ['project', '2026-09-21T00:00:00.000Z'],
    ],
  );
});

test('repositories already in the scope and repositories with no memory are never asked about', async () => {
  const root = scratchRoot();
  const fixture = harness();
  const backend = jevBackendAnswering({});
  await runRecall([...IN_PROJECT, PULL_REQUEST_TASK], {
    ...fixture.dependencies,
    seedRepositories: () =>
      Promise.resolve(fakeRepositoriesUnder(root, [{ name: 'bakery' }, { name: 'empty', memoryFileNames: [] }])),
    chooseBackend: () => Promise.resolve(backend),
  });
  assert.deepEqual(repositoryQuestionIdsOf(backend.requests[0] ?? []), [
    `other repository: ${path.join(root, 'checkouts', 'bakery')}`,
  ]);
});

test('a repository whose memory directory the lookup already searches is not asked about even under another checkout', async () => {
  const fixture = harness();
  const backend = jevBackendAnswering({});
  const mirror = { checkout: '/elsewhere/project-mirror', repositoryName: 'project-mirror', memoryDirectory: fixture.projectMemories, lastSeenAt: null };
  await runRecall([...IN_PROJECT, PULL_REQUEST_TASK], {
    ...fixture.dependencies,
    seedRepositories: () => Promise.resolve([mirror]),
    chooseBackend: () => Promise.resolve(backend),
  });
  assert.deepEqual(repositoryQuestionIdsOf(backend.requests[0] ?? []), []);
});

test('the repository question rides in the same request as the memory questions and names the most recently changed memories, capped', async () => {
  const root = scratchRoot();
  const seededRepositories = fakeRepositoriesUnder(root, [
    {
      name: 'bakery',
      memoryFileNames: ['OLDEST_OVEN_LESSON.md', 'MIDDLE_DOUGH_LESSON.md', 'NEWEST_FLOUR_LESSON.md'],
      ask: 'Does the task touch the bakery ovens in any way?',
    },
  ]);
  const fixture = harness({ repositoryMemoryNamesPerRepository: 2 }, { seededRepositories });
  const backend = jevBackendAnswering({ bakery: 0.7 });
  await runRecall([...IN_PROJECT, PULL_REQUEST_TASK], { ...fixture.dependencies, chooseBackend: () => Promise.resolve(backend) });
  assert.equal(backend.requests.length, 1);
  const questions = backend.requests[0] ?? [];
  assert.ok(questions.some((question) => question.id.endsWith('NEVER_REPUBLISH.md')));
  const repositoryQuestion = questions.find((question) => question.id.startsWith('other repository: '));
  assert.equal(
    repositoryQuestion?.instructions,
    'Does the repository "bakery" likely hold a recorded lesson that helps with the work described in `task`? ' +
      'Does the task touch the bakery ovens in any way? ' +
      'The recorded lessons of bakery, most recently changed first, are titled: newest flour lesson; middle dough lesson.',
  );
});

test('memory names come most recently modified first and stop at the cap; the repository file is not a memory', async () => {
  const root = scratchRoot();
  const [bakery] = fakeRepositoriesUnder(root, [
    { name: 'bakery', memoryFileNames: ['FIRST.md', 'SECOND.md', 'THIRD.md'], ask: 'Does the task touch the bakery in any way?' },
  ]);
  const memoryDirectory = (bakery as RegisteredRepository).memoryDirectory;
  writeFileSync(path.join(memoryDirectory, 'MEMORY.md'), '# index\n');
  assert.deepEqual(await memoryFileNamesMostRecentFirst(memoryDirectory, 2), ['THIRD.md', 'SECOND.md']);
  assert.deepEqual(await memoryFileNamesMostRecentFirst(memoryDirectory, 40), ['THIRD.md', 'SECOND.md', 'FIRST.md']);
  assert.deepEqual(
    (await readMemoriesIn(memoryDirectory)).map((memory) => memory.fileName),
    ['FIRST.md', 'SECOND.md', 'THIRD.md'],
  );
});

test('the cap keeps the repository question of a 258-memory repository near 40 names', async () => {
  const root = scratchRoot();
  const manyNames = Array.from({ length: 258 }, (_, index) => `A_FAIRLY_LONG_LESSON_TITLE_NUMBER_${index}_ABOUT_SOMETHING.md`);
  const seededRepositories = fakeRepositoriesUnder(root, [{ name: 'big', memoryFileNames: manyNames }]);
  const backend = jevBackendAnswering({});
  const fixture = harness({}, { seededRepositories });
  await runRecall([...IN_PROJECT, PULL_REQUEST_TASK], { ...fixture.dependencies, chooseBackend: () => Promise.resolve(backend) });
  const repositoryQuestion = (backend.requests[0] ?? []).find((question) => question.id.startsWith('other repository: '));
  assert.equal(repositoryQuestion?.instructions.split('; ').length, 40);
  assert.ok(estimatedRequestTokens('', repositoryQuestion === undefined ? [] : [repositoryQuestion]) < 1000);
});

test('--lint-asks checks the ask in a repository file too', async () => {
  const root = scratchRoot();
  const [bakery] = fakeRepositoriesUnder(root, [{ name: 'bakery' }]);
  const memoryDirectory = (bakery as RegisteredRepository).memoryDirectory;
  writeFileSync(path.join(memoryDirectory, 'REPOSITORY.md'), '# The bakery, with no ask yet\n');
  const result = await lintAsks([{ path: memoryDirectory, repositoryName: 'bakery' }]);
  assert.deepEqual(
    result.violations
      .filter((violation) => violation.filePath.endsWith('REPOSITORY.md'))
      .map((violation) => violation.rule),
    ['missing-ask'],
  );
});

test('the ledger still records every scored repository, marking only the shown ones as listed', async () => {
  const root = scratchRoot();
  const seededRepositories = fakeRepositoriesUnder(root, [
    { name: 'bakery' },
    { name: 'florist' },
    { name: 'tailor' },
    { name: 'cobbler' },
  ]);
  const fixture = harness({}, { seededRepositories });
  const backend = jevBackendAnswering({ bakery: 0.2, florist: 0.9, tailor: 0.6, cobbler: 0.39 });
  await runRecall([...IN_PROJECT, PULL_REQUEST_TASK], { ...fixture.dependencies, chooseBackend: () => Promise.resolve(backend) });
  const repositoryLines = ledgerLines(fixture.dataDirectory).filter((line) => 'otherRepository' in line);
  assert.deepEqual(
    repositoryLines.map(({ repositoryName, pick, probability, backend: answeredBy, rank, listed }) => ({
      repositoryName,
      pick,
      probability,
      answeredBy,
      rank,
      listed,
    })),
    [
      { repositoryName: 'florist', pick: 'yes', probability: 0.9, answeredBy: 'jev', rank: 1, listed: true },
      { repositoryName: 'tailor', pick: 'yes', probability: 0.6, answeredBy: 'jev', rank: 2, listed: true },
      { repositoryName: 'cobbler', pick: 'yes', probability: 0.39, answeredBy: 'jev', rank: 3, listed: false },
      { repositoryName: 'bakery', pick: 'yes', probability: 0.2, answeredBy: 'jev', rank: 4, listed: false },
    ],
  );
  const [summary] = ledgerLines(fixture.dataDirectory);
  assert.ok(repositoryLines.every((line) => line.at === summary?.at && line.inputHash === summary?.inputHash));
});

test('when the rules answer, the repository answers are still recorded but none is listed', async () => {
  const root = scratchRoot();
  const seededRepositories = fakeRepositoriesUnder(root, [{ name: 'bakery', memoryFileNames: ['GITHUB_PULL_REQUEST_DESCRIPTION.md'] }]);
  const fixture = harness({}, { seededRepositories, backend: RULES_BACKEND });
  await runRecall([...IN_PROJECT, PULL_REQUEST_TASK], fixture.dependencies);
  const repositoryLines = ledgerLines(fixture.dataDirectory).filter((line) => 'otherRepository' in line);
  assert.deepEqual(
    repositoryLines.map((line) => [line.repositoryName, line.backend, line.listed]),
    [['bakery', 'rules', false]],
  );
});
