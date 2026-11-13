# Where I stand
Summary: Agents write the Lord's where-i-stand page as tabs, sections and rows in the where-i-stand database through commands; check-where-i-stand and work-log read it.
Code: src/where-i-stand, src/where-i-stand-store, src/work-log
Search words: where-i-stand, check-where-i-stand, work-log, listing token, archive, purge

## What it does

The page lives in `where-i-stand.sqlite3` in the throne data home (see the throne database spec), owned by the `WhereIStandStore` inside throne-backend and served at `/api/where-i-stand/store/...`. `throne where-i-stand` reaches that route; `--local` opens the file in the command's own process instead.

- `list` prints every tab and section with its id (`t1`, `s3`), archived ones marked, and a listing token computed from the structure.
- `show` prints the page as Markdown, every row with its written and changed times. It is for reading; there is no file to edit and no `save` or `lock`.
- `put` adds or replaces a work entry, found by `--code`; it names a section by `--section-id` with the current `--listing-token`. Text starting with a dash needs `--text=<text>`.
- `note` adds one line to Just happened.
- `archive` and `restore` take a row id (`r12`) or section id; `archive --code` archives a work entry. Nothing is deleted by an agent.
- `add-tab` and `add-section` (optionally under a parent section) create structure; a name matching a sibling's, ignoring case and surrounding spaces, is refused, or revives that sibling when it is archived.
- `purge` deletes rows and sections archived over six months; `--dry-run` lists them.

Every write is one transaction and writes a journal row naming its writer, the action, the item and the before and after values. The writer name `Lord` is reserved for edits made from the page. Each write also keeps house: Just happened keeps its 15 newest live lines and archives the rest, the Delivered tab archives rows past the newest 20 that are older than three days, and archived rows past six months are purged. A replace or restore always moves a row's changed time forward, by a millisecond when the clock has not, so a save made against an older read is refused as stale. Over the route, a refused write answers 200 with its outcome `refused`, never an error status.

`check-where-i-stand` reads the rows directly, without the backend, and exits 66 when a delivered campaign has no outcome entry, printing the `put` to run. `where-i-stand-import` copies today's Markdown page, its archive file and optionally its journal into an empty database once, reading the files without changing them and keeping each row's age; `--compare --page <file>` exits 1 and prints each difference when the database does not show the same entries in the same sections and order. `work-log` lists rows finished since a date.

## Sub-features

- WS-LISTING: An add with a listing token from before the structure last changed is refused with the current listing, and nothing is written.
- WS-PUT-BY-NAME: `put --section '<name>'` is refused for every section, naming `list`.
- WS-ARCHIVE: Archive hides a row or section and restore brings it back; only purge deletes, after six months.
- WS-HOUSEKEEPING: Just happened keeps 15 live lines and the Delivered tab keeps 20 rows or three days; the overflow is archived, not deleted.
- WS-STALE: A save naming a changed time older than the row's is refused, even when both writes fall in the same millisecond.
- WS-JOURNAL: Every write journals writer, action, item, before and after; agents may not write as `Lord`.
- WS-LOCAL: `--local` gives the same results as the backend route, for when throne-backend is down.
- WS-SAME-NAME: A tab or section whose name matches a sibling's is refused or revives the archived sibling.
- WS-CHECK: A missing outcome exits 66 with the put to run.
- WS-IMPORT: The import runs once into an empty database, leaves the files untouched, keeps row ages, and `--compare` exits 0 only when the database matches the page.
- WS-LOG: work-log lists rows since a date, with `--json`.

## How to reach it and prove it works

Against a scratch data home, never the Lord's (`THRONE_DATA_HOME=<scratch> throne where-i-stand list --local`, then `put`, `show`).

```
bun test ./src/where-i-stand-store/where-i-stand.store.spec.ts ./src/where-i-stand-store/where-i-stand-transport.spec.ts ./src/where-i-stand/where-i-stand.spec.ts ./src/where-i-stand/where-i-stand-over-rest.spec.ts ./src/where-i-stand/check-where-i-stand.spec.ts ./src/where-i-stand-import/where-i-stand-import.spec.ts
```

Exits 0.

## Gotchas

The scratch data home is set with `THRONE_DATA_HOME`, not `THRONE_HOME`. `show` prints its checksum line on stderr. A subsection created under an archived section is archived with it and purged only on its own clock. `spec-lock` has its own folder lock; it no longer shares one with this page.
