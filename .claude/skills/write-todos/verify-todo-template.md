# The verify todo (`99b_verify_<topic>.md`)

Always the second terminal executable todo and always a fresh real Shadow. It
runs only after `99a` returns an explicit `**Conformance outcome:** PASS`, and
its job is to find what is broken in the assembled candidate and fix it: run
the bundle's tests and lint/static analysis, fix whatever fails, and re-run
until green; then hunt the whole diff for the bugs no test was written for,
confirming each with a failing test (or, for UI behaviour, a recorded browser
sequence) before fixing it. For a front-end bundle that job includes the
`frontend-critic` review, and every defect it reports is a failure to fix; for
a `frontend_row: builder` bundle it includes the browser function check
instead, and every behaviour that does not work is a failure to fix. When a
front-end bundle's deliverable is a PR it also captures the change with
`/pr-media` (screenshots, and every interaction the change touches recorded as
a video, as `/pr-media`'s video rule requires) into `~/tmp/pr-media-<pr>/`
for `99c`'s `## Screenshots` section. It is a fixing gate, not a verdict gate
— it commits its own repairs on the campaign branch. In `no-git` mode it runs
whatever checks are naturally applicable and records the rest as N/A with the
classifier evidence.

```markdown
---
deps: [99a]
---

# 99b — Run the tests and lint for <feature>, and fix what fails

Fresh independent Shadow. Run the bundle's verification commands against the
assembled candidate — the test suite, the linter, type/static analysis, and any
repository contract check the project already owns. Follow the spec file's "How to reach it and prove it works" section where one exists (`throne spec-location <repository>` says where the spec is). Record every command, its
exit code, and its relevant output; generate that evidence rather than
transcribing it.

Fix every failure you find. A failing test, a lint violation, a type error, or a
broken build is corrective work you do here and commit on the campaign branch —
not a finding you hand back.

Run the checks small first, then big, in rising tiers A, B, C, D, so a fix
never throws away a bigger run. Run each tier, fix and commit what it finds,
and re-run it until it is green; only then start the next tier. Find each
command from this repository's own scripts and runner at run time.

1. **Tier A — the tests nearest the change.** With build, type/static
   analysis, every linter and contract check, and the diff sweep: first the
   test files the campaign added or changed; then the test files that test
   the source files it touched, by the repository's own convention (a
   same-name spec or test beside the file, or a test folder mirror); then the
   test files a grep finds importing the touched files. Run them with the
   runner's own file selection: `node --test <files>`, `jest <files>` or
   `jest --findRelatedTests <files>`, `vitest related <files>`,
   `go test ./pkg/...`, `pytest <files>`.
2. **Tier B — the tests coverage says reach the change.** Run the suite once
   with the runner's coverage on, or read the repository's recorded coverage
   map, to learn which test files execute the changed lines; then run
   exactly those (`jest --findRelatedTests` or `jest --coverage`,
   `vitest related`, `node --test --experimental-test-coverage`,
   `go test -coverprofile`, coverage.py). With no cheap way to map tests to
   files, say so and skip to Tier C. Never fake the mapping.
3. **Tier C — the full suite without slow tests.** The repository's default
   test command; with no slow or fast split, the plain full suite. Run it
   beside the base suite when the project compares against one. Fix and
   commit what it finds, re-run Tier A, then run Tier C once more. Finish on
   a clean Tier C run. Run the base suite with
   `bun scripts/shared-base-suite.mjs <base-directory>`. It may reuse a
   finished base result another campaign saved for the same base; when it
   prints `shared base result used`, write its key and path into this file.
   The candidate suite is never cached: always run it fresh.
4. **Tier D — slow tests and container tests, each only by your decision.**
   Two separate opt-in choices, both off by default: the slow tier, and
   container tests (a test that starts podman or docker is presumed slow).
   Decide each from the assembled diff, and run a group only when the change
   reaches what it covers. Record one line per decision, either way, with
   its reason, for example `container tests: not run; the change is skill
   text only`. When the repository does not separate its container tests,
   say so and treat them as part of its slow or default tier. The heavy tier
   is never part of this decision: it runs only on the Lord's direct order,
   and you never choose it.

Do not start a bigger tier beside a smaller one. A fix the smaller tier
forces makes that bigger run worthless and costs a second one (Lord,
2026-10-15: "1 small test and 1 big test beats 2 big tests.").

Record, for each tier, the command, the files it selected, the exit code and
the duration.

**You own the fixing. Do not punt to the Alpha.** Reporting a failure upward and
waiting for someone else to repair it is not an available move, and neither is a
FAIL whose stated blocker is "this needs a code change" — making the code change
IS the assignment.

For the suite command specifically, do not credit exit 0 alone: read
`run-suite-container.mjs`'s own stdout to its end and record the
`run-suite-container: tests executed: N` line it prints for every real run. A
truncated log, a signal death, or a completed run reporting `tests executed: 0`
or `tests executed: unknown` is never a PASS, whatever the exit code says.

## Bug hunt

Once the tests and lint are green, read the whole assembled diff against the
campaign base (`git diff <base>...HEAD`) as a reviewer who did not write it,
not slice by slice, and ask how it breaks.

- List every piece of state the diff adds or edits (variables kept across
  calls, caches, cursors, history or URL state, stored rows, flags) and every
  contract it changes (function signatures, request and response shapes,
  limits shared with another component or service).
- For each, follow every way it can change and try to break it: the order
  of events, concurrency and late answers, empty and boundary values, a limit
  that disagrees between two places, navigating away and back, an error
  part-way through. For example, a bookshop's basket that caps a title at 10
  copies while its checkout accepts 99 is a limit that disagrees.
- Confirm each suspected bug with a failing test (or, for UI behaviour, a
  recorded browser sequence) before you fix it. A suspicion you cannot
  confirm is listed, not fixed.
- Fix only what the diff added or edited. A bug in code the diff did not
  touch goes under "Pre-existing, not fixed".
- Report the list of state and contracts hunted, one line each: PASS, or the
  confirmed bug with its test and fix commit. A hunt that found nothing still
  lists what it examined.

This hunt covers the whole diff. When this todo carries the critique below, it
adds the critic's own front-end hunt; this one does not repeat the critic's
checklist.

<!-- Include the block below only when 00_overview.md stamps frontend_row: builder. -->
## Browser function check

This bundle is a builder row, so its gates check function only. Rebuild and
serve the assembled candidate, confirm the served bytes carry the change, then
perform each `## Done when` behaviour in Chromium with agent-browser. A
behaviour that does not work is a failure you fix here and commit, exactly like
a red test. Run no `/frontend-critic` review and no accessibility review; the
critic row owns both.

<!-- Include the block below only when 00_overview.md stamps frontend: true and not frontend_row: builder. -->
## Front-end critique

This bundle changes a web UI. Rebuild and serve the assembled candidate,
confirm the served bytes carry the change, then run the throne-local
`/frontend-critic` skill against every surface the bundle touched, in every
state it names (default, hover, focus, fallback), in Chromium only, as
section 4 of that skill sets out, including its interleave moves for kept
state and its open bug hunt (sections 3d and 3e). Each defect it reports (a
baseline off by more than 0.5px, a shifted neighbour, a clipped or overlapping
box, an undersized click target, state lost or overwritten by a late answer)
is a failure you fix here and commit, exactly like a red test. Re-run the
critic after each fix and finish on an empty report.

<!-- Include the paragraph below only when 00_overview.md stamps frontend_row: critic. -->
This bundle is a critic row, so the surfaces include everything the builder
delivered. Run `/screen-reader-check`'s simulated pass on them too, fix what it
raises the same way, and finish on an empty report from both.

## Deliverable

- End with exactly one `**Verify outcome:** PASS` or `**Verify outcome:** FAIL`.
- PASS requires a final clean run of every applicable command, cited with its
  exit code and the suite's `tests executed: N` line; each tier's command,
  selected files, exit code and duration; the two Tier D decision lines; the
  bug-hunt list of
  state and contracts hunted, one line each, even when nothing was found; and
  with the critique block the critic's final empty report, naming Chromium, or
  with the browser function check one line per behaviour performed, naming
  Chromium. A critic row adds `/screen-reader-check`'s final empty report.
- FAIL only when repair is genuinely impossible for you — a requirement nobody
  wrote, two slices whose designs contradict, or an environment you cannot fix.
  Name that precise blocker; never forward a raw test or lint failure as one.
- Fix and commit; do not merge, do not deliver, and do not touch the target
  branch.
- When you end a turn to wait on background work you started (a test or
  suite run, a monitor, a queued container slot, a background agent), end
  that message by running `throne my-state waiting-on-own-run "<what>"` and publishing
  `{"blocked":true} BLOCKED_BY_own-background-run (<what>)`; your next prompt records
  you as working again. Otherwise no-idling pages the Regent every minute.
```
