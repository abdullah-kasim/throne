---
name: write-and-execute-todos
description: This skill should be used when a throne campaign Alpha plans an objective into a todo bundle AND immediately runs it end-to-end in one shot — fully async, no human checkpoint between planning and execution. Invoked by /write-and-execute-todos (aliases: /plan-and-run-todos, /do-all-todos), or when the tasking says "plan and execute", "write todos and run them", "plan this then do it", "full auto todos", or "plan and ship it". Runs ONLY inside the throne orchestrator and refuses elsewhere. Chains /write-todos then /execute-todos on the just-created folder, deferring every question to the bundle's errata file instead of blocking.
version: 0.13.0
user-invocable: true
---
> ## NO PROCESS DEVIATION. THE GATE CHAIN IS NOT OPTIONAL.
>
> **The Lord's order of 2026-08-14**, after three campaigns skipped the chain in
> one day. You run the full real-Shadow gate chain, every slice, every campaign.
> **We do not care about your model's capability, reasoning budget, context
> budget, or self-assessment. JUST DO IT.**
>
> "The diff is small", "it is only test constants", "this was ad-hoc so the
> bundle machinery does not attach", and "I ran every check the chain would
> have run myself" are all **explicitly refused**. The chain's value is that the
> reader is NOT YOU — a self-check reproduces the reasoning that created the
> defect. See `execute-todos/SKILL.md` -> "NO PROCESS DEVIATION" for the
> measured cases, including a self-certified retry loop that would have
> delivered messages TWICE into a live pane.
>
> **If you genuinely cannot run it: STOP and ask your supervisor BEFORE
> proceeding.** Deviation is a Regent-or-Lord decision, never yours. Disclosing
> it honestly after the merge does not make it authorised.


# Write a todo bundle, then execute it — fully async

This is a **chaining** skill that runs the two halves of the todo workflow back to
back with **no human checkpoint** between them. The whole point is async: the user
fires it and walks away. Nothing in this flow blocks on the user — every question,
scope call, and caveat is deferred to the bundle's errata file and answered with a
best-judgment default, exactly like `execute-todos` rule 5.

**Entry guard, inherited.** This chain runs ONLY inside the throne orchestrator —
both skills it chains are throne-only, and `execute-todos`' "Entry guard" section
holds the one canonical throne-context resolver. Run that guard FIRST, before any
planning: outside throne context this chain inherits the same loud refusal (run it
from a throne session, or have the Regent spawn a campaign Alpha), and its aliases
(`/plan-and-run-todos`, `/do-all-todos`) inherit it in turn.

Use it only when the invoker has explicitly asked to plan **and** run in one shot.
If they want to eyeball the plan first, use `/write-todos` alone.

## A TEST ITEM OVER TEN SECONDS IS A BUG. MOVE THE BOOTSTRAP OUT.

**Lord's law, 2026-08-21, verbatim:** *"also i declare that any test item that
takes more than 10 seconds as a bug. if the test involves bootstrapping, then do
the bootstrapping outside of the test. Update the todos skills on this."*

**The second sentence is the mechanism, not an aside.** He is not asking for
tests to be deleted or assertions weakened. He is naming *why* they are slow —
per-test bootstrapping — and saying where that cost belongs instead.

**Why it is worth your attention while writing or executing a slice:** measured
over 3,901 timed items in one full run, **41 items exceed ten seconds — 1.05% of
the tests owning 64% of total test time.** Nearly all of them boot something per
test: a real Nest container, a real CLI dispatch, a cross-process concurrency
proof.

So when your slice adds or touches a test:

- **If it boots something, boot it ONCE outside the test** — a shared fixture, a
  suite-level setup, a prebuilt artefact — rather than per item.
- **Do NOT drop an assertion to get under ten seconds.** That breaks this law
  rather than satisfying it. The remedy is to move the cost, never to remove the
  coverage.
- **Do NOT gate a slow test behind `THRONE_HEAVY_TESTS` and call it solved.**
  Gating relocates the cost; the test is still slow wherever it runs. Gating and
  this law are complementary and neither substitutes for the other.
- **ENFORCEMENT IS MANDATORY — `npm test` FAILS on a violation.** Not warns, not
  reports. The Lord's follow-up: *"npm test should fail if something ran for more
  than 10 seconds."* He was asked to reconsider on flakiness grounds and
  reaffirmed. An earlier ruling calling this a bug-not-failure threshold is
  WITHDRAWN — do not revive it. Contention is real, so state any margin with its
  reasoning, and make the failure message name **both** the measured duration and
  the threshold.
- **Existing slow tests are not grandfathered.** They bind under a manifest that
  may only shrink.

**Report, do not file.** If you find a slow test outside your slice's scope, name
it in `REPORT.md` with its measured duration. Do not create a queue item for it —
see the direct-blockers law above.

## EVERY TEST IS AN INTEGRATION TEST, NAMED FOR THE REQUIREMENT

**Lord's law, 2026-08-21, verbatim:** *"update the todos skill to ensure that all
tests are integration tests - I don't want unit test, i want a test that when I
say 'we should be able to message the user', then the test would be named 'we
should be able to message the user'. The test is named based on the requirement,
NOT 'x function must return y'."*

Two rules, and the second is the enforceable one.

**1. NO UNIT TESTS. Every test is an integration test.** A test exercises the
behaviour through the real path a user or a caller would take. It does not reach
into one function, hand it arguments, and assert on its return value in
isolation.

**2. THE TEST NAME IS THE REQUIREMENT, IN THE LANGUAGE THE REQUIREMENT WAS
STATED.** If the Lord says *"we should be able to message the user"*, the test is
named `we should be able to message the user`. Not
`sendMessage() returns ok for a valid recipient`.

```
WRONG   resolveAgentName() returns undefined for an unknown name
RIGHT   messaging an agent that does not exist refuses instead of guessing

WRONG   parseQueuePriority throws on a non-integer
RIGHT   a queue item cannot be filed with a priority that is not a whole number

WRONG   reapAgent() sets status to complete
RIGHT   an agent that finished its work can be reaped without --force
```

**Why the naming rule carries the weight.** A test named for a function is
anchored to today's implementation: rename the function, split it, inline it, and
the test name becomes a lie while still passing. A test named for the requirement
survives every refactor that preserves behaviour and fails honestly when the
behaviour changes. **The name is the specification; the code underneath is one
way of checking it.**

It also makes the suite readable as a list of what the system promises. Anyone —
including the Lord — can scan the test names and see the requirements. A list of
function signatures tells him nothing he asked for.

**What this does NOT license:**

- It does not license **testing through the slowest possible path**. The
  ten-second law above still binds, and it binds harder now: bootstrapping moves
  OUT of the test, shared setup is built once, and the integration test asserts
  on real behaviour without re-booting the world per case.
- It does not license **vague names**. *"messaging works"* is not a requirement,
  it is a shrug. The name must be specific enough that its failure tells you what
  promise the system broke.
- It does not license **deleting coverage that has no requirement written down
  yet**. If a test guards real behaviour and nobody can state the requirement it
  serves, that is a requirement waiting to be articulated, not a test to discard.
  Write the sentence, then name the test with it.
- It does not license **one enormous test per feature**. One requirement, one
  test. A requirement with three distinct promises is three tests, each named for
  its own promise.

### NO END-TO-END TESTS

**Lord's law, 2026-08-21, verbatim:** *"also, no end-to-end test shall be
written. they're too costly."*

Combined with the rule above, the permitted band is exactly one wide:
**not unit, not end-to-end — integration only.**

**THE BOUNDARY, because a campaign frozen between two laws ships nothing.** The
line is *what the test starts up*, not how many layers it touches:

| | starts up | verdict |
|---|---|---|
| unit | one function, arguments in hand | FORBIDDEN — too narrow, names the implementation |
| **integration** | **the real code path by CALLING THE FUNCTION THAT DOES THE WORK, in-process, real collaborators behind it** | **REQUIRED** |
| end-to-end | real external infrastructure — spawned agents, live terminal sessions, containers, systemd units, networks, third-party accounts (browsers struck 2026-09-02, see amendment below) | FORBIDDEN — too costly |

**Amendment — the Lord, 2026-09-02, verbatim:** *"I retract my law forbidding
browsers as test infra. This was an issue previously because I ran out of
resources, but we've improved the autoscaler a LOT."* Browsers are therefore
struck from the forbidden row: a headless-browser test or evidence capture is
permitted infrastructure. The rest of the row — spawned agents, live terminal
sessions, containers, systemd units, networks, third-party accounts — was not
named in the retraction and stays forbidden.

**An integration test may use real internal collaborators freely.** Real
in-process wiring, a real temporary database, a real filesystem under a temp
root, a real object graph. It stubs at the boundary where the process would
otherwise reach out and start something it does not own.

**The test asks a caller's question through the caller's door.** Everything on
your side of that door is real; everything past it is stubbed.

**Why "too costly" is the right reason and not laziness.** End-to-end tests in
this codebase are where the runtime goes: real spawns and real container boots
dominate the slowest tests, they are the ones that fail under contention for
reasons unrelated to the code, and their failures are the hardest to attribute.
They buy confidence at a price that compounds on every run, for every agent,
forever.


#### CALL THE FUNCTION, NOT THE BINARY

**Lord's clarification, 2026-08-21, verbatim:** *"for integration test - do not
include public entry point - but the underlying function instead. I don't want
use to do tests for './bin/throne-cli update-queue' but instead, test
'updateQueue()'."*

```
WRONG   spawn ./bin/throne-cli update-queue --objective-code x --priority 9
        then assert on the process's stdout and exit code

RIGHT   call updateQueue(store, input) directly and assert on what it did
```

**This is not a softening of the integration rule — it is what makes it
affordable.** Shelling out to a binary starts a process, boots the whole command
framework, and pays the harness cost on every single case. That is the same cost
that makes end-to-end tests forbidden, arriving through the back door. A test
that invokes the CLI to check a queue mutation is an end-to-end test wearing an
integration test's name.

**So the entry point of an integration test is THE FUNCTION THAT DOES THE WORK** —
the runtime, the service, the handler — reached in-process, with its real
collaborators behind it. Not the CLI wrapper, not the binary, not the argv
parser dressed up as a user.

**The argument parsing is not the requirement.** *"we should be able to update a
queue item's priority"* is a promise about `updateQueue()`. Whether the flag is
spelled `--priority` is a separate, much smaller question, and the handful of
tests that genuinely cover argv belong to the parser as its own subject — not
bolted onto every behavioural test by launching a process to get at it.

**The three rules compose into one instruction:** name the test for the
requirement, call the function that fulfils it, and let everything behind that
function be real.


**What this does NOT license:**

- It does not license **stubbing your own code**. The boundary is the edge of the
  process's ownership, not the edge of the file you are editing. Stubbing a
  collaborator you wrote turns an integration test back into a unit test with
  extra steps, and the rule above already forbids that.
- It does not license **abandoning the requirement**. If a promise can only be
  demonstrated end-to-end, that is a finding to report, not a test to smuggle in
  and not a promise to quietly drop. Say which requirement is unverifiable under
  this law and why, and let it be decided rather than decided by default.
- It does not license **deleting an existing end-to-end test on sight**. The law
  is *shall be written* — it governs new tests. Whether the existing real-infra
  tests are removed, kept behind their gate, or rewritten as integration tests is
  a separate decision and not a campaign's to take unilaterally.


**In a todo bundle:** the `## Deliverable` section states requirements as
sentences, and those sentences become the test names verbatim. If a deliverable
cannot be written as a sentence someone would say out loud, it is not yet a
requirement and the slice is not ready to plan.

## DO NOT MANUFACTURE MORE WORK. DIRECT BLOCKERS ONLY.

**Lord's law, 2026-08-21, verbatim:** *"ok make this law. this isnt working out.
the todos skill MUST NOT ask regent to create more alphas or create more queue
items UNLESS they are direct blockers to the task at hand."*

Read **"this isnt working out"** as the operative half. It is a judgement on
outcomes, not on queue hygiene. A court that delivers steadily while every
campaign spawns successors leaves the Lord further from his own objectives, not
closer. This rule stops a growth process.

**DIRECT BLOCKER** means *this campaign's own stated deliverable cannot be
completed until that work is done.* Not "would be better if". Not "we noticed
while here". Not "someone should". **If you have to ARGUE that something is a
blocker, it is not one.** The burden is on you, and an unclear case resolves
against filing.

So:

- **Do NOT call `add-to-queue`** for anything that is not a direct blocker.
- **Do NOT ask the Regent to spawn another Alpha** for non-blocking work.
- **Do NOT route it through your supervisor.** Asking the Regent to file the row
  instead is the identical outcome with an extra hop, and is equally forbidden.
- **Do NOT attach a recommendation that a finding be filed.** Report the finding;
  the disposition is the Lord's, made later, from your report. It is no longer
  the Regent's to make — `add-to-queue` admits the Stager role alone, and the
  Stager files only on the Lord's own instruction.

**Report everything you find.** This rule is not a gag. A campaign that buries a
discovery to avoid looking like it grew its scope has broken the rule in the
other direction and lost the finding as well. Findings go in `REPORT.md` — named,
with evidence, and with what you did NOT do about them.

**A genuine blocker is YOURS to fix. Expand scope and clear it (Lord,
2026-08-21).** If you truly cannot deliver without some other work, do that
work — inside this campaign, as a numbered slice — and then deliver. Do NOT
hand it to the Regent, do NOT ask for another Alpha, and do NOT stop and wait.
There is nowhere to pass it to: `add-to-queue` now admits the Stager role
alone, and the Stager files only on the Lord's own instruction, so a blocker
punted upward becomes nothing and the campaign stalls holding it.

Widening for a blocker is correct rather than scope growth, by the same test
this rule already uses: it is work the ALREADY-STATED Done-when cannot be
reached without. Declare the widening — name the blocker and the slice that
clears it in the overview and `REPORT.md`. Escalate to the Lord only when the
blocker cannot be cleared inside the campaign at all, or when clearing it would
change the Done-when into a different objective.

**Correcting your own incomplete decomposition is not scope growth** and remains
yours under the mid-flight amendment contract. The test is whether the
**Done-when changed** — not whether the slice list did. An unchanged Done-when
whose slices could never have delivered it is an error you fix; a changed
Done-when is a new objective and only the Lord may expand an active bundle.

**Note for implementers:** this prohibition is stated because the banned
behaviour is *emergent*, not instructed. No todos skill ever contained an
instruction to file queue rows. Grepping for one and finding nothing disproves
nothing.

## Model policy — inherit both gates, duplicate no selector

Both phases resolve every agent they dispatch through `MODEL_POLICY.md`. They
first run
`<live-throne>/bin/throne-cli list-harnesses-and-models --json` against the
entry guard's resolved live root and read the
top-level `active_plan` before any other selector. PLAN and ORCHESTRATOR use the
ordered `rolePools.Alpha`, ordinary workers use `rolePools.Shadow`, and both
terminal `99a`/`99b`/`99c` Shadows use `rolePools.ShadowSlice99`. Each
pool is a hard full-pair allowlist. The shared resolver admits only a canonical,
mechanically spawnable pair from that pool or a campaign role pin/allowlist,
valid queue `model_hint`, or durable human exception. Missing or malformed plan
data pauses instead of inventing a route. No remap, upgrade, automatic
escalation, or retry ladder may select another pair.

Native Codex is a normal harness; the live role pool is the permission boundary.
Fresh GPT routing follows `ACTIVE_GPT_HARNESS_POLICY_NAME` in `src/config.ts`,
while the role pools and steering engine still reason over the canonical
Codex/GPT rows. `write-todos` owns PLAN; `execute-todos` owns ORCHESTRATOR and both
terminal Shadows. `create-agent` owns the shared admission result, and
`execute-todos` records the request, final route, reason, and durable evidence.
Tooling refusals remain authoritative and go to the Regent for a human route
decision.

Both phases use the shared resolver rather than ranking or pinning pairs here.
`model_hint` persists with the Alpha and inherits only through that campaign's
recorded descendants. Exact registered resumes keep their stored effort because
they are not re-choosing it. The full admission contract lives once in
`execute-todos/SKILL.md`; do not reimplement it here.

The existing `--bypass-alpha-guardrail` remains a loud one-spawn Alpha capability
override. Honor it only when the current Alpha inspects its own durable
`~/.throne/data/<agent-name>/identity.md` and finds the target-named
`Policy override for <agent-name>:` line naming the flag. Never infer it from
the current model, caller stdout, or caller logs. It does not bypass VALIDATE or admit a pair absent from `rolePools.Alpha`.
Fresh GPT defaults follow the configured forward GPT policy; an explicit alternate fresh GPT request may use `--bypass-harness`, which changes only harness selection. `--bypass-model` and `--bypass-effort` each bypass exactly their own steer; usage steering is mandatory.
`--bypass-preset-agent` retains its narrow role-gate meaning. None bypasses a role pool.
Ordinary slices, non-coding floors, the one-fresh-worker rule, and the
real-Shadow worker mandate are otherwise unchanged.

## Todo-run personality — the three-way boundary this chain carries

Both phases resolve the same three values, and the boundary between them is
identical in all three skills:

- **focused** (explicit request only; the strictest): no discretionary work at
  all — no sidequest slices AND no discretionary refactors, not even a
  behavior-preserving simplification.
- **default** (the default): identify the feature's original promise, intent,
  and acceptance contract, choose the smallest implementation that fulfills
  it, and ship as soon as it is fulfilled. Add no feature, abstraction,
  configurability, speculative edge-case machinery, future-proofing, or
  optional robustness. Complexity may increase only when named concrete
  evidence shows the simple implementation misses an original requirement or
  a reproduced bug requires a correction, and the added mechanism must stay
  minimal to that cause. Admissible work is limited to exact user-requested
  outcomes, candidate-caused regressions, and the minimum defect-clearing work
  required when a discovered issue truly blocks that requested outcome. A
  discovered unrelated or pre-existing defect is report-only: record it as a
  separate finding, but do not let it expand scope, create corrective work, or
  become acceptance criteria. Boy Scout cleanup under `default` is limited to
  behavior-preserving structural hygiene: DRY/SOLID conformance, readability,
  local duplication and dead-structure cleanup, and keeping production files
  within the repository's 500-line boundary. It never authorizes fixing a
  different functional bug. Validation grades the initial promise and known bug
  fixes; it must not manufacture requirements, edge cases, robustness goals,
  unrelated findings, or other scope.
- **perfectionist** (explicit request only): feature and experience sidequest
  appetite, plus codebase-wide principle hunts. Neither `default` nor
  `focused` ever opens a discretionary sidequest slice.

## The one errata file, shared across both phases

Both phases write to a single non-blocking question log in the bundle folder:
`000_current_questions.md`. The user reads and corrects it out of band; the queue
never waits. Entry format is `execute-todos` rule 5's format — question, assumed
answer, reversibility, blank `User answer:` slot for the user to override.

## Commit-message contract — reference the owner

Every commit produced by either phase follows `execute-todos/SKILL.md` →
"Task-focused commit-message contract — single owner". This chain only carries
that contract through planning, implementation, validation, delivery, correction,
reporting, checkpoints, and its `/plan-and-run-todos` and `/do-all-todos` aliases.
It duplicates no forbidden-term list, examples, or acceptance logic.

## Semantic contract handoff — reference the owners

Planning states semantic decisions, invariants, reuse obligations, evidence, and
observable outcomes; `write-todos/SKILL.md` owns that planning-altitude contract.
After code recon, execution names and refines the predicates, transformations,
decisions, and effects; `execute-todos/SKILL.md` owns that semantic-function map
and the review rule that grades shared semantic predicates plus outcome/mutation
evidence rather than planner mechanics. Planning also proposes a legible shape in
the overview's `## Proposed function contract map`, whose law `write-todos` owns
and whose refine-and-record obligation `execute-todos` owns; the proposal is
never binding on the executor. This chain only sequences that handoff and
legislates nothing new.

The same inheritance applies to the platform-first audit. `write-todos`
invents no new machinery before inventorying current stdlib/platform/installed-
dependency primitives and preferring reuse, then a thin wrapper; `execute-todos`
re-checks that audit after recon and when repairs or dependency evolution
suggest duplicated ownership. This chain carries that same audit through
planning, execution, validation, aliases, and reporting without creating a
second rulebook.

## Legacy-feature freeze — reference the owners

Both phases of this chain are bound by the legacy-feature freeze on this
repository's `src/` tree. Its durable law is the throne's `AGENTS.md` and its
executable decision is `src/nest-commander/`. The routing this chain relies on
already lives in the two skills it chains: `write-todos/SKILL.md` routes
new-capability planning through the freeze, and `execute-todos/SKILL.md` binds
both the executing Shadow and the terminal gates to it. This chain sequences
those two and states no freeze rule of its own, so there is no third copy to
drift.

## Protocol

1. **Plan — async, straight through.** Invoke `write-todos` and follow it, with
   one posture pinned: **it runs straight through** — `write-todos`' step-2
   sketch is a self-review point, never a pause, and in this chain execution follows
   the written files immediately; nothing waits on an approval. The planning
   model gate is unchanged, and the planning pass runs at whatever effort the
   Alpha already holds — this chain pins no effort anywhere. Along the way:
   - Pin scope / topic / breakdown yourself with a defensible default.
   - Stamp `bundle_content:` in `00_overview.md` per `write-todos`' rubric, so
     the gate's judgment lenses are unambiguous before execution starts.
   - Resolve and stamp the todo-run personality in `00_overview.md`. An ordinary or root invocation resolves the user's explicit `focused` or `perfectionist` request first, and that explicit choice stays authoritative and always wins; otherwise resolve and stamp `default`.
   - Log any genuine ambiguity (vague scope, contested framing, a breakdown choice
     that could reasonably go another way) to `000_current_questions.md` with your
     assumed answer and reversibility — then proceed on that answer.
   - Still do step 2's traceability check (every `Done when` criterion maps to a
     slice and back). That's a self-check — keep it.

   This produces a `todo-<iso-timestamp>-<topic>/` folder. **Record its exact path.**

2. **Execute — initial absorb, file size, static analysis, implementation validation, then delivery.** Invoke
   `execute-todos` pointed at the folder from step 1. It already runs non-blocking
   (rule 5) and appends to the **same** `000_current_questions.md`, so planning
   assumptions and execution assumptions accumulate in one place. Run every
   slice under `execute-todos`' single owning "Delivery-mode classification".
   `git-repo` uses its authoritative exact-one-commit `merge-git-tree` path;
   `no-git` skips Git-only setup, gates, and delivery with evidence-backed N/A
   reasons while validating and recording the requested operational outcome.
   This chained skill adds no transport or remote-operations behavior.
   Run every
   ordinary slice, then the exact three-terminal-Shadow chain owned by
   `execute-todos`: `99a` grades the candidate against what was literally
   asked for and returns a verdict without repairing anything; then `99b`
   verifies and fixes — it makes the assembled candidate
   green, committing its own fixes, preserving ambient dirt and running
   post-absorb checks before any judgment; then a fresh `99c` merges and
   delivers — it absorbs the latest recorded target into the campaign branch
   and revalidates until the target goes quiet, then invokes the authoritative
   Alpha-tree merge — a fast-forward by then — exactly once, and only after a
   conflict-free absorb of the recorded target branch into the recorded
   candidate inside a private copy of the recorded target repository, with the
   bundle's merge-result checks passing there — any conflict or failed check
   blocks real integration;
   (**Legacy compatibility.** A pre-amendment bundle already authored with a
   retired chain — the two-gate `99a` verify-and-fix → `99b` merge-and-deliver
   chain that preceded the 2026-08-25 renumber, or the five-gate `99a` absorb,
   `99b` file-size, `99c` static analysis, `99d` validate, `99e` deliver —
   keeps the meaning its files were authored with; run those files as written
   with fresh terminal Shadows. New bundles generate only the three-gate chain
   above, per `write-todos`' "Legacy compatibility" and `execute-todos`'
   "`99a` grades conformance, `99b` verifies and fixes, then `99c` merges the
   latest target and delivers", which own this contract. Terminal gates are
   classified by their ROLE WORD, not their letter, precisely because the
   letters mean different things across these generations.)
   `execute-todos`' "The delivery rehearsal" section owns that procedure, the
   live target is never left conflicted, and every live merge or abort is
   bracketed by a recorded working-tree inventory and content manifest. It then
   treats any inapplicable 99 slice as `N/A — no-op`, records the reason without
   spawning that Shadow, and marks the slice immediately reapable.
   inspects the delivered target. The target's content/diff must show the
   intended changes and named post-merge smoke checks must exercise the
   delivered functionality (certifying the merge command or a SHA is not
   evidence). The target also matches its recorded pre-merge baseline
   (baseline-relative hygiene — a dirty target restored exactly still passes;
   the proof never touches ambient dirt). The
   absorb loop is bounded by the target going quiet; the separate PX2 tripwire in
   `execute-todos` rule 6 caps a merge that will not land
   at two rounds and hands a needed third round to the Alpha's own plain git plus a
   process-defect finding. The Alpha executes none of the terminal todos.
   `execute-todos` owns the final route, including quota/usage changes to model
   or harness, and records the request, final route, reason, and admission
   evidence. The chain passes no `--effort` and no bypass flags for terminal
   spawns. Gate strength comes from a
   fresh independent reader, not from a pinned effort.
   Slice order and overlap are `execute-todos` rule 3's business, not this
   chain's: it releases every slice whose `deps:` are merged and whose
   `touches:` footprint is disjoint from the still-running ones, up to its
   concurrency cap, and serializes the rest. This chain neither forces
   one-at-a-time execution nor raises that cap.
   Per-slice workers `01`–`98` spawn the same way, requesting inside the
   execution-shadow allowed set and letting the usage steer pick.
   `execute-todos` spawns each slice worker as a
   real **Shadow** (own herdr tab + worktree, visible in `agent-statuses`) instead
   of an in-harness subagent — see its Rule 2 per-slice sequence. Nothing
   extra to do here; this chain inherits that behavior.

   Every bundle is gated, documentation and analysis bundles included; the
   bundle's content narrows which judgment lenses the gate works, never whether
   it runs. `execute-todos`' Tier 1 owns that selection — this chain neither
   repeats nor overrides it.

   Completion requires the latest fresh final validator's explicit `**Overview outcome:** PASS` over the final assembled state.
   In new bundles that validator is `99b`, preceded by a `99a`
   `**Conformance outcome:** PASS` that must cover every exact source clause
   literally; successful fresh-Shadow `99c` delivery is also required. A `99a`
   FAIL is corrective work for the Alpha and forbids `99b` and `99c`. For `no-git`, that
   delivery is the mode-specific explicit N/A plus final operational outcome
   owned by `execute-todos`. Numbered slices, execution logs, landed commits, and green tests are supporting evidence only and never establish chain completion.
   An undelivered `99b` PASS likewise never establishes chain completion. An absent or FAIL verdict returns control to execute-todos for corrective work and a brand-new independent final validation loop.
   An absent or failed `99c` leaves the bundle incomplete and forbids reporting.
   For read-only/reporting tasks, when every requested objective and required output has been achieved, including
   explicitly recorded `N/A — no-op` terminal slices where applicable, the Alpha
   is reapable after its supervisor handoff; do not keep it alive for unrelated
   work or extra validation.

3. **Report.** Only after explicit `99a` `**Conformance outcome:** PASS`,
   explicit `99b` `**Overview outcome:** PASS` and
   subsequent successful `99c` mode-specific terminal outcome, write `$THRONE_DATA/$ALPHA/REPORT.md`
   FIRST — before the chat summary — exactly as `execute-todos`' Final report
   shape mandates; only after it lands do you report upward.
   When you are ready to be reaped, tell your supervisor first (the primary,
   never-dropped requirement) and, for an Alpha, only after the complete `99c`
   delivery gate. Shadows publish the canonical claim supplied by their
   generated assignment's completion section after slice PASS and supervisor
   handoff; this skill does not duplicate that literal protocol.
   That inherited final report shape includes two separate mandatory sections:
   implementation accounting (changed files, delivered behavior, key decisions,
   explicit boundaries) and real-E2E evidence (real stack/transport, setup,
   exact commands/actions, observations/evidence, verdict, deviations from
   plan), plus the inherited platform-first audit section (current
   stdlib/platform/installed-dependency primitives considered, reuse or thin-
   wrapper decision, any accepted custom machinery, and concrete evidence for
   each missing guarantee). Give `execute-todos`'s full final report shape, and
   surface the full `000_current_questions.md` (or a digest) so the user sees
   every assumption the run rode on — both planning and execution — in one list
   to correct out of band. The final report surfaces the explicit overview
   verdict and never claims completion from process evidence alone.

## Corrected-axis regression authoring — vary the input the guard corrects

When this chain authors a regression for a guard or correction, the bundle and
its tests must name the input axis the implementation exists to correct and the
protected predicate on that axis. They must exercise at least one value that
fails the protected predicate without the guard and changes outcome because of
the guard. Reject a broad matrix that varies unrelated dimensions while freezing
the corrected axis at an already-passing value: volume on the wrong axis is not
a witness for the correction.

YYY is the compact cautionary example. The suite swept usage and routing
combinations while keeping the protected requested-model axis fixed at the
already-capable `fable`, so a broken capability correction
remained green. A valid witness instead varies the protected model axis with a
below-floor value such as `sonnet` and observes the corrected outcome produced
by the guard.

## Discretionary-sidequest handoff — explicit-perfectionist parent only

This narrow chain-level override fires only when the parent run was explicitly requested as `perfectionist` **and** discretionary sidequests actually surface during planning or execution. With `default` the default, every `perfectionist` parent is necessarily an explicit request — there is no assumed-perfectionist path into this section. For that explicit-perfectionist parent only, it supersedes `write-todos` sidequest-slice creation and `execute-todos` tiny/substantial inline sidequest behavior — do not edit either underlying skill. A `default` or `focused` parent, or a `perfectionist` parent that surfaces no discretionary work, never triggers it.

Collect every discretionary sidequest discovered during planning or execution into exactly one parent-bundle file named `000_discretionary_sidequests.md`.
Do not create parent numbered sidequest slices, do not fold these sidequests into existing parent slices, and do not execute them inline in the parent run.

That file must preserve the original parent request together with the parent `00_overview.md` objective, its `## Done when` acceptance criteria, and enough relevant scope context to judge later whether each candidate demonstrably helps perfect the original parent task.

The generated file must carry a concrete machine-readable handoff header that names the one-depth bound and the focused child contract:

```yaml
---
sidequest_handoff_depth: 1
todo_run_personality: focused
---
```

A parent sidequest handoff may run only after the parent overview outcome explicitly passes.
After the parent finishes all its normal slices, its `99b` verify-and-fix PASS, and its `99c` merge-and-deliver, it runs the second-round invocation: only after that parent validation and delivery does it invoke `/write-and-execute-todos <absolute path to 000_discretionary_sidequests.md>` exactly once, and it passes no `focused` or `perfectionist` qualifier so that second-round invocation stays unqualified. The generated `000_discretionary_sidequests.md` already carries the explicit mechanical `focused` stamp above, and that explicit stamp — not the unqualified invocation, which absent it would resolve to `default` — is what binds the child to the strictest scope.

At the start of that second-round invocation, and before authoring or executing any child bundle, re-evaluate every collected candidate against the preserved original parent task, judging each candidate on its own merit rather than on the label the parent attached to it. Record every candidate as kept or dropped with a brief reason. Keep only candidates that demonstrably help perfect the original parent task; explicitly drop unrelated, speculative, duplicate, or merely pleasant candidates.

If zero candidates survive that re-evaluation, record that outcome with the same keep-or-drop reasons and do not author a child bundle or child workers at all.

If one or more candidates survive, author exactly one focused child bundle from only the kept candidates, and retain the dropped candidates as audit context.

The depth-1 child that this handoff generates is mechanically resolved and stamped `focused`, and it must not create another `000_discretionary_sidequests.md`, and it must never recursively invoke or launch another `/write-and-execute-todos` child.
The maximum automatically generated sidequest depth is therefore exactly one.

A later user-explicit root invocation keeps its normal explicit personality authority; this generated unqualified child is a bounded internal handoff, not a global override of any explicit user choice.

## Hard rules

- **Never block on the user.** No interactive question tool (claude's
  `AskUserQuestion` or any harness equivalent), no "should I…?" pause, in either
  phase. A defensible-but-reversible default the user can veto beats a stalled queue.
  Flag irreversible defaults (`Reversible? no`) loudly in the errata file.
- **Mid-run steering is an amendment, not a chat.** Because this chain crosses the
  planning/execution seam without a checkpoint, user steering can land in either
  phase. Either way it follows `write-todos`' "Mid-flight amendments — the one
  reconciliation contract" verbatim — appended as the next ordered source turn in
  `00_overview.md` and reconciled before further affected work, never carried only
  in the errata file or this chain's report. An amendment recorded after a
  terminal PASS makes that PASS stale: an amendment changing what was asked for
  requires a fresh `99a` Shadow, one changing code requires a fresh `99b`, and
  either forbids `99c` until it is re-run. This
  chain adds no exception and defines no alternative lifecycle; the obligations
  named here are the seam-crossing minimum, and that contract governs wherever
  this wording is thinner.
- **Scope expansion requires a direct Lord amendment.** Regent may relay the
  Lord's exact wording verbatim with direct-Lord provenance, clarify existing
  requested scope, and coordinate the minimum correction of a candidate-caused
  regression or demonstrably outcome-blocking defect. Regent-originated
  features, unrelated bugs, robustness goals, cleanup outcomes, and new
  acceptance criteria are findings queued as a separate objective with a new
  Alpha; never append them to the active bundle. This is the chain's operational
  summary of the owning `write-todos` contract, not a second policy surface.
- **A failed gate remediates the owning Alpha, it does not replace it.** An
  incorrect merged candidate or a failed gate returns to the owning Alpha with
  the concrete contradictory evidence and the failed criterion or gate output,
  reproducible evidence of the contradiction, an explanation of why the prior
  reasoning failed, and an actionable repair sketch. The Alpha explains the
  authority and reasoning that produced the incorrect result and teaches back any
  domain or authority context the validator missed, then repairs; a brand-new
  independent validator judges every affected validation and gate. Collaborative
  self-validation is forbidden — the correcting pair never grades its own repair.
  One corrective iteration is the budget. Replacing or reaping the
  owning Alpha is permitted only after that corrective iteration fails, the
  Alpha is genuinely wedged or unresponsive, or continued ownership is unsafe on
  concrete evidence. `execute-todos` owns this contract; this chain adds no
  exception and defines no alternative remediation path, and that contract
  governs wherever this wording is thinner.
- **Perceptual bundles change nothing about this chain's shape.** When phase 1
  stamps `bundle_content: perceptual`, `write-todos`' "Perceptual-quality
  bundles" plans the `01` evidence tool, the per-wave seam slices, and the
  `NNz_critique_<module>` gates, and `execute-todos`' "Rubric critique gates"
  runs them — verdict-only critic Shadows, one corrective Shadow per FAIL, a
  fresh critic per re-grade, `max_rounds`, `STATUS.json`, weakest-first
  resume — all before `99a`, all under this one Alpha. This chain adds no
  round, no fixer Alpha, and no request to the Regent for either; a `/loop`
  re-entry of this chain resumes from `STATUS.json` exactly as
  `execute-todos` says.
- **One source of truth.** Do NOT reimplement planning or execution logic here.
  `write-todos/SKILL.md` and `execute-todos/SKILL.md` own those; this skill only
  sequences them and forces the async/defer posture across the seam.
- **Carry the path forward.** The folder created in step 1 is the folder executed in
  step 3 — never let execution scan a stale or unrelated `todos/` directory.
- **One writer per tree — across bundles, not inside one.** This chain's own slices are scheduled by `execute-todos` rule 3's scheduling contract: dependency-independent slices with disjoint `touches:` footprints run concurrently, and only conflicts, dependencies, integration slices, the assembled-candidate preflight, and the `99a`/`99b`/`99c` terminal chain serializes. What never overlaps is a *different* writer on the same worktree/branch (another bundle's slice Shadows, an in-flight terminal gate Shadow (`99a` conformance, `99b` verify-and-fix, or `99c` merge-and-deliver), a human mid-edit): against those, phase 1's read-only planning may overlap, but any trial-and-error probing in phase 1 and ALL of phase 2 wait for quiescence — see `write-todos`' "Empirical recon needs a quiescent tree" and `execute-todos` rule 3's "Quiescence extends across bundles and editors".
- **Only a hard blocker stops the run.** A broken build a worker can't get past, a
  missing credential — those pause. An unanswered *question* never does; it goes to
  the errata file and the run continues.
- **This chain pins no effort anywhere.** Every fresh spawn it makes — planning,
  ordinary slices `01`–`98`, and all three terminal `99a` / `99b` / `99c` Shadows alike — omits `--effort`
  and takes the model's lowest available score from the steering engine. The
  planning and validation gates are untouched; leverage is bought
  with WHICH model runs a phase and how independent it is, not with an effort
  pin. Do not "compensate" for a lowest-effort gate with `--bypass-effort`.
