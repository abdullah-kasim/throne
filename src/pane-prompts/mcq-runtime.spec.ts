import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IdentityLineReadStatus } from '../agentdata/identity-data.service.ts';
import type { HerdrAgent } from '../herdr/herdr-identity-contracts.ts';
import type { McqAnswerLedgerEntry } from './mcq-answer-ledger.ts';
import { McqExitCode, runMcq, type McqDependencies } from './mcq-runtime.ts';

const PANE_ID = 'w1:p9';
const CLEARED_SCREEN = '⏺ Running…\n\n❯ \n';

function permissionScreen(selectedRow: number): string {
  const rows = ['Yes', 'No', "Yes, and don't ask again"]
    .map((label, index) => ` ${index + 1 === selectedRow ? '❯' : ' '} ${index + 1}. ${label}`)
    .join('\n');
  return `─────────\n Bash command\n\n   │ rm -rf /tmp/x\n   Run shell command\n\n Do you want to proceed?\n${rows}\n\n Esc to cancel · Tab to amend\n`;
}

interface FakePaneBehaviour {
  readonly digitSelectsAndSubmits: boolean;
  readonly digitMovesCursor: boolean;
  readonly arrowsMove: boolean;
  readonly escapeClears: boolean;
  readonly arrowJumpsTo?: number;
}

interface FakeCourt {
  readonly deps: McqDependencies;
  readonly pressed: string[];
  readonly ledger: McqAnswerLedgerEntry[];
  readonly pages: string[];
  readonly stdout: string[];
  readonly stderr: string[];
}

function fakeCourt(
  options: {
    readonly caller?: string;
    readonly role?: string;
    readonly initialScreen?: string;
    readonly behaviour?: Partial<FakePaneBehaviour>;
  } = {},
): FakeCourt {
  const behaviour: FakePaneBehaviour = {
    digitSelectsAndSubmits: true,
    digitMovesCursor: false,
    arrowsMove: true,
    escapeClears: true,
    ...options.behaviour,
  };
  let selectedRow = 1;
  let screen = options.initialScreen ?? permissionScreen(selectedRow);
  const pressed: string[] = [];
  const ledger: McqAnswerLedgerEntry[] = [];
  const pages: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  let clock = 0;
  const agent: HerdrAgent = {
    agent: 'claude',
    name: 'shadow-x',
    agentStatus: 'blocked',
    cwd: '/tmp',
    focused: false,
    paneId: PANE_ID,
    tabId: 't',
    terminalId: 'term',
  };
  const deps: McqDependencies = {
    currentAgentName: async () => options.caller ?? 'stager-a',
    readRole: async () => ({ status: IdentityLineReadStatus.Found, value: options.role ?? 'Stager' }),
    resolveAgent: async () => agent,
    readPaneText: async () => screen,
    pressKey: async (_pane, key) => {
      pressed.push(key);
      if (/^\d$/u.test(key)) {
        if (behaviour.digitSelectsAndSubmits) screen = CLEARED_SCREEN;
        else if (behaviour.digitMovesCursor) {
          selectedRow = Number(key);
          screen = permissionScreen(selectedRow);
        }
        return;
      }
      if (key === 'down' || key === 'up') {
        if (!behaviour.arrowsMove) return;
        selectedRow = behaviour.arrowJumpsTo ?? selectedRow + (key === 'down' ? 1 : -1);
        screen = permissionScreen(selectedRow);
        return;
      }
      if (key === 'enter') screen = CLEARED_SCREEN;
      if (key === 'esc' && behaviour.escapeClears) screen = CLEARED_SCREEN;
    },
    sleep: async (milliseconds) => {
      clock += milliseconds;
    },
    now: () => clock,
    pageRegent: async (message) => {
      pages.push(message);
    },
    appendLedger: async (entry) => {
      ledger.push(entry);
    },
    out: (text) => stdout.push(text),
    err: (text) => stderr.push(text),
  };
  return { deps, pressed, ledger, pages, stdout, stderr };
}

test('a Stager answering 2 on a menu that submits on the digit presses only the digit and records the answer', async () => {
  const court = fakeCourt();
  const code = await runMcq(['--agent', 'shadow-x', '--answer', '2'], court.deps);
  assert.equal(code, McqExitCode.Done);
  assert.deepEqual(court.pressed, ['2']);
  assert.equal(court.ledger.length, 1);
  assert.equal(court.ledger[0]!.outcome, 'answered');
  assert.deepEqual(court.ledger[0]!.chosen, { number: 2, label: 'No' });
  assert.equal(court.ledger[0]!.caller, 'stager-a');
  assert.equal(court.ledger[0]!.agent, 'shadow-x');
  assert.equal(court.ledger[0]!.pane, PANE_ID);
  assert.equal(court.ledger[0]!.question, 'Do you want to proceed?');
  assert.equal(court.ledger[0]!.command, 'rm -rf /tmp/x');
  assert.deepEqual(court.pages, []);
});

test('when the digit only moves the cursor onto the target row, Enter follows', async () => {
  const court = fakeCourt({ behaviour: { digitSelectsAndSubmits: false, digitMovesCursor: true } });
  const code = await runMcq(['--agent', 'shadow-x', '--answer', '3'], court.deps);
  assert.equal(code, McqExitCode.Done);
  assert.deepEqual(court.pressed, ['3', 'enter']);
});

test('when the digit does nothing, the cursor walks with Down presses, checked after each, then Enter', async () => {
  const court = fakeCourt({ behaviour: { digitSelectsAndSubmits: false } });
  const code = await runMcq(['--agent', 'shadow-x', '--answer', '3'], court.deps);
  assert.equal(code, McqExitCode.Done);
  assert.deepEqual(court.pressed, ['3', 'down', 'down', 'enter']);
});

test('the cursor check: a Down press that leaves the cursor where it was presses nothing further, exits non-zero naming expected and observed rows, and pages the Regent to take over', async () => {
  const court = fakeCourt({ behaviour: { digitSelectsAndSubmits: false, arrowsMove: false } });
  const code = await runMcq(['--agent', 'shadow-x', '--answer', '2'], court.deps);
  assert.equal(code, McqExitCode.TakeOver);
  assert.deepEqual(court.pressed, ['2', 'down']);
  assert.equal(court.pages.length, 1);
  assert.match(court.pages[0]!, /expected the cursor on row 2 \(No\), observed row 1 \(Yes\)/u);
  assert.match(court.pages[0]!, /take over: press the keys by hand/u);
  assert.match(court.stderr.join(''), /Pressed nothing further/u);
  assert.equal(court.ledger[0]!.outcome, 'take-over');
});

test('the cursor check: a press that jumps past the expected row stops before Enter', async () => {
  const court = fakeCourt({ behaviour: { digitSelectsAndSubmits: false, arrowJumpsTo: 3 } });
  const code = await runMcq(['--agent', 'shadow-x', '--answer', '2'], court.deps);
  assert.equal(code, McqExitCode.TakeOver);
  assert.deepEqual(court.pressed, ['2', 'down']);
  assert.match(court.pages[0]!, /expected the cursor on row 2 \(No\), observed row 3/u);
});

test('--dismiss presses Escape once and verifies the prompt is gone', async () => {
  const court = fakeCourt();
  const code = await runMcq(['--agent', 'shadow-x', '--dismiss'], court.deps);
  assert.equal(code, McqExitCode.Done);
  assert.deepEqual(court.pressed, ['esc']);
  assert.equal(court.ledger[0]!.outcome, 'dismissed');
  assert.equal(court.ledger[0]!.chosen, 'dismiss');
});

test('--dismiss that leaves the prompt visible pages the Regent to take over', async () => {
  const court = fakeCourt({ behaviour: { escapeClears: false } });
  const code = await runMcq(['--agent', 'shadow-x', '--dismiss'], court.deps);
  assert.equal(code, McqExitCode.TakeOver);
  assert.deepEqual(court.pressed, ['esc']);
  assert.match(court.pages[0]!, /after pressing Escape the prompt is still visible/u);
});

test('--dry-run prints the prompt and the planned keys without pressing anything', async () => {
  const court = fakeCourt();
  const code = await runMcq(['--agent', 'shadow-x', '--answer', '3', '--dry-run'], court.deps);
  assert.equal(code, McqExitCode.Done);
  assert.deepEqual(court.pressed, []);
  assert.deepEqual(court.ledger, []);
  const printed = court.stdout.join('');
  assert.match(printed, /claude permission prompt: Do you want to proceed\?/u);
  assert.match(printed, /would press: 3, verify the cursor; fallback: down x2 \(cursor checked after each\), then enter/u);
});

test('a pane with no visible prompt is refused without a keypress', async () => {
  const court = fakeCourt({ initialScreen: CLEARED_SCREEN });
  const code = await runMcq(['--agent', 'shadow-x', '--answer', '1'], court.deps);
  assert.equal(code, McqExitCode.NoSuchPrompt);
  assert.deepEqual(court.pressed, []);
  assert.match(court.stderr.join(''), /no interactive prompt is visible/u);
});

test('an option number the prompt does not offer is refused, listing the offered ones', async () => {
  const court = fakeCourt();
  const code = await runMcq(['--agent', 'shadow-x', '--answer', '7'], court.deps);
  assert.equal(code, McqExitCode.NoSuchPrompt);
  assert.deepEqual(court.pressed, []);
  assert.match(court.stderr.join(''), /option 7 is not offered; the prompt offers 1 \(Yes\), 2 \(No\), 3/u);
});

test('an Alpha or Shadow caller is refused before the pane is read', async () => {
  for (const role of ['Alpha', 'Shadow']) {
    const court = fakeCourt({ caller: 'alpha-y', role });
    const code = await runMcq(['--agent', 'shadow-x', '--answer', '1'], court.deps);
    assert.equal(code, McqExitCode.CallerRefused);
    assert.deepEqual(court.pressed, []);
    assert.match(court.stderr.join(''), new RegExp(`"alpha-y" is a ${role}`, 'u'));
  }
});

test('the Regent is admitted regardless of its role line', async () => {
  const court = fakeCourt({ caller: 'Regent', role: 'nothing' });
  const code = await runMcq(['--agent', 'shadow-x', '--answer', '2'], court.deps);
  assert.equal(code, McqExitCode.Done);
});

test('unknown flags and missing actions are usage errors', async () => {
  for (const args of [
    ['--agent', 'shadow-x', '--answer', '1', '--force'],
    ['--agent', 'shadow-x'],
    ['--agent', 'shadow-x', '--answer', '1', '--dismiss'],
    ['--answer', '1'],
    ['--agent', 'shadow-x', '--answer', 'two'],
  ]) {
    const court = fakeCourt();
    assert.equal(await runMcq(args, court.deps), McqExitCode.Usage, args.join(' '));
    assert.match(court.stderr.join(''), /usage: throne mcq --agent <name>/u);
  }
});
