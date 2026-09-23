import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { git, initRepo } from '../../test/git-repo-test-fixture.ts';
import { gatherCandidates, meaningfulWordsAndTokens } from './gather-candidates.ts';

let repoRoot: string;

before(async () => {
  repoRoot = await initRepo('throne-gather-candidates-');

  await mkdir(path.join(repoRoot, 'src', 'session-revoke'), { recursive: true });
  await writeFile(
    path.join(repoRoot, 'src', 'session-revoke', 'revoke-session.ts'),
    "import { lookupSessionOwner } from './session-owner.ts';\n\nexport function revokeSession(sessionId: string): void {\n  lookupSessionOwner(sessionId);\n}\n",
  );
  await writeFile(
    path.join(repoRoot, 'src', 'session-revoke', 'session-owner.ts'),
    'export function lookupSessionOwner(sessionId: string): string {\n  return sessionId;\n}\n',
  );
  await writeFile(
    path.join(repoRoot, 'src', 'session-revoke', 'caller.ts'),
    "import { revokeSession } from './revoke-session.ts';\n\nrevokeSession('abc');\n",
  );

  await mkdir(path.join(repoRoot, 'src', 'billing'), { recursive: true });
  await writeFile(
    path.join(repoRoot, 'src', 'billing', 'invoice.ts'),
    'export function issueInvoice(): void {}\n',
  );

  await mkdir(path.join(repoRoot, 'node_modules', 'left-pad'), {
    recursive: true,
  });
  await writeFile(
    path.join(repoRoot, 'node_modules', 'left-pad', 'index.ts'),
    'export function revokeSession(): void {}\n',
  );

  await writeFile(
    path.join(repoRoot, 'package-lock.json'),
    '{"revokeSession": true}\n',
  );

  await writeFile(
    path.join(repoRoot, 'big-revoke-session.txt'),
    `revokeSession\n${'x'.repeat(210 * 1024)}`,
  );

  await git(repoRoot, ['add', '-A']);
  await git(repoRoot, [
    'commit',
    '--no-gpg-sign',
    '-m',
    'add session revoke files and touch revokeSession',
  ]);
});

after(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

test('meaningfulWordsAndTokens splits camelCase and snake_case identifiers into words', () => {
  const words = meaningfulWordsAndTokens('revokeSession and lookup_session_owner');
  assert.ok(words.has('revoke'));
  assert.ok(words.has('session'));
  assert.ok(words.has('lookup'));
  assert.ok(words.has('owner'));
});

test('word and token match finds files whose content contains a meaningful task word, tagged matches:<word>', async () => {
  const candidates = await gatherCandidates('revoke a session', [repoRoot]);
  const revokeFile = candidates.find(
    (candidate) => candidate.path === 'src/session-revoke/revoke-session.ts',
  );
  assert.ok(revokeFile);
  assert.ok(revokeFile.reasons.includes('matches:revoke') || revokeFile.reasons.includes('matches:session'));
});

test('path match finds files whose path segments contain a meaningful task word, tagged path:<word>', async () => {
  const candidates = await gatherCandidates('revoke a session', [repoRoot]);
  const ownerFile = candidates.find(
    (candidate) => candidate.path === 'src/session-revoke/session-owner.ts',
  );
  assert.ok(ownerFile);
  assert.ok(ownerFile.reasons.some((reason) => reason.startsWith('path:session')));
});

test('history match finds files touched by a commit whose diff added a task token, tagged history:<token>', async () => {
  const candidates = await gatherCandidates('revokeSession cleanup', [repoRoot]);
  const revokeFile = candidates.find(
    (candidate) => candidate.path === 'src/session-revoke/revoke-session.ts',
  );
  assert.ok(revokeFile);
  assert.ok(revokeFile.reasons.some((reason) => reason.startsWith('history:')));
});

test('import-neighbour match connects a file to another file it imports or that imports it, tagged imports:<file>', async () => {
  const candidates = await gatherCandidates('revoke a session', [repoRoot]);
  const callerFile = candidates.find(
    (candidate) => candidate.path === 'src/session-revoke/caller.ts',
  );
  assert.ok(callerFile);
  assert.ok(
    callerFile.reasons.includes('imports:src/session-revoke/revoke-session.ts'),
  );
});

test('excludes gitignored paths, node_modules, dist, lockfiles, and files over 200 KB', async () => {
  const candidates = await gatherCandidates('revoke session', [repoRoot]);
  const paths = candidates.map((candidate) => candidate.path);
  assert.ok(!paths.some((candidatePath) => candidatePath.includes('node_modules')));
  assert.ok(!paths.includes('package-lock.json'));
  assert.ok(!paths.includes('big-revoke-session.txt'));
});

test('caps the final candidate list at 200', async () => {
  const manyFilesRoot = await mkdtemp(
    path.join(tmpdir(), 'throne-gather-candidates-many-'),
  );
  try {
    await git(manyFilesRoot, ['init', '-b', 'main']);
    await git(manyFilesRoot, ['config', 'user.email', 'test@throne.local']);
    await git(manyFilesRoot, ['config', 'user.name', 'Throne Test']);
    await git(manyFilesRoot, ['config', 'commit.gpgsign', 'false']);
    for (let index = 0; index < 250; index += 1) {
      await writeFile(
        path.join(manyFilesRoot, `revoke-session-${index}.ts`),
        'export const revokeSession = true;\n',
      );
    }
    await git(manyFilesRoot, ['add', '-A']);
    await git(manyFilesRoot, ['commit', '--no-gpg-sign', '-m', 'many files']);

    const candidates = await gatherCandidates('revoke session', [manyFilesRoot]);
    assert.ok(candidates.length <= 200);
  } finally {
    await rm(manyFilesRoot, { recursive: true, force: true });
  }
});

test('ties break by ascending path depth, shallower paths first', async () => {
  const tieRoot = await mkdtemp(path.join(tmpdir(), 'throne-gather-candidates-tie-'));
  try {
    await git(tieRoot, ['init', '-b', 'main']);
    await git(tieRoot, ['config', 'user.email', 'test@throne.local']);
    await git(tieRoot, ['config', 'user.name', 'Throne Test']);
    await git(tieRoot, ['config', 'commit.gpgsign', 'false']);
    await mkdir(path.join(tieRoot, 'nested', 'deeper'), { recursive: true });
    await writeFile(
      path.join(tieRoot, 'shallow-revoke.ts'),
      'export const revoke = true;\n',
    );
    await writeFile(
      path.join(tieRoot, 'nested', 'deeper', 'deep-revoke.ts'),
      'export const revoke = true;\n',
    );
    await git(tieRoot, ['add', '-A']);
    await git(tieRoot, ['commit', '--no-gpg-sign', '-m', 'tie fixture']);

    const candidates = await gatherCandidates('revoke', [tieRoot]);
    const shallowIndex = candidates.findIndex(
      (candidate) => candidate.path === 'shallow-revoke.ts',
    );
    const deepIndex = candidates.findIndex(
      (candidate) => candidate.path === 'nested/deeper/deep-revoke.ts',
    );
    assert.ok(shallowIndex !== -1 && deepIndex !== -1);
    assert.ok(shallowIndex < deepIndex);
  } finally {
    await rm(tieRoot, { recursive: true, force: true });
  }
});

test('refuses with a plain, non-stack-trace message when rg is not found on PATH', async () => {
  const emptyPathDir = await mkdtemp(
    path.join(tmpdir(), 'throne-gather-candidates-no-rg-'),
  );
  try {
    await assert.rejects(
      gatherCandidates('revoke session', [repoRoot], {
        env: { PATH: emptyPathDir },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          error.message,
          'ripgrep (`rg`) was not found at /opt/homebrew/bin/rg or on PATH; install ripgrep to use `throne locate`.',
        );
        return true;
      },
    );
  } finally {
    await rm(emptyPathDir, { recursive: true, force: true });
  }
});
