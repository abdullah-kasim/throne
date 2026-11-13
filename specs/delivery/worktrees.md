# Worktrees and merges
Summary: Creates campaign worktrees and merges slice branches back into their target.
Code: src/spawn-git-tree, src/merge-git-tree, src/absorb-git-tree, src/make-squash-commit, src/git-lifecycle
Search words: spawn-git-tree, merge-git-tree, absorb-git-tree, make-squash-commit, worktree, merge

## What it does

Campaign code lives in worktrees under `~/.throne/worktrees/<repo>/`. `spawn-git-tree` creates one; `merge-git-tree` merges a slice branch into its Alpha branch (or a campaign into its target) and leaves a `Deliver <name>` commit; `absorb-git-tree` brings the target into an Alpha branch and stamps the acting Shadow; `make-squash-commit` previews the one-commit squash on a scratch ref.

## Sub-features

- WT-SPAWN: A slice gets its own worktree and branch.
- WT-MERGE: A merge leaves a Deliver commit the Shadow can prove.
- WT-ABSORB: Absorb is one atomic step.
- WT-SQUASH: The squash preview never touches the real branches.

## How to reach it and prove it works

Run `throne make-squash-commit <name> "<commit message>"` with a registered tree name; it prints a scratch ref and the branch heads are unchanged afterwards (`git rev-parse` before and after).

## Gotchas

Shadows never call merge-git-tree themselves.
