# Scheduling slices

### 3. Scheduling contract — concurrency with honest serialization

orchestrator applies it at every spawn and merge decision.

1. **Inputs.** Each slice file may declare `deps:` (slice numbers that must be
   merged first) and `touches:` (predicted file/dir footprint: every file the
   slice will create, edit, or delete — kill-list targets and test files
   included) in its YAML frontmatter, stamped at planning time.
2. **Concurrency rule.** Two slices may run concurrently iff (a) neither
   depends — directly or transitively — on the other, and (b) their `touches:`
   footprints are disjoint, treating known shared hotspots (e.g. a command
   registry file) as conflicts. A slice with no `touches:` stamp has an unknown
   footprint and serializes against everything. That conservative default is
   deliberate: a bundle authored before these stamps existed keeps exactly
   today's one-at-a-time behavior.
3. **Merge serialization.** Merges into the Alpha branch are strictly one at a
   time, orchestrator-performed, each preceded by a non-destructive
   `git merge-tree --write-tree` preview. If a merged sibling touched files in
   a still-running slice's footprint (a footprint prediction miss), treat that
   slice's merge as suspect: preview it, and on conflict resolve deliberately
   or re-verify before landing.
4. **Successor release.** The moment a prerequisite merges, every slice whose
   `deps:` are now all merged and whose footprint is disjoint from all
   still-running slices spawns immediately. Do not batch releases into rounds.
5. **Prompt reap.** A Shadow whose slice is merged and whose DONE report is
   verified is reaped immediately; teardown is never batched to the end of the
   bundle.
6. **Event-driven waiting.** The Shadow's DONE or blocker `send-agent` message
   wakes the Alpha immediately. With no dependency-ready work, the Alpha becomes
   idle and schedules no sleep, query, or model turn. One completion review, an
   explicit blocker inspection, and silence beyond the 30-minute Regent heartbeat
   interval may use `agent-logs`; `agent-statuses` is never a polling substitute.
   Durable-ledger startup reconciliation after crash or reboot is unchanged.
7. **Concurrency cap.** At most 3 live build, fix, seam, and `99` Shadows
   per campaign, so supervision, merge quality, and quota stay honest.
   Verdict-only critique-gate Shadows (`NNz_critique_<module>`, every round)
   run in their own pool of up to 7 concurrent Shadows that does not count
   against those 3. Merge serialization (item 3) is unchanged.
8. **Honest serialization.** Shared-file conflicts, true dependencies,
   integration slices, the assembled-candidate preflight, `99a`, `99b`, and
   `99c` are strictly serialized. A seam slice (`NN_seam_<wave>`) intersects
   every core path and therefore serializes against everything; a critique
   gate (`NNz_critique_<module>`) runs once its builder and the evidence tool
   have merged and never after `99a` has started; every gate whose builder
   has merged starts immediately, not in waves. `99a` runs only after every ordinary slice is
   merged and the tree is quiescent; `99b` runs only after explicit `99a`
   `**Conformance outcome:** PASS`; `99c` runs only after explicit `99b` PASS.
   A `99a` FAIL is corrective work for the owning Alpha — never something
   `99b` or `99c` proceeds past.
9. **Pre-staging is preparation, never anticipation.** The serialization above
   costs a full spawn — worktree creation, dependency install, model-policy
   resolution, assignment authoring — on the critical path between one gate's
   verdict and the next gate's first useful second. Prepare that work while the
   predecessor still runs, but only the parts whose content cannot depend on the
   predecessor's verdict or on the code it may still change: author the
   successor's assignment file in the todo folder, resolve its harness/model pair
   from the live policy, and warm any campaign-level cache the spawn will reuse.
   Never launch the successor, never let it read the tree, and never let a
   pre-staged artifact assert or presume the predecessor's outcome. The gate
   order is unchanged: the successor spawns only after the predecessor's own
   explicit `PASS` line, and a `FAIL` discards the pre-staged assignment rather
   than editing it into a re-gate.
   **A pre-staged worktree is bound to a candidate that can still move.** A
   corrective iteration, a late merge, or a re-gate advances the Alpha branch
   after pre-staging, and a worktree created from the older tip would gate stale
   code while reporting on the campaign. So either defer `spawn-git-tree` to
   launch time, or record the candidate HEAD at pre-stage time and, immediately
   before launch, re-read the Alpha branch tip: on any difference, destroy the
   pre-staged tree and create it fresh. Launching a pre-staged tree without that
   equality check is a verdict about code that no longer exists.
   **The same preparation extends to dependent ordinary slices.** While a slice
   runs, prepare the next dependent slice's worktree, its dependencies, and its
   `ASSIGNMENT.md` — staging is permitted while the dependency is still running
   — but do not start that Shadow before its dependency has merged: the start is
   permitted only once the dependency has merged. Both halves stay explicit,
   because a rule that says only "pre-stage" invites the early spawn it exists
   to prevent. What this accelerates is the three-gate terminal chain `99a` → `99b` → `99c`
   together with those dependent ordinary slices, and it
   relaxes none of the one-fresh-worker rule, the concurrency cap, or the
   quiescence rule: a pre-staged tree is preparation, not a running writer.

**Quiescence extends across bundles and editors.** The serialization unit is the working tree + branch, not just this bundle's queue. Before spawning any slice — especially the first slice of a new bundle — confirm no other writer is active on the same tree: a still-running worker from a previous bundle, an in-flight `99b` or `99c` terminal Shadow, another orchestrator, a human mid-edit (a dirty tree you didn't create). Two writers interleaving commits on one branch produce index-lock races and staging that mixes their work. Hold the new queue until the in-flight work reports back. Read-only planning of the NEXT bundle (`/write-todos` research and file authoring in its own todo folder) may overlap; its trial-and-error probing may not (see `write-todos`' "Empirical recon needs a quiescent tree").

### Sequence-and-evaluate

```
resolve MODE and the selectable registry from MODEL_POLICY.md   # once, up front
for each todo in execution order (NOT necessarily numerical order):
  mark in_progress   # harness task tracker if present (claude: TaskUpdate); else skip
  requires, model = resolve_requirement_and_model(todo, MODE)   # see rule 6
  spawn a fresh Shadow (rule 2's per-slice sequence) with that model, no --effort
  verify the work landed (git log, gate script, peek at key files)
  if blocker: address it, then continue
  mark completed
```

### Out-of-order execution is OK when natural deps require it

If todo N is a hard prerequisite for N+1 but ordered later, pull it forward. Document the reorder in the execution log of both todos. Example: the build and test setup (package config, test runner) often gets pulled before any feature todo because every subsequent task needs a working build.

### Skip todos that aren't actionable

- "Later" todos that say "do this once X happens".
- Decision docs whose output is a choice, not code (e.g. file-format design where the field list isn't pinned). Don't block on these — log the open decision and your assumed answer to `000_current_questions.md` (rule 5), then skip the doc itself as a code slice.
- Open-questions lists (those are user worklists, not executable work).
- **`00_overview.md` is not a slice** — it's read-first context for the whole bundle. Load it into every worker's assignment (rule 4); never run a worker to "do" it, even though it matches the `NN_` glob.

Document each skip in your final status report so the user sees what was deliberately not done. (`00_overview.md` is consumed as context, not skipped — don't list it.)

### When a Shadow dies or is rate-limited mid-run

- `git status` + `git diff` in its tree to see what it left on disk.
- Run the gate script to confirm the WIP at least compiles.
- Append a partial-progress log to the todo file (commit it with the WIP).
- Decide whether to relaunch the registered dead Shadow (`create-agent` relaunches its exact stored recipe) or reap it and spawn a fresh Shadow with a tightened assignment (better when little context was banked). The orchestrator never finishes the slice itself.
