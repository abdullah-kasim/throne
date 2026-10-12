import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentStatusesRosterEntry } from '../agent-statuses/agent-statuses.types.ts';
import { IdentityLineReadStatus } from '../agentdata/identity-data.service.ts';
import { AutoreapHostedWorker, type AutoreapDependencies } from './autoreap.hosted-worker.ts';

const CLAIMING_AGENT = 'shadow-claimant-01';
const PUBLISHED_REPO_ROOT = '/published/throne';

function finishedAgentPane(claim: string): string {
  return [
    '› alpha-claimant said: thanks, merged.',
    '',
    `● ${claim}`,
    '',
    '✻ Brewed for 5s',
  ].join('\n');
}

async function reapArgumentsAfterOneTick(claim: string): Promise<readonly (readonly string[])[]> {
  const invocations: (readonly string[])[] = [];
  const finishedAgent: AgentStatusesRosterEntry = {
    name: CLAIMING_AGENT,
    lifecycle: 'live',
    liveStatus: 'done',
    reportLanded: false,
    role: 'shadow',
    focused: false,
  };
  const dependencies: AutoreapDependencies = {
    readEnabled: () => true,
    getRoster: async () => [finishedAgent],
    readLatest: async () => finishedAgentPane(claim),
    readSupervisor: async () => ({ status: IdentityLineReadStatus.Found, value: 'alpha-claimant' }),
    resolvePublishedRuntime: () => ({ repoRoot: PUBLISHED_REPO_ROOT, generation: 'test' }),
    invokeCli: async (_executable, argv) => {
      invocations.push(argv);
      return { outcome: 'success', result: { exitCode: 0, stdout: '', stderr: '' } };
    },
    isCoolingDown: () => false,
    recordCooldown: () => {},
    clearCooldown: () => {},
    recordRefusal: () => {},
    clearRefusal: () => {},
    notifyRegent: async () => {},
    log: () => {},
  };
  await new AutoreapHostedWorker(dependencies).runOnce();
  return invocations;
}

function reapReasons(invocations: readonly (readonly string[])[]): string[] {
  return invocations.map((argv) => {
    assert.equal(argv[1], 'reap-agent');
    assert.equal(argv[2], CLAIMING_AGENT);
    assert.equal(argv[3], '--reason');
    return argv[4]!;
  });
}

test('autoreap reaps an abandoned claim with --reason abandoned', async () => {
  const invocations = await reapArgumentsAfterOneTick('{"reapable":"abandoned"}');

  assert.deepEqual(reapReasons(invocations), ['abandoned']);
});

test('autoreap never runs reap-agent with --reason cancelled, even for an old claim', async () => {
  const invocations = await reapArgumentsAfterOneTick('{"reapable":"cancelled"}');

  assert.deepEqual(reapReasons(invocations), ['abandoned']);
});
