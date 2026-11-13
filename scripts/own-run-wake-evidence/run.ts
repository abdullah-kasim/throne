import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { BlockedPageLedgerEntry } from '../../src/blocked-paging/blocked-agent-escalation-ledger.ts';
import { buildNoBackgroundRunPagingMessage } from '../../src/blocked-paging/blocked-agent-paging-message.ts';
import { readBlockedMarker } from '../../src/agentdata/blocked-marker.service.ts';
import { readAgent } from '../../src/herdr/herdr-runtime.service.ts';
import {
  BlockedAgentPagingHostedWorker,
  REAL_BLOCKED_AGENT_PAGING_DEPENDENCIES,
} from '../../src/blocked-paging/blocked-agent-paging.hosted-worker.ts';
import type { RememberedOwnRunWait } from '../../src/blocked-paging/own-run-wake.ts';
import { THRONE_DATA_DIR } from '../../src/shared-policy/throne-home.ts';
import { resolveMessageQueueDatabasePath } from '../../src/message-queue/message-queue.store.ts';
import { MessageQueueWorkItemState } from '../../src/message-queue/message-queue-work-item-state.ts';
import { NO_IDLING_REGENT_NAME, classifyLastMessageTags, lastMessageBlock } from '../../src/no-idling/idle-family.ts';
import { runPagerPass, type PassRecord, type ScratchAgent } from './pager-pass.ts';
import {
  OWN_RUN_MARKER,
  SCRATCH_NAME_PREFIX,
  ScratchHarness,
  WAKE_OPENING,
  processIsAlive,
  processesWorkingIn,
  waitUntil,
} from './scratch-harness.ts';

const runFile = promisify(execFile);
const MINUTE = 60_000;
const WAKE_QUEUE_BOUND_MILLISECONDS = 15 * MINUTE;
const LINES_AT_ONCE = 6;
const F1_BOUND_AFTER_RUN_ENDS_MILLISECONDS = 3 * MINUTE;
const F2_BOUND_FOR_THE_HARNESS_TO_STOP_THE_RUN_MILLISECONDS = 5 * MINUTE;
const WAITWAKE_LANDED_AT = Date.parse('2026-11-13T12:18:04+08:00');
const F3_AGENTS = ['shadow-pagedb-05z-critique-import', 'shadow-boxsched-12z-crit-r1'];
const SCRIPT = 'scripts/own-run-wake-evidence/run.ts';
const RESULTS = { PASS: 'PASS', FAIL: 'FAIL', NOT_VERIFIED: 'NOT VERIFIED' } as const;
const CLOSING_INSTRUCTIONS =
  'If your run has finished, read its result and continue. If you are still waiting, first check what is holding the run up, then publish the marker again. If a run has gone on far longer than it should, it is stuck: find out what is holding it up and fix that cause; do not just start it again.';
const KEEP_WAITING =
  `From now on, whenever a message starting with "${WAKE_OPENING}" arrives, reply with exactly the line below verbatim and use no tool. Right now, reply with exactly this line verbatim, inside no code block: ${OWN_RUN_MARKER}`;
const SAY_WHAT_ENDED =
  `From now on, whenever a message starting with "${WAKE_OPENING}" arrives, reply with one plain sentence naming the command it says ended, and use no tool. Right now, reply with exactly this line verbatim, inside no code block: ${OWN_RUN_MARKER}`;

type Result = (typeof RESULTS)[keyof typeof RESULTS];

interface LogEntry {
  readonly id: string;
  readonly command: string;
  readonly expected: string;
  readonly observed: string;
  readonly result: Result;
  readonly capture: string;
  readonly seconds?: number;
}

interface Verdict {
  readonly passed: boolean;
  readonly observed: string[];
}

class LineRun {
  readonly escalationLedger: BlockedPageLedgerEntry[] = [];
  readonly passes: PassRecord[] = [];
  readonly keysEnqueuedByTheCandidate = new Set<string>();

  constructor(readonly harness: ScratchHarness) {}

  get agent(): ScratchAgent {
    return { name: this.harness.name, paneId: this.harness.paneId, cwd: this.harness.directory };
  }

  async pass(clockMilliseconds: number): Promise<PassRecord> {
    if (await this.harness.isIdle()) await this.harness.sweep();
    const record = await runPagerPass(this.agent, this.escalationLedger, clockMilliseconds);
    this.passes.push(record);
    return record;
  }

  async restartedPass(clockMilliseconds: number): Promise<PassRecord> {
    if (await this.harness.isIdle()) await this.harness.sweep();
    const { stdout } = await runFile(process.execPath, [
      SCRIPT,
      '--pass',
      JSON.stringify({ agent: this.agent, clockMilliseconds }),
    ]);
    const record = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as PassRecord;
    this.passes.push(record);
    return record;
  }

  wakesSent(record: PassRecord): string[] {
    return record.submissions.filter((submission) => submission.recipient === this.harness.name).map((submission) => submission.prompt);
  }

  regentPages(): string[] {
    return this.passes.flatMap((record) =>
      record.submissions.filter((submission) => submission.recipient === NO_IDLING_REGENT_NAME).map((submission) => submission.prompt),
    );
  }

  wakeKeys(): string[] {
    return [...this.keysEnqueuedByTheCandidate, ...this.passes.flatMap((record) =>
      record.submissions.filter((submission) => submission.delivered && submission.key !== undefined).map((submission) => submission.key as string),
    )];
  }

  async waitForQueuedWakes(): Promise<boolean> {
    return waitUntil(async () => {
      const states = await Promise.all(this.wakeKeys().map(async (key) => (await REAL_BLOCKED_AGENT_PAGING_DEPENDENCIES.readMessageDeliveryOutcome(key))?.state));
      return states.every((state) => state === MessageQueueWorkItemState.Delivered || state === MessageQueueWorkItemState.Failed);
    }, WAKE_QUEUE_BOUND_MILLISECONDS);
  }

  async waitForWakes(count: number): Promise<number> {
    await this.waitForQueuedWakes();
    await waitUntil(async () => (await this.harness.wakesReceived()) >= count, 30_000);
    await waitUntil(
      async () => (await this.harness.composerIsEmpty()) && (await this.harness.isIdle()) && (await this.harness.repliedAfterLastMessage()),
      180_000,
    );
    return this.harness.wakesReceived();
  }

  restrictionHeld(): string {
    const visited = [...new Set(this.passes.flatMap((record) => record.agentsVisited))];
    const delivered = [
      ...new Set(this.passes.flatMap((record) => record.submissions.filter((submission) => submission.delivered).map((submission) => submission.recipient))),
    ];
    const held = visited.every((name) => name === this.harness.name) && delivered.every((name) => name === this.harness.name);
    return `restriction ${held ? 'held' : 'BROKEN'}: passes visited [${visited.join(', ')}], delivered to [${delivered.join(', ')}]`;
  }
}

function runningMinutes(message: string, command: string): number | undefined {
  const match = new RegExp(`${command}[^;.]*\\(running (?:(\\d+)h)?(\\d+)m\\)`).exec(message);
  return match === null ? undefined : Number(match[1] ?? 0) * 60 + Number(match[2]);
}

async function waitForExit(pid: number): Promise<boolean> {
  return waitUntil(async () => !processIsAlive(pid), 60_000);
}

async function exitWakeLine(run: LineRun, restartBetweenPasses: boolean): Promise<Verdict> {
  const { harness } = run;
  await harness.sayUntilMarked(KEEP_WAITING);
  await harness.sweep();
  const shortRun = await harness.start('sleep 20');
  await harness.start('nohup sleep 600');
  const first = await run.pass(Date.now());
  const exited = await waitForExit(shortRun);
  const second = restartBetweenPasses ? await run.restartedPass(Date.now()) : await run.pass(Date.now());
  const received = await run.waitForWakes(1);
  const message = run.wakesSent(second)[0] ?? '';
  const observed = [
    `pass one sent ${run.wakesSent(first).length} wake(s); sleep 20 exited: ${exited}`,
    `pass two${restartBetweenPasses ? ' (fresh node process)' : ''} sent ${run.wakesSent(second).length} wake(s): ${JSON.stringify(message)}`,
    `the pane received ${received} wake message(s)`,
  ];
  return {
    passed:
      run.wakesSent(first).length === 0 &&
      run.wakesSent(second).length === 1 &&
      received === 1 &&
      message.includes('Ended: sleep 20.') &&
      runningMinutes(message, 'sleep 600') !== undefined,
    observed,
  };
}

async function lineW2(run: LineRun): Promise<Verdict> {
  const { harness } = run;
  await harness.sayUntilMarked(KEEP_WAITING);
  await harness.sweep();
  await harness.start('sleep 20');
  await harness.start('nohup sleep 600');
  const fiveMinutesIn = (await harness.blockedAt()) + 5 * MINUTE;
  const first = await run.pass(fiveMinutesIn);
  const second = await run.pass(fiveMinutesIn);
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  const received = await harness.wakesReceived();
  const sent = run.wakesSent(first).length + run.wakesSent(second).length;
  return { passed: sent === 0 && received === 0, observed: [`two passes at marker + 5 minutes sent ${sent} wake(s); the pane received ${received}`] };
}

async function timedWakes(run: LineRun, startedBeforeMarker: (harness: ScratchHarness) => Promise<void>, command: string): Promise<Verdict> {
  const { harness } = run;
  await startedBeforeMarker(harness);
  await harness.sayUntilMarked(KEEP_WAITING);
  await harness.sweep();
  const blockedAt = await harness.blockedAt();
  const first = await run.pass(blockedAt + 15 * MINUTE);
  const afterFirst = await run.waitForWakes(1);
  await run.waitForQueuedWakes();
  const repeated = await run.pass(blockedAt + 15 * MINUTE);
  const third = await run.pass(blockedAt + 30 * MINUTE);
  const afterThird = await run.waitForWakes(2);
  const firstMessage = run.wakesSent(first)[0] ?? '';
  const thirdMessage = run.wakesSent(third)[0] ?? '';
  return {
    passed:
      run.wakesSent(first).length === 1 &&
      run.wakesSent(repeated).length === 0 &&
      run.wakesSent(third).length === 1 &&
      afterFirst === 1 &&
      afterThird === 2 &&
      (runningMinutes(firstMessage, command) ?? 0) >= 15 &&
      (runningMinutes(thirdMessage, command) ?? 0) >= 30,
    observed: [
      `marker + 15 minutes sent ${run.wakesSent(first).length}: ${JSON.stringify(firstMessage)}; pane then held ${afterFirst}`,
      `same clock again sent ${run.wakesSent(repeated).length}`,
      `marker + 30 minutes sent ${run.wakesSent(third).length}: ${JSON.stringify(thirdMessage)}; pane then held ${afterThird}`,
    ],
  };
}

async function lineW3(run: LineRun): Promise<Verdict> {
  return timedWakes(run, async (harness) => void (await harness.start('nohup sleep 600')), 'sleep 600');
}

async function lineW4(run: LineRun): Promise<Verdict> {
  const pipeFile = path.join(run.harness.directory, 'pipe');
  return timedWakes(run, async (harness) => {
    await runFile('mkfifo', [pipeFile]);
    await harness.start(`cat ${pipeFile}`);
  }, 'cat');
}

async function lineW5(run: LineRun): Promise<Verdict> {
  const { harness } = run;
  await harness.sayUntilMarked(KEEP_WAITING);
  await harness.sweep();
  const shortRun = await harness.start('sleep 8');
  await harness.start('nohup sleep 600');
  const first = await run.pass(Date.now());
  await execFileHerdrPrompt(harness.name, `Use the Bash tool to run the command \`python3 -c 'import time; time.sleep(40)'\` in the foreground, not in the background. When it finishes, reply with exactly this line verbatim: ${OWN_RUN_MARKER}`);
  const working = await waitUntil(async () => (await harness.status()) === 'working', 30_000);
  const exited = await waitForExit(shortRun);
  const statusAtSecond = await harness.status();
  const second = await run.pass(Date.now());
  await waitUntil(() => harness.isIdle(), 120_000);
  const third = await run.pass(Date.now());
  const received = await run.waitForWakes(1);
  const message = run.wakesSent(third)[0] ?? '';
  return {
    passed:
      run.wakesSent(first).length === 0 &&
      working &&
      exited &&
      statusAtSecond === 'working' &&
      run.wakesSent(second).length === 0 &&
      run.wakesSent(third).length === 1 &&
      message.includes('sleep 8') &&
      received === 1,
    observed: [
      `pass one sent ${run.wakesSent(first).length}; the pane went working: ${working}; sleep 8 exited: ${exited}`,
      `pass two with herdr status "${statusAtSecond}" sent ${run.wakesSent(second).length}`,
      `pass three after idle sent ${run.wakesSent(third).length}: ${JSON.stringify(message)}; pane received ${received}`,
    ],
  };
}

async function execFileHerdrPrompt(name: string, text: string): Promise<void> {
  await runFile('herdr', ['agent', 'prompt', name, text]);
}

async function lineW6(run: LineRun): Promise<Verdict> {
  const { harness } = run;
  await harness.start('nohup sleep 600');
  await harness.publish('{"blocked":true} __BLOCKED_BY_shadow-x__');
  await harness.sweep();
  const marker = await readBlockedMarker(harness.name);
  const blockedAt = await harness.blockedAt();
  const sent: number[] = [];
  for (const minutes of [0, 15, 30, 60, 240]) {
    sent.push(run.wakesSent(await run.pass(blockedAt + minutes * MINUTE)).length);
  }
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  const received = await harness.wakesReceived();
  return {
    passed: (marker?.blockedBy ?? []).includes('shadow-x') && sent.every((count) => count === 0) && received === 0,
    observed: [
      `ledger marker names [${(marker?.blockedBy ?? []).join(', ')}]`,
      `passes at marker + 0, 15, 30, 60, 240 minutes sent ${sent.join(', ')} wake(s); the pane received ${received}`,
    ],
  };
}

async function lineW7(run: LineRun): Promise<Verdict> {
  const { harness } = run;
  await harness.start('nohup sleep 600');
  await harness.sayUntilMarked(KEEP_WAITING);
  await harness.sweep();
  const blockedAt = await harness.blockedAt();
  const woken = await run.pass(blockedAt + 15 * MINUTE);
  const firstReceived = await run.waitForWakes(1);
  await run.waitForQueuedWakes();
  await harness.say('Reply with the single word: resumed. Use no tool.');
  const cleared = [await run.pass(blockedAt + 30 * MINUTE), await run.pass(blockedAt + 120 * MINUTE)];
  const markerAfterOrdinary = await readBlockedMarker(harness.name);
  await harness.sayUntilMarked(KEEP_WAITING);
  await harness.sweep();
  const secondBlockedAt = await harness.blockedAt();
  const shownBeforeSecondWake = await harness.wakesReceived();
  const early = await run.pass(secondBlockedAt + 14 * MINUTE);
  const due = await run.pass(secondBlockedAt + 15 * MINUTE);
  const secondReceived = (await run.waitForWakes(shownBeforeSecondWake + 1)) - shownBeforeSecondWake;
  const clearedSent = cleared.map((record) => run.wakesSent(record).length);
  return {
    passed:
      run.wakesSent(woken).length === 1 &&
      markerAfterOrdinary === null &&
      clearedSent.every((count) => count === 0) &&
      secondBlockedAt > blockedAt &&
      run.wakesSent(early).length === 0 &&
      run.wakesSent(due).length === 1 &&
      firstReceived === 1 &&
      secondReceived === 1,
    observed: [
      `first marker + 15 minutes sent ${run.wakesSent(woken).length}`,
      `after the ordinary reply the ledger marker is ${markerAfterOrdinary === null ? 'cleared' : 'still there'}; passes at + 30 and + 120 minutes sent ${clearedSent.join(', ')}`,
      `new marker ${new Date(secondBlockedAt).toISOString()}: + 14 minutes sent ${run.wakesSent(early).length}, + 15 minutes sent ${run.wakesSent(due).length}; pane received ${firstReceived} wake(s) after the first marker and ${secondReceived} after the second`,
    ],
  };
}

async function lineW9(run: LineRun): Promise<Verdict> {
  const regentBefore = await readAgent(NO_IDLING_REGENT_NAME, { lines: 400 }).catch(() => '');
  const exitWake = await exitWakeLine(run, false);
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  const regentAfter = await readAgent(NO_IDLING_REGENT_NAME, { lines: 400 }).catch(() => '');
  const regentMentions = regentAfter.split(run.harness.name).length - 1 - (regentBefore.split(run.harness.name).length - 1);
  const pages = run.regentPages();
  return {
    passed: exitWake.passed && pages.length === 0 && regentMentions === 0,
    observed: [
      ...exitWake.observed,
      `submissions addressed to the Regent across the passes: ${pages.length}`,
      `the live Regent pane (read only) mentions ${run.harness.name} ${regentMentions} more time(s) than before`,
    ],
  };
}

async function lineW10(run: LineRun): Promise<Verdict> {
  const { harness } = run;
  await harness.sayUntilMarked(KEEP_WAITING);
  await harness.sweep();
  const first = await run.pass(Date.now());
  const second = await run.pass(Date.now());
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  const received = await harness.wakesReceived();
  const pages = run.regentPages();
  const expectedPage = buildNoBackgroundRunPagingMessage({ agentName: harness.name, cwd: harness.directory, paneId: harness.paneId });
  return {
    passed: pages.length === 1 && pages[0] === expectedPage && run.wakesSent(first).length + run.wakesSent(second).length === 0 && received === 0,
    observed: [
      `two passes with nothing running made ${pages.length} Regent page(s), captured by the tool and not delivered: ${JSON.stringify(pages)}`,
      `wakes sent to the agent: ${run.wakesSent(first).length + run.wakesSent(second).length}; the pane received ${received}`,
    ],
  };
}

async function lineW11(run: LineRun): Promise<Verdict> {
  const { harness } = run;
  await harness.sayUntilMarked(SAY_WHAT_ENDED);
  await harness.sweep();
  const shortRun = await harness.start('sleep 20');
  await harness.start('nohup sleep 600');
  await run.pass(Date.now());
  await waitForExit(shortRun);
  const second = await run.pass(Date.now());
  const received = await run.waitForWakes(1);
  const message = run.wakesSent(second)[0] ?? '';
  const transcript = await harness.transcript();
  const reply = transcript.slice(transcript.lastIndexOf('</message'));
  const tag = await harness.lastMessageTag();
  const replied = /●\s*\S/.test(reply);
  return {
    passed: received === 1 && message.endsWith(CLOSING_INSTRUCTIONS) && replied && tag.kind === 'unmarked',
    observed: [
      `wake as delivered: ${JSON.stringify(message)}`,
      `after the wake the harness replied on its own: ${replied}; its last message reads as "${tag.kind}"`,
    ],
  };
}

async function lineW12(directory: string): Promise<LogEntry> {
  const files = ['src/agentdata/waiting-instructions.ts', '.claude/skills/execute-todos/SKILL.md'];
  const phrases = ["own background mode", "never a shell `&`", 'Stop any server you started before you end a turn with the marker'];
  const found = await Promise.all(
    files.map(async (file) => {
      const text = (await readFile(file, 'utf8')).replace(/"\s*\+\s*\n\s*"/g, '');
      return phrases.map((phrase) => `${file}: "${phrase}" ${text.includes(phrase) ? 'present' : 'MISSING'}`);
    }),
  );
  const capture = path.join(directory, 'W12.txt');
  await writeFile(capture, `${found.flat().join('\n')}\n`);
  return {
    id: 'W12',
    command: `bun ${SCRIPT} W12`,
    expected: LINES.W12,
    observed: `${found.flat().join('; ')} (text line: no pane needed, files read directly)`,
    result: found.flat().every((line) => line.endsWith('present')) ? RESULTS.PASS : RESULTS.FAIL,
    capture,
  };
}


function startCandidatePagerFor(harness: ScratchHarness, keysEnqueuedByTheCandidate: Set<string>): () => Promise<void> {
  const recordPagerStep = (step: string): void => {
    process.stderr.write(`${new Date().toISOString()} F1 pager ${step}\n`);
  };
  let stopped = false;
  let rememberedByTheCandidate: RememberedOwnRunWait | null = null;
  const worker = new BlockedAgentPagingHostedWorker({
    ...REAL_BLOCKED_AGENT_PAGING_DEPENDENCIES,
    listKnownPaneIds: async () => {
      recordPagerStep(`status subscription opened for ${harness.paneId}`);
      return [harness.paneId];
    },
    getRoster: async () => {
      const startedAt = Date.now();
      const roster = (await REAL_BLOCKED_AGENT_PAGING_DEPENDENCIES.getRoster('')).filter((entry) => entry.name === harness.name);
      recordPagerStep(`roster read in ${Date.now() - startedAt} ms: ${JSON.stringify(roster.map(({ liveStatus, lifecycle }) => ({ liveStatus, lifecycle })))}`);
      return roster;
    },
    readAgent: async (name) => {
      const output = await REAL_BLOCKED_AGENT_PAGING_DEPENDENCIES.readAgent(name);
      recordPagerStep(`pane read, last message reads as ${classifyLastMessageTags(lastMessageBlock(output)).kind}`);
      return output;
    },
    readHarnessBackgroundWork: async (paneId) => {
      const work = await REAL_BLOCKED_AGENT_PAGING_DEPENDENCIES.readHarnessBackgroundWork(paneId);
      recordPagerStep(`background work: ${JSON.stringify(work)}`);
      return work;
    },
    readRememberedOwnRunWait: async () => rememberedByTheCandidate,
    writeRememberedOwnRunWait: async (_name, remembered) => {
      recordPagerStep(`remembered: ${JSON.stringify(remembered)}`);
      rememberedByTheCandidate = remembered;
    },
    submitToAgent: async (target, sender, prompt, options) => {
      recordPagerStep(`wake enqueued as ${options?.key}`);
      if (options?.key !== undefined) keysEnqueuedByTheCandidate.add(options.key);
      await REAL_BLOCKED_AGENT_PAGING_DEPENDENCIES.submitToAgent(target, sender, prompt, options);
    },
    stderr: (text) => process.stderr.write(text),
  });
  const running = worker.start(() => stopped);
  return async () => {
    stopped = true;
    await running.catch(() => undefined);
  };
}

async function lineF1(run: LineRun): Promise<Verdict> {
  const { harness, keysEnqueuedByTheCandidate } = run;
  const stopCandidatePager = startCandidatePagerFor(harness, keysEnqueuedByTheCandidate);
  let verdict: Verdict;
  try {
    verdict = await waitForTheOwnRunWake(run);
  } finally {
    await stopCandidatePager();
  }
  return { passed: verdict.passed && keysEnqueuedByTheCandidate.size > 0, observed: verdict.observed };
}

function wakeItemsFor(agentName: string, since: number): { dedupe_key: string; state: string }[] {
  const database = new DatabaseSync(resolveMessageQueueDatabasePath(), { readOnly: true });
  try {
    return database
      .prepare('SELECT dedupe_key, state FROM work_items WHERE dedupe_key LIKE ? AND created_at >= ? ORDER BY created_at')
      .all(`own-run-wake:${agentName}:%`, since) as { dedupe_key: string; state: string }[];
  } finally {
    database.close();
  }
}

async function waitForTheOwnRunWake(run: LineRun): Promise<Verdict> {
  const { harness } = run;
  const resultFile = path.join(harness.directory, 'f1-result');
  await harness.sayUntilMarked(
    `Use the Bash tool once, in the foreground, to run exactly this command: (sleep 30; echo done > ${resultFile}) & nohup sleep 3600 >/dev/null 2>&1 &   The first part writes its result to ${resultFile}. After the command returns, reply with exactly this line verbatim, inside no code block: ${OWN_RUN_MARKER}`,
  );
  const markerFound = await waitUntil(async () => (await readBlockedMarker(harness.name)) !== null, 90_000);
  if (!markerFound) await harness.sweep();
  const runEnded = await waitUntil(async () => (await readFile(resultFile, 'utf8').catch(() => '')).includes('done'), 120_000);
  const runEndedAt = Date.now();
  const woken = await waitUntil(async () => (await harness.wakesReceived()) >= 1, F1_BOUND_AFTER_RUN_ENDS_MILLISECONDS);
  const wokenAt = Date.now();
  const replied = woken && (await waitUntil(
    async () => (await harness.isIdle()) && (await harness.repliedAfterLastMessage()) && (await harness.lastMessageTag()).kind === 'unmarked',
    Math.max(0, runEndedAt + F1_BOUND_AFTER_RUN_ENDS_MILLISECONDS - Date.now()) + 1,
  ));
  const repliedAt = Date.now();
  const readTheFile = await readTheResultAfterTheWake(harness.directory, resultFile);
  const withinBound = replied && repliedAt - runEndedAt <= F1_BOUND_AFTER_RUN_ENDS_MILLISECONDS;
  return {
    passed: runEnded && woken && withinBound && readTheFile,
    observed: [
      `candidate pager started from this tree on its real 60 s timer, restricted to ${harness.name}`,
      `ledger marker written by the pager itself: ${markerFound}${markerFound ? '' : ' (the tool resolved it once; no pager pass by hand)'}`,
      `the 30 s run wrote its file: ${runEnded}`,
      `the real backend's timer delivered the wake ${woken ? `${Math.round((wokenAt - runEndedAt) / 1000)} s after the run ended` : 'NOT within 3 minutes'}`,
      `the harness posted an ordinary message ${replied ? `${Math.round((repliedAt - runEndedAt) / 1000)} s after the run ended` : 'NOT within the bound'}; it read the file: ${readTheFile}`,
      `passes made by hand: ${run.passes.length}`,
    ],
  };
}

async function lineF2(run: LineRun): Promise<Verdict> {
  const { harness } = run;
  const lockFile = path.join(harness.directory, 'lock');
  const command = `flock ${lockFile} sh -c 'flock ${lockFile} true'`;
  await harness.sayUntilMarked(
    `Use the Bash tool with its run_in_background option set to true to run exactly this command: ${command}   Do not wait for it. Then reply with exactly this line verbatim, inside no code block: ${OWN_RUN_MARKER}`,
  );
  await harness.sweep();
  const flockRunning = async (): Promise<boolean> =>
    (await processesWorkingIn(harness.directory)).some((found) => found.command.startsWith('flock '));
  const startedInBackground = await waitUntil(flockRunning, 30_000);
  const blockedAt = await harness.blockedAt();
  const woken = await run.pass(blockedAt + 15 * MINUTE);
  await run.waitForQueuedWakes();
  const received = await waitUntil(async () => (await harness.wakesReceived()) >= 1, 30_000);
  const stopped = await waitUntil(async () => !(await flockRunning()), F2_BOUND_FOR_THE_HARNESS_TO_STOP_THE_RUN_MILLISECONDS);
  const message = run.wakesSent(woken)[0] ?? '';
  return {
    passed: startedInBackground && run.wakesSent(woken).length === 1 && message.includes('flock') && received && stopped,
    observed: [
      `the harness started the flock run through its own background mode: ${startedInBackground}`,
      `marker + 15 minutes sent ${run.wakesSent(woken).length}: ${JSON.stringify(message)}; the pane received it: ${received}`,
      `the flock process was gone within ${F2_BOUND_FOR_THE_HARNESS_TO_STOP_THE_RUN_MILLISECONDS / MINUTE} minutes with nobody else typing: ${stopped}`,
    ],
  };
}

interface TranscriptTurn {
  readonly timestamp: string;
  readonly text: string;
}

function readableBlocks(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((block: { type?: string; text?: string; name?: string; input?: { command?: string }; content?: unknown }) => {
      if (block.type === 'text') return block.text ?? '';
      if (block.type === 'tool_use') return `[${block.name ?? 'tool'}] ${block.input?.command ?? JSON.stringify(block.input ?? {})}`;
      if (block.type === 'tool_result') return typeof block.content === 'string' ? `[result] ${block.content}` : '[result]';
      return '';
    })
    .filter((text) => text !== '')
    .join(' ');
}

async function readTheResultAfterTheWake(directory: string, resultFile: string): Promise<boolean> {
  const folderName = (await realpath(directory)).replace(/[^a-zA-Z0-9]/g, '-');
  const turns = (await transcriptTurns((name) => name === folderName)) ?? [];
  const wakeTurn = turns.findLastIndex((turn) => turn.text.startsWith('user:') && turn.text.includes(WAKE_OPENING));
  return wakeTurn >= 0 && turns.slice(wakeTurn + 1).some((turn) => turn.text.startsWith('assistant:') && /\[\w+\] /.test(turn.text) && turn.text.includes(path.basename(resultFile)));
}

async function transcriptTurns(folderMatches: (name: string) => boolean): Promise<TranscriptTurn[] | undefined> {
  const projects = path.join(os.homedir(), '.claude', 'projects');
  const folder = (await readdir(projects)).find(folderMatches);
  if (folder === undefined) return undefined;
  const turns: TranscriptTurn[] = [];
  for (const file of (await readdir(path.join(projects, folder))).filter((name) => name.endsWith('.jsonl'))) {
    for (const line of (await readFile(path.join(projects, folder, file), 'utf8')).split('\n')) {
      try {
        const entry = JSON.parse(line) as { timestamp?: string; type?: string; message?: { content?: unknown } };
        const content = entry.message?.content;
        const text = typeof content === 'string' ? content : readableBlocks(content);
        if (entry.timestamp !== undefined && text !== '') turns.push({ timestamp: entry.timestamp, text: `${entry.type ?? ''}: ${text}` });
      } catch {
        continue;
      }
    }
  }
  return turns.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
}

async function lineF3(directory: string): Promise<LogEntry> {
  const database = new DatabaseSync(resolveMessageQueueDatabasePath(), { readOnly: true });
  const findings: string[] = [];
  let passed = true;
  try {
    for (const agentName of F3_AGENTS) {
      const wakes = database
        .prepare('SELECT state, failure_reason, created_at, terminal_at FROM work_items WHERE dedupe_key LIKE ? AND created_at >= ? ORDER BY created_at')
        .all(`own-run-wake:${agentName}:%`, WAITWAKE_LANDED_AT) as { state: string; failure_reason: string | null; created_at: number; terminal_at: number | null }[];
      const first = wakes[0];
      if (first === undefined) {
        passed = false;
        findings.push(`${agentName}: FAIL, no wake in the delivery records after idlewake landed (${new Date(WAITWAKE_LANDED_AT).toISOString()})`);
        continue;
      }
      const turns = (await transcriptTurns((name) => name.endsWith(`-${agentName}`))) ?? [];
      const wakeTurn = turns.findIndex((turn) => turn.text.includes(WAKE_OPENING) && Date.parse(turn.timestamp) >= first.created_at - MINUTE);
      const next = turns
        .slice(wakeTurn + 1)
        .filter((turn) => turn.text.startsWith('assistant:'))
        .slice(0, 4)
        .map((turn) => `${turn.timestamp} ${turn.text.slice(11, 250)}`);
      const delivered = first.state === MessageQueueWorkItemState.Delivered;
      if (!delivered) passed = false;
      findings.push(
        `${agentName}: first wake queued ${new Date(first.created_at).toISOString()}, ${first.state}${first.terminal_at === null ? '' : ` at ${new Date(first.terminal_at).toISOString()}`}${first.failure_reason === null ? '' : ` (${first.failure_reason})`}; ${wakes.length} wake(s) in all; ` +
          (wakeTurn < 0
            ? 'the transcript shows no wake'
            : `transcript shows it at ${turns[wakeTurn]?.timestamp}; next it ${next.length === 0 ? 'did nothing more' : `did: ${JSON.stringify(next.join(' | '))}`}`),
      );
    }
  } finally {
    database.close();
  }
  const capture = path.join(directory, 'F3.txt');
  await writeFile(capture, `${findings.join('\n')}\n`);
  return {
    id: 'F3',
    command: `bun ${SCRIPT} F3`,
    expected: LINES.F3 ?? '',
    observed: `${findings.join('; ')} (read only: message-queue records and the two Claude transcripts; neither agent touched)`,
    result: passed ? RESULTS.PASS : RESULTS.FAIL,
    capture,
  };
}

const LINES_THAT_COUNT_REGENT_TRAFFIC = ['W9', 'W10'];
const LINES_TIMED_AGAINST_AN_UNSHARED_QUEUE = ['F1'];
const LINES_RUN_ONE_AT_A_TIME = [...LINES_TIMED_AGAINST_AN_UNSHARED_QUEUE, ...LINES_THAT_COUNT_REGENT_TRAFFIC];

const LINES: Record<string, string> = {
  W1: 'Marker up; sleep 20 & and nohup sleep 600 & in its tree. Pass one, then pass two after sleep 20 exited -> exactly one message naming sleep 20 as ended and sleep 600 as still running with how long it has run.',
  W2: 'Same start, both sleeps alive, marker 5 minutes old, two passes -> no message.',
  W3: 'Only sleep 600 alive; marker + 15 minutes, one pass -> one message; same clock again -> none; + another 15 minutes -> a second message.',
  W4: "mkfifo <file> && cat <file> in the tree, marker up, clock + 15 minutes -> one message naming the command and showing at least 15 minutes.",
  W5: 'The pane is working (herdr status) when a remembered process exits -> no message on that pass; the message arrives on the first pass after the pane is idle.',
  W6: 'The marker names a child agent only (BLOCKED_BY_shadow-x) -> never a wake message, at any clock.',
  W7: 'After a wake the agent posts an ordinary message -> no further message at any clock; it publishes the marker again -> the 15 minutes start again from that new marker.',
  W8: 'The pager in-process state is thrown away between pass one and pass two of W1 -> the same single message as W1.',
  W9: "A wake is delivered to the agent only: the Regent's pane and the delivery records show no message about that agent caused by the wake.",
  W10: 'Nothing running under the marker -> the Regent is paged once, as before (buildNoBackgroundRunPagingMessage), and the agent is not woken twice for it.',
  W11: 'The wake reads as plain sentences ending with the three instructions; with W1 setup the harness resumes and posts an ordinary message without anyone else typing.',
  F1: 'The pagedb case: a shell-& run of sleep 30 writing a file and nohup sleep 3600, marker up, the REAL backend timer and no pass by hand -> within 3 minutes of the 30 s ending the pane got the wake, read the file and posted an ordinary message.',
  F2: "The boxsched case: W4's flock run started through the harness's own background mode, marker up, clock + 15 minutes -> the pane gets the wake and its harness stops the run without anyone else typing.",
  F3: 'Read only: when shadow-pagedb-05z-critique-import and shadow-boxsched-12z-crit-r1 first got a wake after idlewake landed and what each did next; never woken while waiting -> FAIL.',
  W12: 'waiting-instructions.ts and the execute-todos skill both say: start a run you will wait on with the harness background mode, never a shell &; stop any server before ending a turn with the marker.',
};

const PANE_LINES: Record<string, (run: LineRun) => Promise<Verdict>> = {
  W1: (run) => exitWakeLine(run, false),
  W2: lineW2,
  W3: lineW3,
  W4: lineW4,
  W5: lineW5,
  W6: lineW6,
  W7: lineW7,
  W8: (run) => exitWakeLine(run, true),
  W9: lineW9,
  W10: lineW10,
  W11: lineW11,
  F1: lineF1,
  F2: lineF2,
};

async function runPaneLine(id: string, directory: string, stamp: string, owner: string): Promise<LogEntry> {
  const capture = path.join(directory, `${id}.txt`);
  const base = { id, command: `bun ${SCRIPT} ${id}`, expected: LINES[id] ?? '', capture };
  let harness: ScratchHarness | undefined;
  try {
    harness = await ScratchHarness.open(`${SCRATCH_NAME_PREFIX}${id.toLowerCase()}-${stamp}`, path.join(directory, id), owner);
  } catch (error) {
    await writeFile(capture, `no pane: ${String(error)}\n`);
    return { ...base, observed: `could not open a scratch Claude pane: ${String(error)}`, result: RESULTS.NOT_VERIFIED };
  }
  const run = new LineRun(harness);
  const startedAt = Date.now();
  try {
    await mkdir(path.join(THRONE_DATA_DIR, harness.name, 'own-run-wake.json'), { recursive: true });
    const verdict = await (PANE_LINES[id] ?? (async () => ({ passed: false, observed: ['unknown line'] })))(run);
    await harness.capture(capture);
    const restriction = run.restrictionHeld();
    const candidateKeys = new Set(run.wakeKeys());
    const wakes = wakeItemsFor(harness.name, startedAt);
    const everyWakeFromTheCandidate = wakes.every((wake) => candidateKeys.has(wake.dedupe_key));
    const attribution = `wakes in the queue for the pane: ${wakes.length === 0 ? 'none' : wakes
      .map((wake) => `${wake.dedupe_key} (${wake.state}) enqueued by ${candidateKeys.has(wake.dedupe_key) ? 'the candidate' : 'the live main pager'}`)
      .join('; ')}`;
    return {
      ...base,
      observed: [`pane ${harness.paneId} (${harness.name})`, ...verdict.observed, restriction, attribution].join('; '),
      result: verdict.passed && restriction.includes('held') && everyWakeFromTheCandidate ? RESULTS.PASS : RESULTS.FAIL,
    };
  } catch (error) {
    await harness.capture(capture).catch(() => undefined);
    return { ...base, observed: `pane ${harness.paneId}: the line threw ${String(error)}; ${run.restrictionHeld()}`, result: RESULTS.FAIL };
  } finally {
    await harness.close();
  }
}

async function runSinglePass(argument: string): Promise<void> {
  const { agent, clockMilliseconds } = JSON.parse(argument) as { agent: ScratchAgent; clockMilliseconds: number };
  process.stdout.write(`${JSON.stringify(await runPagerPass(agent, [], clockMilliseconds))}\n`);
}

async function main(commandArguments: readonly string[]): Promise<number> {
  if (commandArguments[0] === '--pass') {
    await runSinglePass(commandArguments[1] ?? '{}');
    return 0;
  }
  const wanted = commandArguments[0] ?? '';
  const ids = wanted === 'all' ? Object.keys(LINES) : [wanted.toUpperCase()];
  if (!ids.every((id) => id in LINES)) {
    process.stderr.write(`usage: bun ${SCRIPT} <W1..W12, F1, F2, F3 or "all">\n`);
    return 2;
  }
  const owner = process.env.THRONE_AGENT_NAME;
  if (owner === undefined) {
    process.stderr.write('THRONE_AGENT_NAME must name the agent that owns the scratch panes\n');
    return 2;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = path.join(os.homedir(), 'tmp', 'own-run-wake-evidence', stamp);
  await mkdir(directory, { recursive: true });
  const log: LogEntry[] = [];
  const logPath = path.join(directory, 'log.json');
  const runLine = async (id: string): Promise<void> => {
    process.stdout.write(`${id} ...\n`);
    const startedAt = Date.now();
    const line = id === 'W12' ? await lineW12(directory) : id === 'F3' ? await lineF3(directory) : await runPaneLine(id, directory, stamp.slice(11, 19).toLowerCase(), owner);
    const entry = { ...line, seconds: Math.round((Date.now() - startedAt) / 1000) };
    log.push(entry);
    log.sort((left, right) => ids.indexOf(left.id) - ids.indexOf(right.id));
    await writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`);
    process.stdout.write(`${id} ${entry.result}\n`);
  };
  const runStartedAt = Date.now();
  const waiting = ids.filter((id) => !LINES_RUN_ONE_AT_A_TIME.includes(id));
  await Promise.all(
    Array.from({ length: LINES_AT_ONCE }, async () => {
      for (let id = waiting.shift(); id !== undefined; id = waiting.shift()) await runLine(id);
    }),
  );
  for (const id of LINES_RUN_ONE_AT_A_TIME.filter((id) => ids.includes(id))) await runLine(id);
  const runSeconds = Math.round((Date.now() - runStartedAt) / 1000);
  await writeFile(path.join(directory, 'run.json'), `${JSON.stringify({ seconds: runSeconds, linesAtOnce: LINES_AT_ONCE, serial: LINES_RUN_ONE_AT_A_TIME }, null, 2)}\n`);
  process.stdout.write(`run took ${runSeconds} s\n${logPath}\n`);
  return log.every((entry) => entry.result === RESULTS.PASS) ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
