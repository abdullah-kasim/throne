# Regent queue store
Summary: Keeps the Regent queue of objectives in SQLite and lets the court add, edit, defer, release and archive rows.
Code: src/regent-queue, src/add-to-queue, src/update-queue, src/release-deferred, src/reconcile-queue, src/check-in-flight-rows
Search words: add-to-queue, update-queue, release-deferred, reconcile-queue, check-in-flight-rows, render-queue, migrate-queue-markdown, queue

## What it does

Objectives live as rows in a SQLite store. A Stager files with `add-to-queue`, which refuses an objective code longer than 10 characters before writing anything, so that the longest Shadow name a campaign needs (`shadow-<code>-99a-conform-r2`) fits Herdr's 32, and refuses, also before writing, a row whose target repository has a spec in throne's form when the body names none of that spec's sub-feature IDs and has no `SPECS: none applies — <reason>` line; `update-queue` corrects fields and defers rows (with `--depends-on` and `--defer-reason`); only `release-deferred` reopens one. `reconcile-queue` refreshes delivery evidence; `check-in-flight-rows` lists in-flight rows whose Alpha is gone; `render-queue` prints the store as markdown; `migrate-queue-markdown` moves the old markdown queue in once.

A campaign row goes in-flight under its Alpha's name the moment `create-agent` tasks that Alpha, before its launch returns, and the end of a successful launch tries again without changing a row already in-flight. Only an Alpha ever takes a row: a Shadow launched with the same campaign objective leaves the row as it is, so reaping a Shadow never changes a row's status. A launch that fails after tasking puts the row it holds back to open with no agent name, so it can be launched again.

## Sub-features

- QS-ADD: Only a Stager adds rows.
- QS-CODELEN: Filing refuses an objective code over 10 characters and names the limit.
- QS-SPECCITE: Filing refuses a body that cites no sub-feature ID of its target's spec and gives no reason none applies (`src/add-to-queue/add-to-queue-spec-citation.test.ts`).
- QS-DEFER: Deferring needs a dependency and a reason.
- QS-RELEASE: A deferred row reopens only through release-deferred.
- QS-INFLIGHT: Orphaned in-flight rows exit 1.
- QS-RENDER: The store renders as markdown.
- QS-ALPHA-TIE: A row is tied only to its Alpha, at tasking, and a failed launch gives it back (`test/a-row-release-reports-the-real-row-state.test.ts`).

## How to reach it and prove it works

`throne render-queue` prints the queue and exits 0. Then:

```
bun test ./src/regent-queue/regent-queue-amendments.test.ts ./src/add-to-queue/add-to-queue-code-length.test.ts ./src/add-to-queue/add-to-queue-spec-citation.test.ts
```

## Gotchas

check-in-flight-rows changes nothing; it only reports.

The code length limit applies only at filing: rows already stored with a longer code still read, update and launch. The spec citation check likewise applies only at filing: stored rows, `update-queue` and amendments are never re-checked, and a target spec that cannot be read prints one line and the row is filed.
