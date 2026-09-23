import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type {
  ClassifierBackend,
  ClassifierState,
} from '../relevance-classifier/classifier.types.ts';
import {
  DEFAULT_RECALL_CONFIG,
  type RecallConfig,
} from '../relevance-classifier/recall-user-config.ts';
import { RECALL_LEDGER_FILE_NAME } from '../memory-recall/recall-records.ts';
import { gatherFileItems } from './rank-items.ts';
import { CHARACTERS_IN_THE_LARGEST_PIECE } from './rank-requests.ts';
import { runRank, type RankDependencies } from './rank.command.ts';

const SECRET_CONTENT = 'CONTENT-THAT-MUST-NEVER-BE-PRINTED';

interface Fixture {
  readonly dependencies: RankDependencies;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly root: string;
  readonly allowedDirectory: string;
  readonly outsideDirectory: string;
  readonly dataDirectory: string;
  readonly statesSentToJev: ClassifierState[];
}

function fakeJevScoringBy(probabilityOfText: (text: string) => number, sent: ClassifierState[]): ClassifierBackend {
  return {
    name: 'jev',
    answer: (state, questions) => {
      sent.push(state);
      return Promise.resolve(
        questions.map((question) => {
          const text = typeof state === 'string' ? state : (state[question.stateField ?? ''] ?? '');
          const probability = probabilityOfText(text);
          return probability >= 0.5
            ? { questionId: question.id, pick: 'yes', probability }
            : { questionId: question.id, pick: 'no', probability: 1 - probability };
        }),
      );
    },
  };
}

function fixture(options: {
  backend?: (sent: ClassifierState[]) => ClassifierBackend;
  stdin?: string;
  loadConfig?: () => Promise<RecallConfig>;
} = {}): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'rank-command-'));
  const allowedDirectory = path.join(root, 'allowed');
  const outsideDirectory = path.join(root, 'outside');
  const dataDirectory = path.join(root, 'data');
  mkdirSync(allowedDirectory);
  mkdirSync(outsideDirectory);
  writeFileSync(path.join(allowedDirectory, 'billing.txt'), `${SECRET_CONTENT} invoices and billing retries`);
  writeFileSync(path.join(allowedDirectory, 'wifi.txt'), `${SECRET_CONTENT} router channel settings`);
  writeFileSync(path.join(allowedDirectory, 'mixed.txt'), `${SECRET_CONTENT} billing mentioned once`);
  writeFileSync(path.join(outsideDirectory, 'private.txt'), `${SECRET_CONTENT} customer billing export`);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const statesSentToJev: ClassifierState[] = [];
  const backend = options.backend?.(statesSentToJev);
  return {
    stdout,
    stderr,
    root,
    allowedDirectory,
    outsideDirectory,
    dataDirectory,
    statesSentToJev,
    dependencies: {
      loadConfig:
        options.loadConfig ??
        (() => Promise.resolve({ ...DEFAULT_RECALL_CONFIG, rankAllowedRoots: [allowedDirectory] })),
      chooseBackend: async () =>
        backend ?? (await import('../relevance-classifier/rules-backend.ts')).RULES_BACKEND,
      readJevSwitch: () =>
        Promise.resolve({
          on: false,
          enabledInConfig: false,
          disabledByEnvironment: false,
          keyFile: 'not-checked',
          keyFilePath: '/keys/jev',
        }),
      gatherFileItems,
      readStdin: () => Promise.resolve(options.stdin ?? ''),
      dataDirectory,
      now: () => new Date('2026-09-21T00:00:00Z'),
      writeStdout: (text) => stdout.push(text),
      writeStderr: (text) => stderr.push(text),
    },
  };
}

const scoreByBillingWords = (text: string): number =>
  text.includes('invoices') ? 0.9 : text.includes('billing') ? 0.6 : 0.1;

test('items are printed most likely first, with probability and path, and never their contents', async () => {
  const ranking = fixture({ backend: (sent) => fakeJevScoringBy(scoreByBillingWords, sent) });
  const glob = path.join(ranking.allowedDirectory, '*.txt');
  assert.equal(await runRank(['Is this about billing?', glob], ranking.dependencies), 0);
  assert.deepEqual(ranking.stdout.join('').trim().split('\n'), [
    `0.90  ${path.join(ranking.allowedDirectory, 'billing.txt')}`,
    `0.60  ${path.join(ranking.allowedDirectory, 'mixed.txt')}`,
    `0.10  ${path.join(ranking.allowedDirectory, 'wifi.txt')}`,
  ]);
  assert.doesNotMatch(ranking.stdout.join('') + ranking.stderr.join(''), new RegExp(SECRET_CONTENT));
});

test('small items share one request as named fields', async () => {
  const ranking = fixture({ backend: (sent) => fakeJevScoringBy(scoreByBillingWords, sent) });
  await runRank(['Is this about billing?', path.join(ranking.allowedDirectory, '*.txt')], ranking.dependencies);
  assert.equal(ranking.statesSentToJev.length, 1);
  assert.deepEqual(Object.keys(ranking.statesSentToJev[0] as object), ['item_0', 'item_1', 'item_2']);
});

test('--top and --min trim the list, and --json is machine readable', async () => {
  const ranking = fixture({ backend: (sent) => fakeJevScoringBy(scoreByBillingWords, sent) });
  const glob = path.join(ranking.allowedDirectory, '*.txt');
  await runRank(['Is this about billing?', '--min', '0.5', '--top', '1', '--json', glob], ranking.dependencies);
  assert.deepEqual(JSON.parse(ranking.stdout.join('')), [
    { id: path.join(ranking.allowedDirectory, 'billing.txt'), probability: 0.9, backend: 'jev' },
  ]);
});

test('a file outside the allowed roots is never sent even with Jev on, and is named as not sent', async () => {
  const ranking = fixture({ backend: (sent) => fakeJevScoringBy(scoreByBillingWords, sent) });
  const outsideFile = path.join(ranking.outsideDirectory, 'private.txt');
  await runRank(
    ['Is this about billing?', path.join(ranking.allowedDirectory, 'billing.txt'), outsideFile],
    ranking.dependencies,
  );
  assert.doesNotMatch(JSON.stringify(ranking.statesSentToJev), /customer billing export/);
  assert.match(JSON.stringify(ranking.statesSentToJev), /invoices/);
  assert.match(ranking.stderr.join(''), new RegExp(`not sent to Jev.*${outsideFile}`));
  assert.match(ranking.stdout.join(''), new RegExp(outsideFile));
});

test('stdin items are never sent without the flag, and are sent with it', async () => {
  const stdin = '{"id":"TICKET-1","text":"billing retries fail"}\nplain line about wifi\n';
  const withoutFlag = fixture({ stdin, backend: (sent) => fakeJevScoringBy(scoreByBillingWords, sent) });
  await runRank(['Is this about billing?'], withoutFlag.dependencies);
  assert.deepEqual(withoutFlag.statesSentToJev, []);
  assert.match(withoutFlag.stdout.join(''), /TICKET-1\n/);
  assert.match(withoutFlag.stdout.join(''), /line 2\n/);
  const withFlag = fixture({ stdin, backend: (sent) => fakeJevScoringBy(scoreByBillingWords, sent) });
  await runRank(['Is this about billing?', '--allow-stdin-to-jev'], withFlag.dependencies);
  assert.equal(withFlag.statesSentToJev.length, 1);
});

test('with Jev off the rules rank by the question words each item contains, and say so', async () => {
  const ranking = fixture();
  await runRank(['Is this about billing invoices?', path.join(ranking.allowedDirectory, '*.txt')], ranking.dependencies);
  assert.deepEqual(
    ranking.stdout.join('').trim().split('\n').map((line) => path.basename(line)),
    ['billing.txt', 'mixed.txt', 'wifi.txt'],
  );
  assert.match(ranking.stderr.join(''), /word matching against the question, not meaning/);
  assert.deepEqual(ranking.statesSentToJev, []);
});

test('a failing backend prints every item unranked, with one line saying ranking failed', async () => {
  const ranking = fixture({
    backend: () => ({ name: 'jev', answer: () => Promise.reject(Object.assign(new Error('slow'), { status: 429 })) }),
  });
  const missingFile = path.join(ranking.allowedDirectory, 'missing.txt');
  await runRank(
    ['Is this about billing?', path.join(ranking.allowedDirectory, '*.txt'), missingFile],
    ranking.dependencies,
  );
  const lines = ranking.stdout.join('').trim().split('\n');
  assert.equal(lines.length, 4);
  assert.ok(lines.every((line) => line.startsWith('-     ')));
  assert.equal(ranking.stderr.filter((line) => line.includes('ranking failed')).length, 1);
});

test('an unloadable config lists the items as given rather than losing them', async () => {
  const ranking = fixture({ loadConfig: () => Promise.reject(new Error('broken config')) });
  assert.equal(await runRank(['Is it?', 'a.txt', 'b.txt'], ranking.dependencies), 0);
  assert.deepEqual(ranking.stdout.join('').trim().split('\n'), ['-     a.txt', '-     b.txt']);
});

test('a file too large for one request is split and scores as its best piece', async () => {
  const ranking = fixture({ backend: (sent) => fakeJevScoringBy(scoreByBillingWords, sent) });
  const largeFile = path.join(ranking.allowedDirectory, 'large.log');
  writeFileSync(largeFile, `${'x'.repeat(CHARACTERS_IN_THE_LARGEST_PIECE + 10)} invoices at the very end`);
  await runRank(['Is this about billing?', largeFile], ranking.dependencies);
  assert.equal(ranking.stdout.join(''), `0.90  ${largeFile}\n`);
  assert.ok(ranking.statesSentToJev.length >= 2);
});

test('the ledger records ids, hashes and probabilities, never contents or the question', async () => {
  const ranking = fixture({ backend: (sent) => fakeJevScoringBy(scoreByBillingWords, sent) });
  await runRank(['Is this about billing?', path.join(ranking.allowedDirectory, '*.txt')], ranking.dependencies);
  const ledger = readFileSync(path.join(ranking.dataDirectory, RECALL_LEDGER_FILE_NAME), 'utf8');
  assert.match(ledger, /"command":"rank"/);
  assert.match(ledger, /billing\.txt/);
  assert.match(ledger, /"backend":"jev"/);
  assert.doesNotMatch(ledger, new RegExp(SECRET_CONTENT));
  assert.doesNotMatch(ledger, /Is this about billing/);
});

test('rank without a question, or with an unknown flag, is a steered exit 2', async () => {
  const noQuestion = fixture();
  assert.equal(await runRank([], noQuestion.dependencies), 2);
  assert.match(noQuestion.stderr.join(''), /Usage: .*rank/);
  const unknownFlag = fixture();
  assert.equal(await runRank(['Is it?', '--contents'], unknownFlag.dependencies), 2);
  assert.match(unknownFlag.stderr.join(''), /unknown flag "--contents"/);
  const badTop = fixture();
  assert.equal(await runRank(['Is it?', '--top', 'many'], badTop.dependencies), 2);
});
