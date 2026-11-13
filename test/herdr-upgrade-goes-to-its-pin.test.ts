import assert from 'node:assert/strict';
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { git, initRepo, turnOffCommitSigningThatTheEnvironmentTurnedOn } from './git-repo-test-fixture.ts';
import { SERVICE_MANAGER_COMMANDS, fakeHostEnvironment, runBash, runForExitCode, writeServiceManagerFakes } from './restart-plan-fake-host.ts';

turnOffCommitSigningThatTheEnvironmentTurnedOn();

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..');
const PINNED_TAG = 'v0.9.6';
const PINNED_VERSION = '0.9.6';
const OLDER_TAG = 'v0.9.5';
const OLDER_VERSION = '0.9.5';
const THE_LORDS_WORDS = ['--restart-ordered-by-lord', 'restart it'];

const FAKE_HERDR = `#!/bin/sh
echo "herdr-$FAKE_VERSION $*" >> "$STATE/calls"
case "$*" in
  --version) echo "herdr $FAKE_VERSION" ;;
  *"status server --json")
    running=$(cat "$STATE/running-version")
    if [ -z "$running" ]; then echo '{"running":false,"version":null}'; exit 0; fi
    echo "{\\"running\\":true,\\"version\\":\\"$running\\",\\"protocol\\":22}" ;;
  *"agent list")
    if [ "$FAKE_VERSION" != "$(cat "$STATE/running-version")" ]; then
      echo '{"error":{"code":"protocol_mismatch"}}'
      exit 1
    fi
    echo '{"result":{"agents":[{"name":"regent","pane_id":"p1","agent":"claude","terminal_id":"t1","agent_session":{"kind":"id","value":"session-1"}}]}}' ;;
esac
`;

const FAKE_SYSTEMCTL = `#!/bin/sh
echo "systemctl $*" >> "$STATE/calls"
case "$*" in
  *" cat throne-herdr.service") echo "ExecStart=$HOME/.local/share/throne/herdr/$(cat "$STATE/rendered-tag")/herdr --session throne server" ;;
esac
`;

const FAKE_THRONE_CLI = `#!/bin/sh
echo "throne-cli $*" >> "$STATE/calls"
if [ "$1" = install-services ]; then echo "${PINNED_TAG}" > "$STATE/rendered-tag"; fi
`;

const PRETEND_TO_BE_A_MAC_FILE = 'pretend-to-be-a-mac.mjs';
const PRETEND_TO_BE_A_MAC = "Object.defineProperty(process, 'platform', { value: 'darwin' });\n";
const SECONDS_TO_WAIT_FOR_THE_DETACHED_RUN = 8;

const fakeThatOnlyLogs = (name: string): string => `#!/bin/sh
echo "${name} $*" >> "$STATE/calls"
`;

type FakeHost = {
  renderedTag: string;
  runningVersion: string;
  installedVersions: readonly string[];
};

type Court = {
  scratch: string;
  repository: string;
  home: string;
  env: NodeJS.ProcessEnv;
  run: (...args: string[]) => Promise<{ exitCode: number; output: string }>;
  runOnAMac: (...args: string[]) => Promise<{ exitCode: number; output: string }>;
  calls: () => Promise<string[]>;
  renderedTag: () => Promise<string>;
};

async function writeExecutable(file: string, body: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
  await chmod(file, 0o755);
}

function runScript(
  repository: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; output: string }> {
  const script = path.join(repository, 'scripts', 'herdr-upgrade.mjs');
  return runForExitCode(process.execPath, [script, ...args], { cwd: repository, env });
}

async function courtRepository(): Promise<string> {
  const repository = await initRepo('herdr-upgrade-pinned-');
  await mkdir(path.join(repository, 'scripts'));
  await mkdir(path.join(repository, 'src', 'herdr'), { recursive: true });
  await copyFile(path.join(REPOSITORY_ROOT, 'scripts', 'herdr-upgrade.mjs'), path.join(repository, 'scripts', 'herdr-upgrade.mjs'));
  await copyFile(path.join(REPOSITORY_ROOT, 'scripts', 'land-pin-commit.mjs'), path.join(repository, 'scripts', 'land-pin-commit.mjs'));
  await copyFile(path.join(REPOSITORY_ROOT, 'scripts', 'herdr-repair-identities.mjs'), path.join(repository, 'scripts', 'herdr-repair-identities.mjs'));
  await writeFile(
    path.join(repository, 'src', 'herdr', 'herdr-client.ts'),
    `export const OWNED_HERDR_CLIENT_RELEASE_TAG = '${PINNED_TAG}';\n`,
  );
  await writeExecutable(path.join(repository, 'bin', 'herdr'), await readFile(path.join(REPOSITORY_ROOT, 'bin', 'herdr'), 'utf8'));
  await writeExecutable(path.join(repository, 'bin', 'throne-cli'), FAKE_THRONE_CLI);
  await writeExecutable(path.join(repository, 'bin', 'gh'), fakeThatOnlyLogs('gh'));
  await writeFile(path.join(repository, '.gitignore'), 'dist\n');
  await symlink(path.join(REPOSITORY_ROOT, 'dist'), path.join(repository, 'dist'));
  await git(repository, ['add', '.']);
  await git(repository, ['commit', '--no-gpg-sign', '-m', 'Add the upgrader']);
  return repository;
}

async function withCourt(host: FakeHost, proof: (court: Court) => Promise<void>): Promise<void> {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'herdr-upgrade-pinned-host-'));
  const repository = await courtRepository();
  const home = path.join(scratch, 'home');
  const stubs = path.join(scratch, 'bin');
  try {
    await mkdir(stubs);
    await writeServiceManagerFakes(stubs);
    await writeFile(path.join(scratch, 'calls'), '');
    await writeFile(path.join(scratch, 'rendered-tag'), host.renderedTag);
    await writeFile(path.join(scratch, 'running-version'), host.runningVersion);
    for (const version of host.installedVersions) {
      await writeExecutable(
        path.join(home, '.local', 'share', 'throne', 'herdr', `v${version}`, 'herdr'),
        FAKE_HERDR.replace('#!/bin/sh\n', `#!/bin/sh\nFAKE_VERSION=${version}\n`),
      );
    }
    await writeExecutable(path.join(stubs, 'systemctl'), FAKE_SYSTEMCTL);
    await writeExecutable(path.join(stubs, 'systemd-run'), fakeThatOnlyLogs('systemd-run'));
    await writeExecutable(path.join(stubs, 'npm'), fakeThatOnlyLogs('npm'));
    await writeExecutable(path.join(stubs, 'sleep'), '#!/bin/sh\n');
    await writeFile(path.join(scratch, PRETEND_TO_BE_A_MAC_FILE), PRETEND_TO_BE_A_MAC);
    const { PATH, STATE, XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS } = fakeHostEnvironment(scratch);
    const env = {
      PATH,
      STATE,
      XDG_RUNTIME_DIR,
      DBUS_SESSION_BUS_ADDRESS,
      HOME: home,
      THRONE_LIVE_ROOT: path.join(REPOSITORY_ROOT, 'test', 'fixtures', 'empty-live-root'),
      THRONE_DATA_HOME: path.join(scratch, 'data'),
      THRONE_HERDR_CLIENT_PATH: path.join(home, '.local', 'share', 'throne', 'herdr', PINNED_TAG, 'herdr'),
    };
    await proof({
      scratch,
      repository,
      home,
      env,
      run: (...args) => runScript(repository, args, env),
      runOnAMac: (...args) => runScript(repository, args, { ...env, BUN_OPTIONS: `--preload ${path.join(scratch, PRETEND_TO_BE_A_MAC_FILE)}` }),
      calls: async () => (await readFile(path.join(scratch, 'calls'), 'utf8')).split('\n').filter(Boolean),
      renderedTag: async () => (await readFile(path.join(scratch, 'rendered-tag'), 'utf8')).trim(),
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
    await rm(repository, { recursive: true, force: true });
  }
}

function restartScriptPath(court: Court): string {
  return path.join(court.home, 'tmp', `herdr-upgrade-${PINNED_TAG}.sh`);
}

function changesMade(calls: readonly string[]): string[] {
  return calls.filter((call) => /^(systemd-run|npm|gh|throne-cli install-services)|systemctl --user (restart|try-restart)/.test(call));
}

async function assertNothingChanged(court: Court, headBefore: string, renderedTagBefore: string): Promise<void> {
  assert.deepEqual(changesMade(await court.calls()), []);
  assert.equal(await git(court.repository, ['rev-parse', 'HEAD']), headBefore);
  assert.equal(await git(court.repository, ['status', '--porcelain']), '');
  assert.equal(await court.renderedTag(), renderedTagBefore);
  await assert.rejects(access(restartScriptPath(court)));
}

async function waitForTheDetachedRun(court: Court): Promise<string> {
  const log = path.join(court.home, 'tmp', 'herdr-upgrade.log');
  const deadline = Date.now() + SECONDS_TO_WAIT_FOR_THE_DETACHED_RUN * 1000;
  while (Date.now() < deadline) {
    const text = await readFile(log, 'utf8');
    if (/^===== done [^\n]*\n[^\n]+\n/m.test(text)) return text;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`the detached restart never finished:\n${await readFile(log, 'utf8')}`);
}

const AT_THE_PIN = { renderedTag: PINNED_TAG, runningVersion: PINNED_VERSION, installedVersions: [OLDER_VERSION, PINNED_VERSION] };
const BEHIND_THE_PIN = { renderedTag: OLDER_TAG, runningVersion: OLDER_VERSION, installedVersions: [OLDER_VERSION, PINNED_VERSION] };

test('herdr already at its pin restarts nothing and needs no word', async () => {
  await withCourt(AT_THE_PIN, async (court) => {
    const head = await git(court.repository, ['rev-parse', 'HEAD']);
    const { exitCode, output } = await court.run('--pinned');
    assert.equal(exitCode, 0, output);
    assert.match(output, /throne cli herdr 0\.9\.6, bin\/herdr 0\.9\.6, running service 0\.9\.6/);
    assert.match(output, /herdr is at its pin v0\.9\.6, nothing to do/);
    await assertNothingChanged(court, head, PINNED_TAG);
  });
});

test('herdr behind its pin refuses a real run without the restart word and changes nothing', async () => {
  await withCourt(BEHIND_THE_PIN, async (court) => {
    const head = await git(court.repository, ['rev-parse', 'HEAD']);
    const { exitCode, output } = await court.run('--pinned');
    assert.equal(exitCode, 1, output);
    assert.match(output, /REFUSING — a real upgrade restarts herdr and the backend/);
    await assertNothingChanged(court, head, OLDER_TAG);
  });
});

test('herdr behind its pin goes to the pinned tag without release metadata', async () => {
  await withCourt(BEHIND_THE_PIN, async (court) => {
    const head = await git(court.repository, ['rev-parse', 'HEAD']);
    const { exitCode, output } = await court.run('--pinned', ...THE_LORDS_WORDS);
    assert.equal(exitCode, 0, output);
    const calls = await court.calls();
    assert.deepEqual(calls.filter((call) => /^(gh|npm) /.test(call)), []);
    assert.doesNotMatch(output, /phase 2|phase 4|phase 6/);
    assert.ok(calls.includes('throne-cli install-services'));
    assert.ok(calls.some((call) => call.startsWith('systemd-run --user --collect --unit=throne-herdr-upgrade-v0-9-6 ')));
    assert.equal(await git(court.repository, ['rev-parse', 'HEAD']), head);
    const restartScript = await readFile(restartScriptPath(court), 'utf8');
    assert.ok(restartScript.includes(path.join(court.home, '.local', 'share', 'throne', 'herdr', PINNED_TAG, 'herdr')));
    assert.ok(restartScript.includes('systemctl'));
    assert.ok(restartScript.includes('throne-herdr.service'));
  });
});

test('the identity snapshot uses the running server\'s binary after the unit was already rendered for the new tag', async () => {
  await withCourt({ ...BEHIND_THE_PIN, renderedTag: PINNED_TAG }, async (court) => {
    const { exitCode, output } = await court.run('--pinned', ...THE_LORDS_WORDS);
    assert.equal(exitCode, 0, output);
    assert.match(output, /1 named agent\(s\): regent@p1/);
    const calls = await court.calls();
    const snapshot = calls.findIndex((call) => call === `herdr-${OLDER_VERSION} --session throne agent list`);
    assert.notEqual(snapshot, -1, calls.join('\n'));
    assert.ok(snapshot < calls.indexOf('throne-cli install-services'));
    assert.ok(!calls.includes(`herdr-${PINNED_VERSION} --session throne agent list`));
    assert.ok((await readFile(restartScriptPath(court), 'utf8')).includes('session-1'));
  });
});

test('the pinned binary not being installed yet still snapshots through the running server and installs it', async () => {
  await withCourt({ ...BEHIND_THE_PIN, installedVersions: [OLDER_VERSION] }, async (court) => {
    const { exitCode, output } = await court.run('--pinned', ...THE_LORDS_WORDS);
    assert.equal(exitCode, 0, output);
    assert.match(output, /1 named agent\(s\): regent@p1/);
    assert.ok((await court.calls()).includes('throne-cli install-services'));
  });
});

test('a stopped herdr service restarts with no identities to snapshot', async () => {
  await withCourt({ ...AT_THE_PIN, runningVersion: '' }, async (court) => {
    const { exitCode, output } = await court.run('--pinned', ...THE_LORDS_WORDS);
    assert.equal(exitCode, 0, output);
    assert.match(output, /no herdr server is running, so there are no identities to snapshot/);
    const calls = await court.calls();
    assert.ok(!calls.some((call) => call.endsWith('agent list')));
    assert.ok(calls.some((call) => call.startsWith('systemd-run ')));
  });
});

test('a running server whose binary is gone refuses before anything changes', async () => {
  await withCourt({ ...AT_THE_PIN, runningVersion: OLDER_VERSION, installedVersions: [PINNED_VERSION] }, async (court) => {
    const head = await git(court.repository, ['rev-parse', 'HEAD']);
    const { exitCode, output } = await court.run('--pinned', ...THE_LORDS_WORDS);
    assert.equal(exitCode, 1, output);
    assert.match(output, /REFUSING — the running server is 0\.9\.5 and .*v0\.9\.5\/herdr is missing/);
    await assertNothingChanged(court, head, PINNED_TAG);
  });
});

test('a running version nobody can read refuses before anything changes', async () => {
  await withCourt({ ...BEHIND_THE_PIN, installedVersions: [] }, async (court) => {
    const head = await git(court.repository, ['rev-parse', 'HEAD']);
    const { exitCode, output } = await court.run('--pinned', ...THE_LORDS_WORDS);
    assert.equal(exitCode, 1, output);
    assert.match(output, /REFUSING — cannot read the running herdr version/);
    await assertNothingChanged(court, head, OLDER_TAG);
  });
});

test('bin/herdr off the pin with the service at it restarts nothing, even with the word, on every run', async () => {
  await withCourt(AT_THE_PIN, async (court) => {
    await writeExecutable(path.join(court.repository, 'bin', 'herdr'), FAKE_HERDR.replace('#!/bin/sh\n', '#!/bin/sh\nFAKE_VERSION=0.9.7\n'));
    await git(court.repository, ['add', '.']);
    await git(court.repository, ['commit', '--no-gpg-sign', '-m', 'Leave a release above the pin']);
    const head = await git(court.repository, ['rev-parse', 'HEAD']);
    for (let run = 0; run < 2; run += 1) {
      const { exitCode, output } = await court.run('--pinned', ...THE_LORDS_WORDS);
      assert.equal(exitCode, 1, output);
      assert.match(output, /REFUSING — bin\/herdr reports 0\.9\.7, not the pin v0\.9\.6/);
      assert.match(output, /remove any release above v0\.9\.6/);
    }
    await assertNothingChanged(court, head, PINNED_TAG);
  });
});

test('a dry run behind the pin prints the plan and changes nothing', async () => {
  await withCourt(BEHIND_THE_PIN, async (court) => {
    const head = await git(court.repository, ['rev-parse', 'HEAD']);
    const { exitCode, output } = await court.run('--pinned', '--dry-run');
    assert.equal(exitCode, 0, output);
    assert.match(output, /phase 5: snapshotting agent identities/);
    assert.match(output, /phase 7: would run install-services/);
    assert.match(output, /phase 8: systemctl --user restart throne-herdr\.service/);
    assert.match(output, /dry run done; nothing was changed/);
    await assertNothingChanged(court, head, OLDER_TAG);
  });
});

test('--pinned refuses a named tag, because the checkout chooses the target', async () => {
  await withCourt(BEHIND_THE_PIN, async (court) => {
    const head = await git(court.repository, ['rev-parse', 'HEAD']);
    const { exitCode, output } = await court.run('--pinned', 'v0.9.7', ...THE_LORDS_WORDS);
    assert.equal(exitCode, 1, output);
    assert.match(output, /--pinned goes to the tag this checkout pins, so it takes no tag, and v0\.9\.7 was passed/);
    await assertNothingChanged(court, head, OLDER_TAG);
  });
});

test('every service manager command a court run can reach is a fake', async () => {
  await withCourt(BEHIND_THE_PIN, async (court) => {
    const { output } = await runBash(SERVICE_MANAGER_COMMANDS.map((command) => `command -v ${command}`).join('\n'), court.env);
    assert.deepEqual(output.trim().split('\n'), SERVICE_MANAGER_COMMANDS.map((command) => path.join(court.scratch, 'bin', command)));
  });
});

test('a mac run sends its whole restart to the fake launchctl and never to systemd', async () => {
  await withCourt(BEHIND_THE_PIN, async (court) => {
    const herdrBinary = path.join(court.home, '.local', 'share', 'throne', 'herdr', PINNED_TAG, 'herdr');
    const launchAgents = path.join(court.home, 'Library', 'LaunchAgents');
    await mkdir(launchAgents, { recursive: true });
    await writeFile(path.join(launchAgents, 'com.throne.throne-herdr.plist'), `<string>${herdrBinary}</string>\n`);
    const { exitCode, output } = await court.runOnAMac('--pinned', ...THE_LORDS_WORDS);
    assert.equal(exitCode, 0, output);
    assert.match(output, /detached; follow it with/);
    const detachedLog = await waitForTheDetachedRun(court);
    const calls = await court.calls();
    assert.ok(calls.some((call) => call.startsWith('launchctl bootout ')), detachedLog);
    assert.ok(calls.some((call) => call.startsWith('launchctl bootstrap ')), detachedLog);
    assert.deepEqual(calls.filter((call) => /^(systemctl|systemd-run|busctl) /.test(call)), []);
  });
});
