import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { LedgerDataService } from '../agentdata/ledger-data.service.ts';
import { readSpawnSpec } from '../agentdata/spawn-data-contracts.ts';
import { harnessProvenance } from '../herdr/harness-provenance.ts';
import type { HerdrAgent, HerdrForegroundProcess } from '../herdr/herdr-inventory.service.ts';
import {
  REAL_DEPS as RESTART_HARNESSES_REAL_DEPS,
  ensurePaneCarriesName,
  stopHarnessInPane,
  type RestartHarnessesDeps,
} from '../restart-harnesses/restart-harnesses-runtime.ts';
import {
  REAL_RESUME_CONTRACT,
  ThroneStartupReconciliationService,
  resumeOrphan,
  type StartupReconciliationContract,
} from './throne-startup-reconciliation.service.ts';

const SESSION_ID = '0d3c2a1e-5b6f-4c7d-8e9f-a0b1c2d3e4f5';

interface Launch {
  name: string;
  argv: readonly string[];
  cwd: string | undefined;
}

interface FakeCourt {
  root: string;
  ledgerDir: string;
  vendoredDir: string;
  foreignClaudePath: string;
  panes: Map<string, HerdrForegroundProcess[]>;
  liveAgents: HerdrAgent[];
  ownPaneId: string | undefined;
  processInfoReads: string[];
  signals: Array<{ pid: number; signal: string }>;
  launches: Launch[];
  renames: string[];
  stderr: string[];
}

async function fakeCourt(): Promise<FakeCourt> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'throne-reconcile-provenance-'));
  const nodeModules = path.join(root, 'vendor', 'node_modules');
  const claudeTarget = path.join(nodeModules, '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  await mkdir(path.dirname(claudeTarget), { recursive: true });
  await writeFile(claudeTarget, '');
  await mkdir(path.join(nodeModules, '.bin'));
  await symlink('../@anthropic-ai/claude-code/bin/claude.exe', path.join(nodeModules, '.bin', 'claude'));
  const foreignClaudePath = path.join(root, 'mise', 'bin', 'claude');
  await mkdir(path.dirname(foreignClaudePath), { recursive: true });
  await writeFile(foreignClaudePath, '');
  return {
    root,
    ledgerDir: path.join(root, 'data'),
    vendoredDir: path.join(nodeModules, '.bin'),
    foreignClaudePath,
    panes: new Map(),
    liveAgents: [],
    ownPaneId: undefined,
    processInfoReads: [],
    signals: [],
    launches: [],
    renames: [],
    stderr: [],
  };
}

async function registerAgent(court: FakeCourt, name: string): Promise<void> {
  const directory = path.join(court.ledgerDir, name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'identity.md'), `# Identity — ${name}\n`);
  await writeFile(path.join(directory, 'spawn.json'), JSON.stringify({
    harness: 'claude',
    model: 'opus',
    effort: 3,
    cwd: court.root,
    session_id: SESSION_ID,
    spawned_at: '2026-10-01T00:00:00.000Z',
  }));
}

function seatAgent(
  court: FakeCourt,
  name: string,
  agentStatus: HerdrAgent['agentStatus'],
  processes: HerdrForegroundProcess[],
): string {
  const paneId = `pane-${court.liveAgents.length + 1}`;
  court.panes.set(paneId, processes);
  court.liveAgents.push({
    agent: 'claude',
    name,
    agentStatus,
    cwd: court.root,
    focused: false,
    paneId,
    tabId: `tab-${paneId}`,
    terminalId: `term-${paneId}`,
  });
  return paneId;
}

const loginShell = (pid: number): HerdrForegroundProcess => ({ name: 'bash', argv: ['-bash'], pid });
const foreignClaude = (court: FakeCourt, pid: number): HerdrForegroundProcess =>
  ({ name: 'claude', argv: [court.foreignClaudePath, '--resume', SESSION_ID], pid });
const pinnedClaude = (court: FakeCourt, pid: number): HerdrForegroundProcess =>
  ({ name: 'claude.exe', argv: [path.join(court.vendoredDir, 'claude'), '--resume', SESSION_ID], pid });

function paneOfPid(court: FakeCourt, pid: number): string | undefined {
  return [...court.panes].find(([, processes]) => processes.some((process) => process.pid === pid))?.[0];
}

function reconciliationContract(court: FakeCourt): StartupReconciliationContract {
  const ledger = new LedgerDataService();
  const getPaneProcessInfo = async (paneId: string) => {
    court.processInfoReads.push(paneId);
    return { paneId, foregroundProcesses: court.panes.get(paneId) ?? [] };
  };
  const restartDeps: RestartHarnessesDeps = {
    ...RESTART_HARNESSES_REAL_DEPS,
    getPaneProcessInfo,
    signalProcess: (pid, signal) => {
      court.signals.push({ pid, signal });
      const paneId = paneOfPid(court, pid);
      if (paneId !== undefined) court.panes.set(paneId, [loginShell(pid + 1000)]);
    },
    sleep: async () => {},
    listAgents: async () => court.liveAgents,
    renameAgent: async (paneId, name) => {
      court.renames.push(`${paneId}=${name}`);
    },
  };
  return {
    listRegisteredAgents: () => ledger.listRegisteredAgents(court.ledgerDir),
    listCompletedAgents: () => ledger.listCompletedAgents(court.ledgerDir),
    hasResumableWork: async () => true,
    hasDeliveryCommit: async () => false,
    listLiveAgents: async () => court.liveAgents,
    readSpawnSpec: (name) => readSpawnSpec(name, court.ledgerDir),
    resume: (name) => resumeOrphan(name, {
      ...REAL_RESUME_CONTRACT,
      readSpawnSpec: (agentName) => readSpawnSpec(agentName, court.ledgerDir),
      resumeRegisteredAgentInRestoredTab: async (agentName, opts) => {
        court.launches.push({ name: agentName, argv: opts.argv, cwd: opts.cwd });
        const agent = court.liveAgents.find((candidate) => candidate.name === agentName)!;
        court.panes.set(agent.paneId, [pinnedClaude(court, 4242)]);
        return { kind: 'restored-tab-takeover', tabId: agent.tabId, paneId: agent.paneId };
      },
      deliverOpeningPrompt: async () => {},
      log: () => {},
      warn: () => {},
    }),
    reap: async (name) => {
      throw new Error(`reap of ${name} was never expected`);
    },
    readBlockedMarker: async () => null,
    clearBlockedMarker: async () => {},
    pathExists: async () => true,
    harnessProvenance: (paneId) => harnessProvenance(paneId, {
      getPaneProcessInfo,
      vendoredHarnessBinaryDirectory: court.vendoredDir,
    }),
    currentPaneId: async () => court.ownPaneId,
    stopHarnessInPane: (paneId) => stopHarnessInPane(paneId, restartDeps),
    ensurePaneCarriesName: (agent, name) => ensurePaneCarriesName(agent, name, restartDeps),
    log: () => {},
    warn: (message) => {
      court.stderr.push(message);
    },
  };
}

function reconcile(court: FakeCourt) {
  return new ThroneStartupReconciliationService(reconciliationContract(court)).reconcile(court.liveAgents);
}

function assertReportedAndLeftRunning(outcomes: Awaited<ReturnType<typeof reconcile>>, court: FakeCourt): void {
  assert.deepEqual(outcomes.map(({ action }) => action), ['report-unpinned-harness']);
  assert.equal(court.signals.length, 0);
  assert.equal(court.launches.length, 0);
  assert.equal(court.stderr.length, 1);
}

test('a registered agent whose restored pane is a bare shell is relaunched on its recorded recipe in the same pane', async () => {
  const court = await fakeCourt();
  await registerAgent(court, 'shadow-bare');
  const paneId = seatAgent(court, 'shadow-bare', 'idle', [loginShell(100)]);

  const outcomes = await reconcile(court);

  assert.deepEqual(outcomes.map(({ name, action, ok }) => ({ name, action, ok })), [
    { name: 'shadow-bare', action: 'relaunch-on-pinned-harness', ok: true },
  ]);
  assert.equal(court.signals.length, 0);
  assert.equal(court.launches.length, 1);
  assert.equal(court.launches[0]!.cwd, court.root);
  assert.ok(court.launches[0]!.argv.includes(SESSION_ID));
  assert.deepEqual([...court.panes.keys()], [paneId]);
  assert.deepEqual(court.renames, []);
});

test('a registered agent idling on a harness binary that is not the pinned one is stopped and relaunched pinned in the same pane', async () => {
  const court = await fakeCourt();
  await registerAgent(court, 'shadow-foreign-idle');
  const paneId = seatAgent(court, 'shadow-foreign-idle', 'idle', [foreignClaude(court, 200)]);

  const outcomes = await reconcile(court);

  assert.deepEqual(outcomes.map(({ action, ok }) => ({ action, ok })), [
    { action: 'relaunch-on-pinned-harness', ok: true },
  ]);
  assert.deepEqual(court.signals, [{ pid: 200, signal: 'SIGTERM' }]);
  assert.equal(court.launches.length, 1);
  assert.ok(court.launches[0]!.argv.includes(SESSION_ID));
  assert.deepEqual([...court.panes.keys()], [paneId]);
  assert.equal(court.panes.get(paneId)![0]!.argv[0], path.join(court.vendoredDir, 'claude'));
});

test('a registered agent working on a foreign harness binary is left running and reported once on stderr with its pane and executable', async () => {
  const court = await fakeCourt();
  await registerAgent(court, 'shadow-foreign-working');
  const paneId = seatAgent(court, 'shadow-foreign-working', 'working', [foreignClaude(court, 300)]);

  const outcomes = await reconcile(court);

  assertReportedAndLeftRunning(outcomes, court);
  assert.match(court.stderr[0]!, /"shadow-foreign-working"/);
  assert.ok(court.stderr[0]!.includes(`pane ${paneId}`));
  assert.ok(court.stderr[0]!.includes(court.foreignClaudePath));
});

test('a registered agent already on the pinned harness binary is left alone', async () => {
  const court = await fakeCourt();
  await registerAgent(court, 'shadow-pinned');
  seatAgent(court, 'shadow-pinned', 'idle', [pinnedClaude(court, 400)]);

  const outcomes = await reconcile(court);

  assert.deepEqual(outcomes, []);
  assert.equal(court.signals.length, 0);
  assert.equal(court.launches.length, 0);
  assert.deepEqual(court.stderr, []);
});

test('a pane that belongs to no registered agent is never touched', async () => {
  const court = await fakeCourt();
  await mkdir(court.ledgerDir, { recursive: true });
  seatAgent(court, 'lords-own-shell', 'idle', [foreignClaude(court, 500)]);

  const outcomes = await reconcile(court);

  assert.deepEqual(outcomes, []);
  assert.deepEqual(court.processInfoReads, []);
  assert.equal(court.signals.length, 0);
  assert.equal(court.launches.length, 0);
});

test('reconciliation never stops the pane it is running in', async () => {
  const court = await fakeCourt();
  await registerAgent(court, 'shadow-running-reconcile');
  court.ownPaneId = seatAgent(court, 'shadow-running-reconcile', 'idle', [foreignClaude(court, 600)]);

  const outcomes = await reconcile(court);

  assertReportedAndLeftRunning(outcomes, court);
});
