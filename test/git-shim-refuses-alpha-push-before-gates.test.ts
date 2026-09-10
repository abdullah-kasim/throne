import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const scratch: string[] = [];
after(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

interface Fixture {
  bin: string;
  argvLog: string;
  dataHome: string;
  env: NodeJS.ProcessEnv;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'git-shim-push-guard-'));
  scratch.push(root);
  const bin = path.join(root, 'throne-bin');
  const fakeBin = path.join(root, 'fake-bin');
  const dataHome = path.join(root, 'throne-home');
  await mkdir(bin, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await mkdir(dataHome, { recursive: true });
  await writeFile(path.join(bin, 'git'), await readFile(path.join(REPO_ROOT, 'bin', 'git'), 'utf8'), { mode: 0o755 });
  const argvLog = path.join(root, 'argv.log');
  await writeFile(
    path.join(fakeBin, 'git'),
    `#!/usr/bin/env bash\nif [ "$1" = rev-parse ] || { [ "$1" = -C ] && [ "$3" = rev-parse ]; }; then printf '%s\\n' "\${FAKE_TOPLEVEL:-/repo}"; exit 0; fi\nprintf '%s\\n' "$@" > "${argvLog}"\nexit 0\n`,
    { mode: 0o755 },
  );
  return {
    bin,
    argvLog,
    dataHome,
    env: { ...process.env, PATH: `${bin}:${fakeBin}:/usr/bin:/bin`, THRONE_DATA_HOME: dataHome },
  };
}

async function alphaWorktree(f: Fixture, name: string, role = 'Alpha'): Promise<string> {
  const worktree = path.join(f.dataHome, 'worktrees', 'some-repo', name);
  await mkdir(worktree, { recursive: true });
  const ledger = path.join(f.dataHome, 'data', name);
  await mkdir(ledger, { recursive: true });
  await writeFile(path.join(ledger, 'identity.md'), `# Identity — ${name}\n\n- **Role:** ${role}\n- **Supervisor (routine):** Regent\n`);
  return worktree;
}

async function bundle(f: Fixture, name: string, outcomes: { conformance?: string; verify?: string }): Promise<void> {
  const dir = path.join(f.dataHome, 'data', name, 'todo-20260910T050000Z-topic');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, '00_overview.md'), '# 00 — overview\n');
  const conformance = ['# 99a — conform', '', '- End with exactly one `**Conformance outcome:** PASS` or `**Conformance outcome:** FAIL`.', ''];
  if (outcomes.conformance !== undefined) conformance.push('## Execution log', '', `**Conformance outcome:** ${outcomes.conformance}`, '');
  await writeFile(path.join(dir, '99a_conform_topic.md'), conformance.join('\n'));
  const verify = ['# 99b — verify', '', '- End with exactly one `**Verify outcome:** PASS` or `**Verify outcome:** FAIL`.', ''];
  if (outcomes.verify !== undefined) verify.push('## Execution log', '', `**Verify outcome:** ${outcomes.verify}`, '');
  await writeFile(path.join(dir, '99b_verify_topic.md'), verify.join('\n'));
}

function runShim(f: Fixture, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number; stderr: string }>((resolve) => {
    const child = spawn(path.join(f.bin, 'git'), args, { env: { ...f.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('close', (code) => resolve({ code: code ?? -1, stderr }));
  });
}

async function realGitRan(f: Fixture): Promise<boolean> {
  try {
    await readFile(f.argvLog, 'utf8');
    return true;
  } catch {
    return false;
  }
}

test('an Alpha with no todo bundle cannot push to a named remote', async () => {
  const f = await fixture();
  const worktree = await alphaWorktree(f, 'alpha-guard-01');
  const { code, stderr } = await runShim(f, ['push', 'origin', 'HEAD:add/feature'], { FAKE_TOPLEVEL: worktree });
  assert.equal(code, 66);
  assert.match(stderr, /STOP RIGHT THERE/);
  assert.match(stderr, /no todo bundle exists/);
  assert.match(stderr, /send-agent Regent/);
  assert.equal(await realGitRan(f), false);
});

test('an Alpha whose 99b has not passed cannot push', async () => {
  const f = await fixture();
  const worktree = await alphaWorktree(f, 'alpha-guard-02');
  await bundle(f, 'alpha-guard-02', { conformance: 'PASS', verify: 'FAIL' });
  const { code, stderr } = await runShim(f, ['push'], { FAKE_TOPLEVEL: worktree });
  assert.equal(code, 66);
  assert.match(stderr, /99b has not recorded/);
  assert.equal(await realGitRan(f), false);
});

test('a template mention of the PASS line does not count as a recorded PASS', async () => {
  const f = await fixture();
  const worktree = await alphaWorktree(f, 'alpha-guard-03');
  await bundle(f, 'alpha-guard-03', {});
  const { code, stderr } = await runShim(f, ['push', 'origin'], { FAKE_TOPLEVEL: worktree });
  assert.equal(code, 66);
  assert.match(stderr, /99a has not recorded/);
});

test('an Alpha whose 99a and 99b both recorded PASS pushes through unchanged', async () => {
  const f = await fixture();
  const worktree = await alphaWorktree(f, 'alpha-guard-04');
  await bundle(f, 'alpha-guard-04', { conformance: 'PASS', verify: 'PASS' });
  const { code } = await runShim(f, ['push', 'origin', 'HEAD:add/feature'], { FAKE_TOPLEVEL: worktree });
  assert.equal(code, 0);
  assert.deepEqual((await readFile(f.argvLog, 'utf8')).trimEnd().split('\n'), ['push', 'origin', 'HEAD:add/feature']);
});

test('the checkpoint push to a local backup path is never guarded', async () => {
  const f = await fixture();
  const worktree = await alphaWorktree(f, 'alpha-guard-05');
  const { code } = await runShim(f, ['push', '--no-verify', '/tmp/backups/alpha.git', 'HEAD:refs/heads/claude-checkpoint', '-f'], { FAKE_TOPLEVEL: worktree });
  assert.equal(code, 0);
  assert.equal(await realGitRan(f), true);
});

test('a Shadow worktree and a checkout outside the throne worktrees are not guarded', async () => {
  const f = await fixture();
  const shadow = await alphaWorktree(f, 'shadow-guard-01', 'Shadow');
  const shadowRun = await runShim(f, ['push', 'origin'], { FAKE_TOPLEVEL: shadow });
  assert.equal(shadowRun.code, 0);
  const g = await fixture();
  await alphaWorktree(g, 'alpha-guard-06');
  const outside = await runShim(g, ['push', 'origin'], { FAKE_TOPLEVEL: '/Users/theuser/repos/alpha-guard-06' });
  assert.equal(outside.code, 0);
});
