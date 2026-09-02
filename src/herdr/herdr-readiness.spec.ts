// Requirement: the shell-readiness probe does not get recorded into the
// operator's bash history.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { waitForShellReady } from './herdr-readiness.ts';

test('the shell-readiness probe is typed with a leading space so bash ignorespace history control skips it', async () => {
  const sentTexts: string[] = [];
  let observedNonce: string | undefined;

  const fakeRunHerdr = async (args: string[]) => {
    if (args[0] === 'pane' && args[1] === 'send-text') {
      const probe = args[3];
      sentTexts.push(probe);
      observedNonce = probe.trim().split(' ').pop();
      return { stdout: '', stderr: '' };
    }
    if (args[0] === 'pane' && args[1] === 'send-keys') {
      return { stdout: '', stderr: '' };
    }
    if (args[0] === 'pane' && args[1] === 'wait-output') {
      return { stdout: '', stderr: '' };
    }
    if (args[0] === 'pane' && args[1] === 'read') {
      const sentinel = `THRONE_SHELL_READY_${observedNonce}`;
      return { stdout: `${sentinel}\n$ `, stderr: '' };
    }
    throw new Error(`unexpected herdr invocation: ${args.join(' ')}`);
  };

  await waitForShellReady('pane-1', {
    runHerdr: fakeRunHerdr as unknown as typeof import('./herdr-client.ts').runHerdr,
    now: (() => {
      let t = 0;
      return () => (t += 1);
    })(),
  });

  assert.ok(sentTexts.length > 0, 'the probe was sent at least once');
  for (const probe of sentTexts) {
    assert.ok(
      probe.startsWith(' '),
      `probe text "${probe}" must start with a single leading space to suppress history recording`,
    );
  }
});
