# The 99 gate chain

### `99a` grades conformance, `99b` verifies and fixes, `99bs` updates the spec, then `99c` merges the latest target and delivers

The terminal chain is four fresh real Shadows: one that checks the assembled
candidate is the thing that was actually asked for, one that makes it green,
one that brings the spec and feature map up to date with the whole change
(`gate-99bs-spec.md`), and one that gets it onto the target branch. Nothing
else. The older five-gate
chain (absorb, file-size, static analysis, overview validation, delivery) was
retired for being more machinery than any executor could hold in one head; the
gates below carry its whole job.

The conformance gate was inserted at the Lord's direct order on 2026-08-25,
ahead of the existing pair, because a bundle can pass every test the campaign
wrote for itself and still not be what was requested. Tests grade the code
against the campaign's own understanding; `99a` grades that understanding
against the request.

**Persist the raw suite log before DONE/reapable.** Any terminal gate or
ordinary slice whose deliverable runs a full suite (`bun run test`) must write
that run's raw stdout/stderr to its own `$THRONE_DATA/<its-own-name>/` ledger
directory — the same directory every other mandatory artifact (`ASSIGNMENT.md`,
`identity.md`, evidence files) already lands in — before it reports DONE or
becomes reapable. This is in addition to, not instead of, recording the
`run-suite-container: tests executed: N` line in the gate's own report: the
report cites the count, the ledger keeps the log a lost/reaped Shadow can no
longer be asked for.

In `no-git`, keep every terminal checkpoint but do not fake their Git premises:
`99a` grades conformance exactly as it does in `git-repo` mode — the request's
literal claims do not become N/A merely because delivery is not a merge —
`99b` runs every naturally applicable check and marks only Git-dependent
predicates N/A, and `99c` records Git delivery N/A then independently verifies
the final operational state, ambient-state preservation, and objective-native
rollback evidence before its explicit `**Delivery outcome:** PASS|FAIL`. Every
N/A cites the classifier probe. The remaining Git procedure in this section
applies only to `git-repo`.

#### One frozen candidate — every gate in a round judges the same commit

Once every ordinary slice has merged and the tree is quiescent, record the
campaign branch's tip as the round's frozen candidate SHA, and every gate in
that round judges that exact commit.
The freeze binds **the campaign branch** — the single ref each gate re-reads. It
is not a freeze on the target branch, not on `main`, and not on the live
checkout, and it never blocks a durable memory write that lands on another ref,
because a commit that cannot move the candidate cannot break the round.

What it prevents is not untidy bookkeeping. A gate that PASSes commit A while its
sibling PASSes commit B has produced two verdicts on two trees, and the campaign
still has no tree carrying two passes — a regress wearing convergence's clothes.
So gate-generated learning notes, evidence files, and gate verdicts are never
committed onto the frozen branch while the round is running: they land in the
ledger, or after the round closes.

When a round's gates provably straddled two commits anyway, one mechanical
exception applies and nothing weaker does: prove the earlier gated commit is an
ancestor of the candidate, prove the diff between them is exactly the expected
path set, and prove those paths lie outside every surface the earlier gate
inspected. Record it as a declared exception rather than waving it through.

#### One consolidated corrective slice repairs the whole round

When a round produces confirmed defects, every confirmed defect from that round
is repaired by exactly **one** corrective slice, spawned once, before any
revalidation begins. Not one slice per finding, not one slice per gate, and not a
first correction started while the later gates are still reporting. The finding
list closes when the round's last gate returns, and that closed list is the
corrective slice's scope. A defect discovered after the round closes belongs to
the next round, never to a second corrective slice inside this one.

The reason, stated so a later reader does not helpfully re-split it:
consolidation is what makes a round cost one correction plus one revalidation
instead of a correction and a revalidation per finding. Splitting buys no extra
coverage and spends another two agent lifecycles per finding.

This fixes WHAT a single corrective slice repairs. It changes nothing about WHO
grades the repair: the ownership, teach-back, and fresh-judge contract below is
untouched.

#### One environmental retry, then a baseline A/B — never a validator carousel

A failure suspected to be environmental rather than causal earns exactly one
retry, unchanged, in the same environment. If it survives that retry it is a real
defect and joins the round's consolidated finding list. If it disappears, the
next step is a like-for-like A/B against the recorded baseline — the same
command, the same dependencies, the same load, the same environment, run against
the baseline commit and against the candidate — and that comparison is read by
failure name, never by count or duration.

Spawning another validator to re-ask a question one retry and one A/B can settle
is a **validator carousel**, and it is forbidden. Each round costs a full agent
lifecycle, and the base rate of previous rounds finding defects is not a reason
to run another round on the same question.

#### Baselines are like-for-like or they are not baselines

A fallible acceptance criterion that has not first been run on the unchanged
baseline cannot be imposed on the candidate. Measure it on the campaign's
recorded base before the candidate run, using the same command and capture
conditions, then compare by failure identity. A failure already present on that
like-for-like baseline is pre-existing debt, not a candidate failure; a new
failure identity is candidate-attributable. Candidate-only green runs do not
repair the missing baseline, and an absolute pass count cannot substitute for
the comparison.

A baseline is comparable only when captured with the same dependency set, under
comparable agent load, and in the same environment as the candidate run it is
compared against. The consequence belongs in the contract, not in a reader's
head: a quiet-tree baseline compared against a candidate captured under heavy
court load manufactures failures the campaign never caused. So the recorded
baseline carries its capture conditions alongside its failure names, and a later
reader can tell whether a comparison is honest.

Comparison is by **failure name**. A differing failure count over an identical
name set is not a regression, and a new failure name is one even when the total
count fell.

**A baseline expires when the campaign absorbs the target.** Sibling campaigns
land on the target branch while a campaign runs, and delivery absorbs them. A
baseline captured at the campaign's original base does not describe the absorbed
tree — it lacks the sibling's tests entirely, so every failure the sibling
brought with it reads as a name absent from the baseline, and this campaign is
convicted for another campaign's debt. The rule: after any absorb of the target,
re-capture the baseline at the newly absorbed merge-base under comparable load
before comparing the candidate against it. A carried-forward baseline stays valid
only while the campaign's merge-base is unchanged. Say it plainly because the
failure is silent: a stale baseline does not error, it manufactures findings.

#### The owning Alpha keeps the campaign and gets one corrective iteration

**Read the scope of this section before applying it.** It governs what the
terminal gates CANNOT repair themselves: an escalated blocker `99b` named
(a missing requirement, two slices whose designs contradict), or a semantic fork
`99c` hit between landed slices. It is NOT the route for an ordinary test
failure, lint violation, or merge conflict — `99b` and `99c` own those outright
and repair them in place, and routing one here is the punt those gates exist to
forbid.

An incorrect merged candidate or a genuinely escalated blocker is evidence for
remediation, not grounds to reap or replace the owning Alpha. The default is
remediation by that same owner. Correction is a two-way teaching exchange, not a
one-way verdict, and it runs in this order:

1. **The validator teaches the failure.** Hand the owning Alpha the concrete
   contradictory evidence and the failed criterion or gate output itself — never
   a bare verdict, never a summary that drops the failing detail. That delivery
   carries three parts: reproducible evidence of the contradiction (the exact
   command, file, and line another reader can rerun), an explanation of why the
   Alpha's prior reasoning failed, and an actionable repair sketch naming the
   surfaces the repair must reach. A sketch is guidance, never a mandate: the
   Alpha may repair differently when it shows why.
2. **The Alpha teaches back.** The owning Alpha must explain the authority and
   reasoning that produced the incorrect result before it changes anything, so
   the correction addresses the actual decision path instead of blindly patching
   the symptom. In the same exchange it teaches back any domain or authority
   context the validator missed — a source clause, a constraint, or a
   dependency the failure report did not account for. That teach-back can narrow
   or overturn the finding on evidence; the exchange is bidirectional, and
   neither side's account is privileged by role alone.
3. **The Alpha repairs.** That same owning Alpha repairs the candidate and reruns
   every affected validation and gate. One iteration is the budget — this is not
   unlimited retries.
4. **A brand-new independent validator judges.** Every affected validation and
   gate is judged by fresh required validators that took no part in the exchange
   above. A failed validator identity is never reused after correction, and
   neither the owning Alpha nor the teaching validator may grade the repair.

**Collaborative self-validation is forbidden.** The pair that produced the
correction — the owning Alpha and the validator that taught the failure — may
never jointly declare the repair PASS, agree the finding away without a fresh
judge, or count their exchange as the re-gate. Teaching each other is required;
grading each other's work is not permitted. Agreement between them is input to
the fresh validator, never a verdict.

Replacing or reaping the owning Alpha is permitted only after one of exactly
three cases: the corrective iteration itself fails, the Alpha is genuinely
wedged or unresponsive, or continued ownership is unsafe. Unsafe is narrow and
evidenced — concrete evidence that continued ownership causes harm, never mere
disagreement with the owner's judgment and never a single failed result. No
fourth case exists, and no case may be broadened to cover a first failure.

This governs ownership of the campaign Alpha after failed merged-candidate or
gate evidence only. Ordinary completed-Shadow reaping and the terminal
fresh-Shadow generation rules are untouched: every corrective slice and every
re-gate still runs on brand-new workers.
