import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { fakeBlockedAgentPagingDependencies, type DeclaredState } from './blocked-agent-paging-test-fixtures.ts';
import type { AgentStatus } from '../herdr/herdr-inventory.service.ts';
import { harnessProcessHost } from '../process-inspection/harness-background-work-test-fixtures.ts';

export const WORKTREE = await realpath(await mkdtemp(path.join(tmpdir(), 'own-run-wake-')));
export const SHADOW = 'shadow-bakery-01-build';
export const CHILD = 'shadow-bakery-02-build';
export const MINUTE = 60_000;
export const BLOCKED_AT = Date.parse('Fri Nov 13 06:10:30 2026');

export const HARNESS_LINES = [
  '    1     0     1 Fri Nov 13 06:00:00 2026 /sbin/launchd',
  '52148     1 52148 Fri Nov 13 06:00:00 2026 -zsh',
  '52785 52148 52785 Fri Nov 13 06:00:00 2026 /Users/theuser/throne/vendor/node_modules/.bin/claude --dangerously-skip-permissions --model opus --name shadow-bakery-01',
];
export const SHORT_SLEEP = '60001 52785 60001 Fri Nov 13 06:10:00 2026 sleep 20';
export const LONG_SLEEP = '60002 52785 60002 Fri Nov 13 06:10:00 2026 nohup sleep 600';
export const SECOND_SLEEP = '60003 52785 60003 Fri Nov 13 06:10:00 2026 sleep 30';
export const THIRD_SLEEP = '60004 52785 60004 Fri Nov 13 06:10:00 2026 sleep 40';
export const TEN_SECONDS = 10_000;

export const WAITING_ON_OWN_RUN: DeclaredState = {
  state: 'waiting-on-own-run',
  waitingOn: 'sleeps',
  declaredAt: new Date(BLOCKED_AT).toISOString(),
};

export function waitingShadow(options: { readonly herdrStatus?: AgentStatus; readonly declared?: DeclaredState } = {}) {
  const state = { processLines: [SHORT_SLEEP, LONG_SLEEP] };
  const clock = { now: BLOCKED_AT + MINUTE };
  const fake = fakeBlockedAgentPagingDependencies({
    get now() {
      return clock.now;
    },
    roster: [
      { name: 'regent', lifecycle: 'live', liveStatus: 'working', reportLanded: false, focused: false, paneId: 'w1:p1' },
      { name: SHADOW, lifecycle: 'live', liveStatus: 'blocked', reportLanded: false, role: 'Shadow', focused: false, paneId: 'w1:p3' },
    ],
    supervisorOf: () => 'regent',
    states: { [SHADOW]: options.declared ?? WAITING_ON_OWN_RUN },
    processHostOfPane: () =>
      harnessProcessHost({ processTable: [...HARNESS_LINES, ...state.processLines].join('\n'), harnessDirectory: WORKTREE }),
    herdrStatusOf: () => options.herdrStatus ?? 'idle',
  });
  const wakes = () => fake.pages.filter((page) => page.startsWith('You are waiting on your own background run.'));
  return { ...fake, state, clock, wakes };
}
