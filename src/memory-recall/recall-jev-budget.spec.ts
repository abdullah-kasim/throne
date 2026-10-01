import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { acquireAtomicMkdirLock } from '../alpha-monitoring/atomic-mkdir-lock.ts';
import {
  thisJevLimiterBuild,
  type JevBackendDependencies,
  type JevClient,
} from '../relevance-classifier/jev-backend.ts';
import { jevBudgetDirectory, jevBudgetLockPath, reserveJevTokens } from '../relevance-classifier/jev-budget.ts';
import { JEV_LIMITER_VERSION } from '../relevance-classifier/jev-limiter-build.ts';
import { appendJevUsageLine, readJevUsageLines } from '../relevance-classifier/jev-usage-log.ts';
import type { RecallConfig } from '../relevance-classifier/recall-user-config.ts';
import { runRecall } from './recall.command.ts';
import { HOOK_PAYLOAD, harness, ledgerEntries, type Harness } from './recall.command.test-support.ts';
import { REPORT_TIME, buildReportFixture, reportOn, topicBackend } from './recall-report.test-support.ts';

const HOOK_WITH_JEV_ON: Partial<RecallConfig> = {
  hookEnabled: true,
  hookMode: 'serve',
  jevEnabled: true,
  hookTimeoutMilliseconds: 5000,
};
const USED_UP: Partial<RecallConfig> = { ...HOOK_WITH_JEV_ON, jevTokensPerDay: 1 };

interface FakeJev {
  readonly dependencies: JevBackendDependencies;
  readonly clientsCreated: number[];
  readonly calls: number[];
}

function fakeJev(respond: () => Promise<Awaited<ReturnType<JevClient['systemOne']>>>): FakeJev {
  const clientsCreated: number[] = [];
  const calls: number[] = [];
  return {
    clientsCreated,
    calls,
    dependencies: {
      readKeyFile: () => Promise.resolve('not-a-real-key'),
      createClient: () => {
        clientsCreated.push(clientsCreated.length);
        return Promise.resolve({
          systemOne: () => {
            calls.push(calls.length);
            return respond();
          },
        });
      },
    },
  };
}

function jevThatFailsWithHttpStatus(status: number): FakeJev {
  return fakeJev(() => Promise.reject(Object.assign(new Error('payment required'), { status })));
}

function jevThatIsNeverAsked(): FakeJev {
  return fakeJev(() => Promise.reject(new Error('Jev must not be asked')));
}

async function hookRun(config: Partial<RecallConfig>, jev: FakeJev): Promise<Harness> {
  const run = harness(config, { stdin: HOOK_PAYLOAD, jevBehindTheBudget: jev.dependencies });
  assert.equal(await runRecall(['--hook'], run.dependencies), 0);
  return run;
}

function verdictLineOf(run: Harness): string | undefined {
  return run.stdout
    .join('')
    .split('\n')
    .find((line) => /a relevant memory likely exists|no relevant memory in/.test(line));
}

test('the ledger marks a budget refusal as backend rules with reason rate-limited', async () => {
  const jev = jevThatIsNeverAsked();
  const run = await hookRun(USED_UP, jev);
  const entries = ledgerEntries(run.dataDirectory);
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.equal(entry.backend, 'rules');
    assert.equal(entry.reason, 'rate-limited');
  }
});

test('the hook\'s verdict line says rules (Jev budget used up) when the budget refused', async () => {
  const jev = jevThatIsNeverAsked();
  const run = await hookRun(USED_UP, jev);
  assert.equal(jev.calls.length, 0);
  assert.match(verdictLineOf(run) ?? '', /^rules \(Jev budget used up\): a relevant memory likely exists in /);
});

test('when the budget lock stays busy Jev is not called and the verdict line says rules (Jev budget lock busy)', async () => {
  const jev = jevThatIsNeverAsked();
  const run = harness(HOOK_WITH_JEV_ON, { stdin: HOOK_PAYLOAD, jevBehindTheBudget: jev.dependencies });
  await mkdir(jevBudgetDirectory(run.jevDataHome), { recursive: true });
  const release = await acquireAtomicMkdirLock({ lockPath: jevBudgetLockPath(run.jevDataHome), holder: 'a busy spender' });
  try {
    assert.equal(await runRecall(['--hook'], run.dependencies), 0);
  } finally {
    await release();
  }
  assert.equal(jev.calls.length, 0);
  assert.match(verdictLineOf(run) ?? '', /^rules \(Jev budget lock busy\): /);
  const outcomes = (await readJevUsageLines(run.jevDataHome)).lines.map((line) => line.outcome);
  assert.ok(outcomes.length > 0 && outcomes.every((outcome) => outcome === 'lock-busy'));
});

test('a build older than the recorded limiter version answers with rules labelled this build has no Jev limiter', async () => {
  const jev = jevThatIsNeverAsked();
  const run = harness(HOOK_WITH_JEV_ON, { stdin: HOOK_PAYLOAD, jevBehindTheBudget: jev.dependencies });
  const aNewerLiveBuild = { limiterVersion: JEV_LIMITER_VERSION + 1, runsFromTheLiveCheckout: true };
  await reserveJevTokens(run.jevDataHome, { tokensPerDay: 1_000, tokensPerHour: 1_000 }, [1], run.dependencies.now(), aNewerLiveBuild);
  assert.equal(await runRecall(['--hook'], run.dependencies), 0);
  assert.deepEqual(jev.clientsCreated, []);
  assert.match(verdictLineOf(run) ?? '', /^rules \(this build has no Jev limiter\): /);
  assert.ok(ledgerEntries(run.dataDirectory).every((entry) => entry.reason === 'build without Jev limiter'));
  const outcomes = (await readJevUsageLines(run.jevDataHome)).lines.map((line) => line.outcome);
  assert.ok(outcomes.length > 0 && outcomes.every((outcome) => outcome === 'outdated-build'));
});

test('a Jev failure such as HTTP 402 is labelled as the rules answering, never as Jev', async () => {
  const jev = jevThatFailsWithHttpStatus(402);
  const run = await hookRun(HOOK_WITH_JEV_ON, jev);
  assert.ok(jev.calls.length > 0);
  assert.match(verdictLineOf(run) ?? '', /^rules \(Jev failed\): /);
  assert.doesNotMatch(run.stdout.join(''), /Jev \(\d+% sure\)/);
  assert.ok(ledgerEntries(run.dataDirectory).every((entry) => entry.reason === 'backend error'));
});

test('a Jev limit of zero means no Jev client is ever created', async () => {
  const jev = jevThatIsNeverAsked();
  const run = await hookRun({ ...HOOK_WITH_JEV_ON, jevTokensPerHour: 0 }, jev);
  assert.deepEqual(jev.clientsCreated, []);
  assert.match(verdictLineOf(run) ?? '', /^rules: /);
  assert.deepEqual((await readJevUsageLines(run.jevDataHome)).lines, []);
});

test('recall status shows today\'s and this hour\'s Jev tokens against both limits and counts busy-lock events', async () => {
  const run = harness();
  const now = run.dependencies.now();
  await reserveJevTokens(run.jevDataHome, { tokensPerDay: 15_000_000, tokensPerHour: 1_250_000 }, [1234], now, await thisJevLimiterBuild());
  await appendJevUsageLine(run.jevDataHome, {
    at: now.toISOString(),
    caller: 'hook',
    estimatedTokens: 50,
    realTokens: null,
    outcome: 'lock-busy',
  });
  assert.equal(await runRecall(['--status'], run.dependencies), 0);
  const status = run.stdout.join('');
  assert.match(status, /Jev tokens today: 1,234 of 15,000,000 \(14,998,766 left\)/);
  assert.match(status, /Jev tokens in the last hour: 1,234 of 1,250,000 \(1,248,766 left\)/);
  assert.match(status, /Jev requests not sent today because the budget lock was busy: 1/);
});

test('recall report shows Jev spend per day and per caller kind', async () => {
  const jevDataHome = await mkdtemp(path.join(tmpdir(), 'recall-report-jev-spend-'));
  const yesterday = new Date(REPORT_TIME.getTime() - 86_400_000);
  const usageLines = [
    { at: yesterday, caller: 'hook', estimatedTokens: 100, realTokens: 90, outcome: 'answered' },
    { at: yesterday, caller: 'hook', estimatedTokens: 100, realTokens: null, outcome: 'rate-limited' },
    { at: REPORT_TIME, caller: 'audit', estimatedTokens: 300, realTokens: 280, outcome: 'answered' },
    { at: REPORT_TIME, caller: 'audit', estimatedTokens: 300, realTokens: null, outcome: 'lock-busy' },
  ] as const;
  for (const line of usageLines) await appendJevUsageLine(jevDataHome, { ...line, at: line.at.toISOString() });
  const { output } = await reportOn(buildReportFixture(), { backend: topicBackend(), jevDataHome });
  const localDay = (moment: Date): string => moment.toLocaleDateString('en-CA');
  assert.match(output, /Jev spend per local day and caller \(from jev-usage\.jsonl\):/);
  assert.match(
    output,
    new RegExp(`${localDay(yesterday)} hook: 1 requests sent \\(0 failed\\), 100 estimated tokens, 90 real tokens reported; 1 refused because the budget was used up, 0 not sent`),
  );
  assert.match(
    output,
    new RegExp(`${localDay(REPORT_TIME)} audit: 1 requests sent \\(0 failed\\), 300 estimated tokens, 280 real tokens reported; 0 refused because the budget was used up, 1 not sent because the budget lock was busy`),
  );
});

test('the report says no Jev request was logged when the usage log is absent', async () => {
  const jevDataHome = await mkdtemp(path.join(tmpdir(), 'recall-report-no-jev-'));
  const { exitCode, output } = await reportOn(buildReportFixture(), { backend: topicBackend(), jevDataHome });
  assert.equal(exitCode, 0);
  assert.match(output, /Jev spend per local day and caller[^\n]*\n\s+no Jev requests logged/);
});

test('recall report says whether the account\'s charged usage can be cross-checked', async () => {
  const jevDataHome = await mkdtemp(path.join(tmpdir(), 'recall-report-cross-check-'));
  const { output } = await reportOn(buildReportFixture(), { backend: topicBackend(), jevDataHome });
  assert.match(output, /The TypeSafe API does not expose the account's charged usage, so the TypeSafe console is the only cross-check of this spend\./);
});
