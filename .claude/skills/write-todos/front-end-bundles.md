# Front-end bundles

A bundle is **front-end** when any slice's `touches:` set includes a path
ending in `.css`, `.scss`, `.html`, `.jsx`, `.tsx`, `.vue`, or `.svelte`, or
lying under a directory named `web/`, `ui/`, `frontend/`, or `components/`.
Decide this in step 2, from the `touches:` sets you have already settled; it
is deterministic and costs nothing, unlike diffing at gate time. Stamp
`frontend: true` in `00_overview.md`'s frontmatter and include the front-end
critique block in `99b`, unless the bundle stamps `frontend_row: builder`
(below). A bundle that turns out front-end only during execution (a slice
touched markup the plan did not foresee) is an amendment: `00` gains the stamps
and `99b` gains the block they call for before `99b` runs.

The rule exists because passing tests and a correct DOM do not prove a UI
looks right. On 2026-09-08 a link that met every Playwright assertion still
sat one to two pixels below its neighbours, and the Lord had to notice,
describe, and prescribe the fix. The throne-local `frontend-critic` skill is
the measured review that catches that before he sees it, and it also drives
the state a change keeps through awkward orders (acting mid-request, leaving
and coming back, returning from past the first page) and hunts the bugs its
checklist misses. A bundle with no `frontend_row:` runs it in `99b`, because
`99b` is the only moment the assembled UI exists to be looked at. A critic
bundle already has the assembled UI, delivered, so it runs the review from
slice `01`.

### The `frontend_row:` stamp — builder and critic rows

That review takes far longer than the build, and working function comes first
(Lord, 2026-11-05: "a quick first-round alpha (for functionality purposes
usually) to finish first so that it can be used immediately"). So
`/queue-objective` files a row that changes a web UI as two rows, a builder and
a deferred critic. Each body carries one line, and one key in `00_overview.md`,
beside `frontend: true`, tells the two bundles apart:

| Body line | Stamp |
| --- | --- |
| `FRONTEND-ROW: builder, critic row <critic>` | `frontend_row: builder` |
| `FRONTEND-ROW: critic of <builder>` | `frontend_row: critic` |

- **`frontend_row: builder`** is stamped only when the body carries the builder
  line AND `throne situation-brief --objective-code <builder>` lists the critic
  under "Deferred rows waiting on this objective". Without both, the stamp is
  refused: leave it out and the bundle keeps its `99b` critique, so a dropped
  critic row costs speed and never the critic.

  A builder bundle has no `## Front-end critique` block in `99b`, no
  `NNz_critique_` gates, no `bundle_content: perceptual`, and no accessibility
  review of any kind (keyboard walk, screen-reader checks,
  `/screen-reader-check`, or the accessibility parts of `/frontend-critic`). A
  builder `99b` that carries the critique block is malformed, and a stamped
  builder whose `99b` lacks `## Browser function check` is malformed. Its gates
  check function only, and it delivers as soon as they pass. Its Alpha then
  asks for the critic's release by the "After the PASS" step of
  `/execute-todos`.
- **`frontend_row: critic`** is stamped when the body carries the critic line,
  and it always also stamps `frontend: true`. Slice `01` first brings the tree
  up to the target branch and confirms the builder's delivery commit is
  present. If it is absent, the slice tells the Regent and parks on the
  builder's Alpha, because a deferred row can launch early by design. The slice
  then runs `/frontend-critic` and `/screen-reader-check` on the delivered
  surfaces and fixes every defect they raise. That happens before `99a`, so the
  conformance gate grades the fixed work. `99b` keeps the `## Front-end
  critique` block, widened to `/screen-reader-check`, and finishes on empty
  reports. `/screen-reader-check` runs its simulated pass; its real screen
  reader pass stays a person's order, as that skill says.
- **`frontend: true` with no `frontend_row:`** (a `/gauntlet` row, a row filed
  before this rule, a row never split) keeps its `## Front-end critique` block
  and its critique gates exactly as this skill describes them.
