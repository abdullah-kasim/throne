import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { IdentityLineReadStatus } from './identity-data.service.ts';
import { readAgentState } from './agent-state.service.ts';
import { runMyState, type MyStateDependencies } from '../my-state/my-state.ts';

const scratchDirectories: string[] = [];
async function dataDirectoryWith(...agents: string[]): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), 'throne-agent-state-'));
  scratchDirectories.push(home);
  const directory = join(home, 'data');
  for (const agent of agents) await mkdir(join(directory, agent), { recursive: true });
  return directory;
}
after(() => {
  for (const directory of scratchDirectories) rmSync(directory, { recursive: true, force: true });
});

function runAs(caller: string, dataDirectory: string, role = 'Shadow', message = ''): {
  deps: MyStateDependencies;
  errors: string[];
} {
  const errors: string[] = [];
  return {
    errors,
    deps: {
      currentAgentName: async () => caller,
      readRole: async () => ({ status: IdentityLineReadStatus.Found, value: role }),
      readMessage: async () => message,
      dataDirectory,
      print: () => {},
      printError: (text) => errors.push(text),
    },
  };
}

test("an agent's declared state is read back from its file", async () => {
  const dataDirectory = await dataDirectoryWith('alpha-abc');
  const { deps } = runAs('alpha-abc', dataDirectory);

  assert.equal(await runMyState(['blocked', '--by', 'shadow-1', '--by', 'shadow-2'], deps), 0);

  const state = await readAgentState('alpha-abc', dataDirectory);
  assert.equal(state.state, 'blocked');
  assert.deepEqual(state.blockedBy, ['shadow-1', 'shadow-2']);
  assert.equal(state.declaredBy, 'agent');
  const onDisk = JSON.parse(readFileSync(join(dataDirectory, 'alpha-abc', 'state.json'), 'utf8'));
  assert.deepEqual(Object.keys(onDisk).sort(), ['blockedBy', 'declaredAt', 'declaredBy', 'reapableReason', 'state', 'waitingOn']);
});

test('waiting on its own run and reapable keep the words the agent gave', async () => {
  const dataDirectory = await dataDirectoryWith('shadow-x');
  const { deps } = runAs('shadow-x', dataDirectory);

  await runMyState(['waiting-on-own-run', 'focused tests'], deps);
  assert.equal((await readAgentState('shadow-x', dataDirectory)).waitingOn, 'focused tests');

  await runMyState(['reapable', 'completed'], deps);
  const state = await readAgentState('shadow-x', dataDirectory);
  assert.equal(state.state, 'reapable');
  assert.equal(state.reapableReason, 'completed');
});

test('an unknown state is refused and nothing is written', async () => {
  const dataDirectory = await dataDirectoryWith('shadow-x');
  const { deps, errors } = runAs('shadow-x', dataDirectory);

  assert.equal(await runMyState(['sleeping'], deps), 2);

  assert.match(errors.join(''), /unknown state "sleeping"/);
  assert.equal(existsSync(join(dataDirectory, 'shadow-x', 'state.json')), false);
});

test("an agent cannot write another agent's state", async () => {
  const dataDirectory = await dataDirectoryWith('shadow-x', 'shadow-y');
  const { deps, errors } = runAs('shadow-x', dataDirectory, 'Alpha');

  assert.equal(await runMyState(['reapable', 'completed', '--agent', 'shadow-y'], deps), 1);

  assert.match(errors.join(''), /only the Regent/);
  assert.equal((await readAgentState('shadow-y', dataDirectory)).state, 'working');
});

test("the Regent can write another agent's state, recorded as regent", async () => {
  const dataDirectory = await dataDirectoryWith('shadow-y');
  const { deps } = runAs('Regent', dataDirectory);

  assert.equal(await runMyState(['blocked', '--agent', 'shadow-y', '--by', 'shadow-z'], deps), 0);

  const state = await readAgentState('shadow-y', dataDirectory);
  assert.equal(state.state, 'blocked');
  assert.equal(state.declaredBy, 'regent');
});

test('a stale reapable is working after the next prompt', async () => {
  const dataDirectory = await dataDirectoryWith('shadow-x');
  await runMyState(['reapable', 'completed'], runAs('shadow-x', dataDirectory).deps);

  const hookPath = fileURLToPath(new URL('../../claude-hooks/agent-state.py', import.meta.url));
  const hook = spawnSync('python3', [hookPath], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'go on' }),
    env: { ...process.env, THRONE_DATA_HOME: dirname(dataDirectory), THRONE_AGENT_NAME: 'shadow-x' },
  });
  assert.equal(hook.status, 0);

  const state = await readAgentState('shadow-x', dataDirectory);
  assert.equal(state.state, 'working');
  assert.equal(state.declaredBy, 'turn-start');
});

test('an old blocked.json is converted once', async () => {
  const dataDirectory = await dataDirectoryWith('alpha-old');
  writeFileSync(
    join(dataDirectory, 'alpha-old', 'blocked.json'),
    JSON.stringify({ blockedAt: '2026-11-01T00:00:00.000Z', origin: 'regent', blockedBy: ['shadow-1'] }),
  );

  const converted = await readAgentState('alpha-old', dataDirectory);

  assert.deepEqual(
    { state: converted.state, blockedBy: converted.blockedBy, declaredBy: converted.declaredBy, declaredAt: converted.declaredAt },
    { state: 'blocked', blockedBy: ['shadow-1'], declaredBy: 'regent', declaredAt: '2026-11-01T00:00:00.000Z' },
  );
  assert.equal(existsSync(join(dataDirectory, 'alpha-old', 'blocked.json')), false);
  assert.deepEqual(await readAgentState('alpha-old', dataDirectory), converted);
});

test('a missing file reads as working', async () => {
  const dataDirectory = await dataDirectoryWith('shadow-new');

  assert.equal((await readAgentState('shadow-new', dataDirectory)).state, 'working');
});

async function endTurnWith(agent: string, dataDirectory: string, message: string): Promise<void> {
  assert.equal(await runMyState(['--turn-end'], runAs(agent, dataDirectory, 'Shadow', message).deps), 0);
}

async function startTurn(agent: string, dataDirectory: string): Promise<void> {
  const hookPath = fileURLToPath(new URL('../../claude-hooks/agent-state.py', import.meta.url));
  const hook = spawnSync('python3', [hookPath], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'go on' }),
    env: { ...process.env, THRONE_DATA_HOME: dirname(dataDirectory), THRONE_AGENT_NAME: agent },
  });
  assert.equal(hook.status, 0);
}

test('a turn ending with each marker records the matching state', async () => {
  const cases = [
    {
      message: 'Waiting on my children.\n{"blocked":true} __BLOCKED_BY_shadow-a__ __BLOCKED_BY_shadow-b__',
      expected: { state: 'blocked', blockedBy: ['shadow-a', 'shadow-b'], waitingOn: null, reapableReason: null },
    },
    {
      message: 'Suite started.\n{"blocked":true} BLOCKED_BY_own-background-run (candidate and base suites)',
      expected: { state: 'waiting-on-own-run', blockedBy: [], waitingOn: 'candidate and base suites', reapableReason: null },
    },
    {
      message: '{"reapable":"completed"}',
      expected: { state: 'reapable', blockedBy: [], waitingOn: null, reapableReason: 'completed' },
    },
    {
      message: 'Merge confirmed.\n{"reapable":"cancelled"}',
      expected: { state: 'reapable', blockedBy: [], waitingOn: null, reapableReason: 'abandoned' },
    },
  ];
  for (const { message, expected } of cases) {
    const dataDirectory = await dataDirectoryWith('shadow-x');
    await startTurn('shadow-x', dataDirectory);
    await endTurnWith('shadow-x', dataDirectory, message);
    const state = await readAgentState('shadow-x', dataDirectory);
    assert.deepEqual(
      { state: state.state, blockedBy: state.blockedBy, waitingOn: state.waitingOn, reapableReason: state.reapableReason },
      expected,
      message,
    );
    assert.equal(state.declaredBy, 'agent', message);
  }
});

test('a turn ending with no marker leaves the state the turn-start hook set', async () => {
  const dataDirectory = await dataDirectoryWith('shadow-x');
  await startTurn('shadow-x', dataDirectory);
  const atTurnStart = await readAgentState('shadow-x', dataDirectory);

  await endTurnWith('shadow-x', dataDirectory, 'Done for now; the "blocked" word alone is not a marker.');

  assert.deepEqual(await readAgentState('shadow-x', dataDirectory), atTurnStart);
});

test("a my-state call in the same turn wins over a disagreeing marker", async () => {
  const dataDirectory = await dataDirectoryWith('shadow-x');
  await startTurn('shadow-x', dataDirectory);
  await runMyState(['blocked', '--by', 'shadow-child'], runAs('shadow-x', dataDirectory).deps);

  await endTurnWith('shadow-x', dataDirectory, '{"reapable":"completed"}');

  const state = await readAgentState('shadow-x', dataDirectory);
  assert.equal(state.state, 'blocked');
  assert.deepEqual(state.blockedBy, ['shadow-child']);
});
