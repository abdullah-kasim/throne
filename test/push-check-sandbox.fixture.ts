import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const DISPATCHER_DIRECTORY = path.join(REPO_ROOT, 'git-hooks');
export const SYSTEM_PATH = '/usr/bin:/bin';
export const REFUSED_SKIP_EXIT_CODE = 68;

const sandboxRoots: string[] = [];

export async function removeSandboxes(): Promise<void> {
  for (const directory of sandboxRoots) await rm(directory, { recursive: true, force: true });
}

export interface Sandbox {
  root: string;
  work: string;
  remote: string;
  remoteUrl: string;
  checkLog: string;
  guardDirectory: string;
  environment: NodeJS.ProcessEnv;
}

export interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

export function run(
  command: string,
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  stdin?: string,
): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: environment,
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code: code ?? (signal ? -1 : 0), stdout, stderr }));
    child.stdin?.end(stdin);
  });
}

export async function writeExecutable(file: string, body: string): Promise<void> {
  await writeFile(file, body, { mode: 0o755 });
}

export async function writeGuardCopy(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeExecutable(path.join(directory, 'git'), await readFile(path.join(REPO_ROOT, 'bin', 'git'), 'utf8'));
}

export async function sandbox(): Promise<Sandbox> {
  const root = await mkdtemp(path.join(tmpdir(), 'push-checks-'));
  sandboxRoots.push(root);
  const guardDirectory = path.join(root, 'guard-bin');
  await writeGuardCopy(guardDirectory);
  const fakeSsh = path.join(root, 'fake-ssh');
  await writeExecutable(fakeSsh, '#!/bin/sh\nwhile [ $# -gt 1 ]; do shift; done\nexec sh -c "$1"\n');
  const globalConfig = path.join(root, 'gitconfig');
  await writeFile(
    globalConfig,
    `[core]\n\thooksPath = ${DISPATCHER_DIRECTORY}\n[user]\n\tname = Push Test\n\temail = push-test@example.com\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n`,
  );
  const environment: NodeJS.ProcessEnv = {
    PATH: SYSTEM_PATH,
    HOME: root,
    TMPDIR: tmpdir(),
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_SSH_COMMAND: fakeSsh,
    GIT_SSH_VARIANT: 'simple',
  };
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  await mkdir(work);
  await gitOrThrow(root, environment, ['init', '--quiet', '--bare', remote]);
  await gitOrThrow(work, environment, ['init', '--quiet']);
  await writeFile(path.join(work, 'file.txt'), 'one\n');
  await gitOrThrow(work, environment, ['add', 'file.txt']);
  await gitOrThrow(work, environment, ['commit', '--quiet', '-m', 'one']);
  const remoteUrl = `push-test-host:${remote}`;
  await gitOrThrow(work, environment, ['remote', 'add', 'origin', remoteUrl]);
  return { root, work, remote, remoteUrl, checkLog: path.join(root, 'checks.log'), guardDirectory, environment };
}

export async function addMirrorRemote(box: Sandbox, name: string): Promise<string> {
  const mirror = path.join(box.root, `${name}.git`);
  await gitOrThrow(box.root, box.environment, ['init', '--quiet', '--bare', mirror]);
  await gitOrThrow(box.work, box.environment, ['remote', 'add', name, `push-test-host:${mirror}`]);
  return mirror;
}

export async function gitOrThrow(cwd: string, environment: NodeJS.ProcessEnv, args: string[]): Promise<string> {
  const outcome = await run('git', args, cwd, environment);
  if (outcome.code !== 0) throw new Error(`git ${args.join(' ')} failed (${outcome.code}): ${outcome.stderr}`);
  return outcome.stdout.trim();
}

export function plainGit(box: Sandbox, args: string[], cwd = box.work, extra: NodeJS.ProcessEnv = {}): Promise<Outcome> {
  return run('git', args, cwd, { ...box.environment, ...extra });
}

export function guardedGit(box: Sandbox, args: string[], cwd = box.work, extra: NodeJS.ProcessEnv = {}): Promise<Outcome> {
  return run(path.join(box.guardDirectory, 'git'), args, cwd, {
    ...box.environment,
    PATH: `${box.guardDirectory}:${SYSTEM_PATH}`,
    ...extra,
  });
}

export async function addCheck(box: Sandbox, name: string, exitCode: number, scope: string[] = []): Promise<void> {
  const script = path.join(box.root, `check-${name}`);
  await writeExecutable(
    script,
    `#!/bin/sh\nprintf '%s %s %s\\n' ${name} "$1" "$2" >> "${box.checkLog}"\nsed 's/^/${name} ref /' >> "${box.checkLog}"\necho "check ${name} output"\nexit ${exitCode}\n`,
  );
  await gitOrThrow(box.work, box.environment, ['config', ...scope, '--add', 'push-check.command', `env CHECK_NAME=${name} ${script}`]);
}

export async function checkLogLines(box: Sandbox): Promise<string[]> {
  try {
    return (await readFile(box.checkLog, 'utf8')).trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

export async function remoteHas(box: Sandbox, ref: string): Promise<boolean> {
  const outcome = await run('git', ['--git-dir', box.remote, 'rev-parse', '--verify', '--quiet', ref], box.root, box.environment);
  return outcome.code === 0;
}
