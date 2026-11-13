# Regent queue store
Summary: Keeps the Regent queue of objectives in SQLite and lets the court add, edit, defer, release and archive rows.
Code: src/regent-queue, src/add-to-queue, src/update-queue, src/release-deferred, src/reconcile-queue, src/check-in-flight-rows
Search words: add-to-queue, update-queue, release-deferred, reconcile-queue, check-in-flight-rows, render-queue, migrate-queue-markdown, queue

## What it does

Objectives live as rows in a SQLite store. A Stager files with `add-to-queue`; `update-queue` corrects fields and defers rows (with `--depends-on` and `--defer-reason`); only `release-deferred` reopens one. `reconcile-queue` refreshes delivery evidence; `check-in-flight-rows` lists in-flight rows whose Alpha is gone; `render-queue` prints the store as markdown; `migrate-queue-markdown` moves the old markdown queue in once.

## Sub-features

- QS-ADD: Only a Stager adds rows.
- QS-DEFER: Deferring needs a dependency and a reason.
- QS-RELEASE: A deferred row reopens only through release-deferred.
- QS-INFLIGHT: Orphaned in-flight rows exit 1.
- QS-RENDER: The store renders as markdown.

## How to reach it and prove it works

`throne render-queue` prints the queue and exits 0. Then:

```
bun test ./src/regent-queue/regent-queue-amendments.test.ts
```

## Gotchas

check-in-flight-rows changes nothing; it only reports.
