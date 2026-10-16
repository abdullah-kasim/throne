import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import type { SpawnSpec } from '../agentdata/spawn-data-contracts.ts';
import { classifyLastMessageTags } from './idle-pane-tag-classification.ts';
import { runNoIdling } from './no-idling-run.ts';
import { deps, rosterEntry } from './no-idling-command-test-fixtures.ts';

const WAITING_SHADOW = 'shadow-bakery-01-oven';
const CAPTURED_PANE = await readFile(
  path.join(import.meta.dirname, 'fixtures', 'claude-pane-waiting-on-queued-suite-runs.txt'),
  'utf8',
);
const PANE_SAYING_IT_WAITS_AFTER_THE_SHELLS_FINISHED = CAPTURED_PANE.replace(
  /✻ Sautéed for 6m 57s · done 4:36 PM · 4 shells, 1 monitor still\n  running/,
  '✻ Sautéed for 6m 57s',
);
const PANE_SAYING_IT_WAITS_WITH_AN_APOSTROPHE = [
  "⏺ The oven's suite run is still queued for a container slot.",
  '',
  '✻ Baked for 9s',
  '',
].join('\n');
const PANE_THAT_POSTED_THE_BLOCKED_MARKER = [
  '⏺ Both suite runs are queued for a container slot.',
  '',
  '  {"blocked":true} BLOCKED_BY_own-background-run (candidate and base suites)',
  '',
  '✻ Crunched for 5s',
  '',
].join('\n');
const CAPTURED_WAITING_SENTENCE =
  'Both suite runs (candidate and base) are still queued for a container slot';
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

async function regentNoticesForAShadowShowing(
  pane: string,
  spawnSpec: SpawnSpec | null = null,
  keyOfTheNotice: RegExp = /./,
): Promise<string[]> {
  const { dependencies, submitCalls } = deps({
    getRoster: async () => [rosterEntry(WAITING_SHADOW, 'Shadow', 'idle')],
    readSpawnSpec: async () => spawnSpec,
    readAgent: async () => pane,
    now: () => NOW_MS,
  });
  await runNoIdling(dependencies, { notify: true });
  return submitCalls
    .filter((call) => keyOfTheNotice.test(call.options?.key ?? ''))
    .map((call) => call.prompt);
}

async function waitingNoticeForAShadowShowing(pane: string): Promise<string> {
  const notices = await regentNoticesForAShadowShowing(pane);
  const notice = notices.find((text) => text.includes('waiting on background work'));
  assert.ok(notice, `no waiting notice in: ${notices.join('\n')}`);
  return notice;
}

function lineToSendIn(notice: string): { agent: string; quotedMessage: string } {
  const match = /throne send-agent (\S+) ('.*?resume\.')/.exec(notice);
  assert.ok(match, `no send line in: ${notice}`);
  return { agent: match[1]!, quotedMessage: match[2]! };
}

async function messageTheShellDelivers(quotedMessage: string): Promise<string> {
  const { stdout } = await promisify(execFile)('bash', ['-c', `printf %s ${quotedMessage}`]);
  return stdout;
}

test("the regent's notice gives the own-background-run line to send", async () => {
  const notice = await waitingNoticeForAShadowShowing(PANE_SAYING_IT_WAITS_AFTER_THE_SHELLS_FINISHED);

  assert.ok(
    notice.includes(
      `${WAITING_SHADOW} — waiting on background work: ${CAPTURED_WAITING_SENTENCE}. Send exactly: throne send-agent ${WAITING_SHADOW} 'Publish {"blocked":true} BLOCKED_BY_own-background-run (${CAPTURED_WAITING_SENTENCE}) as your latest message; clear it when you resume.'`,
    ),
    notice,
  );
  assert.doesNotMatch(notice, /idle-with-no-claim/);
});

test("the regent's notice names an untasked agent that says it is waiting on background work the same way", async () => {
  const [untaskedNotice] = await regentNoticesForAShadowShowing(
    PANE_SAYING_IT_WAITS_AFTER_THE_SHELLS_FINISHED,
    NEVER_TASKED,
    UNTASKED_NOTICE_KEY,
  );

  assert.ok(untaskedNotice);
  assert.ok(untaskedNotice.includes(`Send exactly: throne send-agent ${WAITING_SHADOW} '`), untaskedNotice);
  assert.doesNotMatch(untaskedNotice, /spawned but never tasked/);
  assert.match(untaskedNotice, new RegExp(`waiting on background work: ${CAPTURED_WAITING_SENTENCE.replace(/[()]/g, '\\$&')}`));
});

test("the regent's notice says a waiting agent must not be reaped or sent a generic continue", async () => {
  const notice = await waitingNoticeForAShadowShowing(PANE_SAYING_IT_WAITS_AFTER_THE_SHELLS_FINISHED);

  assert.match(notice, /Such a pane is waiting, not idle: never reap it and never send it a generic continue\./);
  assert.match(notice, /once per wait/);
});

test('an agent whose latest message is the blocked marker naming background work is left out of the notice', async () => {
  for (const spawnSpec of [null, NEVER_TASKED]) {
    const notices = await regentNoticesForAShadowShowing(PANE_THAT_POSTED_THE_BLOCKED_MARKER, spawnSpec);

    assert.deepEqual(notices.filter((text) => text.includes(WAITING_SHADOW)), []);
  }
});

test('the line the notice gives delivers a blocked marker the reader accepts', async () => {
  for (const pane of [PANE_SAYING_IT_WAITS_AFTER_THE_SHELLS_FINISHED, PANE_SAYING_IT_WAITS_WITH_AN_APOSTROPHE]) {
    const notice = await waitingNoticeForAShadowShowing(pane);
    const { agent, quotedMessage } = lineToSendIn(notice);
    const delivered = await messageTheShellDelivers(quotedMessage);
    const backgroundWork = /waiting on background work: (.*?)\. Send exactly/.exec(notice)?.[1];

    assert.equal(agent, WAITING_SHADOW);
    assert.deepEqual(classifyLastMessageTags(delivered), { kind: 'blocked', blockedBy: [], waitsOnOwnBackgroundRun: true });
    assert.ok(delivered.includes(`{"blocked":true} BLOCKED_BY_own-background-run (${backgroundWork}) as`), delivered);
  }
});

test('the no-idling notice never tells the regent both to ask a waiting agent for the blocked marker and never to ask it', async () => {
  const notice = await waitingNoticeForAShadowShowing(PANE_SAYING_IT_WAITS_AFTER_THE_SHELLS_FINISHED);

  assert.ok(notice.includes(`Send exactly: throne send-agent ${WAITING_SHADOW} '`), notice);
  assert.doesNotMatch(notice, /must never be told to publish/);
  assert.doesNotMatch(notice, /fully-idle/);
});

test('the no-idling log does not say it reported a waiting agent as fully idle', async () => {
  const logLines: string[] = [];
  const { dependencies } = deps({
    getRoster: async () => [rosterEntry(WAITING_SHADOW, 'Shadow', 'idle')],
    readAgent: async () => PANE_SAYING_IT_WAITS_AFTER_THE_SHELLS_FINISHED,
    now: () => NOW_MS,
    stdout: (text) => logLines.push(text),
  });

  await runNoIdling(dependencies, { notify: true });

  const noticeLog = logLines.find((line) => line.includes('Regent about'));
  assert.ok(noticeLog, `no notice log in: ${logLines.join('')}`);
  assert.doesNotMatch(noticeLog, /fully-idle/);
  assert.match(noticeLog, new RegExp(WAITING_SHADOW));
});
