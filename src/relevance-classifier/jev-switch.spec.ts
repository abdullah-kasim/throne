import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseClassifierBackend, type BackendChoiceDependencies } from './choose-backend.ts';
import { yesOrNoQuestion } from './classifier.types.ts';
import { readJevSwitch, renderedJevStatus } from './jev-switch.ts';

const FAKE_KEY = 'not-a-real-key';
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
  return {
    keyFileReads,
    clientsCreated,
    requests,
    stderr,
    dependencies: {
      jevSwitch: { environment, readKeyFile },
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
      writeStderr: (text) => stderr.push(text),
    },
  };
}

const ON = { jevEnabled: true, jevKeyFile: '/keys/jev' };
const OFF = { jevEnabled: false, jevKeyFile: '/keys/jev' };

function assertNothingReachedJev(checked: Probe): void {
  assert.deepEqual(checked.keyFileReads, []);
  assert.deepEqual(checked.clientsCreated, []);
  assert.deepEqual(checked.requests, []);
}

test('switched off in the config: no key file read, no client, no request', async () => {
  const offProbe = probe();
  const backend = await chooseClassifierBackend(OFF, offProbe.dependencies);
  assert.equal(backend.name, 'rules');
  await backend.answer('some task', [QUESTION]);
  assertNothingReachedJev(offProbe);
});

test('switched on: the key is read and the request goes to Jev', async () => {
  const onProbe = probe();
  const backend = await chooseClassifierBackend(ON, onProbe.dependencies);
  assert.equal(backend.name, 'jev');
  await backend.answer('some task', [QUESTION]);
  assert.deepEqual(onProbe.clientsCreated, [FAKE_KEY]);
  assert.equal(onProbe.requests.length, 1);
});

test('was on, now off: the very next choice touches nothing of Jev', async () => {
  const wasOn = probe();
  await (await chooseClassifierBackend(ON, wasOn.dependencies)).answer('task', [QUESTION]);
  assert.equal(wasOn.requests.length, 1);
  const nowOff = probe();
  const backend = await chooseClassifierBackend(OFF, nowOff.dependencies);
  assert.equal(backend.name, 'rules');
  await backend.answer('task', [QUESTION]);
  assertNothingReachedJev(nowOff);
});

test('THRONE_JEV_DISABLED wins over a config that says on, and nothing of Jev is touched', async () => {
  const overridden = probe({ THRONE_JEV_DISABLED: '1' });
  const backend = await chooseClassifierBackend(ON, overridden.dependencies);
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
  ['empty', '  \n'],
] as const) {
  test(`a ${situation} key file means off, with one stderr line and no client`, async () => {
    const noKey = probe({}, keyFileText);
    const backend = await chooseClassifierBackend(ON, noKey.dependencies);
    assert.equal(backend.name, 'rules');
    assert.deepEqual(noKey.clientsCreated, []);
    assert.equal(noKey.stderr.length, 1);
    assert.match(noKey.stderr[0] ?? '', /missing, unreadable or empty/);
  });
}

test('the status names the backend, the reason, the override and the key file, never the key', async () => {
  const onProbe = probe();
  const on = renderedJevStatus(await readJevSwitch(ON, onProbe.dependencies.jevSwitch));
  assert.match(on, /backend that would answer now: jev/);
  assert.match(on, /key file \/keys\/jev: usable/);
  assert.doesNotMatch(on, new RegExp(FAKE_KEY));
  const overridden = renderedJevStatus(
    await readJevSwitch(ON, probe({ THRONE_JEV_DISABLED: '1' }).dependencies.jevSwitch),
  );
  assert.match(overridden, /backend that would answer now: rules\nwhy: THRONE_JEV_DISABLED is set/);
  assert.match(overridden, /not opened, because Jev is off/);
  const noKey = renderedJevStatus(await readJevSwitch(ON, probe({}, '').dependencies.jevSwitch));
  assert.match(noKey, /why: the key file is missing, unreadable or empty/);
});
