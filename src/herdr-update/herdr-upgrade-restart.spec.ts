import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  HERDR_UPGRADE_MODES,
  herdrRestartSteps,
  installedTagRefusal,
  lordsWordsFrom,
  renderedHerdrAgentPath,
  renderedHerdrAgentRefusal,
  restartedServerVerdict,
  restartRefusal,
} from './herdr-upgrade-restart.ts';
import {
  SERVICE_MANAGER_COMMANDS,
  fakeHostEnvironment,
  runBash,
  writeExecutables,
  writeServiceManagerFakes,
} from '../../test/restart-plan-fake-host.ts';

const MAC_USER_ID = 501;
const NEW_BINARY = '/home/someone/.local/share/throne/herdr/v0.9.5/herdr';
const OLD_BINARY = '/home/someone/.local/share/throne/herdr/v0.8.2/herdr';
const HERDR_JOB = 'gui/501/com.throne.throne-herdr';
const BACKEND_KICKSTART = 'launchctl kickstart -k gui/501/com.throne.throne-backend';

const FAKE_HERDR = `#!/bin/sh
echo "herdr $*" >> "$STATE/calls"
echo 'warning: a line the terminal server writes to stderr' >&2
echo '{"running":true,"version":"0.9.5","protocol":22}'
`;

const FAKE_VERIFIER = `#!/bin/sh
echo "verify $1" >> "$STATE/calls"
exit "$VERIFIER_EXIT"
`;

type MacRestartRun = { exitCode: number; output: string; calls: string[] };

async function runRestartStepsOnFakeHost(
  host: { platform: string; userId: number; scratch: string },
  hostEnvironment: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; output: string }> {
  await writeServiceManagerFakes(path.join(host.scratch, 'bin'));
  const steps = herdrRestartSteps({
    platform: host.platform,
    userId: host.userId,
    newBinary: path.join(host.scratch, 'herdr'),
    session: 'throne',
    verifyServer: [path.join(host.scratch, 'verify')],
  });
  return runBash(steps.map((step) => step.bash).join('\n'), { ...fakeHostEnvironment(host.scratch), ...hostEnvironment });
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
    await writeExecutables([
      [herdr, FAKE_HERDR],
      [verifier, FAKE_VERIFIER],
    ]);
    const result = await runRestartStepsOnFakeHost({ platform: 'darwin', userId: MAC_USER_ID, scratch }, {
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
    'verify {"running":true,"version":"0.9.5","protocol":22}',
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
  assert.equal(steps[1], 'systemctl --user restart throne-herdr.service');
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

const FAKE_STARTING_HERDR = `#!/bin/sh
echo "herdr $*" >> "$STATE/calls"
polls=$(cat "$STATE/polls-until-running" 2>/dev/null || echo 0)
if [ "$polls" -gt 0 ]; then
  echo $((polls - 1)) > "$STATE/polls-until-running"
  echo '{"status":"not_running","running":false,"version":null,"protocol":null}'
  exit 0
fi
echo '{"status":"running","running":true,"version":"0.9.5","protocol":22}'
`;

const FAKE_PS = `#!/bin/sh
cat "$STATE/signing-agents"
`;

const APP_SLICE = '0::/user.slice/user-1000.slice/user@1000.service/app.slice';
const MOVE_CALL = 'busctl --user call org.freedesktop.systemd1 /org/freedesktop/systemd1 org.freedesktop.systemd1.Manager StartTransientUnit ssa(sv)a(sa(sv)) throne-gpg-agent-4242.scope fail 1 PIDs au 1 4242 0';
const HERDR_RESTART_CALL = 'systemctl --user restart throne-herdr.service';
const BACKEND_RESTART_CALL = 'systemctl --user restart throne-backend.service';
const BOT_BRIDGES_RESTART_CALL = 'systemctl --user try-restart throne-bot-bridge@*.service';

async function runLinuxRestart(host: {
  botUnitActiveExit: number;
  pollsUntilRunning?: number;
  verifierExit?: number;
  tryRestartExit?: number;
  signingAgents?: string;
  moveOutcome?: 'moved' | 'refused' | 'never-lands';
}): Promise<MacRestartRun> {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'herdr-upgrade-linux-restart-'));
  try {
    const fakes = path.join(scratch, 'bin');
    const herdr = path.join(scratch, 'herdr');
    const verifier = path.join(scratch, 'verify');
    await mkdir(fakes);
    await symlink('/usr/bin/true', path.join(fakes, 'sleep'));
    await writeFile(path.join(scratch, 'calls'), '');
    await writeFile(path.join(scratch, 'polls-until-running'), String(host.pollsUntilRunning ?? 0));
    await writeFile(path.join(scratch, 'signing-agents'), host.signingAgents ?? '');
    await writeExecutables([
      [path.join(fakes, 'ps'), FAKE_PS],
      [herdr, FAKE_STARTING_HERDR],
      [verifier, FAKE_VERIFIER],
    ]);
    const result = await runRestartStepsOnFakeHost({ platform: 'linux', userId: 1000, scratch }, {
      BOT_UNIT_ACTIVE_EXIT: String(host.botUnitActiveExit),
      VERIFIER_EXIT: String(host.verifierExit ?? 0),
      TRY_RESTART_EXIT: String(host.tryRestartExit ?? 0),
      MOVE_OUTCOME: host.moveOutcome ?? 'moved',
    });
    const calls = (await readFile(path.join(scratch, 'calls'), 'utf8')).trim().split('\n');
    return { ...result, calls };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const RUNNING_STATUS = '{"status":"running","running":true,"version":"0.9.5","protocol":22}';

test('the restart plan tests cannot reach the real service manager', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'herdr-upgrade-no-manager-'));
  try {
    const fakes = path.join(scratch, 'bin');
    await mkdir(fakes);
    await writeServiceManagerFakes(fakes);
    const environment = fakeHostEnvironment(scratch);
    const lookups = SERVICE_MANAGER_COMMANDS.map((command) => `command -v ${command}`).join('\n');
    const found = await runBash(lookups, environment);
    assert.deepEqual(found.output.trim().split('\n'), SERVICE_MANAGER_COMMANDS.map((command) => path.join(fakes, command)));
    assert.ok(environment.XDG_RUNTIME_DIR?.startsWith(scratch));
    assert.ok(environment.DBUS_SESSION_BUS_ADDRESS?.includes(scratch));
    const realCommand = await runBash('PATH=/usr/bin:/bin systemctl --user show-environment', environment);
    assert.notEqual(realCommand.exitCode, 0, realCommand.output);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('on linux the herdr restart also restarts the bot server', async () => {
  const run = await runLinuxRestart({ botUnitActiveExit: 0 });
  assert.equal(run.exitCode, 0, run.output);
  const serviceCalls = run.calls.filter((call) => call.startsWith('systemctl') && !call.includes('is-active'));
  assert.deepEqual(serviceCalls, [
    'systemctl --user restart throne-herdr.service',
    'systemctl --user try-restart throne-bot-herdr.service',
    BOT_BRIDGES_RESTART_CALL,
    'systemctl --user restart throne-backend.service',
  ]);
  assert.ok(run.calls.includes('herdr --session throne-bot status server --json'));
  assert.equal(run.calls.filter((call) => call === `verify ${RUNNING_STATUS}`).length, 2);
});

test('a herdr move restarts the bot bridges right after the bot server', async () => {
  const run = await runLinuxRestart({ botUnitActiveExit: 0 });
  assert.equal(run.exitCode, 0, run.output);
  const botServerAt = run.calls.indexOf('systemctl --user try-restart throne-bot-herdr.service');
  assert.equal(run.calls[botServerAt + 1], BOT_BRIDGES_RESTART_CALL);
  assert.equal(run.calls.filter((call) => call === BOT_BRIDGES_RESTART_CALL).length, 1);
});

test('a bridge restart that fails writes a failure line and the restart goes on', async () => {
  const run = await runLinuxRestart({ botUnitActiveExit: 3, tryRestartExit: 1 });
  assert.equal(run.exitCode, 0, run.output);
  assert.match(run.output, /^FAILED: systemctl --user try-restart throne-bot-bridge@\*\.service exited non-zero$/m);
  assert.ok(run.calls.includes(BACKEND_RESTART_CALL));
});

test('the bridge restart reaches systemctl as a pattern the shell left alone', () => {
  const steps = herdrRestartSteps({ platform: 'linux', userId: 1000, newBinary: NEW_BINARY, session: 'throne', verifyServer: ['verify'] });
  assert.ok(steps.some((step) => step.bash.startsWith("'systemctl' '--user' 'try-restart' 'throne-bot-bridge@*.service' ||")));
});

test('on linux a host without the bot server running is not a failure', async () => {
  const run = await runLinuxRestart({ botUnitActiveExit: 3 });
  assert.equal(run.exitCode, 0, run.output);
  assert.ok(!run.calls.includes('herdr --session throne-bot status server --json'));
  assert.equal(run.calls.filter((call) => call === `verify ${RUNNING_STATUS}`).length, 1);
  assert.equal(run.calls.at(-1), 'systemctl --user restart throne-backend.service');
});

test('a mac herdr restart never calls systemctl', async () => {
  const run = await runMacRestart({ lingeringPrints: 0, bootstrapRefusals: 0, binaryLaunchdLoads: NEW_BINARY });
  assert.equal(run.exitCode, 0, run.output);
  assert.deepEqual(run.calls.filter((call) => call.startsWith('systemctl')), []);
});

function macRestartSteps(): ReturnType<typeof herdrRestartSteps> {
  return herdrRestartSteps({
    platform: 'darwin',
    userId: MAC_USER_ID,
    newBinary: NEW_BINARY,
    session: 'throne',
    verifyServer: ['verify'],
  });
}

test('a mac herdr restart has no bot server to restart', () => {
  assert.ok(!macRestartSteps().some((step) => step.bash.includes('throne-bot')));
});

test('a herdr upgrade on macOS restarts no bridge', () => {
  assert.ok(!macRestartSteps().some((step) => step.bash.includes('throne-bot-bridge')));
});

test('a restarted server that still reports it is not running is waited for', async () => {
  const run = await runLinuxRestart({ botUnitActiveExit: 3, pollsUntilRunning: 3 });
  assert.equal(run.exitCode, 0, run.output);
  assert.equal(run.calls.filter((call) => call === 'herdr --session throne status server --json').length, 5);
  assert.ok(run.calls.includes(`verify ${RUNNING_STATUS}`));
});

test('a signing agent running inside the terminal server\'s unit is moved out before the restart', async () => {
  for (const unit of ['throne-herdr.service', 'throne-bot-herdr.service']) {
    const run = await runLinuxRestart({ botUnitActiveExit: 3, signingAgents: `4242 ${APP_SLICE}/${unit}\n` });
    assert.equal(run.exitCode, 0, run.output);
    assert.equal(run.calls.filter((call) => call.startsWith('busctl')).length, 1);
    assert.ok(run.calls.indexOf(MOVE_CALL) !== -1, run.calls.join('\n'));
    assert.ok(run.calls.indexOf(MOVE_CALL) < run.calls.indexOf(HERDR_RESTART_CALL));
    assert.match(run.output, /^moved gpg-agent 4242 into throne-gpg-agent-4242\.scope with its cache intact$/m);
    assert.doesNotMatch(run.output, /FAILED:/);
  }
});

test('a signing agent already outside that unit is left alone', async () => {
  for (const signingAgents of ['', `4242 ${APP_SLICE}/throne-gpg-agent-99.scope\n`, `4242 ${APP_SLICE}/not-throne-herdr.service\n`]) {
    const run = await runLinuxRestart({ botUnitActiveExit: 3, signingAgents });
    assert.equal(run.exitCode, 0, run.output);
    assert.ok(!run.calls.some((call) => call.startsWith('busctl')));
    assert.match(run.output, /^no gpg-agent inside throne-herdr\.service or throne-bot-herdr\.service, nothing to move$/m);
    assert.ok(run.calls.includes(HERDR_RESTART_CALL));
  }
});

test('a failed move is reported and the restart still runs', async () => {
  const signingAgents = `4242 ${APP_SLICE}/throne-herdr.service\n`;
  const refused = await runLinuxRestart({ botUnitActiveExit: 3, signingAgents, moveOutcome: 'refused' });
  assert.match(
    refused.output,
    /^FAILED: gpg-agent 4242 could not be moved: Call failed: Access denied, so signing will need the passphrase after the restart$/m,
  );
  const neverLands = await runLinuxRestart({ botUnitActiveExit: 3, signingAgents, moveOutcome: 'never-lands' });
  assert.match(
    neverLands.output,
    /^FAILED: gpg-agent 4242 did not reach throne-gpg-agent-4242\.scope within 10 s, so signing will need the passphrase after the restart$/m,
  );
  for (const run of [refused, neverLands]) {
    assert.equal(run.exitCode, 0, run.output);
    assert.equal(run.output.match(/^FAILED:/gm)?.length, 1);
    assert.doesNotMatch(run.output, /^moved gpg-agent/m);
    assert.ok(run.calls.includes(HERDR_RESTART_CALL));
    assert.equal(run.calls.at(-1), BACKEND_RESTART_CALL);
  }
});

test('a dry run lists the signing agent move ahead of the linux restart and a mac has no such step', () => {
  const stepsOn = (platform: string) =>
    herdrRestartSteps({ platform, userId: 1000, newBinary: NEW_BINARY, session: 'throne', verifyServer: ['verify'] });
  assert.match(stepsOn('linux')[0]?.says ?? '', /^move any gpg-agent out of throne-herdr\.service and throne-bot-herdr\.service/);
  assert.ok(!stepsOn('darwin').some((step) => step.bash.includes('gpg-agent')));
});

test('a dry run of an installed tag is not refused', () => {
  assert.equal(installedTagRefusal(HERDR_UPGRADE_MODES.DRY_RUN, NEW_BINARY, true, false), undefined);
});

test('an apply of an installed tag still needs --yes', () => {
  assert.match(installedTagRefusal(HERDR_UPGRADE_MODES.APPLY, NEW_BINARY, true, false) ?? '', /pass --yes to reuse it/);
  assert.equal(installedTagRefusal(HERDR_UPGRADE_MODES.APPLY, NEW_BINARY, true, true), undefined);
  assert.equal(installedTagRefusal(HERDR_UPGRADE_MODES.APPLY, NEW_BINARY, false, false), undefined);
});
