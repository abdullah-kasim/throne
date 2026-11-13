import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import type { SpawnSpec } from '../agentdata/spawn-data-contracts.ts';
import { readHarnessBackgroundWork } from '../process-inspection/harness-background-work.ts';
import { harnessProcessHost, processTableCapture } from '../process-inspection/harness-background-work-test-fixtures.ts';
import { runNoIdling } from './no-idling-run.ts';
import type { AgentState } from '../agentdata/agent-state.service.ts';
import { declaredState, deps, rosterEntry } from './no-idling-command-test-fixtures.ts';

const WAITING_SHADOW = 'shadow-bakery-01-oven';
const CAPTURED_WAITING_SENTENCE =
  'Both suite runs (candidate and base) are still queued for a container slot';
const WORKING_WHILE_SAYING_IT_WAITS = declaredState('working', { waitingOn: CAPTURED_WAITING_SENTENCE });
const WORKING_WHILE_SAYING_IT_WAITS_WITH_AN_APOSTROPHE = declaredState('working', {
  waitingOn: "The oven's suite run is still queued for a container slot",
});
const WAITING_ON_ITS_OWN_RUN = declaredState('waiting-on-own-run', { waitingOn: 'candidate and base suites' });
const NOW_MS = Date.parse('2026-10-15T08:40:00.000Z');
const NEVER_TASKED: SpawnSpec = {
  harness: 'claude',
  model: 'opus',
  effort: 2,
  cwd: `/throne/${WAITING_SHADOW}`,
  spawned_at: '2026-10-15T08:28:00.000Z',
  spawn_finished_at: '2026-10-15T08:29:00.000Z',
  tasked_at: null,
};

const UNTASKED_NOTICE_KEY = /^no-idling-untasked:/;

async function regentNoticesForAShadowDeclaring(
  declared: AgentState,
  spawnSpec: SpawnSpec | null = null,
  keyOfTheNotice: RegExp = /./,
): Promise<string[]> {
  const { dependencies, submitCalls } = deps({
    getRoster: async () => [rosterEntry(WAITING_SHADOW, 'Shadow', 'idle')],
    readSpawnSpec: async () => spawnSpec,
    readAgentState: async () => declared,
    now: () => NOW_MS,
  });
  await runNoIdling(dependencies, { notify: true });
  return submitCalls
    .filter((call) => keyOfTheNotice.test(call.options?.key ?? ''))
    .map((call) => call.prompt);
}

async function waitingNoticeForAShadowDeclaring(declared: AgentState): Promise<string> {
  const notices = await regentNoticesForAShadowDeclaring(declared);
  const notice = notices.find((text) => text.includes('waiting on background work'));
  assert.ok(notice, `no waiting notice in: ${notices.join('\n')}`);
  return notice;
}

function lineToSendIn(notice: string): { agent: string; quotedMessage: string } {
  const match = /throne send-agent (\S+) ('.*?as your latest message\.')/.exec(notice);
  assert.ok(match, `no send line in: ${notice}`);
  return { agent: match[1]!, quotedMessage: match[2]! };
}

async function messageTheShellDelivers(quotedMessage: string): Promise<string> {
  const { stdout } = await promisify(execFile)('bash', ['-c', `printf %s ${quotedMessage}`]);
  return stdout;
}

test("the regent's notice gives the own-background-run line to send", async () => {
  const notice = await waitingNoticeForAShadowDeclaring(WORKING_WHILE_SAYING_IT_WAITS);

  assert.ok(
    notice.includes(
      `${WAITING_SHADOW} — waiting on background work: ${CAPTURED_WAITING_SENTENCE}. Send exactly: throne send-agent ${WAITING_SHADOW} 'Run throne my-state waiting-on-own-run "${CAPTURED_WAITING_SENTENCE}" and publish {"blocked":true} BLOCKED_BY_own-background-run (${CAPTURED_WAITING_SENTENCE}) as your latest message.'`,
    ),
    notice,
  );
  assert.doesNotMatch(notice, /idle-with-no-claim/);
});

test("the regent's notice names an untasked agent that says it is waiting on background work the same way", async () => {
  const [untaskedNotice] = await regentNoticesForAShadowDeclaring(
    WORKING_WHILE_SAYING_IT_WAITS,
    NEVER_TASKED,
    UNTASKED_NOTICE_KEY,
  );

  assert.ok(untaskedNotice);
  assert.ok(untaskedNotice.includes(`Send exactly: throne send-agent ${WAITING_SHADOW} '`), untaskedNotice);
  assert.doesNotMatch(untaskedNotice, /spawned but never tasked/);
  assert.match(untaskedNotice, new RegExp(`waiting on background work: ${CAPTURED_WAITING_SENTENCE.replace(/[()]/g, '\\$&')}`));
});

test("the regent's notice says a waiting agent must not be reaped or sent a generic continue", async () => {
  const notice = await waitingNoticeForAShadowDeclaring(WORKING_WHILE_SAYING_IT_WAITS);

  assert.match(notice, /Such a pane is waiting, not idle: never reap it and never send it a generic continue\./);
  assert.match(notice, /once per wait/);
});

test('an agent whose state file says it waits on its own run is left out of the notice', async () => {
  for (const spawnSpec of [null, NEVER_TASKED]) {
    const notices = await regentNoticesForAShadowDeclaring(WAITING_ON_ITS_OWN_RUN, spawnSpec);

    assert.deepEqual(notices.filter((text) => text.includes(WAITING_SHADOW)), []);
  }
});

test('the line the notice gives tells the agent to declare its wait in its state file', async () => {
  for (const declared of [WORKING_WHILE_SAYING_IT_WAITS, WORKING_WHILE_SAYING_IT_WAITS_WITH_AN_APOSTROPHE]) {
    const notice = await waitingNoticeForAShadowDeclaring(declared);
    const { agent, quotedMessage } = lineToSendIn(notice);
    const delivered = await messageTheShellDelivers(quotedMessage);
    const backgroundWork = /waiting on background work: (.*?)\. Send exactly/.exec(notice)?.[1];

    assert.equal(agent, WAITING_SHADOW);
    assert.ok(delivered.includes(`throne my-state waiting-on-own-run "${backgroundWork}"`), delivered);
    assert.ok(delivered.includes(`{"blocked":true} BLOCKED_BY_own-background-run (${backgroundWork}) as`), delivered);
  }
});

test('the no-idling notice never tells the regent both to ask a waiting agent for the blocked marker and never to ask it', async () => {
  const notice = await waitingNoticeForAShadowDeclaring(WORKING_WHILE_SAYING_IT_WAITS);

  assert.ok(notice.includes(`Send exactly: throne send-agent ${WAITING_SHADOW} '`), notice);
  assert.doesNotMatch(notice, /must never be told to publish/);
  assert.doesNotMatch(notice, /fully-idle/);
});

test('the no-idling log does not say it reported a waiting agent as fully idle', async () => {
  const logLines: string[] = [];
  const { dependencies } = deps({
    getRoster: async () => [rosterEntry(WAITING_SHADOW, 'Shadow', 'idle')],
    readAgentState: async () => WORKING_WHILE_SAYING_IT_WAITS,
    now: () => NOW_MS,
    stdout: (text) => logLines.push(text),
  });

  await runNoIdling(dependencies, { notify: true });

  const noticeLog = logLines.find((line) => line.includes('Regent about'));
  assert.ok(noticeLog, `no notice log in: ${logLines.join('')}`);
  assert.doesNotMatch(noticeLog, /fully-idle/);
  assert.match(noticeLog, new RegExp(WAITING_SHADOW));
});

test("the Regent's notice names the background processes an agent waits on", async () => {
  const worktree = await realpath(await mkdtemp(path.join(tmpdir(), 'waiting-agent-notice-')));
  const hostsInReadOrder = [
    harnessProcessHost({ processTable: await processTableCapture('macos-claude-idle-harness'), harnessDirectory: worktree }),
    harnessProcessHost({
      processTable: await processTableCapture('macos-claude-harness-with-background-hold-script'),
      harnessDirectory: worktree,
    }),
  ];
  const { dependencies, submitCalls } = deps({
    getRoster: async () => [rosterEntry(WAITING_SHADOW, 'Shadow', 'idle')],
    readHarnessBackgroundWork: (paneId) => readHarnessBackgroundWork(paneId, hostsInReadOrder.shift() ?? hostsInReadOrder[0]!),
    now: () => NOW_MS,
  });

  await runNoIdling(dependencies, { notify: true });

  const notice = submitCalls.map((call) => call.prompt).find((text) => text.includes('waiting on background work'));
  assert.ok(notice, submitCalls.map((call) => call.prompt).join('\n'));
  assert.match(notice, new RegExp(`${WAITING_SHADOW} — waiting on background work: [^\\n]*sh \\./hold\\.sh; sleep 600`));
});
