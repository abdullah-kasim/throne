import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { chooseClassifierBackend, type BackendChoiceDependencies } from './choose-backend.ts';
import { yesOrNoQuestion } from './classifier.types.ts';
import {
  PRODUCTION_JEV_SWITCH_DEPENDENCIES,
  readJevSwitch,
  renderedJevStatus,
  type KeyFileFacts,
} from './jev-switch.ts';
import { DEFAULT_RECALL_CONFIG, JEV_LIMIT_FIELDS } from './recall-user-config.ts';

const FAKE_KEY = 'not-a-real-key';
const JEV_DATA_HOME = await mkdtemp(path.join(tmpdir(), 'jev-switch-'));
const NO_SPENDING = {
  spend: { todayTokens: 0, lastHourTokens: 0 },
  limits: { tokensPerDay: 1, tokensPerHour: 1 },
  lockBusyRequestsToday: 0,
};
const QUESTION = yesOrNoQuestion('a', 'Is it?', { kind: 'any-phrase', phrases: [] });

interface Probe {
  readonly dependencies: BackendChoiceDependencies;
  readonly keyFileReads: string[];
  readonly clientsCreated: string[];
  readonly requests: unknown[];
  readonly stderr: string[];
}

function probe(environment: NodeJS.ProcessEnv = {}, keyFileText: string | Error = `${FAKE_KEY}\n`): Probe {
  const keyFileReads: string[] = [];
  const clientsCreated: string[] = [];
  const requests: unknown[] = [];
  const stderr: string[] = [];
  const readKeyFile = (keyFilePath: string): Promise<string> => {
    keyFileReads.push(keyFilePath);
    return keyFileText instanceof Error ? Promise.reject(keyFileText) : Promise.resolve(keyFileText);
  };
  const statKeyFile = (): Promise<KeyFileFacts> =>
    keyFileText instanceof Error
      ? Promise.reject(keyFileText)
      : Promise.resolve({ isFile: () => true, size: keyFileText.length });
  return {
    keyFileReads,
    clientsCreated,
    requests,
    stderr,
    dependencies: {
      jevSwitch: { environment, statKeyFile },
      jevBackend: {
        readKeyFile,
        createClient: (apiKey) => {
          clientsCreated.push(apiKey);
          return Promise.resolve({
            systemOne: (request) => {
              requests.push(request);
              return Promise.resolve({ answers: { question_0: { type: 'noul', noul: 1 } } });
            },
          });
        },
      },
      jevDataHome: JEV_DATA_HOME,
      writeStderr: (text) => stderr.push(text),
    },
  };
}

const DEFAULT_LIMITS = {
  jevTokensPerDay: DEFAULT_RECALL_CONFIG.jevTokensPerDay,
  jevTokensPerHour: DEFAULT_RECALL_CONFIG.jevTokensPerHour,
};
const ON = { jevEnabled: true, jevKeyFile: '/keys/jev', ...DEFAULT_LIMITS };
const OFF = { jevEnabled: false, jevKeyFile: '/keys/jev', ...DEFAULT_LIMITS };

function assertNothingReachedJev(checked: Probe): void {
  assert.deepEqual(checked.keyFileReads, []);
  assert.deepEqual(checked.clientsCreated, []);
  assert.deepEqual(checked.requests, []);
}

test('switched off in the config: no key file read, no client, no request', async () => {
  const offProbe = probe();
  const backend = await chooseClassifierBackend(OFF, 'hand recall', offProbe.dependencies);
  assert.equal(backend.name, 'rules');
  await backend.answer('some task', [QUESTION]);
  assertNothingReachedJev(offProbe);
});

test('switched on: the key is read and the request goes to Jev', async () => {
  const onProbe = probe();
  const backend = await chooseClassifierBackend(ON, 'hand recall', onProbe.dependencies);
  assert.equal(backend.name, 'jev');
  await backend.answer('some task', [QUESTION]);
  assert.deepEqual(onProbe.clientsCreated, [FAKE_KEY]);
  assert.equal(onProbe.requests.length, 1);
});

test('was on, now off: the very next choice touches nothing of Jev', async () => {
  const wasOn = probe();
  await (await chooseClassifierBackend(ON, 'hand recall', wasOn.dependencies)).answer('task', [QUESTION]);
  assert.equal(wasOn.requests.length, 1);
  const nowOff = probe();
  const backend = await chooseClassifierBackend(OFF, 'hand recall', nowOff.dependencies);
  assert.equal(backend.name, 'rules');
  await backend.answer('task', [QUESTION]);
  assertNothingReachedJev(nowOff);
});

test('THRONE_JEV_DISABLED wins over a config that says on, and nothing of Jev is touched', async () => {
  const overridden = probe({ THRONE_JEV_DISABLED: '1' });
  const backend = await chooseClassifierBackend(ON, 'hand recall', overridden.dependencies);
  assert.equal(backend.name, 'rules');
  await backend.answer('task', [QUESTION]);
  assertNothingReachedJev(overridden);
});

test('the environment override can only switch Jev off, never on', async () => {
  for (const value of ['0', '', 'false-looking-but-set']) {
    const jevSwitch = await readJevSwitch(OFF, probe({ THRONE_JEV_DISABLED: value }).dependencies.jevSwitch);
    assert.equal(jevSwitch.on, false);
  }
  assert.equal((await readJevSwitch(ON, probe({ THRONE_JEV_DISABLED: '0' }).dependencies.jevSwitch)).on, true);
});

for (const [situation, keyFileText] of [
  ['missing', new Error('ENOENT /keys/jev')],
  ['empty', ''],
] as const) {
  test(`a ${situation} key file means off, with one stderr line and no client`, async () => {
    const noKey = probe({}, keyFileText);
    const backend = await chooseClassifierBackend(ON, 'hand recall', noKey.dependencies);
    assert.equal(backend.name, 'rules');
    assert.deepEqual(noKey.clientsCreated, []);
    assert.equal(noKey.stderr.length, 1);
    assert.match(noKey.stderr[0] ?? '', /missing, unreadable or empty/);
  });
}

test('the status names the backend, the reason, the override and the key file, never the key', async () => {
  const onProbe = probe();
  const on = renderedJevStatus(await readJevSwitch(ON, onProbe.dependencies.jevSwitch), NO_SPENDING);
  assert.match(on, /backend that would answer now: jev/);
  assert.match(on, /key file \/keys\/jev: usable/);
  assert.doesNotMatch(on, new RegExp(FAKE_KEY));
  const overridden = renderedJevStatus(
    await readJevSwitch(ON, probe({ THRONE_JEV_DISABLED: '1' }).dependencies.jevSwitch),
    NO_SPENDING,
  );
  assert.match(overridden, /backend that would answer now: rules\nwhy: THRONE_JEV_DISABLED is set/);
  assert.match(overridden, /not opened, because Jev is off/);
  const noKey = renderedJevStatus(await readJevSwitch(ON, probe({}, '').dependencies.jevSwitch), NO_SPENDING);
  assert.match(noKey, /why: the key file is missing, unreadable or empty/);
});

for (const limit of JEV_LIMIT_FIELDS) {
  test(`a Jev limit of zero switches Jev off without opening the key file (${limit})`, async () => {
    const zeroLimit = probe();
    const backend = await chooseClassifierBackend({ ...ON, [limit]: 0 }, 'hand recall', zeroLimit.dependencies);
    assert.equal(backend.name, 'rules');
    await backend.answer('task', [QUESTION]);
    assertNothingReachedJev(zeroLimit);
    assert.deepEqual(zeroLimit.stderr, []);
  });

  test(`recall status says which Jev limit is zero when that is why Jev is off (${limit})`, async () => {
    const status = renderedJevStatus(
      await readJevSwitch({ ...ON, [limit]: 0 }, probe().dependencies.jevSwitch),
      NO_SPENDING,
    );
    assert.match(status, new RegExp(`backend that would answer now: rules\nwhy: recall\.${limit} is 0, which switches Jev off`));
    assert.match(status, /not opened, because Jev is off/);
  });
}

test('the Jev switch decides the key is usable without reading it', async () => {
  const keyDirectory = await mkdtemp(path.join(tmpdir(), 'jev-switch-key-'));
  const unreadableKeyFile = path.join(keyDirectory, 'unreadable-key');
  await writeFile(unreadableKeyFile, FAKE_KEY);
  await chmod(unreadableKeyFile, 0o000);
  const emptyKeyFile = path.join(keyDirectory, 'empty-key');
  await writeFile(emptyKeyFile, '');
  const switchOf = (jevKeyFile: string) =>
    readJevSwitch({ ...ON, jevKeyFile }, { ...PRODUCTION_JEV_SWITCH_DEPENDENCIES, environment: {} });
  assert.equal((await switchOf(unreadableKeyFile)).keyFile, 'usable');
  assert.equal((await switchOf(emptyKeyFile)).keyFile, 'unavailable');
  assert.equal((await switchOf(keyDirectory)).keyFile, 'unavailable');
  assert.equal((await switchOf(path.join(keyDirectory, 'missing-key'))).keyFile, 'unavailable');
});
