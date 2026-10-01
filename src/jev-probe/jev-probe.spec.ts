import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { makeScratchDirectory } from '../scratch-directory.test-support.ts';
import type { BackendChoiceDependencies } from '../relevance-classifier/choose-backend.ts';
import type { JevClient } from '../relevance-classifier/jev-backend.ts';
import { readJevSpend } from '../relevance-classifier/jev-budget.ts';
import {
  JEV_DISABLED_ENVIRONMENT_VARIABLE,
  PRODUCTION_JEV_SWITCH_DEPENDENCIES,
} from '../relevance-classifier/jev-switch.ts';
import { readJevUsageLines } from '../relevance-classifier/jev-usage-log.ts';
import { DEFAULT_RECALL_CONFIG, type RecallConfig } from '../relevance-classifier/recall-user-config.ts';
import { runJevProbe } from './jev-probe.ts';

const ROOMY_LIMIT = 1_000_000;
const REPORTED_USAGE = { input_tokens: 30, output_tokens: 2 };
const PROBE_STATE = 'The deploy failed because the database migration timed out after ten minutes.';
const PROBE_QUESTION = 'Does this text say why the deploy failed?';
interface ProbeWorld {
  readonly dataHome: string;
  readonly keyFilePath: string;
  readonly keyReads: string[];
  readonly clientsCreated: string[];
  readonly jevCalls: number[];
  readonly stdout: string[];
  readonly stderr: string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly jevFails: boolean;
  readonly beforeAnswering?: () => Promise<void>;
}

async function probeWorld(environment: NodeJS.ProcessEnv = {}, jevFails = false): Promise<ProbeWorld> {
  const dataHome = await makeScratchDirectory('jev-probe-');
  const keyFilePath = path.join(dataHome, 'jev-key');
  await writeFile(keyFilePath, 'not-a-real-key');
  return {
    dataHome,
    keyFilePath,
    keyReads: [],
    clientsCreated: [],
    jevCalls: [],
    stdout: [],
    stderr: [],
    environment,
    jevFails,
  };
}

function limitedConfig(world: ProbeWorld, overrides: Partial<RecallConfig> = {}): RecallConfig {
  return {
    ...DEFAULT_RECALL_CONFIG,
    jevEnabled: true,
    jevKeyFile: world.keyFilePath,
    jevTokensPerDay: ROOMY_LIMIT,
    jevTokensPerHour: ROOMY_LIMIT,
    ...overrides,
  };
}

function fakeJevClient(world: ProbeWorld): JevClient {
  return {
    systemOne: async (request) => {
      world.jevCalls.push(world.jevCalls.length);
      await world.beforeAnswering?.();
      if (world.jevFails) throw Object.assign(new Error('out of credits'), { status: 402 });
      return {
        answers: Object.fromEntries(Object.keys(request.questions).map((name) => [name, { type: 'noul', noul: 0.8 }])),
        usage: REPORTED_USAGE,
      };
    },
  };
}

function backendChoice(world: ProbeWorld): BackendChoiceDependencies {
  return {
    jevSwitch: { ...PRODUCTION_JEV_SWITCH_DEPENDENCIES, environment: world.environment },
    jevBackend: {
      readKeyFile: (keyFilePath) => {
        world.keyReads.push(keyFilePath);
        return Promise.resolve('not-a-real-key');
      },
      createClient: (apiKey) => {
        world.clientsCreated.push(apiKey);
        return Promise.resolve(fakeJevClient(world));
      },
    },
    jevDataHome: world.dataHome,
    writeStderr: (text) => world.stderr.push(text),
  };
}

function probe(world: ProbeWorld, config: RecallConfig, commandArguments: readonly string[]): Promise<number> {
  return runJevProbe(commandArguments, {
    loadConfig: () => Promise.resolve(config),
    readStateFile: () => Promise.reject(new Error('no state file in these tests')),
    backendChoice: backendChoice(world),
    writeStdout: (text) => world.stdout.push(text),
    writeStderr: (text) => world.stderr.push(text),
  });
}

function probeArguments(runs: number): readonly string[] {
  return ['--question', PROBE_QUESTION, '--state', PROBE_STATE, '--repeat', String(runs)];
}

function chargeReportedAsJson(world: ProbeWorld): { reservedTokens: number; spentTokens: number } {
  const report = JSON.parse(world.stdout.join('')) as { reservedTokens: number; spentTokens: number };
  return { reservedTokens: report.reservedTokens, spentTokens: report.spentTokens };
}

async function estimatedTokensOfOneRun(): Promise<number> {
  const world = await probeWorld();
  assert.equal(await probe(world, limitedConfig(world), probeArguments(1)), 0);
  const [line] = (await readJevUsageLines(world.dataHome)).lines;
  assert.ok(line !== undefined);
  return line.estimatedTokens;
}

test('a Jev probe charges the machine budget for every run', async () => {
  const world = await probeWorld();
  const exitCode = await probe(world, limitedConfig(world), probeArguments(3));
  assert.equal(exitCode, 0);
  assert.equal(world.jevCalls.length, 3);
  const lines = (await readJevUsageLines(world.dataHome)).lines;
  assert.deepEqual(lines.map((line) => [line.caller, line.outcome]), [
    ['probe', 'answered'],
    ['probe', 'answered'],
    ['probe', 'answered'],
  ]);
  const spentPerRun = REPORTED_USAGE.input_tokens + REPORTED_USAGE.output_tokens;
  assert.deepEqual(await readJevSpend(world.dataHome, new Date()), {
    todayTokens: 3 * spentPerRun,
    lastHourTokens: 3 * spentPerRun,
  });
  const output = world.stdout.join('');
  assert.match(output, /run 3: yes, probability 0\.800, answered by Jev \(80% sure\)/);
  assert.match(output, new RegExp(`tokens reserved: ${3 * (lines[0]?.estimatedTokens ?? 0)}, spent: ${3 * spentPerRun}`));
});

test('two Jev probes running at once each report only their own tokens', async () => {
  const tokensPerRun = await estimatedTokensOfOneRun();
  const spentPerRun = REPORTED_USAGE.input_tokens + REPORTED_USAGE.output_tokens;
  const firstWorldBeforeTheHold = await probeWorld();
  const second: ProbeWorld = { ...(await probeWorld()), dataHome: firstWorldBeforeTheHold.dataHome };
  let secondExitCode: Promise<number> | undefined;
  const first: ProbeWorld = {
    ...firstWorldBeforeTheHold,
    beforeAnswering: async () => {
      secondExitCode = probe(second, limitedConfig(second), [...probeArguments(2), '--json']);
      await secondExitCode;
    },
  };
  assert.equal(await probe(first, limitedConfig(first), [...probeArguments(1), '--json']), 0);
  assert.equal(await secondExitCode, 0);
  assert.equal((await readJevUsageLines(first.dataHome)).lines.length, 3);
  assert.deepEqual(chargeReportedAsJson(first), { reservedTokens: tokensPerRun, spentTokens: spentPerRun });
  assert.deepEqual(chargeReportedAsJson(second), { reservedTokens: 2 * tokensPerRun, spentTokens: 2 * spentPerRun });
});

test('a Jev probe that would not fit in the remaining budget is refused before anything is sent', async () => {
  const tokensPerRun = await estimatedTokensOfOneRun();
  for (const limitField of ['jevTokensPerDay', 'jevTokensPerHour'] as const) {
    const world = await probeWorld();
    const config = limitedConfig(world, { [limitField]: 2 * tokensPerRun });
    const exitCode = await probe(world, config, probeArguments(3));
    assert.equal(exitCode, 1, limitField);
    assert.equal(world.jevCalls.length, 0, limitField);
    assert.deepEqual((await readJevUsageLines(world.dataHome)).lines, [], limitField);
    assert.deepEqual(await readJevSpend(world.dataHome, new Date()), { todayTokens: 0, lastHourTokens: 0 });
    assert.match(world.stderr.join(''), new RegExp(`refused, nothing was sent: the whole call needs about ${3 * tokensPerRun} tokens and only ${2 * tokensPerRun} are left`));
  }
});

test('a refused Jev probe never reads the key', async () => {
  const tokensPerRun = await estimatedTokensOfOneRun();
  const world = await probeWorld();
  const exitCode = await probe(world, limitedConfig(world, { jevTokensPerDay: tokensPerRun }), probeArguments(2));
  assert.equal(exitCode, 1);
  assert.deepEqual(world.keyReads, []);
  assert.deepEqual(world.clientsCreated, []);
});

test("a Jev probe prints its estimated cost and what is left of today's and this hour's budget", async () => {
  const tokensPerRun = await estimatedTokensOfOneRun();
  const world = await probeWorld();
  const config = limitedConfig(world, { jevTokensPerDay: 10_000, jevTokensPerHour: 5_000 });
  assert.equal(await probe(world, config, probeArguments(2)), 0);
  const output = world.stdout.join('');
  const costLine = `jev-probe: 2 run(s) of about ${tokensPerRun} estimated tokens each, ${2 * tokensPerRun} in all`;
  const positions = [
    costLine,
    'Jev tokens today: 0 of 10,000 (10,000 left)',
    'Jev tokens in the last hour: 0 of 5,000 (5,000 left)',
    'run 1:',
  ].map((text) => output.indexOf(text));
  assert.ok(positions.every((position) => position >= 0), output);
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right), output);
  const spent = 2 * (REPORTED_USAGE.input_tokens + REPORTED_USAGE.output_tokens);
  assert.ok(output.includes(`Jev tokens today: ${spent} of 10,000 (${(10_000 - spent).toLocaleString('en-US')} left)`), output);
});

test('a Jev probe prints the same run and budget facts as one JSON object with --json', async () => {
  const world = await probeWorld();
  assert.equal(await probe(world, limitedConfig(world), [...probeArguments(2), '--json']), 0);
  assert.equal(world.stdout.length, 1);
  const report = JSON.parse(world.stdout[0] ?? '') as {
    runs: { pick: string; answeredBy: string }[];
    spentTokens: number;
    leftAfter: { todayTokens: number };
  };
  assert.deepEqual(report.runs.map((run) => [run.pick, run.answeredBy]), [
    ['yes', 'Jev (80% sure)'],
    ['yes', 'Jev (80% sure)'],
  ]);
  assert.equal(report.leftAfter.todayTokens, ROOMY_LIMIT - report.spentTokens);
});

test('a Jev probe run that Jev fails says the rules answered, never a Jev answer', async () => {
  const world = await probeWorld({}, true);
  assert.equal(await probe(world, limitedConfig(world), probeArguments(1)), 0);
  assert.equal(world.jevCalls.length, 1);
  assert.ok(world.stdout.join('').includes('run 1: yes, probability 1.000, answered by rules (Jev failed)'), world.stdout.join(''));
  assert.deepEqual((await readJevUsageLines(world.dataHome)).lines.map((line) => line.outcome), ['failed']);
});

test('a Jev probe cannot repeat more than five times', async () => {
  const world = await probeWorld();
  const exitCode = await probe(world, limitedConfig(world), probeArguments(6));
  assert.equal(exitCode, 2);
  assert.match(world.stderr.join(''), /--repeat is capped at 5 \(got 6\)/);
  assert.equal(world.jevCalls.length, 0);
  assert.deepEqual((await readJevUsageLines(world.dataHome)).lines, []);
});

test('a Jev probe says why when Jev is switched off', async () => {
  const cases: readonly { environment: NodeJS.ProcessEnv; overrides: Partial<RecallConfig>; reason: string }[] = [
    { environment: {}, overrides: { jevEnabled: false }, reason: 'recall.jevEnabled is false' },
    { environment: {}, overrides: { jevTokensPerHour: 0 }, reason: 'recall.jevTokensPerHour is 0, which switches Jev off' },
    { environment: { [JEV_DISABLED_ENVIRONMENT_VARIABLE]: '1' }, overrides: {}, reason: `${JEV_DISABLED_ENVIRONMENT_VARIABLE} is set` },
  ];
  for (const { environment, overrides, reason } of cases) {
    const world = await probeWorld(environment);
    const exitCode = await probe(world, limitedConfig(world, overrides), probeArguments(1));
    assert.equal(exitCode, 1, reason);
    assert.ok(world.stderr.join('').includes(`refused, nothing was sent: Jev is off because ${reason}`), reason);
    assert.equal(world.stdout.join(''), '', reason);
    assert.equal(world.jevCalls.length, 0, reason);
  }
});

test('a Jev probe with an unknown flag is a steered exit 2 that sends nothing', async () => {
  const world = await probeWorld();
  const exitCode = await probe(world, limitedConfig(world), [...probeArguments(1), '--verbose']);
  assert.equal(exitCode, 2);
  assert.match(world.stderr.join(''), /jev-probe entrance validation refused: unknown flag "--verbose"\. No bypass is available/);
  assert.equal(world.jevCalls.length, 0);
});

test('a Jev probe without a question or a state is refused with the usage and sends nothing', async () => {
  for (const commandArguments of [['--state', PROBE_STATE], ['--question', PROBE_QUESTION]]) {
    const world = await probeWorld();
    const exitCode = await probe(world, limitedConfig(world), commandArguments);
    assert.equal(exitCode, 2);
    assert.match(world.stderr.join(''), /^Usage: throne jev-probe/);
    assert.equal(world.jevCalls.length, 0);
  }
});
