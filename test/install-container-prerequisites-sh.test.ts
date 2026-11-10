import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, constants, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, test } from 'node:test';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'install-container-prerequisites.sh');
const REQUIRED_COREUTILS = ['bash', 'env', 'dirname', 'cp', 'touch', 'cat'];
const TEST_TIMEOUT = { timeout: 10_000 };

const scratch: string[] = [];
after(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

interface Fixture {
  fakeBin: string;
  available: string;
  state: string;
  callLog: string;
}

interface Host {
  system: 'Linux' | 'Darwin';
  installed?: Array<'podman' | 'docker'>;
  engineUp?: boolean;
  packageManagers?: string[];
  passwordlessSudo?: boolean;
}

interface RunResult {
  stdout: string;
  code: number;
}

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
  throw new Error(`required tool "${name}" not found on this machine's PATH`);
}

function logCall(fixture: Fixture, name: string): string {
  return `printf '%s\\n' "${name} $*" >> "${fixture.callLog}"`;
}

function installFromAvailable(fixture: Fixture): string {
  return `for package in "$@"; do case "$package" in podman) cp "${fixture.available}/podman" "${fixture.fakeBin}/podman" ;; podman-docker|docker) cp "${fixture.available}/docker" "${fixture.fakeBin}/docker" ;; esac; done`;
}

async function buildFixture(host: Host): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'install-container-prerequisites-'));
  scratch.push(root);
  const fixture: Fixture = {
    fakeBin: path.join(root, 'bin'),
    available: path.join(root, 'available'),
    state: path.join(root, 'state'),
    callLog: path.join(root, 'calls.log'),
  };
  await mkdir(fixture.fakeBin);
  await mkdir(fixture.available);
  await mkdir(fixture.state);
  await writeFile(fixture.callLog, '');
  for (const tool of REQUIRED_COREUTILS) await symlink(await resolveRealTool(tool), path.join(fixture.fakeBin, tool));

  await writeFakeExecutable(path.join(fixture.fakeBin, 'uname'), [`echo ${host.system}`]);
  await writeFakeExecutable(path.join(fixture.fakeBin, 'id'), ['echo 1000']);
  await writeFakeExecutable(path.join(fixture.fakeBin, 'sudo'), [
    logCall(fixture, 'sudo'),
    `if [ "$1" = -n ]; then exit ${host.passwordlessSudo ? 0 : 1}; fi`,
    'exec "$@"',
  ]);
  await writeFakeExecutable(path.join(fixture.available, 'podman'), [
    logCall(fixture, 'podman'),
    `if [ "$1" = info ]; then [ -e "${fixture.state}/engine-up" ]; exit $?; fi`,
    `if [ "$1 $2" = "machine list" ]; then cat "${fixture.state}/machine" 2>/dev/null; exit 0; fi`,
    `if [ "$1 $2" = "machine init" ]; then echo podman-machine-default > "${fixture.state}/machine"; exit 0; fi`,
    `if [ "$1 $2" = "machine start" ]; then touch "${fixture.state}/engine-up"; exit 0; fi`,
    'if [ "$1 $2" = "machine inspect" ]; then echo /fake/podman.sock; exit 0; fi',
    'exit 0',
  ]);
  await writeFakeExecutable(path.join(fixture.available, 'docker'), [
    logCall(fixture, 'docker'),
    `if [ "$1" = info ]; then [ -e "${fixture.state}/engine-up" ] && [ -e "${fixture.state}/docker-reaches-engine" ]; exit $?; fi`,
    `if [ "$1 $2" = "context inspect" ]; then [ -e "${fixture.state}/context" ]; exit $?; fi`,
    `if [ "$1 $2" = "context create" ]; then touch "${fixture.state}/context"; exit 0; fi`,
    `if [ "$1 $2" = "context use" ]; then touch "${fixture.state}/docker-reaches-engine"; exit 0; fi`,
    'exit 0',
  ]);
  for (const tool of host.installed ?? []) await copyFile(path.join(fixture.available, tool), path.join(fixture.fakeBin, tool));
  if (host.engineUp) {
    await writeFile(path.join(fixture.state, 'engine-up'), '');
    await writeFile(path.join(fixture.state, 'docker-reaches-engine'), '');
  }

  for (const manager of host.packageManagers ?? []) {
    const lines = [logCall(fixture, manager)];
    if (manager === 'brew') lines.push('if [ "$1" = install ]; then shift; fi', installFromAvailable(fixture));
    if (manager === 'apt-get' || manager === 'dnf') lines.push('if [ "$1" = install ]; then shift 2; ' + installFromAvailable(fixture) + '; fi');
    await writeFakeExecutable(path.join(fixture.fakeBin, manager), [...lines, 'exit 0']);
  }
  if (host.system === 'Linux') {
    await writeFakeExecutable(path.join(fixture.fakeBin, 'systemctl'), [
      logCall(fixture, 'systemctl'),
      `if [ "$2" = is-active ]; then [ -e "${fixture.state}/engine-up" ]; exit $?; fi`,
      `if [ "$2" = enable ]; then touch "${fixture.state}/engine-up" "${fixture.state}/docker-reaches-engine"; fi`,
      'exit 0',
    ]);
  }
  return fixture;
}

async function runScript(fixture: Fixture, argumentsList: string[] = []): Promise<RunResult> {
  const bash = path.join(fixture.fakeBin, 'bash');
  try {
    const { stdout } = await execFileAsync(bash, [SCRIPT, ...argumentsList], {
      env: { PATH: fixture.fakeBin, HOME: fixture.state, I_AM_AN_AGENT: '1' },
    });
    return { stdout, code: 0 };
  } catch (error) {
    const failure = error as { stdout: string; code: number };
    return { stdout: failure.stdout, code: failure.code };
  }
}

async function calls(fixture: Fixture): Promise<string[]> {
  return (await readFile(fixture.callLog, 'utf8')).split('\n').filter(Boolean);
}

function changingCalls(log: string[]): string[] {
  return log.filter((line) => !/^(docker|podman) info|^podman machine list|^docker context inspect|^systemctl --user is-active|^sudo -n/.test(line));
}

test('a machine that already has a working container runtime is left unchanged', TEST_TIMEOUT, async () => {
  const fixture = await buildFixture({ system: 'Linux', installed: ['podman', 'docker'], engineUp: true, packageManagers: ['apt-get'] });
  const result = await runScript(fixture);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^container runtime: ready \(docker\)$/m);
  assert.deepEqual(await calls(fixture), ['docker info']);
});

test('a mac with Homebrew and no runtime gets podman and the docker cli through brew', TEST_TIMEOUT, async () => {
  const fixture = await buildFixture({ system: 'Darwin', packageManagers: ['brew'] });
  const result = await runScript(fixture);
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /container runtime: ready \(docker\)\n$/);
  assert.deepEqual(changingCalls(await calls(fixture)), [
    'brew install podman',
    'brew install docker',
    'podman machine init',
    'podman machine start',
    "podman machine inspect --format {{.ConnectionInfo.PodmanSocket.Path}}",
    'docker context create podman --docker host=unix:///fake/podman.sock',
    'docker context use podman',
  ]);
});

test('a mac without Homebrew is told to install it and nothing is installed', TEST_TIMEOUT, async () => {
  const fixture = await buildFixture({ system: 'Darwin' });
  const result = await runScript(fixture);
  assert.equal(result.code, 2);
  assert.match(result.stdout, /^needs you: Homebrew is not installed/m);
  assert.deepEqual(changingCalls(await calls(fixture)), []);
});

test('a debian-style linux gets podman and docker compatibility through apt', TEST_TIMEOUT, async () => {
  const fixture = await buildFixture({ system: 'Linux', packageManagers: ['apt-get'], passwordlessSudo: true });
  const result = await runScript(fixture);
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /container runtime: ready \(docker\)\n$/);
  assert.deepEqual(changingCalls(await calls(fixture)), [
    'sudo apt-get update',
    'apt-get update',
    'sudo apt-get install -y podman podman-docker',
    'apt-get install -y podman podman-docker',
    'systemctl --user enable --now podman.socket',
  ]);
});

test('a fedora-style linux gets podman and docker compatibility through dnf', TEST_TIMEOUT, async () => {
  const fixture = await buildFixture({ system: 'Linux', packageManagers: ['dnf'], passwordlessSudo: true });
  const result = await runScript(fixture);
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(changingCalls(await calls(fixture)), [
    'sudo dnf install -y podman podman-docker',
    'dnf install -y podman podman-docker',
    'systemctl --user enable --now podman.socket',
  ]);
});

test('an image-based linux host layers no packages and says what is missing', TEST_TIMEOUT, async () => {
  const fixture = await buildFixture({ system: 'Linux', installed: ['podman'], packageManagers: ['rpm-ostree', 'dnf'], passwordlessSudo: true });
  const result = await runScript(fixture);
  assert.equal(result.code, 2);
  assert.match(result.stdout, /^needs you: this image-based host lacks podman or docker \(podman podman-docker\)/m);
  assert.deepEqual(changingCalls(await calls(fixture)), []);
});

test('a step that needs root without passwordless sudo prints the command and fails', TEST_TIMEOUT, async () => {
  const fixture = await buildFixture({ system: 'Linux', packageManagers: ['dnf'], passwordlessSudo: false });
  const result = await runScript(fixture);
  assert.equal(result.code, 2);
  assert.match(result.stdout, /^needs you: run `sudo dnf install -y podman podman-docker` yourself, then re-run this script$/m);
  assert.deepEqual(changingCalls(await calls(fixture)), []);
});

test('a check run reports what is missing and changes nothing', TEST_TIMEOUT, async () => {
  const fixture = await buildFixture({ system: 'Darwin', packageManagers: ['brew'] });
  const result = await runScript(fixture, ['--check']);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, 'missing: podman\nmissing: docker cli\ncontainer runtime: missing\n');
  assert.deepEqual(changingCalls(await calls(fixture)), []);
});

test('a second run after an install changes nothing', TEST_TIMEOUT, async () => {
  const fixture = await buildFixture({ system: 'Darwin', packageManagers: ['brew'] });
  assert.equal((await runScript(fixture)).code, 0);
  await writeFile(fixture.callLog, '');
  const result = await runScript(fixture);
  assert.equal(result.code, 0);
  assert.deepEqual(await calls(fixture), ['docker info']);
});
