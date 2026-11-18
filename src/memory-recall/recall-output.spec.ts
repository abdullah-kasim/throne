import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  NO,
  YES,
  type BackendAnswer,
  type ClassifierBackend,
} from '../relevance-classifier/classifier.types.ts';
import { SHADOW_ARM } from '../relevance-classifier/recall-user-config.ts';
import {
  fakeRepositoriesUnder,
  backendAnswering,
  scratchRoot,
} from './other-repositories.test-support.ts';
import { runRecall } from './recall.command.ts';
import {
  IN_PROJECT,
  PULL_REQUEST_TASK,
  harness,
} from './recall.command.test-support.ts';
import type { RegisteredRepository } from './repository-registry.ts';
import { recallCommandFor } from './other-repositories-output.ts';

const SEARCHED_LINE = /^Searched: /m;
const NOT_SEARCHED_HERE = 'Memories for any other repository are not searched here';
const QUOTED_TASK = `'${PULL_REQUEST_TASK}'`;

function outputWithRepositories(
  probabilityOfYesByRepository: Readonly<Record<string, number>>,
  options: {
    readonly backend?: ClassifierBackend;
    readonly task?: string;
  } = {},
) {
  const root = scratchRoot();
  const seededRepositories = fakeRepositoriesUnder(
    root,
    Object.keys(probabilityOfYesByRepository).map((name) => ({ name })),
  );
  const fixture = harness(
    {},
    { seededRepositories },
  );
  const backend = options.backend ?? backendAnswering(probabilityOfYesByRepository);
  return {
    root,
    fixture,
    checkoutOf: (name: string) => path.join(root, 'checkouts', name),
    run: () =>
      runRecall([...IN_PROJECT, options.task ?? PULL_REQUEST_TASK], {
        ...fixture.dependencies,
        chooseBackend: () => Promise.resolve(backend),
      }),
  };
}

function blockBeforeTheScopeLine(stdout: string): string {
  return stdout.slice(0, stdout.search(SEARCHED_LINE));
}

test('the literal <task> placeholder is used only when the task has no text', () => {
  assert.equal(recallCommandFor('/code/bakery', ''), 'throne recall --directory /code/bakery "<task>"');
  assert.equal(recallCommandFor('/code/bakery', ' \n\t\n '), 'throne recall --directory /code/bakery "<task>"');
  assert.equal(recallCommandFor('/code/bakery', '\n  bake bread  \n'), "throne recall --directory /code/bakery 'bake bread'");
});

test('when the rules answer, a hand recall lists no repository and says the rules answered', async () => {
  const rulesBackend = { ...backendAnswering({ bakery: 0.99 }), name: 'rules' as const };
  const scenario = outputWithRepositories({ bakery: 0.99 }, { backend: rulesBackend });
  await scenario.run();
  const stdout = scenario.fixture.stdout.join('');
  assert.ok(
    stdout.includes('Other repositories that may hold relevant memories: none listed, because the rules answered.\n'),
    stdout,
  );
  assert.ok(!stdout.includes(scenario.checkoutOf('bakery')), stdout);
});

function answeringByFileName(
  answers: Readonly<Record<string, Pick<BackendAnswer, 'pick' | 'probability'>>>,
  repositories: Readonly<Record<string, number>>,
): ClassifierBackend {
  const repositoryAnswers = backendAnswering(repositories);
  return {
    name: 'rules',
    answer: async (state, questions) => {
      const repositoryReplies = await repositoryAnswers.answer(state, questions);
      return questions.map((question, index) => {
        const byFileName = answers[path.basename(question.id)];
        return byFileName === undefined
          ? (repositoryReplies[index] as BackendAnswer)
          : { questionId: question.id, ...byFileName };
      });
    },
  };
}

const BIG_LESSON = `---\nask: Does the task edit a GitHub pull request description?\n---\n# A very long lesson\n\n${'- one more line of it\n'.repeat(500)}`;

function withheldScenario() {
  const root = scratchRoot();
  const seededRepositories = fakeRepositoriesUnder(root, [{ name: 'bakery' }, { name: 'florist' }]);
  const [bakery] = seededRepositories;
  const fixture = harness({}, { seededRepositories });
  writeFileSync(path.join(fixture.projectMemories, 'BIG_LESSON.md'), BIG_LESSON);
  const backend = answeringByFileName(
    {
      'BIG_LESSON.md': { pick: YES, probability: 0.9 },
      'NEVER_REPUBLISH.md': { pick: YES, probability: 0.8 },
      'NETWORK_SAFETY.md': { pick: YES, probability: 0.3 },
    },
    { bakery: 0.7, florist: 0.1 },
  );
  return { fixture, bakery: bakery as RegisteredRepository, dependencies: { ...fixture.dependencies, chooseBackend: () => Promise.resolve(backend) } };
}

test('--json prints the scope, the verdict, the served memories, the withheld ones with their reason, and no other repository', async () => {
  const { fixture, bakery, dependencies } = withheldScenario();
  await runRecall([...IN_PROJECT, '--json', PULL_REQUEST_TASK], dependencies);
  const projectMemories = realpathSync(fixture.projectMemories);
  assert.deepEqual(JSON.parse(fixture.stdout.join('')), {
    scope: {
      repositories: [path.join(fixture.currentDirectory, 'project')],
      globalMemoryDirectories: [fixture.globalMemories],
    },
    verdict: { memoryLikelyExists: true, confidence: 0.9, backend: 'rules' },
    memories: [
      {
        file: path.join(projectMemories, 'NEVER_REPUBLISH.md'),
        probability: 0.8,
        served: true,
        body: '# Never republish a pull request body from a local file\n\n- it grows by a newline each time',
      },
    ],
    withheldMemories: [
      { file: path.join(projectMemories, 'BIG_LESSON.md'), probability: 0.9, reason: 'over the size limit' },
      { file: path.join(realpathSync(fixture.globalMemories), 'NETWORK_SAFETY.md'), probability: 0.3, reason: 'below the serving floor' },
    ],
    otherRepositories: [],
  });
  assert.equal(fixture.stderr.join(''), '');
});

test('the stderr line names the real reason each relevant memory was not served', async () => {
  const { fixture, dependencies } = withheldScenario();
  await runRecall([...IN_PROJECT, PULL_REQUEST_TASK], dependencies);
  assert.equal(
    fixture.stderr.join(''),
    'recall: 2 relevant memories were not served: BIG_LESSON.md (over the size limit), NETWORK_SAFETY.md (below the serving floor)\n',
  );
});

test('--json is refused outside a hand recall', async () => {
  for (const mode of [['--status'], ['--report']]) {
    const fixture = harness();
    assert.equal(await runRecall([...mode, '--json'], fixture.dependencies), 2);
    assert.match(fixture.stderr.join(''), /--json only go with a hand recall/);
  }
});

test('a memory answered no is neither served nor withheld', async () => {
  const fixture = harness();
  const backend = answeringByFileName({ 'NEVER_REPUBLISH.md': { pick: NO, probability: 0.9 }, 'NETWORK_SAFETY.md': { pick: NO, probability: 0.9 } }, {});
  await runRecall([...IN_PROJECT, '--json', PULL_REQUEST_TASK], { ...fixture.dependencies, chooseBackend: () => Promise.resolve(backend) });
  const json = JSON.parse(fixture.stdout.join('')) as { memories: unknown[]; withheldMemories: unknown[] };
  assert.deepEqual([json.memories, json.withheldMemories], [[], []]);
});
