# Worktrees and merges
Summary: Creates campaign worktrees, merges slice branches back into their target and records each delivery in the agent's delivery-evidence.json.
Code: src/spawn-git-tree, src/merge-git-tree, src/absorb-git-tree, src/make-squash-commit, src/record-delivery, src/git-lifecycle
Search words: spawn-git-tree, merge-git-tree, absorb-git-tree, make-squash-commit, record-delivery, worktree, merge, delivery-evidence.json, one commit, dependency hydration, build cache

## What it does

Campaign code lives in worktrees under `~/.throne/worktrees/<repo>/`. `spawn-git-tree` creates one; `merge-git-tree` merges a slice branch into its Alpha branch and writes the Shadow's `delivery-evidence.json`; `absorb-git-tree` brings the target into an Alpha branch, stamps the acting Shadow's branch with a content-empty commit titled "Mark this branch as merged into its target", and writes that Shadow's `delivery-evidence.json`; `make-squash-commit` previews the one-commit squash on a scratch ref.

A campaign lands on its target as one commit: the target is merged into the campaign branch, the branch is soft-reset onto exactly that merged target commit, one commit summarising every change is made, and the target is fast-forwarded to it (pushed, for a yolo repository); a refused fast-forward or push starts again from the merge. `record-delivery <agent-name> --commit <sha>` then writes the agent's `delivery-evidence.json` for that commit, refusing a commit that is not reachable from the agent's recorded target branch. Delivery is proven only by that record: no code reads a commit subject, so a commit titled `Deliver <name>` proves nothing.

A new worktree is hydrated with dependency folders copied from its source tree. When the manifests or lockfiles match, every folder is copied. When they differ, installed dependencies keep their old rule (`node_modules` is installed fresh, anything else such as `.venv`, `vendor` or `Pods` refuses the hydration), while a build cache whose tool checks it itself (rust and maven `target`, gradle `.gradle`, swift `.build`, dart `.dart_tool`) is copied anyway with one stderr line naming it, even from a source tree whose own marker is stale.

## Sub-features

- WT-SPAWN: A slice gets its own worktree and branch.
- WT-MERGE: A merge writes a `delivery-evidence.json` the Shadow can prove.
- WT-ABSORB: Absorb is one atomic step and records the acting Shadow's delivery.
- WT-RECORD: `record-delivery` records only a commit reachable from the agent's target branch, and the record alone proves delivery (`test/delivery-is-proven-from-the-record.test.ts`).
- WT-SQUASH: The squash preview never touches the real branches.
- WT-HYDRATE: A build cache is copied across a manifest mismatch; installed dependencies are not.

## How to reach it and prove it works

Run `throne make-squash-commit <name> "<commit message>"` with a registered tree name; it prints a scratch ref and the branch heads are unchanged afterwards (`git rev-parse` before and after).

```
bun test ./test/delivery-is-proven-from-the-record.test.ts ./test/absorb-git-tree-never-touches-ambient-dirt.test.ts
```

It exits 0.

## Gotchas

Shadows never call merge-git-tree themselves. After the soft reset the campaign branch no longer contains its slices' commits, so every slice is merged and reaped before it.

A folder counts as a build cache only when every ecosystem that names it is a build-cache ecosystem; a path shared with an installed-dependencies ecosystem keeps the refusal. `test/dependency-hydration-build-cache.test.ts` proves the Cargo.lock, Cargo.toml, python-refusal, mixed npm and rust, and stale-marker cases.
