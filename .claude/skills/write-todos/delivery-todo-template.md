# The delivery todo (`99c_deliver_<topic>.md`)

Always the final executable todo and always a distinct fresh real Shadow. It
runs only after explicit `99b` PASS and owns delivery together with the
conflicts delivery hits in `git-repo` mode: it merges the latest target branch
into the campaign branch, resolves every conflict there, and then delivers the
result to the target. When the deliverable is a pull request (the queue row's
launch facts carry `pr: <branch>`, or the objective says so), the todo also
pushes the human-named PR branch with `throne forge push-branch` and opens the
draft PR from it with `throne forge pr create --draft`, so on a host where
Forgejo is installed the PR lands in Forgejo — see
`/execute-todos` "Pull-request delivery": the branch, the PR title and body,
and every pushed commit message are written as the repository's own
contributor would write them, and never name `alpha`, `shadow`, an objective
code, an agent, a bundle or a gate. Write the PR branch name and the base
branch into the todo verbatim; a `99c` that has to guess them is a defect of
this bundle. When the deliverable is a PR and the bundle's `ticket-warning.md`
holds a warning block, `99c` puts that block verbatim at the very bottom of
the PR body, after `## Agents`, as the `## Ticket Status` section
`/pr-description` describes; `no warning needed` means the body has no
`## Ticket Status` section at all. In `no-git` mode it invokes no merge tooling: it records
Git delivery as N/A with the classifier reason, verifies the requested
operational outcome with its naturally applicable evidence, and records the
explicit final outcome.

```markdown
---
deps: [99b]
---

# 99c — Merge the latest target into <feature>, then deliver it

Fresh delivery Shadow. Use plain git throughout; this gate invokes no throne
merge tooling. Merge the recorded target branch INTO the campaign branch with
`git merge` and resolve every conflict there — never on the way past, and never
on the target. Re-run the bundle's checks on the merged result.

**You own the conflict resolution. Do not punt to the Alpha.** Every conflict
this merge raises is yours to resolve, by reading both sides and deciding —
never returned upward as a finding, never left for a corrective slice, never
handed to a fresh Shadow. A merge conflict is the expected content of this
assignment, not an obstacle to report. Escalate only if resolving one would
require a decision the bundle never made — a genuine semantic fork between two
landed slices — and say exactly which two. Then re-read the
target HEAD: if it moved, absorb and re-check again, and repeat for as long as
the target keeps moving.

Only when the campaign branch is current with a target whose HEAD is unchanged
since that final check, deliver it with plain git — check out the target branch
and `git merge` the campaign branch, one integration round. No throne merge
tooling. Inspect the resulting target diff and content, then run named smoke
checks that exercise the delivered feature on the target.

Prove delivery with plain git, do not assert it. Show the campaign's commits
reachable from the target tip (`git log`) and an empty `git diff` between the
delivered paths on the two branches, and paste that exact output into the
report.

Bracket the live merge: record a path-qualified working-tree inventory and
content manifest — tracked, staged, and untracked alike — before you touch the
target, compare it afterwards, and restore anything that changed. Plain git
carries no stash-and-restore of its own, so this bracket is the only protection
the ambient dirt has.

When delivering a pull request and this bundle's `ticket-warning.md` holds a
warning block, put that block verbatim at the very bottom of the PR body, after
`## Agents`, as the `## Ticket Status` section `/pr-description` describes.
When it reads `no warning needed`, the body has no `## Ticket Status` section
at all.

Never leave the live target in a conflicted merge state. An unexpected conflict
during real integration is abandoned and the target is returned to its pre-merge
baseline before any further attempt.

## Deliverable

- End with exactly one `**Delivery outcome:** PASS` or
  `**Delivery outcome:** FAIL`.
- A PASS without cited git output showing the campaign's content on the target
  branch is not a valid terminal report.
- Never fast-forward a target whose HEAD moved after the final check; that target
  has not been checked against, so the absorb loop repeats instead.
- The absorb loop is bounded by the target going quiet, never by a retry count.
- Any integration failure, target-content mismatch, or failed smoke check leaves
  the campaign incomplete and forbids `REPORT.md`.
```

**Legacy compatibility.** Pre-amendment bundles keep their authored meanings:
a bare `99_validate` remains a historical validation gate, and any older
multi-gate chain — the two-gate `99a` verify-and-fix → `99b` merge-and-deliver
chain that preceded the 2026-08-25 renumber, `99b_validate`/`99c_merge`, or the
five-gate `99a` absorb → `99b` file-size → `99c` static analysis → `99d`
validate → `99e` deliver — keeps the meaning its files were authored with. Run
those files as written with fresh terminal Shadows. New bundles generate only
the three-gate `99a` conformance → `99b` verify-and-fix → `99c`
merge-and-deliver chain above.

Because the bare letter is therefore ambiguous across generations, the throne
classifies a terminal gate by its ROLE WORD, not its letter
(`terminalGateRoleFromShadowName` in `src/merge-git-tree/terminal-gate-shadow.ts`).
Keep the verb in every terminal filename — `99a_conform_<topic>`,
`99b_verify_<topic>`, `99c_deliver_<topic>` — or a delivery gate stops being
recognisable as one.

`98_ticket_<topic>` keeps its role word too. It is the last ordinary-band
number, so it runs after every other ordinary slice and before `99a`, and it
is not one of the three terminal gates the throne classifies by verb.
