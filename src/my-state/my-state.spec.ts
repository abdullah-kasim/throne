import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { IdentityLineReadStatus } from '../agentdata/identity-data.service.ts';
import { readAgentState } from '../agentdata/agent-state.service.ts';
import { runMyState, type MyStateDependencies } from './my-state.ts';

const scratchDirectories: string[] = [];
after(() => {
  for (const directory of scratchDirectories) rmSync(directory, { recursive: true, force: true });
});

async function dataDirectoryWith(...agents: string[]): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), 'throne-my-state-'));
  scratchDirectories.push(home);
  const directory = join(home, 'data');
  for (const agent of agents) await mkdir(join(directory, agent), { recursive: true });
  return directory;
}

function runAs(
  caller: string,
  dataDirectory: string,
  roles: Record<string, string>,
  tellRegent: (message: string) => Promise<void> = async () => {},
): { deps: MyStateDependencies; told: string[]; errors: string[] } {
  const told: string[] = [];
  const errors: string[] = [];
  return {
    told,
    errors,
    deps: {
      currentAgentName: async () => caller,
      readRole: async (name) => ({ status: IdentityLineReadStatus.Found, value: roles[name] ?? 'Shadow' }),
      readMessage: async () => '',
      dataDirectory,
      print: () => {},
      printError: (text) => errors.push(text),
      tellRegent: async (message) => {
        told.push(message);
        await tellRegent(message);
      },
    },
  };
}

test('an Alpha declaring itself reapable for a reason tells the Regent once, naming itself, the reason and its report', async () => {
  const dataDirectory = await dataDirectoryWith('alpha-abc');
  const { deps, told } = runAs('alpha-abc', dataDirectory, { 'alpha-abc': 'Alpha' });

  assert.equal(await runMyState(['reapable', 'completed'], deps), 0);

  assert.deepEqual(told, [
    `alpha-abc declared itself reapable (completed). Its report: ${join(dataDirectory, 'alpha-abc', 'REPORT.md')}. ` +
      'Before reaping, confirm its commit is on the recorded target branch; if it is not reapable, tell it to continue.',
  ]);
});

test('an Alpha declaring itself reapable with reason fail still tells the Regent, showing the reason', async () => {
  const dataDirectory = await dataDirectoryWith('alpha-abc');
  const { deps, told } = runAs('alpha-abc', dataDirectory, { 'alpha-abc': 'Alpha' });

  await runMyState(['reapable', 'fail'], deps);

  assert.equal(told.length, 1);
  assert.match(told[0]!, /^alpha-abc declared itself reapable \(fail\)\./);
});

test('a Shadow declaring itself reapable tells nobody', async () => {
  const dataDirectory = await dataDirectoryWith('shadow-x');
  const { deps, told } = runAs('shadow-x', dataDirectory, { 'shadow-x': 'Shadow' });

  await runMyState(['reapable', 'completed'], deps);

  assert.deepEqual(told, []);
});

test('declaring the same reapable reason twice tells the Regent once', async () => {
  const dataDirectory = await dataDirectoryWith('alpha-abc');
  const { deps, told } = runAs('alpha-abc', dataDirectory, { 'alpha-abc': 'Alpha' });

  await runMyState(['reapable', 'completed'], deps);
  await runMyState(['reapable', 'completed'], deps);

  assert.equal(told.length, 1);
});

test('declaring working, blocked or waiting-on-own-run tells nobody', async () => {
  const dataDirectory = await dataDirectoryWith('alpha-abc');
  const { deps, told } = runAs('alpha-abc', dataDirectory, { 'alpha-abc': 'Alpha' });

  await runMyState(['working'], deps);
  await runMyState(['blocked', '--by', 'shadow-1'], deps);
  await runMyState(['waiting-on-own-run', 'suite'], deps);
  await runMyState(['--turn-start'], deps);

  assert.deepEqual(told, []);
});

test("the Regent writing an Alpha's state as reapable does not tell the Regent", async () => {
  const dataDirectory = await dataDirectoryWith('Regent', 'alpha-abc');
  const { deps, told } = runAs('Regent', dataDirectory, { Regent: 'Regent', 'alpha-abc': 'Alpha' });

  assert.equal(await runMyState(['reapable', 'completed', '--agent', 'alpha-abc'], deps), 0);

  assert.equal((await readAgentState('alpha-abc', dataDirectory)).state, 'reapable');
  assert.deepEqual(told, []);
});

test('when the Regent cannot be told the state is still written and the command still succeeds, saying why on stderr', async () => {
  const dataDirectory = await dataDirectoryWith('alpha-abc');
  const { deps, errors } = runAs('alpha-abc', dataDirectory, { 'alpha-abc': 'Alpha' }, async () => {
    throw new Error('no pane named Regent');
  });

  assert.equal(await runMyState(['reapable', 'completed'], deps), 0);

  assert.equal((await readAgentState('alpha-abc', dataDirectory)).state, 'reapable');
  assert.deepEqual(errors, ['my-state: the Regent was not told: no pane named Regent\n']);
});
