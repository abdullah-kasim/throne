import assert from 'node:assert/strict';
import { realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  NO,
  YES,
  type BackendAnswer,
  type ClassifierBackend,
} from '../relevance-classifier/classifier.types.ts';
import { JevBudgetUsedUpError } from '../relevance-classifier/jev-backend.ts';
import { SHADOW_ARM } from '../relevance-classifier/recall-user-config.ts';
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
} from './recall.command.test-support.ts';
import type { RegisteredRepository } from './repository-registry.ts';

const SEARCHED_LINE = /^Searched: /m;

function outputWithRepositories(
  probabilityOfYesByRepository: Readonly<Record<string, number>>,
  options: {
    readonly hook?: boolean;
    readonly hookMode?: typeof SHADOW_ARM;
    readonly backend?: ClassifierBackend;
    readonly hookPayload?: string;
  } = {},
) {
  const root = scratchRoot();
  const seededRepositories = fakeRepositoriesUnder(
    root,
    Object.keys(probabilityOfYesByRepository).map((name) => ({ name })),
  );
  const fixture = harness(
    { hookEnabled: true, ...(options.hookMode === undefined ? {} : { hookMode: options.hookMode }) },
    { seededRepositories, stdin: options.hookPayload ?? HOOK_PAYLOAD },
  );
  const backend = options.backend ?? jevBackendAnswering(probabilityOfYesByRepository);
  return {
    root,
    fixture,
    checkoutOf: (name: string) => path.join(root, 'checkouts', name),
    run: () =>
      runRecall(options.hook === true ? ['--hook'] : [...IN_PROJECT, PULL_REQUEST_TASK], {
        ...fixture.dependencies,
        chooseBackend: () => Promise.resolve(backend),
      }),
  };
}

test('a hand recall lists the three most likely other repositories after the verdict line, most likely first, with the command to search each', async () => {
  const scenario = outputWithRepositories({ bakery: 0.2, florist: 0.91, tailor: 0.55, cobbler: 0.4 });
  await scenario.run();
  const stdout = scenario.fixture.stdout.join('');
  const block = stdout.slice(0, stdout.search(SEARCHED_LINE));
  assert.equal(
    block,
    [
      'Other repositories that may hold relevant memories:',
      `- florist (91%): throne recall --directory ${scenario.checkoutOf('florist')} "<task>"`,
      `- tailor (55%): throne recall --directory ${scenario.checkoutOf('tailor')} "<task>"`,
      `- cobbler (40%): throne recall --directory ${scenario.checkoutOf('cobbler')} "<task>"`,
      '',
    ].join('\n'),
  );
});

test('repositories with the same probability are listed in name order, and a low probability is still listed', async () => {
  const scenario = outputWithRepositories({ tailor: 0.05, bakery: 0.05, florist: 0.05, cobbler: 0.05 });
  await scenario.run();
  const listedNames = [...scenario.fixture.stdout.join('').matchAll(/^- (\w+) \(5%\)/gm)].map((match) => match[1]);
  assert.deepEqual(listedNames, ['bakery', 'cobbler', 'florist']);
});

test('the prompt hook prints the block too, even when it serves no memory', async () => {
  const scenario = outputWithRepositories({ bakery: 0.8 }, { hook: true });
  await scenario.run();
  const stdout = scenario.fixture.stdout.join('');
  assert.ok(
    stdout.startsWith(
      `Other repositories that may hold relevant memories:\n- bakery (80%): throne recall --directory ${scenario.checkoutOf('bakery')} "<task>"\nSearched: `,
    ),
    stdout,
  );
});

test('the shadow arm of the hook prints nothing, yet still asks about the other repositories', async () => {
  const backend = jevBackendAnswering({ bakery: 0.8 });
  const scenario = outputWithRepositories({ bakery: 0.8 }, { hook: true, hookMode: SHADOW_ARM, backend });
  await scenario.run();
  assert.equal(scenario.fixture.stdout.join(''), '');
  assert.ok((backend.requests[0] ?? []).some((question) => question.id.startsWith('other repository: ')));
});

test('when the rules answer, a hand recall lists no repository and says the rules answered', async () => {
  const rulesBackend = { ...jevBackendAnswering({ bakery: 0.99 }), name: 'rules' as const };
  const scenario = outputWithRepositories({ bakery: 0.99 }, { backend: rulesBackend });
  await scenario.run();
  const stdout = scenario.fixture.stdout.join('');
  assert.ok(
    stdout.includes('Other repositories that may hold relevant memories: none listed, because the rules answered instead of Jev.\n'),
    stdout,
  );
  assert.ok(!stdout.includes(scenario.checkoutOf('bakery')), stdout);
});

test('when the Jev budget is used up, the note names it and nothing is listed, in a hand recall and in the hook alike', async () => {
  const exhausted: ClassifierBackend = {
    name: 'jev',
    answer: () => Promise.reject(new JevBudgetUsedUpError('over the hourly limit')),
  };
  const hand = outputWithRepositories({ bakery: 0.99 }, { backend: exhausted });
  await hand.run();
  assert.ok(
    hand.fixture.stdout
      .join('')
      .includes('Other repositories that may hold relevant memories: none listed, because the rules (Jev budget used up) answered instead of Jev.\n'),
    hand.fixture.stdout.join(''),
  );
  const hook = outputWithRepositories(
    { bakery: 0.99 },
    { backend: exhausted, hook: true, hookPayload: JSON.stringify({ session_id: 'abc', cwd: '/somewhere', prompt: 'water the plants' }) },
  );
  await hook.run();
  const hookOutput = hook.fixture.stdout.join('');
  assert.ok(
    hookOutput.startsWith(
      "rules (Jev budget used up): no relevant memory in project's memories and the global memories.\n" +
        'Other repositories that may hold relevant memories: none listed, because the rules (Jev budget used up) answered instead of Jev.\n',
    ),
    hookOutput,
  );
  assert.ok(!hookOutput.includes(hook.checkoutOf('bakery')), hookOutput);
});

function answeringByFileName(
  answers: Readonly<Record<string, Pick<BackendAnswer, 'pick' | 'probability'>>>,
  repositories: Readonly<Record<string, number>>,
): ClassifierBackend {
  const repositoryAnswers = jevBackendAnswering(repositories);
  return {
    name: 'jev',
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

test('--json prints the scope, the verdict, the served memories, the withheld ones with their reason, and the listed repositories', async () => {
  const { fixture, bakery, dependencies } = withheldScenario();
  await runRecall([...IN_PROJECT, '--json', PULL_REQUEST_TASK], dependencies);
  const projectMemories = realpathSync(fixture.projectMemories);
  assert.deepEqual(JSON.parse(fixture.stdout.join('')), {
    scope: {
      repositories: [path.join(fixture.currentDirectory, 'project')],
      globalMemoryDirectories: [fixture.globalMemories],
    },
    verdict: { memoryLikelyExists: true, confidence: 0.9, backend: 'jev' },
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
    otherRepositories: [
      {
        repository: 'bakery',
        checkout: bakery.checkout,
        memoryDirectory: bakery.memoryDirectory,
        probability: 0.7,
        recall: `throne recall --directory ${bakery.checkout} "<task>"`,
      },
      {
        repository: 'florist',
        checkout: bakery.checkout.replace(/bakery$/, 'florist'),
        memoryDirectory: bakery.memoryDirectory.replace(/bakery$/, 'florist'),
        probability: 0.1,
        recall: `throne recall --directory ${bakery.checkout.replace(/bakery$/, 'florist')} "<task>"`,
      },
    ],
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
  const hook = harness({ hookEnabled: true }, { stdin: HOOK_PAYLOAD });
  assert.equal(await runRecall(['--hook', '--json'], hook.dependencies), 0);
  assert.equal(hook.stdout.join(''), '');
});

test('a memory answered no is neither served nor withheld', async () => {
  const fixture = harness();
  const backend = answeringByFileName({ 'NEVER_REPUBLISH.md': { pick: NO, probability: 0.9 }, 'NETWORK_SAFETY.md': { pick: NO, probability: 0.9 } }, {});
  await runRecall([...IN_PROJECT, '--json', PULL_REQUEST_TASK], { ...fixture.dependencies, chooseBackend: () => Promise.resolve(backend) });
  const json = JSON.parse(fixture.stdout.join('')) as { memories: unknown[]; withheldMemories: unknown[] };
  assert.deepEqual([json.memories, json.withheldMemories], [[], []]);
});
