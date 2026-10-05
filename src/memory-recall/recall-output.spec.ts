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
import { recallCommandFor } from './other-repositories-output.ts';

const SEARCHED_LINE = /^Searched: /m;
const NOT_SEARCHED_HERE = 'Memories for any other repository are not searched here';
const QUOTED_TASK = `'${PULL_REQUEST_TASK}'`;

function outputWithRepositories(
  probabilityOfYesByRepository: Readonly<Record<string, number>>,
  options: {
    readonly hook?: boolean;
    readonly hookMode?: typeof SHADOW_ARM;
    readonly backend?: ClassifierBackend;
    readonly hookPayload?: string;
    readonly task?: string;
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
      runRecall(options.hook === true ? ['--hook'] : [...IN_PROJECT, options.task ?? PULL_REQUEST_TASK], {
        ...fixture.dependencies,
        chooseBackend: () => Promise.resolve(backend),
      }),
  };
}

function blockBeforeTheScopeLine(stdout: string): string {
  return stdout.slice(0, stdout.search(SEARCHED_LINE));
}

test('a repository Jev rates at or above the serving floor is printed as a directive whose command carries the task', async () => {
  const scenario = outputWithRepositories({ bakery: 0.46 });
  await scenario.run();
  assert.equal(
    blockBeforeTheScopeLine(scenario.fixture.stdout.join('')),
    [
      'bakery probably holds memories for this task (46%). Search it before looking it up yourself:',
      `throne recall --directory ${scenario.checkoutOf('bakery')} ${QUOTED_TASK}`,
      '',
    ].join('\n'),
  );
});

test('two repositories over the serving floor each get their own command, most likely first', async () => {
  const scenario = outputWithRepositories({ bakery: 0.2, florist: 0.44, tailor: 0.58 });
  await scenario.run();
  assert.equal(
    blockBeforeTheScopeLine(scenario.fixture.stdout.join('')),
    [
      'tailor (58%) and florist (44%) probably hold memories for this task. Search them before looking them up yourself:',
      `throne recall --directory ${scenario.checkoutOf('tailor')} ${QUOTED_TASK}`,
      `throne recall --directory ${scenario.checkoutOf('florist')} ${QUOTED_TASK}`,
      '',
    ].join('\n'),
  );
});

test('no more than three repositories are ever shown, even when more clear the serving floor', async () => {
  const scenario = outputWithRepositories({ bakery: 0.5, florist: 0.91, tailor: 0.55, cobbler: 0.4 });
  await scenario.run();
  assert.equal(
    blockBeforeTheScopeLine(scenario.fixture.stdout.join('')),
    [
      'florist (91%), tailor (55%) and bakery (50%) probably hold memories for this task. Search them before looking them up yourself:',
      `throne recall --directory ${scenario.checkoutOf('florist')} ${QUOTED_TASK}`,
      `throne recall --directory ${scenario.checkoutOf('tailor')} ${QUOTED_TASK}`,
      `throne recall --directory ${scenario.checkoutOf('bakery')} ${QUOTED_TASK}`,
      '',
    ].join('\n'),
  );
});

test('repositories below the serving floor are never printed, and the not-searched-here sentence stays', async () => {
  const scenario = outputWithRepositories({ bakery: 0.2, florist: 0.05 });
  await scenario.run();
  const stdout = scenario.fixture.stdout.join('');
  assert.ok(!stdout.includes('Other repositories'), stdout);
  assert.ok(!stdout.includes('probably hold'), stdout);
  assert.ok(!stdout.includes(scenario.checkoutOf('bakery')) && !stdout.includes(scenario.checkoutOf('florist')), stdout);
  assert.ok(stdout.includes(NOT_SEARCHED_HERE), stdout);
});

test('the not-searched-here sentence is left out when a directive was printed', async () => {
  const scenario = outputWithRepositories({ bakery: 0.8 });
  await scenario.run();
  const stdout = scenario.fixture.stdout.join('');
  assert.match(stdout, SEARCHED_LINE);
  assert.ok(!stdout.includes(NOT_SEARCHED_HERE), stdout);
});

test('a repository at 0.39 is hidden and one at 0.40 is shown', async () => {
  const scenario = outputWithRepositories({ bakery: 0.39, florist: 0.4 });
  await scenario.run();
  const stdout = scenario.fixture.stdout.join('');
  assert.ok(stdout.startsWith('florist probably holds memories for this task (40%).'), stdout);
  assert.ok(!stdout.includes(scenario.checkoutOf('bakery')), stdout);
});

test('a task with quotes, newlines and more than 120 characters is cut to its first line and quoted safely', async () => {
  const firstLine = `fix the "oven" timer that says it's done; rm -rf $HOME \`echo nope\` ${'and keep going '.repeat(8)}`;
  const scenario = outputWithRepositories({ bakery: 0.7 }, { task: `${firstLine}\nsecond line that must not appear` });
  await scenario.run();
  const commandLine = scenario.fixture.stdout.join('').split('\n')[1] ?? '';
  const taskWord = commandLine.slice(`throne recall --directory ${scenario.checkoutOf('bakery')} `.length);
  const taskAsTheShellReadsIt = execFileSync('sh', ['-c', `printf %s ${taskWord}`], { encoding: 'utf8' });
  assert.equal(taskAsTheShellReadsIt, firstLine.trim().slice(0, 120));
  assert.ok(!commandLine.includes('second line'), commandLine);
});

test('the literal <task> placeholder is used only when the task has no text', () => {
  assert.equal(recallCommandFor('/code/bakery', ''), 'throne recall --directory /code/bakery "<task>"');
  assert.equal(recallCommandFor('/code/bakery', ' \n\t\n '), 'throne recall --directory /code/bakery "<task>"');
  assert.equal(recallCommandFor('/code/bakery', '\n  bake bread  \n'), "throne recall --directory /code/bakery 'bake bread'");
});

test('the prompt hook prints the directive too, even when it serves no memory', async () => {
  const scenario = outputWithRepositories({ bakery: 0.8 }, { hook: true });
  await scenario.run();
  const stdout = scenario.fixture.stdout.join('');
  assert.ok(
    stdout.startsWith(
      `bakery probably holds memories for this task (80%). Search it before looking it up yourself:\nthrone recall --directory ${scenario.checkoutOf('bakery')} ${QUOTED_TASK}\nSearched: `,
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

test('--json prints the scope, the verdict, the served memories, the withheld ones with their reason, and only the shown repositories with commands carrying the task', async () => {
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
        recall: `throne recall --directory ${bakery.checkout} ${QUOTED_TASK}`,
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
