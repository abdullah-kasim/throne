import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, constants, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, test } from 'node:test';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const REQUIRED_COREUTILS = ['bash', 'cat', 'dirname', 'grep', 'head', 'id', 'rm', 'tr', 'wc'];
const FORGEJO_IMAGE = 'codeberg.org/forgejo/forgejo:16.0.5-rootless';
const FORGEJO_STATE_FILES: Record<string, string> = {
  'data/data/forgejo.db': 'repositories, pull requests and attachments',
  'config/app.ini': 'APP_NAME = Forgejo\n',
  'admin-password': 'one-time-password\n',
  enabled: '',
};

type Platform = 'Linux' | 'Darwin';

interface Fixture {
  throneRoot: string;
  home: string;
  fakeBin: string;
  forgejoStateDirectory: string;
  serviceManagerLog: string;
  runtimeLog: string;
  runningContainers: string;
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

const scratch: string[] = [];
after(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

async function writeFakeExecutable(filePath: string, lines: string[]): Promise<void> {
  await writeFile(filePath, `#!/usr/bin/env bash\n${lines.join('\n')}\n`, { mode: 0o755 });
}

async function resolveRealTool(name: string): Promise<string> {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(`required coreutil "${name}" not found on this machine's PATH`);
}

async function writeFakeSystemctl(fixture: Fixture, activeUnits: string[]): Promise<void> {
  await writeFakeExecutable(path.join(fixture.fakeBin, 'systemctl'), [
    `printf '%s\\n' "$*" >> "${fixture.serviceManagerLog}"`,
    `if [ "$2" = is-active ]; then case " ${activeUnits.join(' ')} " in *" $4 "*) exit 0 ;; *) exit 3 ;; esac; fi`,
    'if [ "$2" = is-enabled ]; then exit 1; fi',
    'exit 0',
  ]);
}

async function writeFakeLaunchctl(fixture: Fixture, loadedLabels: string[]): Promise<void> {
  await writeFakeExecutable(path.join(fixture.fakeBin, 'launchctl'), [
    `printf '%s\\n' "$*" >> "${fixture.serviceManagerLog}"`,
    `if [ "$1" = print ]; then case " ${loadedLabels.join(' ')} " in *" \${2##*/} "*) exit 0 ;; *) exit 113 ;; esac; fi`,
    'exit 0',
  ]);
}

async function writeFakePodman(fixture: Fixture): Promise<void> {
  await writeFakeExecutable(path.join(fixture.fakeBin, 'podman'), [
    `printf '%s\\n' "$*" >> "${fixture.runtimeLog}"`,
    `if [ "$1" = container ] && [ "$2" = inspect ]; then grep -qx "$3" "${fixture.runningContainers}"; exit $?; fi`,
    `if [ "$1" = rm ]; then grep -vx "$3" "${fixture.runningContainers}" > "${fixture.runningContainers}.next" || true; cat "${fixture.runningContainers}.next" > "${fixture.runningContainers}"; fi`,
    'exit 0',
  ]);
}

async function buildFixture(platform: Platform): Promise<Fixture> {
  const throneRoot = await mkdtemp(path.join(tmpdir(), 'uninstall-forgejo-'));
  scratch.push(throneRoot);
  const home = path.join(throneRoot, 'home');
  const fixture: Fixture = {
    throneRoot,
    home,
    fakeBin: path.join(throneRoot, 'fake-bin'),
    forgejoStateDirectory: path.join(home, '.local', 'state', 'forgejo'),
    serviceManagerLog: path.join(throneRoot, 'service-manager.log'),
    runtimeLog: path.join(throneRoot, 'runtime.log'),
    runningContainers: path.join(throneRoot, 'running-containers.txt'),
  };
  await mkdir(fixture.fakeBin, { recursive: true });
  await mkdir(path.join(throneRoot, 'scripts'), { recursive: true });
  await writeFile(
    path.join(throneRoot, 'scripts', 'require-agent.sh'),
    await readFile(path.join(REPO_ROOT, 'scripts', 'require-agent.sh'), 'utf8'),
  );
  await writeFile(
    path.join(throneRoot, 'uninstall.sh'),
    await readFile(path.join(REPO_ROOT, 'uninstall.sh'), 'utf8'),
    { mode: 0o755 },
  );
  await writeFile(fixture.runningContainers, '');
  await writeFakeExecutable(path.join(fixture.fakeBin, 'uname'), [`echo ${platform}`]);
  await writeFakePodman(fixture);
  for (const name of REQUIRED_COREUTILS) {
    await symlink(await resolveRealTool(name), path.join(fixture.fakeBin, name));
  }
  return fixture;
}

async function installForgejoState(fixture: Fixture): Promise<void> {
  for (const [relativePath, content] of Object.entries(FORGEJO_STATE_FILES)) {
    const filePath = path.join(fixture.forgejoStateDirectory, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }
  await writeFile(fixture.runningContainers, 'throne-ntfy\nthrone-forgejo\n');
}

async function installLinuxUnits(fixture: Fixture, units: string[]): Promise<void> {
  const unitDirectory = path.join(fixture.home, '.config', 'systemd', 'user');
  await mkdir(unitDirectory, { recursive: true });
  for (const unit of units) await writeFile(path.join(unitDirectory, unit), '[Service]\n');
}

async function installLaunchAgents(fixture: Fixture, labels: string[]): Promise<void> {
  const agentDirectory = path.join(fixture.home, 'Library', 'LaunchAgents');
  await mkdir(agentDirectory, { recursive: true });
  for (const label of labels) await writeFile(path.join(agentDirectory, `${label}.plist`), '<plist/>\n');
}

async function runUninstaller(fixture: Fixture): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      await resolveRealTool('bash'),
      [path.join(fixture.throneRoot, 'uninstall.sh'), '--yes'],
      { cwd: fixture.throneRoot, env: { PATH: fixture.fakeBin, I_AM_AN_AGENT: '1', HOME: fixture.home } },
    );
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', code: failure.code ?? 1 };
  }
}

async function snapshotDirectory(root: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const filePath = path.join(entry.parentPath, entry.name);
    snapshot.set(path.relative(root, filePath), await readFile(filePath, 'utf8'));
  }
  return snapshot;
}

function lines(text: string): string[] {
  return text.split('\n');
}

function assertForgejoImageWasNeverRemoved(runtimeLog: string): void {
  assert.equal(lines(runtimeLog).filter((line) => /^(rmi|image rm)\b/.test(line)).length, 0);
}

function assertNoteSaysForgejoDataAndImageWereLeft(stdout: string): void {
  const note = stdout.slice(stdout.indexOf('Left deliberately untouched:'));
  assert.match(note, new RegExp(`the Forgejo image +docker/podman rmi ${FORGEJO_IMAGE.split(':')[0].replaceAll('.', '\\.')}`));
  assert.match(note, /Forgejo's data directory +rm -rf "\$\{XDG_STATE_HOME:-\$HOME\/\.local\/state\}\/forgejo"/);
  assert.match(note, /Forgejo's HTTPS front, if configured +tailscale serve --https=8443 off/);
}

test('uninstalling the throne stops and removes Forgejo\'s service and container but leaves its data and image', async () => {
  const fixture = await buildFixture('Linux');
  await installForgejoState(fixture);
  await installLinuxUnits(fixture, ['ntfy.service', 'forgejo.service']);
  await writeFakeSystemctl(fixture, ['ntfy.service', 'forgejo.service']);
  const stateBefore = await snapshotDirectory(fixture.forgejoStateDirectory);

  const result = await runUninstaller(fixture);

  assert.equal(result.code, 0, result.stderr);
  const systemctlCalls = lines(await readFile(fixture.serviceManagerLog, 'utf8'));
  assert.ok(systemctlCalls.includes('--user stop forgejo.service'));
  assert.ok(systemctlCalls.includes('--user disable forgejo.service'));
  await assert.rejects(stat(path.join(fixture.home, '.config', 'systemd', 'user', 'forgejo.service')));
  const runtimeLog = await readFile(fixture.runtimeLog, 'utf8');
  assert.ok(lines(runtimeLog).includes('rm -f throne-forgejo'));
  assert.equal(await readFile(fixture.runningContainers, 'utf8'), '');
  assert.match(result.stdout, /stopped forgejo\.service/);
  assert.match(result.stdout, /removed the throne-forgejo container \(podman\)/);
  assertForgejoImageWasNeverRemoved(runtimeLog);
  assert.deepEqual(await snapshotDirectory(fixture.forgejoStateDirectory), stateBefore);
  assertNoteSaysForgejoDataAndImageWereLeft(result.stdout);
});

test('uninstalling the throne on macOS boots out and removes com.throne.forgejo and its container but leaves its data and image', async () => {
  const fixture = await buildFixture('Darwin');
  await installForgejoState(fixture);
  await installLaunchAgents(fixture, ['com.throne.ntfy', 'com.throne.forgejo']);
  await writeFakeLaunchctl(fixture, ['com.throne.ntfy', 'com.throne.forgejo']);
  const stateBefore = await snapshotDirectory(fixture.forgejoStateDirectory);

  const result = await runUninstaller(fixture);

  assert.equal(result.code, 0, result.stderr);
  const launchctlCalls = lines(await readFile(fixture.serviceManagerLog, 'utf8'));
  assert.ok(launchctlCalls.some((line) => /^bootout gui\/\d+\/com\.throne\.forgejo$/.test(line)));
  await assert.rejects(stat(path.join(fixture.home, 'Library', 'LaunchAgents', 'com.throne.forgejo.plist')));
  const runtimeLog = await readFile(fixture.runtimeLog, 'utf8');
  assert.ok(lines(runtimeLog).includes('rm -f throne-forgejo'));
  assertForgejoImageWasNeverRemoved(runtimeLog);
  assert.deepEqual(await snapshotDirectory(fixture.forgejoStateDirectory), stateBefore);
  assertNoteSaysForgejoDataAndImageWereLeft(result.stdout);
});

test('uninstalling the throne on a host that never installed Forgejo prints no Forgejo error or removal', async () => {
  const fixture = await buildFixture('Linux');
  await installLinuxUnits(fixture, ['ntfy.service']);
  await writeFakeSystemctl(fixture, ['ntfy.service']);

  const result = await runUninstaller(fixture);

  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /forgejo/i);
  assert.doesNotMatch(result.stdout.slice(0, result.stdout.indexOf('Left deliberately untouched:')), /forgejo/i);
  assert.ok(!lines(await readFile(fixture.runtimeLog, 'utf8')).includes('rm -f throne-forgejo'));
  await assert.rejects(stat(fixture.forgejoStateDirectory));
});

test('uninstalling the throne keeps tea and its forgejo login, drops the tea download cache, and says how to remove them', async () => {
  const fixture = await buildFixture('Linux');
  await installForgejoState(fixture);
  await installLinuxUnits(fixture, ['ntfy.service', 'forgejo.service']);
  await writeFakeSystemctl(fixture, ['ntfy.service', 'forgejo.service']);
  const teaBinary = path.join(fixture.home, '.local', 'bin', 'tea');
  const teaConfig = path.join(fixture.home, '.config', 'tea', 'config.yml');
  const teaCache = path.join(fixture.home, '.cache', 'throne', 'tea');
  for (const [filePath, content] of [
    [teaBinary, '#!/usr/bin/env bash\n'],
    [teaConfig, 'logins:\n  - name: forgejo\n'],
    [path.join(teaCache, '0.16.0', 'tea-0.16.0-linux-amd64'), 'tea'],
  ]) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }

  const result = await runUninstaller(fixture);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(teaBinary, 'utf8'), '#!/usr/bin/env bash\n');
  assert.equal(await readFile(teaConfig, 'utf8'), 'logins:\n  - name: forgejo\n');
  await assert.rejects(stat(teaCache));
  assert.match(result.stdout, /removed tea download cache/);
  const note = result.stdout.slice(result.stdout.indexOf('Left deliberately untouched:'));
  assert.match(note, /tea and its forgejo login +~\/\.local\/bin\/tea logins delete forgejo && rm ~\/\.local\/bin\/tea/);
});
