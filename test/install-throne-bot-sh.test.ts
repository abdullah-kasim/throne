import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, test } from 'node:test';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const REQUIRED_COREUTILS = ['bash', 'basename', 'cat', 'dirname', 'mkdir', 'mktemp', 'rm', 'seq'];

const scratch: string[] = [];
after(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

interface Fixture {
  throneRoot: string;
  fakeBin: string;
  systemctlLog: string;
}

async function writeFakeExecutable(filePath: string, body: string): Promise<void> {
  await writeFile(filePath, `#!/usr/bin/env bash\nset -e\n${body}\n`, { mode: 0o755 });
}

async function resolveRealTool(name: string): Promise<string> {
  const { access, constants } = await import('node:fs/promises');
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

async function linkRealCoreutils(fakeBin: string): Promise<void> {
  for (const name of REQUIRED_COREUTILS) {
    await symlink(await resolveRealTool(name), path.join(fakeBin, name));
  }
}

async function buildFixture(): Promise<Fixture> {
  const throneRoot = await mkdtemp(path.join(tmpdir(), 'install-throne-bot-'));
  scratch.push(throneRoot);
  const fakeBin = path.join(throneRoot, 'fake-bin');
  await mkdir(fakeBin, { recursive: true });
  await mkdir(path.join(throneRoot, 'scripts'), { recursive: true });
  await mkdir(path.join(throneRoot, 'dist', 'src', 'install-services'), { recursive: true });
  await mkdir(path.join(throneRoot, 'bin'), { recursive: true });

  await writeFile(
    path.join(throneRoot, 'scripts', 'require-agent.sh'),
    await readFile(path.join(REPO_ROOT, 'scripts', 'require-agent.sh'), 'utf8'),
  );

  await writeFile(
    path.join(throneRoot, 'vendor-pins.json'),
    JSON.stringify({ tools: { conduwuit: { image: 'ghcr.io/continuwuity/continuwuity:v26.8.1' } } }),
  );

  await writeFile(path.join(throneRoot, 'dist', 'src', 'tools.js'), '');
  await writeFakeExecutable(path.join(throneRoot, 'bin', 'claudey'), 'exit 0');

  await writeFile(
    path.join(throneRoot, 'dist', 'src', 'install-services', 'herdr-release.service.js'),
    `export function ownedHerdrExecutablePath() { return ${JSON.stringify(path.join(throneRoot, 'fake-bin', 'herdr'))}; }\n`,
  );

  const systemctlLog = path.join(throneRoot, 'systemctl.log');

  await writeFakeExecutable(path.join(fakeBin, 'docker'), [
    'if [ "$1" = image ] && [ "$2" = inspect ]; then exit 0; fi',
    'exit 0',
  ].join('\n'));
  await writeFakeExecutable(path.join(fakeBin, 'herdr'), 'exit 0');
  await writeFakeExecutable(path.join(fakeBin, 'tailscale'), 'exit 0');
  await writeFakeExecutable(
    path.join(fakeBin, 'node'),
    `exec ${process.execPath} "$@"`,
  );
  await writeFakeExecutable(
    path.join(fakeBin, 'systemctl'),
    `printf '%s\\n' "$@" >> "${systemctlLog}"\nif [ "$1" = --user ] && [ "$2" = is-active ]; then exit 1; fi\nexit 0`,
  );
  await linkRealCoreutils(fakeBin);

  return { throneRoot, fakeBin, systemctlLog };
}

async function runInstaller(
  fixture: Fixture,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const scriptSource = await readFile(path.join(REPO_ROOT, 'install-throne-bot.sh'), 'utf8');
  const scriptPath = path.join(fixture.throneRoot, 'install-throne-bot.sh');
  await writeFile(scriptPath, scriptSource, { mode: 0o755 });
  const bashBinary = await resolveRealTool('bash');
  try {
    const { stdout, stderr } = await execFileAsync(bashBinary, [scriptPath], {
      cwd: fixture.throneRoot,
      env: {
        PATH: fixture.fakeBin,
        I_AM_AN_AGENT: '1',
        HOME: fixture.throneRoot,
        THRONE_BOT_TAILNET_WAIT_ATTEMPTS: '1',
        THRONE_BOT_CONDUWUIT_READY_ATTEMPTS: '1',
        ...extraEnv,
      },
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.code ?? 1 };
  }
}

test('install-throne-bot.sh exits non-zero with a clear message when no container runtime is on PATH', async () => {
  const fixture = await buildFixture();
  await rm(path.join(fixture.fakeBin, 'docker'));
  const result = await runInstaller(fixture);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /no container runtime found/);
});

test('install-throne-bot.sh exits non-zero with a clear message when tailscale is missing', async () => {
  const fixture = await buildFixture();
  await rm(path.join(fixture.fakeBin, 'tailscale'));
  const result = await runInstaller(fixture);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /tailscale.*is not on PATH/);
});

test('install-throne-bot.sh skips starting an already-active throne-bot-herdr.service', async () => {
  const fixture = await buildFixture();
  await writeFakeExecutable(
    path.join(fixture.fakeBin, 'systemctl'),
    [
      `printf '%s\\n' "$@" >> "${fixture.systemctlLog}"`,
      'if [ "$1" = --user ] && [ "$2" = is-active ] && [ "$3" = --quiet ] && [ "$4" = throne-bot-herdr.service ]; then exit 0; fi',
      'if [ "$1" = --user ] && [ "$2" = is-active ]; then exit 1; fi',
      'exit 0',
    ].join('\n'),
  );
  await writeFakeExecutable(path.join(fixture.fakeBin, 'curl'), 'exit 1');
  const result = await runInstaller(fixture);
  const log = await readFile(fixture.systemctlLog, 'utf8');
  assert.doesNotMatch(log, /start throne-bot-herdr\.service/);
  assert.notEqual(result.code, 0);
});
