import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { RESTART_FAILED_PREFIX } from '../src/herdr-update/herdr-upgrade-restart.ts';
import { DETACHED_LOG_LINES, readPendingRestarts } from './update-throne-restarts.mjs';
import {
  AGENTS_FINISHED_CLEANLY,
  AGENTS_FINISHED_WITH_A_FAILURE,
  AGENTS_STILL_RESTARTING,
  AGENT_RESTART_CALL,
  type Court,
  HERDR_HAND_OFF,
  HERDR_RELAUNCH_FAILED,
  HERDR_RELAUNCH_RUNNING,
  HERDR_RELAUNCH_SUCCEEDED,
  THE_WORD,
  agentRestartLog,
  backendRuns,
  callsTo,
  courtFor,
  currentDistGeneration,
  dieHere,
  failOnce,
  herdrPinMovingTo,
  herdrUpgradeLog,
  land,
  pinsMoving,
  restartCalls,
  runUpdate,
  upgradeHerdr,
} from './update-throne-fixture.ts';

const AGENTS_PENDING = 'agents';
const MOVED_HERDR = '0.9.6';
const RESTART_QUESTION = /^update-throne: question: restart every agent/m;
const NOT_RESTARTED_AGENTS = /^update-throne: report: not restarted agents — /m;
const SECONDS_IN_A_DAY = 86400;
const BRIDGE = 'throne-bot-bridge@first.service';
const HERDR_UPGRADER = 'herdr-upgrade.mjs';
const HERDR_UPGRADE_HEADER = '===== herdr-upgrade pinned v0.9.7 2026-11-08T00:00:00.000Z =====\n';

function pendingFile(court: Court): string {
  return path.join(court.checkout, 'vendor', '.stamps', 'update-throne-pending-restarts');
}

async function handOverAgentRestart(court: Court, detachedOutcome: string): Promise<void> {
  land(court, 'origin', pinsMoving({ codex: '0.51.0' }));
  court.detachedAgentRestart = detachedOutcome;
  assert.equal((await runUpdate(court, THE_WORD)).code, 0);
  backendRuns(court, currentDistGeneration(court));
  court.calls.length = 0;
}

async function handOverHerdrRestart(court: Court, detachedOutcome: string): Promise<void> {
  court.runningBotBridges = [BRIDGE];
  land(court, 'origin', { ...herdrPinMovingTo(MOVED_HERDR), 'src/new.ts': 'export const added = 1;\n' });
  court.detachedHerdrRelaunch = detachedOutcome;
  assert.equal((await runUpdate(court, THE_WORD)).code, 0);
  backendRuns(court, currentDistGeneration(court));
  court.calls.length = 0;
}

function hasGoneQuietForADay(log: string): void {
  const aDayAgo = Date.now() / 1000 - SECONDS_IN_A_DAY;
  utimesSync(log, aDayAgo, aDayAgo);
}

test('a restart handed to a detached run stays owed until it succeeds', async (t) => {
  const court = courtFor(t);
  await handOverAgentRestart(court, AGENTS_STILL_RESTARTING);
  const pending = readPendingRestarts(court.checkout);
  assert.ok(pending.includes(AGENTS_PENDING));
  assert.ok(pending.some((entry: string) => entry.includes(agentRestartLog(court))));
});

test('a restart handed to a detached run is reported as handed over and not as restarted', async (t) => {
  const court = courtFor(t);
  land(court, 'origin', pinsMoving({ codex: '0.51.0' }));
  court.detachedAgentRestart = AGENTS_STILL_RESTARTING;
  const { code, output } = await runUpdate(court, THE_WORD);
  assert.equal(code, 0);
  assert.doesNotMatch(output, /report: restarted every agent/);
  assert.ok(output.includes(`update-throne: report: handed every agent's restart to a detached run, which is not yet a result; read ${agentRestartLog(court)}\n`));
});

test('a detached restart that succeeded clears what was owed on the next run', async (t) => {
  const court = courtFor(t);
  await handOverAgentRestart(court, AGENTS_FINISHED_CLEANLY);
  const { code, output } = await runUpdate(court, THE_WORD);
  assert.equal(code, 0);
  assert.deepEqual(callsTo(court, AGENT_RESTART_CALL), []);
  assert.doesNotMatch(output, NOT_RESTARTED_AGENTS);
  assert.deepEqual(readPendingRestarts(court.checkout), []);
});

test('a detached restart that failed is asked about again by the next check', async (t) => {
  const court = courtFor(t);
  await handOverAgentRestart(court, AGENTS_FINISHED_WITH_A_FAILURE);
  const { output } = await runUpdate(court, ['--check']);
  assert.match(output, RESTART_QUESTION);
});

test('a detached restart that failed is reported by a run with no word', async (t) => {
  const court = courtFor(t);
  await handOverAgentRestart(court, AGENTS_FINISHED_WITH_A_FAILURE);
  const { code, output } = await runUpdate(court);
  assert.equal(code, 0);
  assert.deepEqual(callsTo(court, AGENT_RESTART_CALL), []);
  assert.ok(output.includes(`update-throne: report: not restarted agents — their detached restart did not succeed and no restart word was given; read ${agentRestartLog(court)}\n`));
  assert.deepEqual(readPendingRestarts(court.checkout), [AGENTS_PENDING]);
});

test('a detached restart that failed is retried by a run with the word', async (t) => {
  const court = courtFor(t);
  await handOverAgentRestart(court, AGENTS_FINISHED_WITH_A_FAILURE);
  court.detachedAgentRestart = undefined;
  const { code, output } = await runUpdate(court, THE_WORD);
  assert.equal(code, 0);
  assert.deepEqual(callsTo(court, AGENT_RESTART_CALL), [AGENT_RESTART_CALL]);
  assert.match(output, /^update-throne: report: restarted every agent$/m);
  assert.deepEqual(readPendingRestarts(court.checkout), []);
});

test('a detached restart still running is not started a second time', async (t) => {
  const court = courtFor(t);
  await handOverAgentRestart(court, AGENTS_STILL_RESTARTING);
  const pendingBefore = readFileSync(pendingFile(court), 'utf8');
  const { code, output } = await runUpdate(court, THE_WORD);
  assert.equal(code, 1);
  assert.deepEqual(restartCalls(court), []);
  assert.ok(output.includes(`update-throne: REFUSING — a detached restart is still running, so nothing was started a second time; read ${agentRestartLog(court)} and run again when it ends\n`));
  assert.equal(readFileSync(pendingFile(court), 'utf8'), pendingBefore);
});

test('a check says a detached restart is still running and asks nothing about it', async (t) => {
  const court = courtFor(t);
  await handOverAgentRestart(court, AGENTS_STILL_RESTARTING);
  const { code, output } = await runUpdate(court, ['--check']);
  assert.equal(code, 0);
  assert.doesNotMatch(output, RESTART_QUESTION);
  assert.match(output, /^update-throne: a run would refuse: a detached restart is still running/m);
});

test('a finished line from an earlier restart does not answer a later one', async (t) => {
  const court = courtFor(t);
  await handOverAgentRestart(court, AGENTS_FINISHED_WITH_A_FAILURE);
  court.detachedAgentRestart = AGENTS_STILL_RESTARTING;
  await runUpdate(court, THE_WORD);
  court.calls.length = 0;
  const { code } = await runUpdate(court, THE_WORD);
  assert.equal(code, 1);
  assert.deepEqual(restartCalls(court), []);
  appendFileSync(agentRestartLog(court), AGENTS_FINISHED_CLEANLY);
  assert.equal((await runUpdate(court, THE_WORD)).code, 0);
  assert.deepEqual(callsTo(court, AGENT_RESTART_CALL), []);
  assert.deepEqual(readPendingRestarts(court.checkout), []);
});

test('a detached restart whose log is missing stays owed and is retried', async (t) => {
  const court = courtFor(t);
  await handOverAgentRestart(court, AGENTS_STILL_RESTARTING);
  rmSync(agentRestartLog(court));
  court.detachedAgentRestart = undefined;
  assert.equal((await runUpdate(court, THE_WORD)).code, 0);
  assert.deepEqual(callsTo(court, AGENT_RESTART_CALL), [AGENT_RESTART_CALL]);
});

test('a detached restart that died with no verdict stays owed once its log goes quiet', async (t) => {
  const court = courtFor(t);
  await handOverAgentRestart(court, AGENTS_STILL_RESTARTING);
  hasGoneQuietForADay(agentRestartLog(court));
  const { code, output } = await runUpdate(court);
  assert.equal(code, 0);
  assert.match(output, NOT_RESTARTED_AGENTS);
  assert.deepEqual(readPendingRestarts(court.checkout), [AGENTS_PENDING]);
});

test('a herdr relaunch that failed leaves the agents owed', async (t) => {
  const court = courtFor(t);
  await handOverHerdrRestart(court, HERDR_RELAUNCH_FAILED);
  const check = await runUpdate(court, ['--check']);
  assert.match(check.output, RESTART_QUESTION);
  const { code, output } = await runUpdate(court);
  assert.equal(code, 0);
  assert.match(output, NOT_RESTARTED_AGENTS);
  assert.ok(readPendingRestarts(court.checkout).includes(AGENTS_PENDING));
  court.calls.length = 0;
  assert.equal((await runUpdate(court, THE_WORD)).code, 0);
  assert.deepEqual(callsTo(court, AGENT_RESTART_CALL), [AGENT_RESTART_CALL]);
});

test('agents still owed after a failed retry of a herdr relaunch are not said to wait on a harness move', async (t) => {
  const court = courtFor(t);
  await handOverHerdrRestart(court, HERDR_RELAUNCH_FAILED);
  failOnce(court, AGENT_RESTART_CALL);
  assert.equal((await runUpdate(court, THE_WORD)).code, 1);
  const { code, output } = await runUpdate(court);
  assert.equal(code, 0);
  assert.match(output, /^update-throne: report: not restarted agents — an earlier run owed them a restart that has not happened, and no restart word was given$/m);
  assert.deepEqual(readPendingRestarts(court.checkout), [AGENTS_PENDING]);
});

test('a herdr relaunch that failed leaves the bridges it covered owed', async (t) => {
  const court = courtFor(t);
  await handOverHerdrRestart(court, HERDR_RELAUNCH_FAILED);
  const { output } = await runUpdate(court);
  assert.ok(output.includes(`update-throne: report: restarted ${BRIDGE}\n`));
});

test('a herdr relaunch that succeeded leaves nothing owed and restarts nothing', async (t) => {
  const court = courtFor(t);
  await handOverHerdrRestart(court, court.detachedHerdrRelaunch);
  const { code } = await runUpdate(court, THE_WORD);
  assert.equal(code, 0);
  assert.deepEqual(restartCalls(court), []);
  assert.deepEqual(readPendingRestarts(court.checkout), []);
});

test('a signing agent that could not move does not make a herdr relaunch a failure', async (t) => {
  const court = courtFor(t);
  await handOverHerdrRestart(court, `FAILED: gpg-agent 4242 could not be moved: denied, so signing will need the passphrase after the restart\n${HERDR_RELAUNCH_SUCCEEDED}`);
  await runUpdate(court);
  assert.deepEqual(readPendingRestarts(court.checkout), []);
});

test('a herdr relaunch still running is not started a second time', async (t) => {
  const court = courtFor(t);
  await handOverHerdrRestart(court, HERDR_RELAUNCH_RUNNING);
  const { code, output } = await runUpdate(court, THE_WORD);
  assert.equal(code, 1);
  assert.deepEqual(restartCalls(court), []);
  assert.deepEqual(callsTo(court, 'herdr-upgrade.mjs'), []);
  assert.ok(output.includes(`read ${herdrUpgradeLog(court)} and run again when it ends`));
});

test('a herdr move is reported as handed to a detached run and names its log', async (t) => {
  const court = courtFor(t);
  land(court, 'origin', herdrPinMovingTo(MOVED_HERDR));
  const { code, output } = await runUpdate(court, THE_WORD);
  assert.equal(code, 0);
  assert.ok(output.includes(`update-throne: report: handed herdr's restart to a detached run, which is not yet a result; read ${herdrUpgradeLog(court)}\n`));
});

test('a herdr hand-over killed before it returns still owes the agents', async (t) => {
  const court = courtFor(t);
  land(court, 'origin', herdrPinMovingTo(MOVED_HERDR));
  court.detachedHerdrRelaunch = HERDR_RELAUNCH_FAILED;
  court.onCall.set(HERDR_UPGRADER, () => {
    upgradeHerdr(court);
    dieHere();
  });
  await runUpdate(court, THE_WORD);
  court.onCall.delete(HERDR_UPGRADER);
  backendRuns(court, currentDistGeneration(court));
  assert.match((await runUpdate(court, ['--check'])).output, RESTART_QUESTION);
  assert.match((await runUpdate(court)).output, NOT_RESTARTED_AGENTS);
  court.calls.length = 0;
  assert.equal((await runUpdate(court, THE_WORD)).code, 0);
  assert.deepEqual(callsTo(court, AGENT_RESTART_CALL), [AGENT_RESTART_CALL]);
  assert.deepEqual(readPendingRestarts(court.checkout), []);
});

test('a herdr step that fails before the hand-off owes only what it owed', async (t) => {
  const court = courtFor(t);
  land(court, 'origin', herdrPinMovingTo(MOVED_HERDR));
  failOnce(court, HERDR_HAND_OFF);
  assert.equal((await runUpdate(court, THE_WORD)).code, 1);
  assert.deepEqual(readPendingRestarts(court.checkout), ['bot-bridges']);
  assert.equal((await runUpdate(court, THE_WORD)).code, 0);
  assert.deepEqual(callsTo(court, HERDR_HAND_OFF).length, 2);
});

async function killAHerdrMoveBeforeItsStepBegins(court: Court, stepWritesItsHeader: boolean): Promise<void> {
  await handOverHerdrRestart(court, HERDR_RELAUNCH_SUCCEEDED);
  assert.equal((await runUpdate(court)).code, 0);
  land(court, 'origin', herdrPinMovingTo('0.9.7'));
  court.onCall.set(HERDR_UPGRADER, () => {
    if (stepWritesItsHeader) appendFileSync(herdrUpgradeLog(court), HERDR_UPGRADE_HEADER);
    dieHere();
  });
  await runUpdate(court, THE_WORD);
  court.onCall.delete(HERDR_UPGRADER);
}

test('a hand-over killed before the step began is not reported as still running', async (t) => {
  const court = courtFor(t);
  await killAHerdrMoveBeforeItsStepBegins(court, false);
  const check = await runUpdate(court, ['--check']);
  assert.doesNotMatch(check.output, /still running/);
  assert.match(check.output, /^update-throne: plan: the detached restart did not succeed/m);
  assert.ok(readPendingRestarts(court.checkout).includes(AGENTS_PENDING));
  assert.equal((await runUpdate(court, THE_WORD)).code, 0);
  assert.equal(court.running.herdr, '0.9.7');
});

test("a hand-over that never started does not read an older run's verdict", async (t) => {
  const court = courtFor(t);
  await killAHerdrMoveBeforeItsStepBegins(court, true);
  const { code, output } = await runUpdate(court, THE_WORD);
  assert.equal(code, 1);
  assert.match(output, /^update-throne: REFUSING — a detached restart is still running/m);
  assert.ok(readPendingRestarts(court.checkout).includes(AGENTS_PENDING));
  hasGoneQuietForADay(herdrUpgradeLog(court));
  assert.equal((await runUpdate(court, THE_WORD)).code, 0);
  assert.equal(court.running.herdr, '0.9.7');
});

test('a run killed at its final check with herdr unmoved owes the agents nothing', async (t) => {
  const court = courtFor(t);
  court.onCall.set(HERDR_UPGRADER, dieHere);
  await runUpdate(court, THE_WORD);
  assert.deepEqual(readPendingRestarts(court.checkout), []);
});

test('a hand-off the plan did not foresee stays owed until it succeeds', async (t) => {
  const court = courtFor(t);
  court.detachedHerdrRelaunch = HERDR_RELAUNCH_FAILED;
  court.onCall.set(HERDR_UPGRADER, () => {
    court.running.herdr = '0.9.4';
  });
  assert.equal((await runUpdate(court, THE_WORD)).code, 0);
  court.onCall.delete(HERDR_UPGRADER);
  assert.ok(readPendingRestarts(court.checkout).includes(AGENTS_PENDING));
  assert.match((await runUpdate(court, ['--check'])).output, RESTART_QUESTION);
});

test('a check writes nothing when it reads a detached verdict', async (t) => {
  for (const detachedOutcome of [AGENTS_FINISHED_CLEANLY, AGENTS_FINISHED_WITH_A_FAILURE, AGENTS_STILL_RESTARTING]) {
    const court = courtFor(t);
    await handOverAgentRestart(court, detachedOutcome);
    const pendingBefore = readFileSync(pendingFile(court), 'utf8');
    assert.equal((await runUpdate(court, ['--check'])).code, 0);
    assert.equal(readFileSync(pendingFile(court), 'utf8'), pendingBefore);
  }
});

test('a check after a detached restart that succeeded asks nothing about the agents', async (t) => {
  const court = courtFor(t);
  await handOverAgentRestart(court, AGENTS_FINISHED_CLEANLY);
  const { output } = await runUpdate(court, ['--check']);
  assert.doesNotMatch(output, RESTART_QUESTION);
});

test('the lines the detached restarts really write are the lines the update reads', () => {
  const repository = path.resolve(import.meta.dirname, '..');
  const restartRun = readFileSync(path.join(repository, 'src/restart-harnesses/restart-harnesses-run.ts'), 'utf8');
  const upgrade = readFileSync(path.join(repository, 'scripts/herdr-upgrade.mjs'), 'utf8');
  assert.ok(restartRun.includes('restart-harnesses: continuing in a detached run; read ${logPath}'));
  assert.ok(restartRun.includes('=== restart-harnesses run ${'));
  assert.ok(restartRun.includes('restart-harnesses: finished — ${count("restarted")} restarted, ${count("skipped")} skipped, ${count("failed")} failed'));
  assert.ok(upgrade.includes("const LOG = path.join(os.homedir(), 'tmp', 'herdr-upgrade.log');"));
  assert.ok(upgrade.includes('detached; follow it with:  tail -f ${LOG}'));
  assert.ok(upgrade.includes("say('phases 8-10: "));
  assert.ok(upgrade.includes('|| echo "${RESTART_FAILED_PREFIX} the restart and identity repair exited $?"'));
  assert.ok(upgrade.includes('echo "===== done $(date) ====="\n${versionAgreementCommand()}'));
  assert.equal(RESTART_FAILED_PREFIX, 'FAILED:');
  assert.ok(DETACHED_LOG_LINES.herdr.failure.test(`${RESTART_FAILED_PREFIX} any reason`));
  assert.ok(readFileSync(path.join(repository, 'src/herdr-update/herdr-upgrade-restart.ts'), 'utf8').includes("const SIGNING_AGENT = 'gpg-agent';"));
});
