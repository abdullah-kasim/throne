#!/usr/bin/env node
// Installs the main-guard pre-commit hook into a live throne checkout by
// pointing its LOCAL `core.hooksPath` at `scripts/git-hooks` (the directory
// this file lives beside). A bare `.git/hooks/pre-commit` file is not used:
// measured empirically during planning, this environment carries a GLOBAL
// `core.hooksPath` (`git config --global core.hooksPath`) that silently
// overrides any file dropped directly at `.git/hooks/pre-commit` — a hook
// installed that way would never fire. A LOCAL `core.hooksPath` outranks the
// global one and restores firing, in both the checkout itself and every
// worktree linked to its `.git` dir (they share `.git/config` by default —
// no `extensions.worktreeConfig` — so the same hooksPath applies there too;
// harmless, since the hook's own branch check is what gates it, and no
// legitimate agent worktree is ever checked out on `main`).
//
// Idempotent: re-running leaves the same end state. Refuses to clobber a
// local `core.hooksPath` that already points somewhere other than this
// hooks directory, rather than assuming none will ever be set for something
// else.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS_DIR_NAME = path.join('scripts', 'git-hooks');

function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`git ${args.join(' ')} failed: ${stderr.trim() || error.message}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function readLocalHooksPathStatus(cwd) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['config', '--local', '--get', 'core.hooksPath'],
      { cwd, encoding: 'utf8' },
      (error, stdout) => {
        resolve({ code: error?.code ?? 0, value: stdout.trim() });
      },
    );
  });
}

/** Points `repoRoot`'s LOCAL `core.hooksPath` at its `scripts/git-hooks`
 *  directory so the main-guard pre-commit hook there actually fires,
 *  overriding this environment's global `core.hooksPath`. Safe to call
 *  repeatedly. Throws if a local `core.hooksPath` is already set to
 *  something else, rather than silently repointing an unrelated owner's
 *  config. */
export async function installMainGuardHook(repoRoot) {
  const existing = await readLocalHooksPathStatus(repoRoot);
  const alreadyOurs = existing.code === 0 && existing.value === HOOKS_DIR_NAME;
  if (alreadyOurs) return;

  const hasUnrelatedValue = existing.code === 0 && existing.value !== '';
  if (hasUnrelatedValue) {
    throw new Error(
      `refusing to install the main-guard hook: local core.hooksPath is already set to ` +
        `"${existing.value}", not "${HOOKS_DIR_NAME}"; resolve the conflict before installing`,
    );
  }

  await runGit(['config', '--local', 'core.hooksPath', HOOKS_DIR_NAME], repoRoot);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  const repoRoot = process.argv[2] ?? process.cwd();
  installMainGuardHook(repoRoot).then(
    () => {
      process.stdout.write(`main-guard hook installed for ${repoRoot}\n`);
    },
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
