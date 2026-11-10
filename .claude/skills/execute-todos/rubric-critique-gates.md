# Rubric critique gates

### Rubric critique gates — Shadow-run, bounded, resumed weakest-first

A bundle stamped `bundle_content: perceptual` carries `NNz_critique_<module>`
gate files authored by `write-todos`' "Perceptual-quality bundles". This
section owns how they execute. Everything here happens under the one
campaign Alpha: the critic is a Shadow, the fix is a Shadow, the re-grade is
a fresh Shadow, and at no point does anything ask the Regent for another
Alpha — the Lord's ruling of 2026-09-02, after a multi-Alpha fix chain left
the Regent queueing corrections without end. `review-loop`'s fixer-Alpha
model is NOT the route for a campaign-scoped critique. A bundle stamped
`frontend_row: builder` has no critique gates, so none of this applies to it;
every other `frontend: true` bundle follows it as written.

1. **Spawn.** A critique gate is scheduled like any ordinary slice — it runs
   when its `deps:` (the builder it grades and the `01` evidence tool) have
   merged — and always before `99a`. Spawn it with `--deliverable-shape
   verdict-only`: it writes no product code and its branch is legitimately
   empty, and that flag is the property-keyed no-diff exemption
   `merge-git-tree` honours (the name-pattern exemption covers only the `99`
   terminal gates). Address it `shadow-<code>-NNz-critique-<module>`. Each
   concurrent critic uses its own worktree, its own dev-server and e2e port
   (never one another live critic holds), and its own agent-browser session
   (`agent-browser session id --scope worktree --prefix <critic name>`),
   closed when it is done.
2. **Grade.** The critic runs the gate's `evidence_cmd` itself for every
   pinned preset, in its own worktree — a builder's own captures are never
   evidence. It scores each axis, produces one overall score, a ranked issue
   list, and the explicit line `**Critique outcome:** PASS` or `FAIL`. The
   score grades visual fidelity only; functionality is never a weighted share
   of it. The gate's per-Shadow `REPORT.md` carries the scores and the
   evidence paths.
   - **In a bundle stamped `frontend: true`** the critic also runs the
     **functional parity check**: through the real UI in agent-browser at the
     pinned viewport, in its own session, it lists every interactive element
     and every state change the reference shows, performs each, and records
     one line per check — `action | expected (from the reference) | observed
     | PASS or FAIL | capture path`. A reference element with no working
     counterpart, a control that does nothing, a wrong destination, a missing
     or wrong state change, data that does not persist after navigating away
     and reloading, a crash, a dead end, or any console or page error is a
     FAIL line. PASS requires zero FAIL lines AND zero console or page errors
     AND the project's e2e suite green AND score `≥ threshold`. With any FAIL
     line the gate fails whatever the visual score, and the critic reports
     "visual N, capped at <cap> by functional failures", the cap one step of
     the gate's scale below its threshold (79 at a threshold of 80), so a
     score at or above threshold always means functional parity held.
   - **In any other bundle** PASS requires score `≥ threshold` AND zero
     errors in every evidence JSON.

   A FAIL verdict lists functional failures first, worst first, then the
   rubric issues.
3. **Record.** After every critique verdict the Alpha updates
   `STATUS.json` in the todo folder — the one durable, machine-readable
   record of where the bundle's quality stands:

   ```json
   {
     "updated": "<ISO timestamp>",
     "modules": {
       "<module>": {
         "gate": "03z",
         "round": 2,
         "score": 8.4,
         "visual_score": 8.8,
         "threshold": 8.5,
         "verdict": "FAIL",
         "functional_failures": ["<FAIL line, verbatim from the critic>"],
         "open_issues": ["<ranked issue, verbatim from the critic>"],
         "evidence": ["<path>"]
       }
     }
   }
   ```

   `score` is the reported score, capped when functional failures exist;
   `visual_score` is the uncapped visual score; `functional_failures` holds
   the open FAIL lines verbatim, `[]` when the check is clean or the bundle
   is not `frontend: true`. Never round a score up, never drop an open issue
   or a functional FAIL line to make a row look closed, and never write a
   verdict the critic did not emit. `STATUS.json`
   is bundle ledger, not product: it lives in the todo folder and is never
   committed onto the campaign branch.
4. **Correct.** A FAIL is corrective work for the owning Alpha. Spawn exactly
   one fresh corrective Shadow, `NNy_fix_<module>_r<round>`, whose scope is
   the critic's functional FAIL lines and ranked issue list verbatim and
   whose `touches:` is the module's own folder. It fixes the functional
   failures first and adds one e2e spec per functional behaviour it fixes.
   If the list names a core change, the fix Shadow appends it to
   `core-requests.md` and the next seam slice carries it — the fix Shadow
   does not touch core. The corrective slice merges like any
   slice.
5. **Re-grade with a fresh critic.** Spawn a brand-new critique Shadow for
   the same gate file; the previous critic's identity is never reused, and
   the fix Shadow never grades its own repair (the "collaborative
   self-validation is forbidden" rule applies unchanged). Increment `round`.
6. **Bound.** `max_rounds` from the gate's frontmatter caps the
   fix→re-grade cycles. At the cap the gate records `verdict: "FAIL"`,
   `capped: true`, and the residual issue list, and the Alpha proceeds to the
   next module. A capped module is not a pass and is not hidden: `99a` reads
   `STATUS.json`, and a `## Done when` criterion the capped module served is
   an unmet requirement with no addendum behind it — a `99a` FAIL — unless an
   errata entry or Lord ruling explicitly relaxes that criterion. That
   relaxation covers only a visual shortfall with an empty
   `functional_failures`. A module whose `functional_failures` is non-empty
   at the cap is carried by no errata entry or ruling that relaxes a capped
   visual criterion: the Alpha stops that module — no further rounds, not
   accepted, not delivered — and reports its open functional failures to the
   Regent, while the other modules continue.
7. **Resume weakest-first.** When this bundle is re-entered — a `/loop`
   iteration, a crash reconciliation, a Lord order to "keep going" — the
   Alpha reads `STATUS.json` before the todo folder and starts with the
   lowest-scoring uncapped `FAIL`, then the next lowest, before any unstarted
   work. A module stopped at the cap for functional failures is not picked
   up. A module already at `PASS` is never re-graded unless a later merge
   touched its folder or a seam slice changed core after its verdict, in
   which case its row is reset to `verdict: "STALE"` and it re-enters the
   queue by score.
8. **Whole-deliverable critique and blind comparison.** When
   `00_overview.md` names a whole-deliverable rubric (a demo scene, the
   assembled UI), plan it as one more critique gate, `98z_critique_<topic>`,
   with `deps:` on every seam slice; it runs last before `99a` and the same
   rules apply. When a `reference_set` exists, that gate additionally runs a
   **blind comparison**: pair each candidate capture with a reference at the
   same preset, label the pair `A`/`B` in shuffled order, hand the judge only
   the pair and the axes, and record which it preferred and why. The judge is
   the same critic Shadow; the shuffle is recorded in `STATUS.json` so the
   result can be un-blinded by a reader and never by the judge.

The final report's verification matrix carries one row per critique gate —
module, rounds spent, final score against threshold, open functional
failures, verdict, and whether it was capped — measured rows and
carried-forward rows visibly distinct, exactly as for the `99` gates.
