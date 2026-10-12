import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after } from 'node:test';
import { gitOrThrow, run, SYSTEM_PATH, type Outcome } from '../push-check-sandbox.fixture.ts';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const scratch: string[] = [];
after(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

export interface GhGuardSandbox {
  root: string;
  guardBin: string;
  realBin: string;
  argvLog: string;
  dataHome: string;
  path: string;
}

export interface GhGuardSandboxOptions {
  withRealGhe?: boolean;
  realGhePinnedHost?: string;
  ghRoutesToGhe?: boolean;
  realExitCode?: number;
  guardDirectoryLast?: boolean;
  originUrl?: string;
}

export async function createGhGuardSandbox(options: GhGuardSandboxOptions = {}): Promise<GhGuardSandbox> {
  const root = await mkdtemp(path.join(tmpdir(), 'gh-guard-'));
  scratch.push(root);
  const guardBin = path.join(root, 'throne-bin');
  const realBin = path.join(root, 'real-bin');
  const dataHome = path.join(root, 'data-home');
  await mkdir(guardBin, { recursive: true });
  await mkdir(realBin, { recursive: true });
  for (const name of ['gh', 'ghe']) {
    await writeFile(path.join(guardBin, name), await readFile(path.join(REPO_ROOT, 'bin', name), 'utf8'), { mode: 0o755 });
  }
  const argvLog = path.join(root, 'argv.log');
  const recorder = `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argvLog}"\necho real-binary-output\nexit ${options.realExitCode ?? 0}\n`;
  await writeFile(path.join(realBin, 'gh'), options.ghRoutesToGhe ? `#!/usr/bin/env bash\nexec ghe "$@"\n` : recorder, { mode: 0o755 });
  const realGhe = options.realGhePinnedHost
    ? `#!/usr/bin/env bash\nGH_HOST=${options.realGhePinnedHost} exec ${path.join(realBin, 'gh')} "$@"\n`
    : recorder;
  if (options.withRealGhe !== false) await writeFile(path.join(realBin, 'ghe'), realGhe, { mode: 0o755 });
  if (options.originUrl) {
    const gitEnvironment = { PATH: SYSTEM_PATH, HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    await gitOrThrow(root, gitEnvironment, ['init', '--quiet']);
    await gitOrThrow(root, gitEnvironment, ['remote', 'add', 'origin', options.originUrl]);
  }
  const searchPath = options.guardDirectoryLast ? `${realBin}:/usr/bin:/bin:${guardBin}` : `${guardBin}:${realBin}:/usr/bin:/bin`;
  return { root, guardBin, realBin, argvLog, dataHome, path: searchPath };
}

export function runGuard(
  box: GhGuardSandbox,
  command: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
  stdin = '',
): Promise<Outcome> {
  return run(
    path.join(box.guardBin, command),
    args,
    box.root,
    { PATH: box.path, HOME: process.env.HOME, THRONE_DATA_HOME: box.dataHome, ...extraEnv },
    stdin,
  );
}

export async function argvSeenByRealBinary(box: GhGuardSandbox): Promise<string[]> {
  return (await readFile(box.argvLog, 'utf8')).trim().split('\n');
}
