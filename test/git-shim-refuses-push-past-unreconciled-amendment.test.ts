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
  readonly bin: string;
  readonly realGitLog: string;
  readonly checkLog: string;
  readonly dataHome: string;
  readonly env: NodeJS.ProcessEnv;
}

async function fixture(options: { withCheckCommand: boolean }): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'git-shim-amendment-'));
  scratch.push(root);
  const bin = path.join(root, 'throne-bin');
  const fakeBin = path.join(root, 'fake-bin');
  const dataHome = path.join(root, 'throne-home');
  await mkdir(bin, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await mkdir(dataHome, { recursive: true });
  await writeFile(path.join(bin, 'git'), await readFile(path.join(REPO_ROOT, 'bin', 'git'), 'utf8'), { mode: 0o755 });
  const realGitLog = path.join(root, 'real-git.log');
  const checkLog = path.join(root, 'check.log');
  await writeFile(
    path.join(fakeBin, 'git'),
    `#!/usr/bin/env bash\nif [ "$1" = rev-parse ] || { [ "$1" = -C ] && [ "$3" = rev-parse ]; }; then printf '%s\\n' "\${FAKE_TOPLEVEL:-/repo}"; exit 0; fi\nprintf '%s\\n' "$@" > "${realGitLog}"\nexit 0\n`,
    { mode: 0o755 },
  );
  if (options.withCheckCommand) {
    await writeFile(
      path.join(bin, 'throne-cli'),
      `#!/usr/bin/env bash\nif [ "$1" = git-identity ]; then exit 3; fi\nprintf 'data-home=%s args=%s\\n' "$THRONE_DATA_HOME" "$*" >> "${checkLog}"\nif [ -n "\${FAKE_CHECK_REPORT:-}" ]; then printf '%s\\n' "$FAKE_CHECK_REPORT" >&2; fi\nexit "\${FAKE_CHECK_EXIT:-0}"\n`,
      { mode: 0o755 },
    );
  }
  return {
    bin,
    realGitLog,
    checkLog,
    dataHome,
    env: { ...process.env, PATH: `${bin}:${fakeBin}:/usr/bin:/bin`, THRONE_DATA_HOME: dataHome },
  };
}

async function alphaWithPassingGates(f: Fixture, name: string): Promise<string> {
  const worktree = path.join(f.dataHome, 'worktrees', 'some-repo', name);
  await mkdir(worktree, { recursive: true });
  const ledger = path.join(f.dataHome, 'data', name);
  const plan = path.join(ledger, 'todo-20260917T050000Z-topic');
  await mkdir(plan, { recursive: true });
  await writeFile(path.join(ledger, 'identity.md'), `# Identity — ${name}\n\n- **Role:** Alpha\n- **Supervisor (routine):** Regent\n`);
  await writeFile(path.join(plan, '00_overview.md'), '# overview\n');
  await writeFile(path.join(plan, '99a_conform_topic.md'), '## Execution log\n\n**Conformance outcome:** PASS\n');
  await writeFile(path.join(plan, '99b_verify_topic.md'), '## Execution log\n\n**Verify outcome:** PASS\n');
  return worktree;
}

function runShim(f: Fixture, args: string[], extraEnv: NodeJS.ProcessEnv) {
  return new Promise<{ code: number; stderr: string }>((resolve) => {
    const child = spawn(path.join(f.bin, 'git'), args, { env: { ...f.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('close', (code) => resolve({ code: code ?? -1, stderr }));
  });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath, 'utf8');
    return true;
  } catch {
    return false;
  }
}

test('an Alpha whose gates passed is still refused when its plan has not reconciled a queue amendment', async () => {
  const f = await fixture({ withCheckCommand: true });
  const worktree = await alphaWithPassingGates(f, 'alpha-amended-01');
  const { code, stderr } = await runShim(f, ['push', 'origin', 'HEAD:add/feature'], {
    FAKE_TOPLEVEL: worktree,
    FAKE_CHECK_EXIT: '66',
    FAKE_CHECK_REPORT: 'NOT reconciled — queue row "amended" carries AMENDMENT 3',
  });
  assert.equal(code, 66);
  assert.match(stderr, /past a queue amendment its plan has not reconciled/);
  assert.match(stderr, /carries AMENDMENT 3/);
  assert.match(stderr, /send-agent Regent/);
  assert.equal(await fileExists(f.realGitLog), false);
  assert.equal(
    (await readFile(f.checkLog, 'utf8')).trim(),
    `data-home=${f.dataHome} args=check-queue-amendments-reconciled --agent alpha-amended-01`,
  );
});

test('an Alpha whose plan reconciled every amendment pushes through unchanged', async () => {
  const f = await fixture({ withCheckCommand: true });
  const worktree = await alphaWithPassingGates(f, 'alpha-amended-02');
  const { code } = await runShim(f, ['push', 'origin', 'HEAD:add/feature'], { FAKE_TOPLEVEL: worktree, FAKE_CHECK_EXIT: '0' });
  assert.equal(code, 0);
  assert.deepEqual((await readFile(f.realGitLog, 'utf8')).trimEnd().split('\n'), ['push', 'origin', 'HEAD:add/feature']);
});

test('a check that fails for any other reason also refuses the push', async () => {
  const f = await fixture({ withCheckCommand: true });
  const worktree = await alphaWithPassingGates(f, 'alpha-amended-03');
  const { code } = await runShim(f, ['push'], { FAKE_TOPLEVEL: worktree, FAKE_CHECK_EXIT: '1' });
  assert.equal(code, 66);
  assert.equal(await fileExists(f.realGitLog), false);
});

test('the amendment check never runs before the gates themselves have passed', async () => {
  const f = await fixture({ withCheckCommand: true });
  const worktree = await alphaWithPassingGates(f, 'alpha-amended-04');
  await writeFile(
    path.join(f.dataHome, 'data', 'alpha-amended-04', 'todo-20260917T050000Z-topic', '99b_verify_topic.md'),
    '**Verify outcome:** FAIL\n',
  );
  const { code, stderr } = await runShim(f, ['push'], { FAKE_TOPLEVEL: worktree, FAKE_CHECK_EXIT: '0' });
  assert.equal(code, 66);
  assert.match(stderr, /99b has not recorded/);
  assert.equal(await fileExists(f.checkLog), false);
});

test('a missing check command is reported loudly and does not block the push', async () => {
  const f = await fixture({ withCheckCommand: false });
  const worktree = await alphaWithPassingGates(f, 'alpha-amended-05');
  const { code, stderr } = await runShim(f, ['push'], { FAKE_TOPLEVEL: worktree });
  assert.equal(code, 0);
  assert.match(stderr, /NOT checked for unreconciled queue amendments/);
});

test('a push that is not from an Alpha never runs the amendment check', async () => {
  const f = await fixture({ withCheckCommand: true });
  const { code } = await runShim(f, ['push', 'origin'], { FAKE_TOPLEVEL: '/somewhere/else', FAKE_CHECK_EXIT: '66' });
  assert.equal(code, 0);
  assert.equal(await fileExists(f.checkLog), false);
});
