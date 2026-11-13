# Slice work every Shadow follows

### An ordinary slice writes no spec

An ordinary slice changes no spec file and no feature map; the `99bs` spec
gate writes the whole campaign's spec change. End your execution log with two
or three lines on what changed for a user or for another module. That gate
reads them.

### Mechanical checks shift left into the slice that creates the defect

**Every implementation slice runs the mechanical checks over its own diff before
it reports DONE.** Those checks are the ones the first two terminal gates own:
the file-size regression predicate over the slice's own changed files, and the
lint, static-analysis, and duplicate checks over the slice's own diff. A slice
that reports DONE while one of those checks fails over its own diff has not
delivered; its DONE report is returned rather than merged.

**Evidence still belongs in `REPORT.md`, and nothing now checks it for you.**
Every Shadow whose `ASSIGNMENT.md` states an `Evidence required: <command>`
line should still write a `## Evidence` section carrying that command and its
real output, because the next reader of that report — a supervisor, a gate, the
Lord — has nothing else to go on. Write it because the report is the record,
not because a checker is watching.

**THE AUTOMATIC STATED-EVIDENCE GATE WAS DELETED ON THE LORD'S ORDER,
2026-08-25**, along with the `check-slice-evidence` command. It read
`ASSIGNMENT.md` for the required command and refused `complete-agent` and
`reap-agent --reason completed` until `REPORT.md` quoted it with output. It was
self-imposed, never asked for, and was removed rather than repaired because it
had a demonstrated false-failure rate and no demonstrated catch: a regex bug
captured the markdown backticks around the command, making it unsatisfiable for
any assignment written in the ordinary form, and the resulting refusals routed
operators onto `--force`, which cascades teardown through live children.

**What still gates a completion claim, and it is most of the protection:**
`checkOwnWorktreeCommittedPrecondition` refuses teardown while an agent's own
worktree carries uncommitted tracked changes; the terminal delivery
precondition proves delivery from git state rather than from prose; the runtime
model check; the reapability claim; and the terminal gate chain itself.

**What is genuinely uncovered now, and it is on supervisors rather than on a
guard:** a deliverable git cannot see. On a documentation, audit, or analysis
slice the report IS the artefact, so no commit exists to re-derive a verdict
from. A supervisor accepting such a DONE report must read the evidence itself
and say it did — that duty used to be shared with a checker and is now
entirely yours.

**The scope is the slice's own diff, never the assembled candidate.** A slice
cannot judge what its siblings have not landed yet, and demanding that it try is
how a shift-left rule turns into a per-slice full-campaign gate — the exact cost
this removes. Each check runs over the slice's own changed files, from the slice
tree's base to its tip.

**The file-size check is the one exception to "slice's own base": its FILES are
the slice's own changed files, but its LINE-COUNT BASELINE is always the
campaign's recorded base commit, never the slice's own base.** Run
`campaign-evidence --base <campaign's recorded base commit> --target
<recorded target branch> --repo <live-throne> --head <slice tip>`, not a
slice-relative diff.
Baselining against the slice's own start would let growth hide across a whole
campaign: a 503-line file that five different slices each grow by 10 lines
would pass every one of those five own-diff checks under a slice-relative
baseline (each slice sees the file arrive already-over-budget and leave the
same amount over, from its own vantage point), and the cumulative 50-line
regression would surface only once, at `99c`, after every slice already
reported DONE. Comparing against the campaign base instead of the slice base
makes each slice see the true in-campaign growth and fail its own shift-left
check the moment it, not some later slice, pushes the file further from the
ideal.

State the reason, because a later reader will otherwise read this as duplicated
work: the terminal gates still run their own checks over the assembled
candidate, and those runs are unfakeable and near-free. What shift-left removes
is not the gate's run — it is the ROUND TRIP the gate would otherwise open: gate
spawn, verdict, corrective slice spawn, revalidation spawn, all to rediscover
something a command could have caught inside the slice that created it.
Shift-left changes WHERE a defect is found, never WHETHER it is checked.

Every slice worker's assignment carries this obligation, and that slice's own
execution log records each check's command and exit code.

#### Three verification layers, and the layers are not interchangeable

1. **Per edit** — the slice's own focused tests plus its mutation checks, run
   inside the slice on every edit. They are what makes a slice's DONE report
   mean something. A slice never runs slow or container tests.
   **Independent cases run together, not one after another.** When you write
   a check for yourself (an evidence tool, a probe script, a batch of one-off
   runs) and it has more than one independent case, start those cases at the
   same time and collect every result. Run cases serially only when two of
   them share one real machine, one lock, one account or one counter, and
   write that reason in one sentence where you decide it. Give each case its
   own pane, port, temporary folder, data home and container name, chosen by
   the tool at run time, never fixed. Run at most 6 cases at once by default;
   use fewer when each case starts a browser, a container or a harness and
   the host shows strain. When you run several independent commands by hand,
   start them together (your harness's background mode, or one command that
   starts them all and waits for all), never one wait after another. The
   tool's log records the wall-clock seconds of each case and of the whole
   run. For example, a recipe app's evidence tool that captures twelve
   screens starts six capture browsers at once, each on its own port and
   temporary folder. This rule does not reach the repository's own suites or
   the single assembled full-suite run in layer 2; that run keeps its rules,
   including running it in the foreground.
2. **Once before the terminal chain** — exactly one baseline-comparative
   full-suite run over the assembled candidate, at the assembled-candidate
   preflight, before the terminal chain begins. `99b` re-runs the suite as its
   own deliverable; `99c` does not repeat it, and within a round carries it
   forward against the frozen candidate. This run is the Tier C run of
   `99b`'s rising tiers: the default suite without slow tests.
   A base suite run for comparison (the `99b` base run, or a preflight of an
   unchanged base) goes through `bun scripts/shared-base-suite.mjs
   <base-directory>`, which reuses a finished result another campaign saved
   for the same base tree, suite command, test groups and suite scripts, and
   prints `shared base result used: key=... ran_at=... path=...` when it does.
   A cached base result is allowed; the `99b` file names its key and path. The
   candidate suite is never cached: it always runs fresh.
   Record the evidence tree with `git rev-parse "<assembled-candidate>^{tree}"`
   beside the suite result. Before any gate carries that result, resolve the
   current frozen candidate with the same command. The recorded evidence tree
   must equal the current candidate tree exactly; a mismatch **REFUSES** carry
   and requires a fresh like-for-like run before any suite verdict is claimed.
   Run this suite in the foreground with a tail of its output. Do not start it
   in a background shell and then wait on it through a Monitor or notification
   — a pane holding on a backgrounded suite and a genuinely finished pane look
   identical to status inference that only checks whether a turn is in flight,
   so the wait reads as done and triggers a false-idle sweep against an agent
   that is correctly waiting on work it started. Foregrounding with a tail
   keeps the run visible in the same turn that started it, which removes that
   false signal at the source instead of relying on the sweep's own busy-work
   detection to catch it after the fact. Any wait that still ends a turn — a
   run queued for a container slot, a second suite started beside the first —
   runs `throne my-state waiting-on-own-run "<what>"` and ends that message with
   `{"blocked":true} BLOCKED_BY_own-background-run (<what>)`; the next prompt records
   the agent as working again. Otherwise no-idling pages the Regent every
   minute.
3. **Repeat only on reach** — the full suite is re-run after a correction only
   when that correction can affect it, judged from the corrective diff's file
   list plus an inbound-reference sweep over those files. A correction that
   provably cannot reach the suite may carry the earlier run forward only when
   the recorded evidence tree still equals the current candidate tree; the carry
   is a labeled transcription with its untouched-proof, exactly as a scoped
   re-gate transcribes an untouched criterion. Tree mismatch is never softened
   into a warning or a silent claim that a run happened.

The layering replaces a per-slice full-suite run, which costs every slice the
whole suite's wall-clock and tells the campaign nothing a single assembled run
does not.

### Evidence is generated, never transcribed

Wherever this contract would otherwise ask a reader to list changed files, count
lines, re-derive a `file:line` citation, summarize a duplicate report, or copy a
gate manifest with the base commit filled in, run the throne's evidence command
and record its output and its exit code instead:

```bash
"$THRONE/bin/throne-cli" campaign-evidence --base <recorded base commit> \
  --target <recorded target branch> --repo <path> [--head <ref>] [--json] \
  [--section inventory|line-sizes|citations|duplicates|manifest]...
```

Omitting `--section` runs all five sections. The duplicate comparison
additionally takes `--baseline-duplicates <path>` and `--head-duplicates <path>`,
the two detector reports it diffs. The exit code IS the verdict: `0` every
requested section clean, `1` a section reported findings, `2` a section could
not be verified or the arguments and revisions were unusable. Record the exact
command and that code — `2` is never a pass.

The reason belongs in the contract rather than in a reader's head: a command
yields the same exit code for every reader and cannot paraphrase, while a
transcription is exactly where a gate's evidence silently drifts from the tree
it claims to describe.

### `todo!()` for unpinned bodies

If a todo's wire-format / external-API contract isn't pinned but its public API IS pinned, implement the API surface fully and use `todo!()` in the bodies. Subsequent code references the contract and only fills in bodies later. This is how dependency cycles between todos resolve cleanly.

### `501 Not Implemented` over fake 200s

When a route depends on infrastructure that doesn't exist yet, return `501 Not Implemented` with a `{"error": "not_implemented", "blocked_by": ["todo NN"]}` body. **Never return 200 with placeholder data** — it pollutes the API contract with lies and makes future debugging painful.

### Pre-commit gate must include the release build

When the release build differs from the development build (a production bundler step, an optimizing compiler profile, minification, a link step that only runs for release), the fast development check silently masks release-only failures:

- An import the production bundler drops, so a page renders blank only in production.
- A minifier renaming a function that something else looks up by name.
- A link or packaging error that only the release profile reaches.

Add the release build to the pre-commit gate. It is slower but catches the bug class that would otherwise fire only after deploy.
