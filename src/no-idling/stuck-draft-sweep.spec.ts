import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { HerdrAgent } from '../herdr/herdr-inventory.service.ts';
import type { ActiveComposerSnapshot } from '../codex-screen/composer/composer.types.ts';
import type { AgentStatusesRosterEntry } from '../agent-statuses/agent-statuses.types.ts';
import { runNoIdling } from './no-idling-run.ts';
import { deps, rosterEntry } from './no-idling-command-test-fixtures.ts';
import { emptyStuckDraftMemory } from './stuck-draft-sweep.ts';
import { STUCK_DRAFT_AGE_MS } from './stuck-draft.ts';
import type { NoIdlingDependencies } from './no-idling-dependencies.types.ts';

const STUCK_TEXT = 'Regent said: please continue [message 1]';

interface Harness {
  readonly pressed: string[];
  readonly regentNotices: string[];
  readonly output: string[];
  setComposer: (name: string, composer: ActiveComposerSnapshot | Error) => void;
  advance: (milliseconds: number) => void;
  pass: (notify?: boolean) => Promise<void>;
}

function harness(
  roster: AgentStatusesRosterEntry[],
  overrides: Partial<NoIdlingDependencies> = {},
): Harness {
  let nowMs = 1_000_000;
  const composers = new Map<string, ActiveComposerSnapshot | Error>();
  const pressed: string[] = [];
  const output: string[] = [];
  const memory = emptyStuckDraftMemory();
  const built = deps({
    getRoster: async () => roster,
    now: () => nowMs,
    stuckDraftMemory: memory,
    readComposer: async (agent: HerdrAgent) => {
      const composer = composers.get(agent.name ?? '') ?? { state: 'empty', text: '' };
      if (composer instanceof Error) throw composer;
      return composer;
    },
    submitStuckDraft: async (agent) => {
      pressed.push(agent.name ?? '');
    },
    stdout: (text) => output.push(text),
    stderr: (text) => output.push(text),
    ...overrides,
  });
  return {
    pressed: overrides.submitStuckDraft === undefined ? pressed : [],
    get regentNotices() {
      return built.submitCalls
        .filter((call) => call.prompt.includes('input box'))
        .map((call) => call.prompt);
    },
    output,
    setComposer: (name, composer) => composers.set(name, composer),
    advance: (milliseconds) => {
      nowMs += milliseconds;
    },
    pass: async (notify = true) => {
      await runNoIdling(built.dependencies, { notify });
    },
  };
}

const alphaRoster = [rosterEntry('alpha-one', 'Alpha', 'working')];

describe('the no-idling sweep presses Enter on a draft stuck for a minute', () => {
  it('presses Enter once, without typing, on the same draft seen on two passes a minute apart', async () => {
    const calls: { agent: string }[] = [];
    const sweep = harness(alphaRoster, {
      submitStuckDraft: async (agent) => {
        calls.push({ agent: agent.name ?? '' });
      },
    });
    sweep.setComposer('alpha-one', { state: 'draft', text: STUCK_TEXT });
    await sweep.pass();
    sweep.advance(STUCK_DRAFT_AGE_MS);
    await sweep.pass();
    assert.deepEqual(calls, [{ agent: 'alpha-one' }]);
    assert.ok(sweep.output.some((line) => line.includes('alpha-one') && line.includes(STUCK_TEXT.slice(0, 80))));
  });

  it('presses the Regent and a Shadow too, but never a Stager', async () => {
    const sweep = harness([
      rosterEntry('shadow-one', 'Shadow', 'working'),
      rosterEntry('stager-one', 'Stager', 'idle'),
    ]);
    for (const name of ['shadow-one', 'stager-one', 'Regent']) {
      sweep.setComposer(name, { state: 'draft', text: STUCK_TEXT });
    }
    await sweep.pass();
    sweep.advance(STUCK_DRAFT_AGE_MS);
    await sweep.pass();
    assert.deepEqual(sweep.pressed.sort(), ['Regent', 'shadow-one']);
  });

  it('the real wiring presses the stuck draft with the forced Enter', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./no-idling.command.ts', import.meta.url), 'utf8'),
    );
    assert.match(source, /submitStuckDraft: \(agent\) => forceEnter\(agent\)/);
  });

  const neverPressed: [string, (sweep: Harness) => void][] = [
    ['a box showing a menu', (sweep) => sweep.setComposer('alpha-one', { state: 'modal' })],
    ['a box that cannot be read', (sweep) => sweep.setComposer('alpha-one', { state: 'unavailable' })],
    ['a box whose read throws', (sweep) => sweep.setComposer('alpha-one', new Error('pane gone'))],
    ['an empty box', (sweep) => sweep.setComposer('alpha-one', { state: 'empty', text: '' })],
  ];
  for (const [label, arrange] of neverPressed) {
    it(`never presses ${label}`, async () => {
      const sweep = harness(alphaRoster);
      arrange(sweep);
      await sweep.pass();
      sweep.advance(STUCK_DRAFT_AGE_MS);
      await sweep.pass();
      assert.deepEqual(sweep.pressed, []);
    });
  }

  it('never presses a draft seen for under a minute', async () => {
    const sweep = harness(alphaRoster);
    sweep.setComposer('alpha-one', { state: 'draft', text: STUCK_TEXT });
    await sweep.pass();
    sweep.advance(STUCK_DRAFT_AGE_MS - 1_000);
    await sweep.pass();
    assert.deepEqual(sweep.pressed, []);
  });

  it('never presses a draft whose text changed since the last pass', async () => {
    const sweep = harness(alphaRoster);
    sweep.setComposer('alpha-one', { state: 'draft', text: STUCK_TEXT });
    await sweep.pass();
    sweep.advance(STUCK_DRAFT_AGE_MS);
    sweep.setComposer('alpha-one', { state: 'draft', text: `${STUCK_TEXT} more` });
    await sweep.pass();
    assert.deepEqual(sweep.pressed, []);
  });

  it('never presses a pane the stranded-spawn recovery handled in the same pass', async () => {
    const sweep = harness(alphaRoster, {
      detectStrandedSpawns: async () => [
        { agentName: 'alpha-one', tabId: 'tab-alpha-one', classification: 'PROMPT_UNSUBMITTED' },
      ] as never,
    });
    sweep.setComposer('alpha-one', { state: 'draft', text: STUCK_TEXT });
    await sweep.pass();
    sweep.advance(STUCK_DRAFT_AGE_MS);
    await sweep.pass();
    assert.deepEqual(sweep.pressed, []);
  });

  it('a report-only pass presses nothing and prints the pane it would press', async () => {
    const sweep = harness(alphaRoster);
    sweep.setComposer('alpha-one', { state: 'draft', text: STUCK_TEXT });
    await sweep.pass(false);
    sweep.advance(STUCK_DRAFT_AGE_MS);
    await sweep.pass(false);
    assert.deepEqual(sweep.pressed, []);
    assert.ok(sweep.output.some((line) => line.includes('would press Enter on alpha-one')));
  });

  it('presses a box that stays stuck again on every later pass', async () => {
    const sweep = harness(alphaRoster);
    sweep.setComposer('alpha-one', { state: 'draft', text: STUCK_TEXT });
    await sweep.pass();
    for (let pass = 0; pass < 3; pass++) {
      sweep.advance(STUCK_DRAFT_AGE_MS);
      await sweep.pass();
    }
    assert.deepEqual(sweep.pressed, ['alpha-one', 'alpha-one', 'alpha-one']);
  });

  it('sends the Regent no notice for a box that stays stuck, even when the press is refused', async () => {
    const sweep = harness(alphaRoster, {
      submitStuckDraft: async () => {
        throw new Error('a dialog covers the box');
      },
    });
    sweep.setComposer('alpha-one', { state: 'draft', text: STUCK_TEXT });
    await sweep.pass();
    for (let pass = 0; pass < 3; pass++) {
      sweep.advance(STUCK_DRAFT_AGE_MS);
      await sweep.pass();
    }
    assert.equal(sweep.regentNotices.length, 0);
    assert.equal(sweep.output.filter((line) => line.includes('stuck draft of alpha-one did not submit')).length, 3);
  });
});
