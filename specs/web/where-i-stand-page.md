# Where-i-stand page
Summary: The web app's where-i-stand route shows the database's tabs, sections and rows below the Lord's pull request table, lets him edit his epics, and archive or restore any row or section.
Code: web/src/features/where-i-stand, src/where-i-stand/where-i-stand.controller.ts, src/where-i-stand-store/where-i-stand-store.controller.ts, scripts/where-i-stand-evidence, test/e2e/where-i-stand
Search words: where-i-stand page, epics, archived spoiler, row age, where-i-stand-evidence, test:e2e

## What it does

The page reads `/api/where-i-stand/store/page` for tabs, sections and rows, and `/api/where-i-stand/records` for the pull request table; it calls no other where-i-stand route. Each tab is a tab of the page, followed by a read-only Archive tab (at `#archive`, the old archive address) that lists archived rows by section and archived sections, each with Restore, or says nothing has been archived yet; an address naming no tab is replaced by the selected tab's. Restoring there keeps keyboard focus on the page; on the Pull requests tab the work table lists Needs you, then In flight, and labels subsection work with its top section. Every row shows its age, with the exact written and changed times on hover or tap. Archived rows and sections wait in a counted ▶ spoiler at the foot of their section, read from `sections/:id/archived-rows` when opened. The Lord adds, edits and removes epics on the Epics tab, and every other tab is read-only apart from archive and restore controls on each row and section. Edits from the page are journaled with the writer `Lord`. Restoring from a spoiler keeps the reader's place. Controls are readable and tappable at phone width.

`scripts/where-i-stand-evidence/run.mjs` serves the product against a fixture backend and a reference, and writes captures, a contact sheet and `evidence.json` per preset. `bun run test:e2e` runs the Playwright tests of the page against that fixture.

## Sub-features

- WSP-TABS: The page shows the database's tabs and sections in their stored order.
- WSP-ARCHIVE-TAB: The Archive tab lists every archived row and section read-only, with Restore.
- WSP-AGE: Every row shows its age, with exact times on hover or tap.
- WSP-SPOILER: Archived rows and sections sit in a counted spoiler and can be restored in place.
- WSP-EPICS: The Lord adds, edits and removes epics; other tabs are read-only.
- WSP-ARCHIVE: Any row or section can be archived from the page.
- WSP-EVIDENCE: The evidence tool writes captures and evidence.json per preset; its fixture is absent from `dist/`.

## How to reach it and prove it works

Open `/throne` on the tailnet, or `http://127.0.0.1:8430/` on the host, and pick the where-i-stand tool.

```
bun run test:web
bun run build && bun run test:e2e
bun scripts/where-i-stand-evidence/run.mjs --preset all --out <folder> --port <port> --data-home <scratch>
```

Each exits 0.

## Gotchas

The scratch evidence server serves the page at `/`, not under `/throne`. `bun run test` does not run the Playwright tests; they are a separate gate and need a built `dist/`. Never point the evidence tool at the Lord's data home.
