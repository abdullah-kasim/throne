import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ClassifierBackend } from '../relevance-classifier/classifier.types.ts';
import {
  DEFAULT_RECALL_CONFIG,
  type RecallConfig,
} from '../relevance-classifier/recall-user-config.ts';
import { RULES_BACKEND } from '../relevance-classifier/rules-backend.ts';
import { LINES_PER_CHUNK, overlappingChunks } from './chunks.ts';
import { runSift, type SiftDependencies } from './sift.command.ts';

const FULL_COPY_PATH = '/home/someone/tmp/sift-copy.log';

function logOf(lineCount: number, special: Readonly<Record<number, string>>): string {
  return `${Array.from(
    { length: lineCount },
    (_unused, index) => special[index + 1] ?? `ok ${index + 1} - routine passing check`,
  ).join('\n')}\n`;
}

interface Harness {
  readonly dependencies: SiftDependencies;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly savedInputs: string[];
}

function harness(
  stdin: string,
  backend: ClassifierBackend = RULES_BACKEND,
  loadConfig: () => Promise<RecallConfig> = () => Promise.resolve(DEFAULT_RECALL_CONFIG),
): Harness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const savedInputs: string[] = [];
  return {
    stdout,
    stderr,
    savedInputs,
    dependencies: {
      loadConfig,
      chooseBackend: () => Promise.resolve(backend),
      readJevSwitch: () =>
        Promise.resolve({
          on: false,
          enabledInConfig: false,
          disabledByEnvironment: false,
          keyFile: 'not-checked',
          keyFilePath: '/keys/jev',
        }),
      readStdin: () => Promise.resolve(stdin),
      saveFullInput: (text) => {
        savedInputs.push(text);
        return Promise.resolve(FULL_COPY_PATH);
      },
      writeStdout: (text) => stdout.push(text),
      writeStderr: (text) => stderr.push(text),
    },
  };
}

test('neighbouring chunks overlap and together cover every line exactly to the end', () => {
  const chunks = overlappingChunks(Array.from({ length: 100 }, (_unused, index) => `line ${index + 1}`));
  assert.deepEqual(
    chunks.map((chunk) => [chunk.firstLineNumber, chunk.lastLineNumber]),
    [
      [1, 40],
      [36, 75],
      [71, 100],
    ],
  );
  assert.equal(chunks[0]?.text.split('\n').length, LINES_PER_CHUNK);
});

test('the rules keep the chunk with a failure word, the chunk naming the query, and the last chunk', async () => {
  const input = logOf(300, {
    50: 'NOT OK 50 - loads the config',
    150: 'resolving the podman runtime',
    300: '# tests 300',
  });
  const fixture = harness(input);
  assert.equal(await runSift(['podman', 'runtime'], fixture.dependencies), 0);
  const printed = fixture.stdout.join('');
  assert.match(printed, /^ 50: NOT OK 50 - loads the config$/m);
  assert.match(printed, /^150: resolving the podman runtime$/m);
  assert.match(printed, /^300: # tests 300$/m);
  assert.doesNotMatch(printed, /^ 10: /m);
  assert.doesNotMatch(printed, /^200: /m);
  assert.match(printed, /\.\.\.\n/);
  assert.deepEqual(fixture.savedInputs, [input]);
  const keptLineCount = printed.split('\n').filter((line) => /^\s*\d+: /.test(line)).length;
  assert.match(
    fixture.stdout.at(-1) ?? '',
    new RegExp(`^sift: dropped ${300 - keptLineCount} of 300 lines; full copy at ${FULL_COPY_PATH}\\n$`),
  );
  assert.ok(keptLineCount < 150);
});

test('a line shared by two kept chunks is printed once', async () => {
  const fixture = harness(logOf(100, { 38: 'error in the overlap' }));
  await runSift(['anything'], fixture.dependencies);
  assert.equal(fixture.stdout.join('').match(/error in the overlap/g)?.length, 1);
});

const BROKEN_BACKENDS: readonly [string, ClassifierBackend['answer']][] = [
  ['throws', () => Promise.reject(new Error('boom'))],
  ['is rate limited', () => Promise.reject(Object.assign(new Error('slow'), { status: 429 }))],
  ['is unsure', (_state, questions) =>
    Promise.resolve(questions.map((question) => ({ questionId: question.id, pick: 'no', probability: 0.5 })))],
];

for (const [situation, answer] of BROKEN_BACKENDS) {
  test(`a backend that ${situation} keeps every line`, async () => {
    const fixture = harness(logOf(120, {}), { name: 'jev', answer });
    assert.equal(await runSift(['anything'], fixture.dependencies), 0);
    assert.match(fixture.stdout.at(-1) ?? '', /^sift: dropped 0 of 120 lines/);
  });
}

test('an unloadable config keeps every line and still saves the full copy', async () => {
  const input = logOf(120, {});
  const fixture = harness(input, RULES_BACKEND, () => Promise.reject(new Error('broken config')));
  assert.equal(await runSift(['anything'], fixture.dependencies), 0);
  assert.deepEqual(fixture.stdout, [input]);
  assert.deepEqual(fixture.savedInputs, [input]);
  assert.match(fixture.stderr.join(''), /broken config/);
});

test('sift without a query is refused with the usage and reads nothing', async () => {
  const fixture = harness('some input');
  assert.equal(await runSift([], fixture.dependencies), 2);
  assert.match(fixture.stderr.join(''), /Usage: .*sift/);
  assert.deepEqual(fixture.savedInputs, []);
});

test('an unknown flag is a steered exit 2', async () => {
  const fixture = harness('some input');
  assert.equal(await runSift(['--quiet', 'anything'], fixture.dependencies), 2);
  assert.match(fixture.stderr.join(''), /unknown flag "--quiet"/);
  assert.deepEqual(fixture.savedInputs, []);
});

test('when the full copy cannot be saved every line is printed, because a dropped line would be lost', async () => {
  const input = logOf(120, {});
  const fixture = harness(input);
  const dependencies = { ...fixture.dependencies, saveFullInput: () => Promise.reject(new Error('disk full')) };
  assert.equal(await runSift(['anything'], dependencies), 0);
  assert.deepEqual(fixture.stdout, [input]);
  assert.match(fixture.stderr.join(''), /disk full/);
});

test('after a whole group of chunks fails open the backend is not asked again', async () => {
  let callCount = 0;
  const fixture = harness(logOf(2000, {}), {
    name: 'jev',
    answer: () => {
      callCount += 1;
      return Promise.reject(new Error('network down'));
    },
  });
  assert.equal(await runSift(['anything'], fixture.dependencies), 0);
  assert.equal(callCount, 8);
  assert.match(fixture.stdout.at(-1) ?? '', /^sift: dropped 0 of 2000 lines/);
});
