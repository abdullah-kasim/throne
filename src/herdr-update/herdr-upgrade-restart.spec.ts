import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  HERDR_UPGRADE_MODES,
  herdrRestartSteps,
  lordsWordsFrom,
  renderedHerdrAgentPath,
  renderedHerdrAgentRefusal,
  restartedServerVerdict,
  restartRefusal,
} from './herdr-upgrade-restart.ts';

const execFileAsync = promisify(execFile);

const MAC_USER_ID = 501;
const NEW_BINARY = '/home/someone/.local/share/throne/herdr/v0.9.5/herdr';
const OLD_BINARY = '/home/someone/.local/share/throne/herdr/v0.8.2/herdr';
const HERDR_JOB = 'gui/501/com.throne.throne-herdr';
const BACKEND_KICKSTART = 'launchctl kickstart -k gui/501/com.throne.throne-backend';

const FAKE_LAUNCHCTL = `#!/bin/sh
echo "launchctl $*" >> "$STATE/calls"
lingering=$(cat "$STATE/lingering" 2>/dev/null || echo 0)
refusals=$(cat "$STATE/refusals" 2>/dev/null || echo 0)
loaded=$(cat "$STATE/loaded" 2>/dev/null)
case "$1" in
  bootout) echo "$LINGERING_PRINTS" > "$STATE/lingering"; : > "$STATE/loaded" ;;
  print)
    if [ "$lingering" -gt 0 ]; then echo $((lingering - 1)) > "$STATE/lingering"; echo "arguments = { exec $OLD_BINARY }"; exit 0; fi
    if [ -n "$loaded" ]; then echo "arguments = { exec $loaded --session throne server }"; exit 0; fi
    echo "Could not find service" >&2; exit 113 ;;
  bootstrap)
    if [ "$lingering" -gt 0 ] || [ -n "$loaded" ]; then echo "bootstrap while still loaded" >> "$STATE/calls"; echo "Try re-running as root" >&2; exit 5; fi
    if [ "$refusals" -gt 0 ]; then echo $((refusals - 1)) > "$STATE/refusals"; echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi
    echo "$BINARY_LAUNCHD_LOADS" > "$STATE/loaded" ;;
esac
exit 0
`;

const FAKE_HERDR = `#!/bin/sh
echo "herdr $*" >> "$STATE/calls"
echo 'warning: a line the terminal server writes to stderr' >&2
echo '{"version":"0.9.5","protocol":22}'
`;

const FAKE_VERIFIER = `#!/bin/sh
echo "verify $1" >> "$STATE/calls"
exit "$VERIFIER_EXIT"
`;

type MacRestartRun = { exitCode: number; output: string; calls: string[] };

async function runBash(script: string, env: NodeJS.ProcessEnv): Promise<{ exitCode: number; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('bash', ['-c', script], { env });
    return { exitCode: 0, output: stdout + stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { exitCode: failed.code, output: failed.stdout + failed.stderr };
  }
}

async function runMacRestart(launchd: {
  lingeringPrints: number;
  bootstrapRefusals: number;
  binaryLaunchdLoads: string;
  verifierExit?: number;
}): Promise<MacRestartRun> {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'herdr-upgrade-restart-'));
  try {
    const fakes = path.join(scratch, 'bin');
    const herdr = path.join(scratch, 'herdr');
    const verifier = path.join(scratch, 'verify');
    await mkdir(fakes);
    await symlink('/usr/bin/true', path.join(fakes, 'sleep'));
    await writeFile(path.join(scratch, 'refusals'), String(launchd.bootstrapRefusals));
    await writeFile(path.join(scratch, 'loaded'), OLD_BINARY);
    await writeFile(path.join(scratch, 'calls'), '');
    for (const [file, body] of [
      [path.join(fakes, 'launchctl'), FAKE_LAUNCHCTL],
      [herdr, FAKE_HERDR],
      [verifier, FAKE_VERIFIER],
    ] as const) {
      await writeFile(file, body);
      await chmod(file, 0o755);
    }
    const steps = herdrRestartSteps({
      platform: 'darwin',
      userId: MAC_USER_ID,
      newBinary: herdr,
      session: 'throne',
      verifyServer: [verifier],
    });
    const result = await runBash(steps.map((step) => step.bash).join('\n'), {
      ...process.env,
      LC_ALL: 'C',
      PATH: `${fakes}:${process.env.PATH}`,
      STATE: scratch,
      LINGERING_PRINTS: String(launchd.lingeringPrints),
      BINARY_LAUNCHD_LOADS: launchd.binaryLaunchdLoads === NEW_BINARY ? herdr : launchd.binaryLaunchdLoads,
      OLD_BINARY,
      VERIFIER_EXIT: String(launchd.verifierExit ?? 0),
    });
    const calls = (await readFile(path.join(scratch, 'calls'), 'utf8'))
      .trim()
      .split('\n')
      .map((call) => call.replaceAll(herdr, 'NEW_HERDR'));
    return { ...result, calls };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

test('on a mac the herdr restart reloads the herdr agent from its rewritten file', async () => {
  const run = await runMacRestart({ lingeringPrints: 2, bootstrapRefusals: 1, binaryLaunchdLoads: NEW_BINARY });
  assert.equal(run.exitCode, 0, run.output);
  const herdrAgentCalls = run.calls.slice(0, run.calls.findIndex((call) => call.startsWith('herdr ')));
  assert.deepEqual(herdrAgentCalls, [
    `launchctl bootout ${HERDR_JOB}`,
    `launchctl print ${HERDR_JOB}`,
    `launchctl print ${HERDR_JOB}`,
    `launchctl print ${HERDR_JOB}`,
    `launchctl bootstrap gui/501 ${renderedHerdrAgentPath()}`,
    `launchctl bootstrap gui/501 ${renderedHerdrAgentPath()}`,
    `launchctl print ${HERDR_JOB}`,
  ]);
});

test('on a mac the herdr restart never bootstraps before launchd confirms the bootout', async () => {
  const slowBootout = await runMacRestart({ lingeringPrints: 4, bootstrapRefusals: 0, binaryLaunchdLoads: NEW_BINARY });
  assert.equal(slowBootout.exitCode, 0, slowBootout.output);
  assert.ok(!slowBootout.calls.includes('bootstrap while still loaded'));
});

test('on a mac a herdr agent that launchd never confirms gone is reported as failed and never bootstrapped', async () => {
  const neverGone = await runMacRestart({ lingeringPrints: 1000, bootstrapRefusals: 0, binaryLaunchdLoads: NEW_BINARY });
  assert.notEqual(neverGone.exitCode, 0);
  assert.ok(!neverGone.calls.some((call) => call.includes('bootstrap')));
  assert.match(neverGone.output, /^FAILED: launchctl print gui\/501\/com\.throne\.throne-herdr still finds the job/m);
  assert.match(neverGone.output, /may be unloaded, load it with: launchctl bootstrap gui\/501 /);
});

test('on a mac a herdr agent that launchd keeps refusing to load is reported as failed with how to load it', async () => {
  const run = await runMacRestart({ lingeringPrints: 0, bootstrapRefusals: 1000, binaryLaunchdLoads: NEW_BINARY });
  assert.notEqual(run.exitCode, 0);
  assert.match(run.output, /^FAILED: launchctl bootstrap gui\/501 .* refused 10 times: Bootstrap failed: 5/m);
  assert.match(run.output, /may be unloaded, load it with: launchctl bootstrap gui\/501 /);
  assert.ok(!run.calls.includes(BACKEND_KICKSTART));
});

test('on a mac a reload that leaves launchd running the old binary is reported as failed', async () => {
  const run = await runMacRestart({ lingeringPrints: 0, bootstrapRefusals: 0, binaryLaunchdLoads: OLD_BINARY });
  assert.notEqual(run.exitCode, 0);
  assert.match(run.output, /^FAILED: launchctl print gui\/501\/com\.throne\.throne-herdr does not name/m);
  assert.ok(!run.calls.includes(BACKEND_KICKSTART));
});

test('on a mac the backend restart is a kickstart, after the herdr server answers', async () => {
  const run = await runMacRestart({ lingeringPrints: 0, bootstrapRefusals: 0, binaryLaunchdLoads: NEW_BINARY });
  assert.equal(run.exitCode, 0, run.output);
  assert.deepEqual(run.calls.slice(-3), [
    'herdr --session throne status server --json',
    'verify {"version":"0.9.5","protocol":22}',
    BACKEND_KICKSTART,
  ]);

  const wrongServer = await runMacRestart({
    lingeringPrints: 0,
    bootstrapRefusals: 0,
    binaryLaunchdLoads: NEW_BINARY,
    verifierExit: 1,
  });
  assert.notEqual(wrongServer.exitCode, 0);
  assert.ok(!wrongServer.calls.includes(BACKEND_KICKSTART));
});

test('an upgrade whose restarted server is not the target release is reported as failed', () => {
  assert.match(
    restartedServerVerdict('{"version":"0.8.2","protocol":20}', 'v0.9.5'),
    /^FAILED: the restarted server runs 0\.8\.2, not v0\.9\.5/,
  );
  assert.match(restartedServerVerdict('error: connection refused', 'v0.9.5'), /^FAILED: the restarted server is unreachable/);
  assert.equal(
    restartedServerVerdict('{"version":"0.9.5","protocol":22}', 'v0.9.5'),
    'restarted server runs 0.9.5 protocol 22',
  );
});

test('on linux the herdr restart still restarts both systemd units', () => {
  const steps = herdrRestartSteps({
    platform: 'linux',
    userId: 1000,
    newBinary: NEW_BINARY,
    session: 'throne',
    verifyServer: ['verify'],
  }).map((step) => step.says);
  assert.equal(steps[0], 'systemctl --user restart throne-herdr.service');
  assert.equal(steps.at(-1), 'systemctl --user restart throne-backend.service');
  assert.ok(!steps.some((step) => step.includes('launchctl')));
});

test("an upgrade that is not a dry run refuses without the Lord's word before changing anything", () => {
  assert.match(restartRefusal(HERDR_UPGRADE_MODES.APPLY, undefined) ?? '', /--restart-ordered-by-lord/);
  assert.match(restartRefusal(HERDR_UPGRADE_MODES.APPLY, '   ') ?? '', /--restart-ordered-by-lord/);
});

test("an upgrade carrying the Lord's word is allowed to restart herdr", () => {
  assert.equal(restartRefusal(HERDR_UPGRADE_MODES.APPLY, 'upgrade herdr to v0.9.5 now'), undefined);
});

test("an upgrade whose word flag is followed by another option carries no word from the Lord and refuses", () => {
  for (const argv of [
    ['v0.9.5', '--restart-ordered-by-lord', '--yes'],
    ['--restart-ordered-by-lord', 'v0.9.5', '--yes'],
    ['v0.9.5', '--yes', '--restart-ordered-by-lord'],
  ]) {
    assert.match(restartRefusal(HERDR_UPGRADE_MODES.APPLY, lordsWordsFrom(argv)) ?? '', /--restart-ordered-by-lord/);
  }
  assert.equal(
    lordsWordsFrom(['v0.9.5', '--yes', '--restart-ordered-by-lord', 'upgrade herdr to v0.9.5 now']),
    'upgrade herdr to v0.9.5 now',
  );
});

test('a dry run needs no word from the Lord', () => {
  assert.equal(restartRefusal(HERDR_UPGRADE_MODES.DRY_RUN, undefined), undefined);
  assert.equal(restartRefusal(HERDR_UPGRADE_MODES.CHECK, undefined), undefined);
});

test('on a mac phase 7 refuses when the rendered herdr agent file does not name the new binary', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'herdr-upgrade-agent-'));
  try {
    const agentPath = path.join(scratch, 'com.throne.throne-herdr.plist');
    await writeFile(agentPath, `<string>exec ${OLD_BINARY} --session throne server</string>`);
    assert.match((await renderedHerdrAgentRefusal(agentPath, NEW_BINARY)) ?? '', /does not name/);
    await writeFile(agentPath, `<string>exec ${NEW_BINARY} --session throne server</string>`);
    assert.equal(await renderedHerdrAgentRefusal(agentPath, NEW_BINARY), undefined);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('on a mac phase 7 refuses when the rendered herdr agent file cannot be read', async () => {
  const missingAgent = path.join(os.tmpdir(), 'herdr-upgrade-agent-missing', 'com.throne.throne-herdr.plist');
  assert.match((await renderedHerdrAgentRefusal(missingAgent, NEW_BINARY)) ?? '', /cannot read/);
});
