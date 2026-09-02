---
name: write-todos
description: 'This skill should be used when a throne campaign Alpha plans an objective into a folder of executable todo files. Invoked by /write-todos (aliases: /create-todos, /make-todos, /plan-todos, /draft-todos), or when the tasking says "write todos", "create todos", "make todos", "plan this as todos", "draft todos for ...", "break this into todos", "generate a todo list", or "create a todo bundle". Runs ONLY inside the throne orchestrator and refuses elsewhere. Output is a `todo-<iso-timestamp>-<topic>/` folder of `NN_<task>.md` files under `~/.throne/data/<alpha-name>/` that the `/execute-todos` skill picks up later.'
version: 0.16.0
user-invocable: true
---

# Write a folder of todos

Produce a `todo-<iso-timestamp>-<topic>/` folder of sequence-numbered planning
files in your campaign data dir: `~/.throne/data/<alpha-name>/` — never at the
target repo root, never at the throne root. Campaign working notes/artifacts
live in the same `~/.throne/data/<alpha-name>/` dir; durable cross-session learnings go
to `agent_docs/MEMORY/`. `/execute-todos` later runs one fresh real
Shadow per file and lands the work on your campaign branch.

## Entry guard — throne context only

This skill runs ONLY inside the throne orchestrator — the Lord's order of
2026-07-20; the throne `AGENTS.md` section "Shadows are real harnesses in the
throne" carries the law. Before anything else, establish throne context with
the one canonical resolver in `execute-todos/SKILL.md` → "Entry guard" (the
source + main-checkout owner check, the unique-live-Regent fallback,
and the Alpha-registration conditions — defined once there; never re-derive a
variant here). If it yields no live throne root, REFUSE loudly and stop: say
plainly that `/write-todos` is throne-only, and that the remedy is to run it
from a throne session (a campaign Alpha spawned by the Regent) or to have the
Regent spawn a campaign Alpha for the objective — never a stack trace, never a
degraded local run. The alias skills (`/create-todos`, `/make-todos`,
`/plan-todos`, `/draft-todos`) and `/write-and-execute-todos` chain into this
skill and inherit the same refusal.

**Admission planning — read first.** Which model executes each todo is governed by
the shared resolver described in `<live-throne>/agent_docs/MODEL_POLICY.md`.
Read the live `active_plan` and its role-pool pairs before writing files. The
planner does not rank models or select routes. It records an explicit,
nullable human `model_hint` from the queue request and leaves admission to the
shared resolver at spawn time. A missing or malformed preset or role pool pauses
authoring; never reconstruct it from prose or invent an out-of-pool fallback.

The planning Alpha uses `rolePools.Alpha`; ordinary slices use
`rolePools.Shadow`; terminal slices use `rolePools.ShadowSlice99`. A campaign
role pin or non-empty allowlist may supply the applicable pool. A model hint is
inherited only down the recorded campaign chain. When a pair is refused, report
the reason to the Regent for a human route decision: automatic escalation and
retry ladders are forbidden. Every fresh spawn omits `--effort`; do not write a
model or effort pin into a slice.

**Which pair a fresh Alpha runs is steered, not chosen freely.** `steerSpawn` applies the current Alpha set, usage balance, and desperation policy from the executable symbols named in `MODEL_POLICY.md`. Follow its compliant-spawn message or use only the bypass it names; do not copy the current pairs or threshold here. The full contract, including what a refusal means and how to comply, lives once in `execute-todos/SKILL.md` → "Steering + bypass contract"; do not restate its rules here.

Human exceptions are durable, scoped evidence. Honor only the applicable
Lord/Regent authorization or role pin; agents never self-authorize one.
Exceptions do not create an automatic substitute for a refused pair.

Check which harness/model you are (your system prompt states it) and record the active preset, Alpha pool, filters, and actual pair before writing anything. If you are outside the admitted gate and hold no valid explicit Alpha override, STOP before step 3 rather than writing a degraded bundle. You cannot switch your own model mid-session; refusing to plan below the gate is the enforcement.

**Delivery mode is evidence, not preference.** Use the single classifier owned by
`execute-todos/SKILL.md` → "Delivery-mode classification" before drafting the
bundle. Stamp its result in `00_overview.md` as `delivery_mode: git-repo | no-git`
and record the target-path plus probe evidence. Never initialize Git to make the
Git path available. `git-repo` terminal todos deliver with plain git — a
checkout of the target branch and a `git merge` of the campaign branch. `no-git` terminal todos
retain applicable outcome checks, mark Git-only setup, gates, and delivery N/A
with the classifier's evidence-backed reason, and finish with an explicit
operational outcome. Do not invent SSH, transport, or remote-operation machinery.

**Todo-run personality.** Every bundle has a run personality. Valid values are
`default` (the default), `focused`, and `perfectionist`. If the invoker names
one, use it; otherwise resolve `default` without asking — `focused` and
`perfectionist` are never assumed, only explicitly requested. `default` is the
resolved default by the Lord's order of 2026-07-21, the named successor to the
2026-07-20 flip away from assumed-perfectionist: perfectionist's
add-more-when-it-improves-the-result appetite is what accumulated the
complexity that once demanded per-slice capability stamps, so
restraint stays the standing posture and feature/experience sidequest appetite
is opt-in. Stamp the resolved value in `00_overview.md` as
`todo_run_personality: <value>` and include a short `## Run personality`
section. Personality controls scope appetite; it never overrides the user
objective, model policy, question-log rules, cleanup, or validation.

- **focused** (explicit request only; the strictest): no discretionary work at
  all — no sidequest slices AND no discretionary refactors, not even a
  behavior-preserving simplification. For when even a cleanup is unwanted.
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
  separate finding, but do not let it expand planned scope, create a new slice,
  or become acceptance criteria. Boy Scout cleanup under `default` is limited
  to behavior-preserving structural hygiene: DRY/SOLID conformance,
  readability, local duplication and dead-structure cleanup, and keeping
  production files within the repository's 500-line boundary. It never
  authorizes fixing a different functional bug. Validation grades the initial
  promise and known bug fixes; it must not manufacture requirements, edge
  cases, robustness goals, unrelated findings, or other scope.
- **perfectionist** (explicit request only): the planner may create sidequest
  slices it believes improve the experience — features and experience
  improvements included — and the executor is expected to finish sidequests the
  bundle creates. Every sidequest must still be traceable to `00` and verifiable.

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

**A genuine blocker is PLANNED INTO THIS BUNDLE, not dispatched elsewhere
(Lord, 2026-08-21).** If the objective cannot be delivered without some other
work, that work becomes a numbered slice in this bundle. Do NOT plan a
follow-up objective for it, do NOT write "the Regent should file X" into the
overview, and do NOT plan a bundle that stops at the blocker and waits. There
is nowhere for it to go: `add-to-queue` now admits the Stager role alone, and
the Stager files only on the Lord's own instruction, so a blocker you plan to
hand off does not become someone else's objective — it becomes nothing, and the
bundle you wrote cannot deliver.

This is the one case where widening the slice list is correct rather than scope
growth, and it is the same test the rest of this rule uses: the blocker is work
the ALREADY-STATED Done-when cannot be reached without. Planning it in does not
change what the bundle promises; leaving it out means the promise is unkeepable
from the moment you write it. "Would be better if" is still not a blocker, the
burden is still on you, and an unclear case still resolves against widening.

Say so in the overview. Name the blocker, name the slice that clears it, and
say why the deliverable was unreachable without it — a widened bundle that
declares the widening is a plan doing its job; one that hides it is the
manufactured-scope failure this rule exists to stop.

**The escape hatch is the Lord, and it is narrow.** Plan for escalation only
when the blocker cannot be cleared inside the bundle at all — it needs a
decision only the Lord can make, or clearing it would change the Done-when
itself into a different objective. Then say so explicitly in `00_overview.md`
rather than planning around it silently.

**Correcting your own incomplete decomposition is not scope growth** and remains
yours under the mid-flight amendment contract. The test is whether the
**Done-when changed** — not whether the slice list did. An unchanged Done-when
whose slices could never have delivered it is an error you fix; a changed
Done-when is a new objective and only the Lord may expand an active bundle.

**Note for implementers:** this prohibition is stated because the banned
behaviour is *emergent*, not instructed. No todos skill ever contained an
instruction to file queue rows. Grepping for one and finding nothing disproves
nothing.

## Planning altitude — state semantics, leave mechanics to execution

The governing design principle is the global
`claude/agent_docs/coding_principles.md` section “Name the logic before
implementing it”, available to throne workflows at
`<live-throne>/agent_docs/coding_principles.md`. Apply it by reference here;
do not duplicate or paraphrase that principle into a second doctrine.

For every non-trivial coding slice, the planner states the **semantic
 decisions, invariants, reuse obligations, required evidence, and observable
 outcomes** that define acceptance. The planner MUST NOT prescribe **exact
 function names, line-by-line algorithms, file-local mechanics, or freeze a
 speculative call graph**. Those prohibitions bind planner inventions, not a
symbol demonstrably already present in the target code or an externally fixed
name such as a public API, CLI flag, on-disk key, or protocol field.

Every generated slice (`01`–`98` and each terminal todo) also records a
high-level **suspected file inventory** with exactly three groups: **Files likely
needing READ**, **Files likely needing CHANGE**, and **Files likely needing
CREATE**. This inventory is FILE granularity only: naming a file is not naming a
function, and an inventory item must not prescribe function names, signatures,
call graphs, line-by-line algorithms, or code sketches.

The suspected file inventory is a search-starting **HYPOTHESIS**, explicitly not
an execution allowlist. The plan states that the executor may refine it after
recon; an unlisted file is never off-limits when the evidence requires reading,
changing, or creating it.

When a slice's work is a decomposition — splitting a module that changes for
several unrelated reasons — the plan names **hypothesized responsibility
modules** at high level: one line each, identified by its **reason to change**
(public API or orchestration, platform- or harness-specific handling, a major
effect such as send, create, or persistence, and genuinely reused shared
predicates or transformations). These are file-granularity hypotheses under the
inventory rules above, never a final layout: the executor refines their names,
boundaries, and count after recon. The owning contract — the recursive
Single Responsibility rule and the shapes it rejects — lives in `execute-todos`'
"Responsibility-oriented decomposition" section; reference it, never restate it,
and never plan a split by file size, balanced chunk, or numbered part.

When two or more places in a slice turn on the same domain rule, the plan states
that they share **ONE semantic decision** and names that decision in domain
language; it never names the function that will implement it. The reuse
obligation belongs to a domain rule that decides behavior in multiple places or
whose meaning can drift.

Trivial expressions are exempt: arithmetic, string formatting, and an obvious
single-use comparison require no plan sentence, named predicate, or extraction
obligation. Planning owns the semantic contract; after recon, execution owns
the concrete vocabulary and mechanics that satisfy it.

## Platform-first audit — inventory before proposing machinery

Before the plan proposes a new tool, transport, parser, wrapper, or state
machine, it must inventory the current stdlib, platform, and installed-
dependency primitives that could satisfy the needed guarantees. The audit is
evidence, not a vibe check: name the candidate primitive, the guarantee it
already provides, and the exact guarantee still missing.

The decision order is strict:

1. Reuse an existing primitive when it already satisfies the guarantee.
2. Prefer a thin wrapper when the primitive is close and the wrapper's job is
   only adaptation or composition.
3. Propose custom machinery only when concrete evidence shows every candidate
   primitive misses a required guarantee.

Do not invent a custom mechanism merely because it feels cleaner, more unified,
or easier to explain. A claimed gap without concrete evidence is not a gap.
Planning must carry this audit into the overview, the relevant slice
deliverables, the validator contract, and the report expectation so execution
can re-check it after recon.

Every bundle is bracketed by four auto-included bookends: `00_overview.md`
(the north-star — read first, never executed), `99a_conform_<topic>.md` (the
fresh conformance gate, which grades the candidate against what was literally
asked for), `99b_verify_<topic>.md` (the fresh tests-and-lint gate, which fixes
what it finds), and `99c_deliver_<topic>.md` (the fresh conflict-owning
delivery Shadow). Ordinary slices live between `00` and `99a`; the three
terminal Shadows run in `99a` → `99b` → `99c` order.

## Proposed function contract map — a legible shape, never a mandate

Every generated `00_overview.md` carries a `## Proposed function contract map`.
Its purpose is legibility: a reader sees the intended implementation shape and
says "oh, that is what you mean" before any code exists.

Build it **top-down**. Decompose the bundle's behavior recursively under the
Single Responsibility rule until each leaf has **one semantic responsibility and
one reason to change**, then STOP. Stopping is part of the law: a decomposition
that keeps splitting past one cohesive responsibility manufactures exactly the
meaningless one-line helpers the planning-altitude section already forbids. The
owning recursive contract — the rule and the shapes it rejects — lives in
`execute-todos`' "Responsibility-oriented decomposition" section; reference it,
never restate it.

Every proposed entry states six things, the fourth conditional:

1. **suggested function name**
2. **parameters** — names plus types or meaning
3. **output** — type plus semantic meaning
4. **side effects and failure outcome**, when relevant
5. **parent / composition relationship**
6. **reuse / modify / create hypothesis**

Entries are table rows — one column per field, so a field cannot go missing
silently — plus a seventh column, **Covers**, naming the acceptance clause that
contract satisfies. The overview template below emits that table; do not restate
its columns here.

Coverage is the test: **every objective and acceptance clause maps to a
contract.** Every `## Done when` criterion must appear in some entry's `Covers`
cell, and every exact-wording clause must reach a contract through the criterion
it produces. A clause with no mapped contract is a planning gap, not a
formatting miss.

**The map is a suggestion, not a mandate — this is the reconciliation.** The
planning-altitude prohibitions above are not repealed by this section. Suggested
names and signatures are **NOT mandatory identifiers, NOT an allowlist, and NOT
frozen mechanics**. After recon the executing Shadow may refine any name,
parameter, or signature, provided it records material deviations and preserves
the same contracts and responsibilities. State that in the generated section, in
terms a later reader cannot soften — a map that reads as binding has repealed
the altitude law by wording.

The map prescribes **no call graph and no implementation steps**. A parent /
composition relationship names what composes what, never the order of calls
inside a body.

An entry names **ONE** responsibility. A suggested name that joins two verbs
(`parseAndPersistReport`), or a row whose output or effect joins two behaviors
with `and then`, `, then`, `as well as`, or `and also`, has two reasons to
change: split it or re-cut the boundary.

**A bundle whose work is prose maps to sections, not to invented functions.**
Where a clause ships as contract prose plus the test that pins it rather than as
code, its contract IS that named section and that test — record the section and
its pinning test in the `Suggested name` cell and fill the remaining fields with
the section's inputs, the test's verdict, and its failure outcome. Forcing a
function name onto prose work produces exactly the meaningless helper this law
forbids.

## Folder + filename layout

```
~/.throne/data/<alpha-name>/
└── todo-YYYY-MM-DD-HHmm-<kebab-topic>/
    ├── 00_overview.md          ← always present: the north-star, read FIRST
    ├── 01_<snake_case_task>.md
    ├── 02_<snake_case_task>.md
    ├── 03_<snake_case_task>.md
    ├── 03z_critique_<module>.md   ← perceptual bundles only: rubric gate paired with 03
    ├── 04_seam_<wave>.md          ← perceptual bundles only: the one slice touching core
    ├── ...
    ├── 99a_conform_<topic>.md         ← fresh gate: does this do what was ASKED?
    ├── 99b_verify_<topic>.md          ← fresh tests-and-lint gate, fixes what fails
    └── 99c_deliver_<topic>.md         ← fresh Shadow merges latest and delivers LAST
```

- **Folder name**: literal `todo-` prefix + ISO-style timestamp + kebab-case topic. Get the timestamp with `date +%Y-%m-%d-%H%M`. Example: `todo-2026-05-08-1430-bms-config-page/`.
- **Topic**: 2–5 kebab-case words capturing the deliverable (`bms-config-page`, `fix-flash-corruption`, `migrate-auth-middleware`). Don't repeat what the campaign name already implies.
- **Sequence number**: zero-padded. `00`, `99a`, `99b`, and `99c` are reserved
  bookends — `00_overview.md` is read-first context,
  `99a_conform_<topic>.md` grades the candidate against what was literally
  asked for, `99b_verify_<topic>.md` runs the tests and lint and fixes what
  fails, and `99c_deliver_<topic>.md` merges the latest target and delivers.
  Slices take `01`–`98`; a perceptual bundle's `NNz_critique_<module>` gate
  shares its builder's number with a `z` suffix (see "Perceptual-quality
  bundles"). Numbers order and cross-reference; ordinary slices do
  NOT force numerical execution order. `00` reads first, then the fresh
  terminal Shadows run `99a`, `99b` and `99c` in order. Keep the role word in
  each terminal filename: the throne classifies terminal gates by verb, not by
  letter.
- **Filename body**: snake_case verb-phrase summarizing the deliverable (`implement_store`, `wire_route`, `audit_partition_table`).

## Protocol

### 1. Pin the topic + scope

Before writing files, pin:

- **Topic** — one sentence: what's being built / changed / fixed.
- **In-scope** — the slice this bundle covers.
- **Out-of-scope** — what's deferred (linked todos for a future bundle, or just "not now").
- **Run personality** — `default` unless the invoker explicitly asked for
  `focused` or `perfectionist`.

The objective arrives from your invoker — the Regent's brief, the queue entry,
your own assignment file. If it is vague, ambiguity is yours to resolve
(research + best-effort assumption, court law: the buck stops with the Alpha);
log genuinely contestable readings to the bundle's `000_current_questions.md`
(create it with the folder) with your assumed answer, and proceed. If scope is
already pinned, restate it in one sentence and proceed.

### 2. Sketch the breakdown — DO NOT write files yet

Output the **list of titles** in numerical order, bracketed by the two bookends:

```
00 — Overview & acceptance criteria (north-star, read first)
01 — Lock CAN frame encoding + shared types   ← contract the whole bundle reads
02 — Implement param store                     ← localized, clear pattern
03 — Wire store to route                        ← contract already pinned by 01
04 — Slice-ring time-sync coherence            ← subtle concurrency/timing
05 — Add Vitest coverage                        ← mirrors existing tests
99a — Grade the candidate against what was literally asked for
99b — Run the tests and lint, and fix what fails
99c — Merge the latest target, then deliver and smoke-check it
```

Annotate each executed entry (`01`–`98`, `99a`, `99b`, and `99c`) with a ≤6-word
reason describing what it is and why it is its own slice, as above. Model
selection is NOT part of this: the throne routes every worker itself, so a
planner does not rank or score slices. Spend the
judgment on the CUT instead — whether each slice is genuinely independently
testable, and whether its boundary is a real seam.

`00`, `99a`, `99b`, and `99c` are non-negotiable — every new bundle ships with all four. Draft `00`'s "Done when:" checklist HERE, out loud, and confirm **every criterion maps to a numbered slice and every slice maps to a criterion**. That mapping IS the answer to "do these steps actually achieve the goal?" — and catching a gap now costs one line of text, not an execution re-run.

**COUNT YOUR DEPENDENCY CHAIN BEFORE YOU COMMIT TO IT (Lord, 2026-08-25).**
Slice by independently-testable unit, not by sequential phase. The test is one
question per slice: *can this be finished and proven correct with nothing else
in the bundle existing yet?* If not, you have cut the work in the middle of a
seam rather than at one.

Then count the longest `deps:` chain, terminal gates excluded:

- **Depth 2** — fine, if the dependency is genuine.
- **Depth 3** — a smell. State why the middle slice cannot be given a contract
  and built against it.
- **Depth 4 or more** — an ANTIPATTERN. Restructure the bundle; do not file it.
  The last slice cannot start until three others finish in order, so it
  inherits every delay and every failure ahead of it, and the bundle's runtime
  becomes the sum of its longest path instead of the length of its slowest
  slice.

The fix is almost never merging slices. It is noticing that most links are not
real dependencies — they are the planner's reading order leaking into the
schedule. **A slice usually needs its predecessor's CONTRACT, not its
COMPLETION.** Pin the contract in the overview, write both slices against it,
and the link disappears.

This is measured, not theorised. A phase-chained campaign filed on 2026-08-25
(spikes -> core -> guest provisioning -> daemon -> desktop -> install) was five
deep. One spike failed on a malformed command-line argument and a VM missing a
service, four objectives stalled behind it, the court ran idle, and unblocking
it took a human ruling about an architecture nobody had disproved. Three of
those four never needed the spike's completion at all — only its answer, which
is a contract. A unit-split campaign filed the same night ran its slices
concurrently and landed within hours.

Settle each slice's **`deps:` and `touches:`** here as well, while the whole
breakdown is still in front of you. `deps:` lists the slice numbers that must be
merged before this one starts; `touches:` predicts the slice's file/dir
footprint — every file it will create, edit, or delete, kill-list targets and
test files included. `/execute-todos` schedules dependency-independent,
footprint-disjoint slices concurrently, so these two stamps are what buys a
bundle its concurrency. A slice with no `touches:` stamp has an unknown
footprint and serializes against everything, which is the conservative default
that keeps older bundles behaving exactly as they always did. Shared hotspot
files — a command registry every slice appends to, a barrel export, a single
config map — belong in `touches:` so the conflict is declared at planning time
instead of discovered at merge time. Under-predicting a footprint is the
expensive mistake: list the file when in doubt.

**Do not manufacture micro-slices.** Every slice is a Shadow, and every Shadow
costs a fixed orchestration overhead — spawn, assignment, watch, merge, reap —
measured in minutes regardless of how small the work is. A slice whose
substantive work is smaller than that overhead is over-fragmented, and a bundle
of them runs slower than a bundle of honest ones. Consolidate cohesive work that
edits the same files into one slice. Split for **isolation** — independent
footprints, a true contract boundary another slice
must read — never for tidiness or symmetry.

Name any slice that deletes or changes a mechanism, so its
prose sweep gets planned rather than discovered by the gate (see "Claim discipline
and mechanism-deletion sweeps").

There is no interactive approval pause in the throne — the buck stops with you,
and the veto arrives out of band. Treat the sketch as the cheapest self-review
point: a misframed bundle is caught HERE, so challenge the breakdown once —
titles, order, gaps, stamps — before any file exists, and log genuinely
contestable framing calls to `000_current_questions.md` so the veto has
something to land on. When chained by `/write-and-execute-todos`, execution
follows immediately; a standalone invocation reports the sketch alongside the
final folder listing instead of waiting on approval.

### 3. Write the files

Once the breakdown is settled:

1. `mkdir ~/.throne/data/<alpha-name>/todo-<timestamp>-<topic>/` — the campaign
   data dir is the bundle's only home: never the target repo root, never the
   throne root.
2. Write `00_overview.md` first (see "The overview file" below) with the bundle-level `todo_run_personality:` stamp, it is never executed.
3. Write each `NN_<task>.md` slice (one per title), each opening with the `deps:` and `touches:` lines settled there. Never emit legacy `tier:`/`model:` stamps.
4. Write `99a_conform_<topic>.md` (see "The conformance todo" below) with
   `deps: [<every ordinary slice>]`.
5. Write `99b_verify_<topic>.md` (see "The verify todo" below) with
   `deps: [99a]` frontmatter. It runs the
   bundle's tests and lint, and fixes what fails.
6. Write `99c_deliver_<topic>.md` last (see "The delivery todo" below) with
   `deps: [99b]` and the conflict-owning delivery
   contract. It merges the target branch into the campaign branch and re-checks
   until the target goes quiet, then delivers with plain git — checking out the
   target branch and merging the campaign branch into it — only while the target
   HEAD is unchanged since that final check, inspects the resulting target
   diff/content, and runs meaningful delivered-feature smoke checks on the
   target.
6. Report the folder path and the file list in your report upward. That
   completion report to Regent must also state the exact planned real-E2E
   strategy: the actual system/components, the required runtime state, the
   trigger/action that will exercise the path, the observable final outcome,
   and why that route is genuinely end-to-end rather than a mock-only or
   synthetic stand-in. It must also state the platform-first audit: the current
   stdlib/platform/installed-dependency primitives considered, which primitive
   is being reused or thin-wrapped, and concrete evidence for every guarantee
   still missing when the plan authorizes custom machinery. Bare `done`, bare
   `E2E passed`, or a missing field is invalid.

Do NOT pre-fill an `## Execution log` section in any file — that's `/execute-todos`'s job when the work lands.

## What goes in a todo file

Each slice todo is a self-contained planning doc for one slice. Standard structure:

```markdown
---
deps: [01, 02]      # slice numbers that must be merged first; [] when independent
touches:            # predicted file/dir footprint — omit only when genuinely unknown
  - src/store/params.ts
  - src/store/params.test.ts
---

# NN — <Title>

<One-paragraph "why": what this todo unlocks, what calls into it, why it
exists as its own slice.>

## Semantic contract

<Required for every non-trivial coding slice: state the semantic decisions,
invariants, reuse obligations, required evidence, and observable outcomes.
When several sites use one domain rule, declare one shared semantic decision in
domain language without choosing its implementing function. Omit trivial
arithmetic, formatting, and obvious single-use comparisons.>

## Suspected file inventory

<This is a search-starting HYPOTHESIS at FILE granularity, not an execution
allowlist. The executor may refine it after recon; unlisted files are not
off-limits. List file paths only — never functions, signatures, call graphs,
algorithms, or code sketches. New capability belongs under `src/nest-commander/`;
a legacy `src/` path appears here only for a permitted change kind, and never for
an interim implementation of a feature awaiting a command's migration.>

### Files likely needing READ

- `<path, or none expected>`

### Files likely needing CHANGE

- `<path, or none expected>`

### Files likely needing CREATE

- `<path, or none expected>`

## <Other domain-specific sections, when needed>

<Pin only externally fixed interfaces or facts already demonstrated by target
code or measured evidence. Leave invented names, algorithms, file-local
mechanics, and call-graph shape to the executing Shadow after recon.>

## Out of scope

- <Explicitly deferred concern>
- <Concern that belongs in todo MM>

## Kill list

- <Superseded file / function / flag / shim this slice must DELETE>

## Deliverable

- <User-visible / contract-visible outcome>
- <Verification command, e.g. `pnpm -C hmi-frontend exec vitest run` exits 0>
- The slice's focused tests and mutation checks pass, and the file-size and
  lint/static-analysis/duplicate mechanical checks pass over the slice's OWN
  diff, before it reports DONE.
- When ready to be reaped, the executor tells its supervisor (the primary,
  never-dropped requirement) and, for an Alpha, only after the complete `99c`
  delivery gate, publishes the canonical reapability claim. Slice assignments
  receive the exact claim from `renderSliceAssignment`; do not duplicate its
  literal protocol in authored todo prose.
```

For slices (`01`–`98`), the `## Out of scope` and `## Deliverable` sections are non-negotiable, and `## Kill list` is non-negotiable whenever the slice supersedes existing code (omit it only when nothing is superseded — see "Code cleanup is mandatory"). Everything else is shaped by the slice's semantic contract — a cross-slice contract todo emphasizes externally fixed interfaces and invariants; an implement-the-page todo emphasizes observable UX states and validation evidence; a fix-the-bug todo emphasizes the failing reproduction, the shared decision, and the invariant being restored. (`00`, `99a`, `99b`, and `99c` follow their own templates below.)

## Concurrency stamps (`deps:` / `touches:`)

Both live in the slice's frontmatter and both are planning-time claims that
`/execute-todos` acts on:

- **`deps:`** — the slice numbers whose merged output this slice reads. A slice
  that reads a contract pinned by `01` declares `deps: [01]`; a slice that reads
  nothing declares `deps: []`. Declaring a dependency you don't have costs
  wall-clock; omitting one you do have costs a rebase, so declare the real edge
  and no more.
- **`touches:`** — every path the slice will create, edit, or delete, including
  test files and kill-list targets. Directory entries (`src/store/`) are allowed
  when the slice owns the whole folder. Two slices whose `touches:` sets
  intersect are serialized against each other even when their `deps:` are
  disjoint.

Omitting `touches:` is a legal, conservative declaration meaning "footprint
unknown" — the scheduler then serializes the slice against every other. Bundles
written before these stamps existed keep that behavior unchanged. Never stamp a
`touches:` set narrower than the truth to buy parallelism: the concurrency is
worth nothing if the merges collide.

## Perceptual-quality bundles — evidence tool first, seam slices, rubric critique gates

Some objectives are graded by eye, ear, or measurement rather than by a test
that returns 0 or 1: a rendered scene, a UI, generated audio, a latency
budget, a document judged against reference material. The tests-and-lint
gates still run for these bundles, but they cannot answer "does this look
AAA" — and a bundle that has no machine-runnable answer to that question
ships whatever the builder Shadow *claims* it looks like. This section is the
one home for the three planning shapes that close that gap. Stamp
`bundle_content: perceptual` in `00_overview.md` when the objective's
`## Done when` contains any criterion a test cannot settle; skip the whole
section otherwise. It adds machinery to nothing else.

**Everything below runs under the ONE campaign Alpha.** Builders, the
evidence-tool slice, seam slices, critic gates, and corrective rounds are all
Shadows on this Alpha's branch. No shape here ever asks the Regent for a
second Alpha (the Lord's ruling of 2026-09-02: a multi-Alpha fix chain once
left the Regent queueing corrections forever). A critic that wants a fix
files a FAIL; the Alpha spawns a corrective Shadow; nothing escalates.

### 1. The evidence tool is slice `01`, before any feature slice

When acceptance is perceptual, the first ordinary slice builds the thing that
generates evidence, and every module slice declares `deps: [01]`. Its
deliverable is a single command that loads the artefact under test, waits for
a documented ready signal, drives it to a named preset (camera + time of day,
route + viewport, input fixture — whatever the domain's axes are), and writes
**an image or capture plus a JSON log** carrying at minimum: console/runtime
errors, the domain's budget metrics (fps, draw calls, latency, file size),
and the preset that produced it. Pin the command's exact invocation and the
JSON keys in `01`'s `## Semantic contract`; every later critic gate cites
them by name.

Every module slice additionally ships a **showcase entrypoint** — a mode that
stages a representative scene of only that module, so the critic can grade
the module in isolation before integration hides its defects.

**Where the evidence tool sits relative to the test suite.** Browsers are
permitted test infrastructure again (the Lord's 2026-09-02 retraction,
recorded under "NO END-TO-END TESTS"), so a slice MAY exercise the evidence
tool from an integration test — a readiness check, a "showcase loads with
zero console errors" assertion. But the tool's primary role is a **gate
artefact**: a critic Shadow runs it at gate time and reads its output as
evidence, exactly the way `99a` runs an installer to see what it writes. A
green suite item that calls it is a floor, never the score; the score comes
only from a critic looking at what it captured.

### 2. Module ownership and the seam slice

A perceptual bundle decomposes by module, and each builder slice stamps
`touches:` as exactly its own folder (`src/terrain/`, `src/roads/`). The
shared core — the world data model, the event bus, the render loop, whatever
`ARCHITECTURE.md` names as shared — is owned by **no builder**. A builder
that needs a core change does not make it: it appends a dated entry to the
bundle's `core-requests.md` (what it needs, why, the smallest change that
would do) and works around the gap inside its own folder until the seam
lands.

The **seam slice** (`NN_seam_<wave>`) is the one slice per dependency wave
whose `touches:` includes the core paths. It declares `deps:` on every
builder in its wave, consumes `core-requests.md`, applies the requests it
accepts, records the ones it refuses with a reason, and fixes the
integration seams the wave exposed. Because its footprint intersects every
core path, the scheduler serializes it against everything — that is the
point. Plan one seam slice per wave, numbered after that wave's builders and
before the next wave's; a bundle with one wave still plans one seam slice.

For a greenfield target, slice `01`'s predecessor is the architecture: the
`## Architecture and invariants` and `## Proposed function contract map`
sections of `00_overview.md` are committed as `ARCHITECTURE.md` in the target
by the first slice that touches core (usually `01` itself), naming one folder
per module, the shared data model, each module's public API and emitted
events, units, determinism (seeded RNG only), the numeric performance budget,
the asset policy, and the isolation rule that one module's failure never
takes the whole down. Every later slice's `## Semantic contract` cites it
rather than restating it.

### 3. Rubric critique gates (`NNz_critique_<module>`)

For every module slice `NN` whose criterion is perceptual, plan a paired gate
file `NNz_critique_<module>.md`. It is a **separate gate class** from `99a`:
`99a` grades literal conformance to the request and stays PASS/FAIL; a
critique gate scores *quality* against a rubric and a threshold, and taste
scores never dilute the conformance standard. Ordinary band (`01`–`98`),
scheduled by `deps:`, always before `99a`.

```markdown
---
deps: [NN, 01]                     # the builder it grades, plus the evidence tool
gate: critique                     # role word; the executor spawns this verdict-only
module: src/<module>/              # the folder under judgment — the critic never edits it
threshold: 8.5                     # PASS iff score ≥ threshold AND zero errors in the evidence log
max_rounds: 4                      # builder-fix rounds before the gate records a residual
evidence_cmd: <exact 01 invocation with the presets this gate uses>
reference_set: <path or URL list of reference material; `none` ⇒ rubric-only>
---

# NNz — Critique <module> against <reference>

<One paragraph: what "good" means for this module in the target's own terms.>

## Rubric

| Score | Anchor |
| --- | --- |
| 10 | Indistinguishable from the reference set |
| 8.5 | Reference quality with nits a reviewer would list, not reject |
| 7 | Competent; a trained eye names what is missing |
| 5 | Programmer art — placeholder materials, flat light, no depth |
| 2 | Broken, or the showcase does not load |

## Axes graded

- <Axis 1 — e.g. materials, lighting, silhouette, motion, timing>
- <Axis 2>
- <Every preset the critic must capture: at least three, spanning the domain's hard cases — night, dusk, close zoom, empty state, overload>

## Deliverable

- The critic runs `evidence_cmd` ITSELF for every listed preset — never grades a builder's own captures.
- A score per axis and one overall score, with the evidence paths that justify each.
- A ranked issue list: most damaging first, each naming the axis, the preset, and the file the fix most likely lives in.
- `**Critique outcome:** PASS` or `FAIL` — PASS only at `≥ threshold` with zero errors in every JSON log.
- Writes no product code; commits nothing to the campaign branch.
```

Write the rubric anchors in the target's own vocabulary — the table above is
the shape, not the text. Pin the presets: an unpinned critic captures the
flattering angle. `reference_set: none` is legal when nothing external exists
to compare against; then the anchors carry the whole standard and must be
concrete enough that two critics would score within a point of each other.

**Scoring honesty is a hard rule.** The critic reports the number the
evidence supports, never the number that closes the round. A round that
fails is a failed round in `STATUS.json` and in the final report, with what
is still missing named. `/execute-todos` owns what happens next — the
corrective round, the fresh critic, the round cap, and the weakest-first
resume — under "Rubric critique gates" there; plan nothing about that here.

## Where new capability may be planned — the legacy-feature freeze

Choosing where a slice's implementation lands is a planning act, and after
2026-07-31 that choice is bound by the legacy-feature freeze. The durable law is
the throne `AGENTS.md` section "The legacy-feature freeze"; the executable
decision that returns the verdict for a concrete proposal lives in
`src/nest-commander/`. Read those two. This section states only what a planner
does differently, and never re-derives the verdict or the recorded exceptions.

Three obligations, in the order a planner meets them:

- **New capability is planned into `src/nest-commander/`.** Every new command,
  every new user-visible capability, and every feature expansion is implemented
  there, and the `touches:` stamp of the slice that implements it says so.
- **Legacy `src/` stays open by change kind, never by path.** Bug fixes,
  behavior-preserving refactors, compatibility maintenance, tests, and thin
  `src/exec.ts` migration plumbing may still be planned at a legacy path. The
  same file is open or closed according to the kind of change the slice proposes.
- **A feature aimed at a command that has not been ported yields a
  migration-first plan.** The request is a priority signal: that one command's
  migration is expedited ahead of the ordinary migration order, lands, and
  switches to `src/nest-commander/`, and the feature is implemented only there
  afterwards.

**Plan the migrate-first shape; quoting the rule is not planning it.** The
resulting bundle has three visible properties. The one command's migration is
planned work owned by its own expedited one-command migration Alpha — a separate
campaign that this bundle declares as a dependency and waits on — never an
assumption. The feature slice declares `deps:` on that migration and stamps a
`touches:` footprint under `src/nest-commander/` only. And nothing sits between
the two: no slice implements the feature in legacy code first, not even one whose
kill list promises to delete it once the port lands. A temporary legacy
implementation is forbidden even when the plan is to remove it, so a bundle that
cannot be drawn in this shape has the wrong scope rather than a licence to
improvise.

**Grandfathering is frozen and is not a planning tool.** The recorded exceptions
are the exact scope an already-in-flight campaign had written down when the order
landed, and the set never grows. A new bundle never plans into it; a planner who
reads that exceptions exist and reaches for one has inverted the law.

Both generated templates carry the obligation, so a location decision cannot be
written down without meeting it: the slice template's suspected file inventory
states where new capability goes, and `00_overview.md`'s scope-and-boundaries
section states the bundle's own boundary against legacy implementation.

## Code cleanup is mandatory

Git history is the archive; code is the present. When a slice supersedes existing code, the plan kills that code — deletion happens in the same slice that replaces it, never "later" and never "keep it just in case".

- **Every superseding slice carries a `## Kill list`.** If a slice replaces, rewires, or obsoletes existing code, name the files / functions / flags / shims to DELETE, and make the deletion part of that slice's deliverable. A slice that ships the new path but leaves the old one standing has not delivered.
- **A DERIVED re-export under the old name is not a deletion.** Turning
  `export const OLD = NEW_SOURCE[...]` is the most plausible near-miss in any
  consolidation: the duplication is genuinely gone, every value is genuinely
  correct, and the campaign has still failed — the second name survives, stays
  importable, and is what the next agent reaches for and hand-edits. When a kill
  list entry exists, the slice migrates the consumers and deletes the export.
- **When a mid-campaign amendment widens scope, amend the `## Kill list` in the
  same turn.** A ruling that arrives after planning ("X is legacy too") does not
  reach `99b` unless the kill list is updated, so the new symbol is never swept
  and can survive a green terminal chain. Reconcile the amendment into the
  bundle's kill list, not only into its prose.
- **Forbid the graveyard patterns in every plan.** No commented-out blocks of the old version, no `_old` / `_legacy` / `_v2` parallel copies, no dead feature flags guarding removed paths, no "keeping for reference" remnants, no re-exports/shims kept only for history. Anyone who needs the old version has `git log`.
- **`99b` sweeps for leftovers.** The verify todo's lint/static-analysis run covers the bundle's diff for stale-code survivors — a leftover is fixed there, not footnoted.

## Commit-message policy — inherited from execution

Every planned slice that creates a commit is bound by `execute-todos/SKILL.md` →
"Task-focused commit-message contract — single owner". Planning may require a
task-domain-oriented result, but it must not restate the forbidden vocabulary,
examples, commit classes, or acceptance rules. The executor applies the owning
contract to the complete subject and body for implementation, validation,
delivery, correction, report, and checkpoint work. Planning aliases inherit this
reference through `write-todos`; they add no commit-message policy of their own.

## Mechanical checks shift left into every implementation slice

Every generated implementation slice (`01`–`98`) states that the slice runs the
mechanical checks over its OWN diff before it reports DONE: the file-size
regression predicate over the slice's own changed files, and the lint,
static-analysis, and duplicate checks over the slice's own diff. Stamp that
obligation into the slice's `## Deliverable`, so the executing Shadow reads it in
its own assignment instead of inheriting it from prose it never opens — the same
mechanism the question-log template and the cleanup mandate already use.

The scope is the slice's own diff and never the assembled candidate: a slice
cannot judge what its siblings have not landed yet. The owning statement of the
obligation, its reason, and the three verification layers lives in
`execute-todos`; point the slice at that section and do not restate or weaken it
in the generated slice.

The stamp is an obligation on the executor's verification, not a licence for the
planner to descend into mechanics. The planning-altitude law above is unchanged:
the stamp names no function, no algorithm, and no file-local structure.

## Claim discipline and mechanism-deletion sweeps

Two defect classes recur across campaigns and cost the most when a gate is what
finally catches them. Both are cheaper to plan than to grade, so plan them.

**Corpus-wide claim discipline.** Every mechanical claim a slice ships — in code
comments, doc comments, specs, READMEs, any commit-visible prose — must be one of
three things: **measured** (a named command plus the output it produced), **quoted**
(verbatim from a named source), or **bounded** (explicitly hedged as unverified). A
plausible paraphrase presented as sourced is a defect, not a rounding error. Write
that requirement into any slice whose deliverable includes prose making mechanical
claims.

The invariant is corpus-wide, which is what makes it a planning problem: a slice
that fixes a defective claim must also sweep for verbatim twins of it. Take the
sweep's pattern set from the fix commit's own deleted lines
(`git show <fix-sha> --unified=0 | grep '^-' | grep -v '^---'`) and read every hit
before counting it clean. A fix fenced to the sites a reviewer happened to name
leaves byte-identical twins standing everywhere else — a finding list is an index,
not a boundary.

**Mechanism-deletion prose sweep.** A bundle that deletes or changes a mechanism
carries an explicit prose-sweep step — its own slice, or a named step inside the
deleting slice. Grep every present-tense description of the old behavior across code
comments, docstrings, and docs, corpus-wide, and update or delete each hit. Deleting
a mechanism means hunting its prose; front-run the class at planning time instead of
leaving the gate to find living prose about dead code.

## The overview file (`00_overview.md`)

Always the first file. It is **read-first context, never an executed todo** — `/execute-todos` loads it into every worker's prompt so each slice knows the whole it plugs into, and never runs a worker for it. It carries bundle metadata such as `todo_run_personality`.

It also carries a mandatory `## Exact user wording` section. Preserve the
initial user request and every later amendment as separate, ordered, verbatim
source turns. A paraphrase may annotate a quoted turn but cannot replace it.
Follow it with a clause ledger whose rows contain the exact clause, any needed
interpretation, planned final-state evidence, and `PASS` / `FAIL` / `PARTIAL`.
Every source clause must have a row. Omission, polished or semantic substitution
for quoted source, unsupported added scope, or `PARTIAL` makes the overview
contract fail closed. Later amendments supersede only the clauses they actually
correct; they do not erase the earlier source evidence. Structure:

**Spec echo against the queue item (mandatory when one exists, Lord-ordered
2026-08-19).** The `## Exact user wording` ledger above preserves the tasking
you received — but if the brief that reached you drifted from the queue
item's body, the ledger faithfully preserves the drift. So when the tasking
traces to a Regent-queue objective (an objective code in the tasking, the
campaign name, or the queue row itself), read that queue item's FULL body
directly (`render-queue`), and add a `## Spec echo` section to
`00_overview.md` restating, in your own words, every invariant, ruling, and
constraint the body carries — then compare. Any mismatch between the tasking
and the queue body, or any body clause your slices do not cover, goes to the
bundle's errata file by name; never silently reconcile in either direction.
The queue body is the spec of record; the brief is a pointer to it. A
tasking with no traceable queue objective states that fact in `## Spec echo`
instead of omitting the section.

The entire `00_overview.md` is the authoritative bundle outcome. Its objective, normative scope and boundaries, architecture and invariants, and `## Done when` criteria are all binding. Traceability proves planned coverage but cannot prove that the assembled final state achieved the overview outcome.

```markdown
---
todo_run_personality: default
---

# 00 — <Feature> overview

<One-paragraph "what & why": the whole feature in plain language — what the
user can do once this bundle lands that they couldn't before.>

## Run personality

`default` — identify the feature's original promise, intent, and acceptance
contract; choose the smallest implementation that fulfills it; and ship as
soon as it is fulfilled. Add no speculative features, abstractions,
configurability, edge-case machinery, future-proofing, or optional robustness.
Increase complexity only for named concrete evidence of a missed original
requirement or a reproduced bug, and keep the correction minimal to that
cause. Validation grades the initial promise and known bug fixes without
manufacturing new scope.
Stamp `focused` (no discretionary work at all, not even a cleanup) or
`perfectionist` (feature/experience sidequest appetite) only when the invoker
explicitly asked for it.

## Exact user wording

### Source turn 1

> <initial user wording, verbatim>

### Source turn 2 — amendment

> <later amendment, verbatim>

**Amendments reconciled through:** Source turn 2

| Exact clause | Interpretation (if needed) | Planned final-state evidence | Status |
| --- | --- | --- | --- |
| `<verbatim clause>` | <bounded interpretation> | <observable evidence> | PASS / FAIL / PARTIAL |
| `<earlier corrected clause>` | superseded by Source turn 2 | <retained earlier evidence> | PASS / FAIL / PARTIAL |

## Scope and boundaries

<The normative in-scope outcome and its explicit boundaries, including what is
deferred or excluded from this bundle. Do not add scope unsupported by an exact
source clause. State where new capability lands — `src/nest-commander/` — and,
when a slice serves a command that has not been ported, that the command's
migration is planned work this bundle depends on rather than a legacy
implementation.>

## Architecture and invariants

<How the slices compose into the whole: the data / control flow across todos,
the key boundaries and invariants, where each slice plugs in. A short bullet
flow or small diagram — NOT a re-paste of each todo's internals.>

## Proposed function contract map

<Suggested names and signatures are planning proposals — NOT mandatory
identifiers, NOT an allowlist, and NOT frozen mechanics. After recon the
executor may refine any of them, provided it records material deviations and
preserves the stated responsibility, inputs, outputs, and failure outcome. No
call graph and no implementation steps are prescribed here.>

| Suggested name | Parameters (name: type — meaning) | Output (type — meaning) | Side effects / failure | Parent / composition | Reuse / modify / create | Covers |
| --- | --- | --- | --- | --- | --- | --- |
| `<suggestedName>` | `<name>: <type>` — <meaning> | `<type>` — <semantic meaning> | <effect and failure outcome, or `pure`> | <parent entry, or `(root)`> | reuse / modify / create | <the `## Done when` criterion this satisfies> |
| `§<named section>` + `<pinning test>` | <the section's inputs> | <the test's verdict> | <what a violation fails with> | <parent entry, or `(root)`> | create | <the `## Done when` criterion this satisfies> |

## Done when

- [ ] <Acceptance criterion — observable, gradeable outcome>
- [ ] <Acceptance criterion>
- [ ] <Acceptance criterion>

## Traceability

| Done-when criterion | Delivered by |
| --- | --- |
| <criterion> | 02, 03 |
| <criterion> | 02 |
| <criterion> | 04 |
```

Write each criterion as observable behavior the `99b` verify gate can later mark pass/fail with evidence — "picker filters inverters by chemistry" is gradeable; "the picker works" is not. **Every criterion must map to ≥1 slice; every slice (`01`–`98`) must appear against ≥1 criterion.** A criterion with no slice = missing work. A slice mapping to nothing = scope creep, or a slice that doesn't serve the goal. In `perfectionist`, sidequests you add must appear in this mapping. In `default`, every slice must serve the original promise or a named minimally-scoped correction for an unmet original requirement or reproduced bug; speculative additions stay out. In `focused`, discretionary sidequests stay out of scope entirely. Resolve all of this during step 2, before the slice files exist.

### Consumer-bearing criteria — new capability and replacement bundles

A capability can exist, pass every test, and clear every gate while nothing
calls it — see `agent_docs/MEMORY/THE_CAPABILITY_EXISTED_THE_WIRING_DID_NOT.md`.
Two obligations close that gap; neither applies to a bugfix, a
behavior-preserving refactor, a doc/report bundle, or any criterion shipping no
new or replaced capability. **New capability:** a criterion introducing a new
command, store, route, or other unit nothing currently calls must name its
consumer — "X exists and `<named caller>` uses it," not "X exists and is
tested." **Tests are not consumers. Coverage is not use.** If this campaign
wires no consumer, say so and name a follow-up plus its owner instead of
leaving the gap implied. **Replacement or migration:** a criterion replacing or
migrating an existing authoritative path must state what retires the old path,
or scope that retirement as a named follow-up with an owner — a bundle that
leaves a transition state (old and new both live) must say what ends it.

## Mid-flight amendments — the one reconciliation contract

Steering arrives after authoring has started and after execution has started.
This section is the single normative home for what happens then; `execute-todos`
and `write-and-execute-todos` bind to it, add no exception, and define no
alternative lifecycle. Each of them states only the operational obligations its
own phase needs; wherever such a phase summary is thinner, this contract governs.

**A direct user amendment is a source turn.** Any later user instruction that
arrives through the chat or steering channel and changes the objective, scope, or
acceptance is appended verbatim as the next ordered source turn in
`00_overview.md` — never paraphrased into a summary, never edited into an earlier
turn, never carried only in an agent's prose report or head. This holds whether
it lands during authoring or mid-execution.

**Only a direct Lord amendment may expand an active bundle.** A Regent message
may append scope only when it relays the Lord's exact wording verbatim and keeps
that direct-Lord provenance explicit. Regent may clarify existing requested
scope and coordinate the minimum correction of a candidate-caused regression or
a defect demonstrably blocking the requested outcome; those actions do not add
new acceptance scope. A Regent-originated feature, unrelated bug, robustness
goal, cleanup outcome, or new acceptance criterion is a separate finding: queue
it as a separate objective with a new Alpha, and never append it to the active
bundle.

**Append and reconcile before the affected work continues.** The append plus the
reconciliation below happens BEFORE any further work in the area the amendment
touches, and before an authoring bundle is handed to execution. Unaffected slices
keep running; nothing pauses that the amendment does not touch.

**Supersession is clause-scoped.** Mark the corrected ledger row
`superseded by Source turn N` and keep it; add the amending clause as its own
row. Earlier source turns and their rows are never deleted or rewritten, so the
record of what the user originally asked for survives every correction.

**A question-log answer is never a source turn.** Answers the user writes into
`000_current_questions.md` are a separate reconciliation channel. They stay in the
question log — they are never promoted, copied, or appended into the ordered
source turns, and they never renumber or restate a source turn, even when the
answer changes an execution decision. Their effect reaches the bundle only
through the named-surface reconciliation rule below, which treats an answered
question exactly like an amendment for reconciliation purposes while leaving the
source-turn record untouched. The two channels never merge: chat/steering
instructions become source turns, question-log answers do not.

**Reconcile every named surface, then stamp freshness.** The surfaces are:
`00_overview.md`'s source turns, clause ledger, `## Scope and boundaries`,
`## Done when`, and `## Traceability`; and every affected numbered slice. Unstarted slices are rewritten in place;
work already landed or in flight that the amendment contradicts earns a new
numbered corrective slice rather than a silent edit to landed work. An answered
question drives this same surface sweep, and records its reconciliation by citing
the answered question's own entry — it never advances the source-turn count.
Finish by setting `**Amendments reconciled through:** Source turn N` to the
highest-numbered recorded turn.

**A late amendment staleness-kills a terminal PASS.** An amendment recorded
after `99a` or `99b` has already passed makes that PASS stale: completion
requires a fresh real Shadow re-run of every terminal gate the amendment
invalidates — `99a` whenever the amendment changes what was asked for, `99b`
whenever it changes code — over the amended bundle, before any `99c`
delivery.

## The conformance todo (`99a_conform_<topic>.md`)

Always the FIRST terminal executable todo and always a fresh real Shadow. It
exists because a bundle can be green on every test the campaign wrote for
itself and still not be the thing that was asked for. Tests grade the code
against the campaign's own understanding; this gate grades the campaign's
understanding against the request.

**The standard is literal.** Take what the Lord asked for — as recorded in the
queue row's `INTENT:`/`SCOPE:`/`RULINGS:` sections and in `00_overview.md`'s
`## Done when` — and check the delivered candidate against it word by word,
not in spirit. If he said `./install.sh` installs the app and leaves him able
to open a `.desktop` file, then the objective is unmet until you have shown
that `./install.sh` writes a `.desktop` file and that the file actually
launches the installed application. "The installer runs cleanly" is not that
claim. "We implemented installation" is not that claim.

**Addenda are the only thing that moves the standard.** A recorded amendment to
the bundle — an errata entry, an explicit Lord ruling, a queue-row amendment —
relaxes or redirects a requirement, and you grade against the amended text.
Nothing else does: not a slice's own opinion that a requirement was
unreasonable, not an Alpha's decision to descope, not a convenient reading. An
unmet requirement with no addendum behind it is a FAIL.

**This gate never blocks on a human.** It is a machine-checkable conformance
pass, not a request for someone to come and look. Where a criterion genuinely
needs human eyes, exercise the closest machine-checkable proxy — run the
installer, assert the file exists, parse it, invoke what it points at, check
the process starts — record the residual human half as UNPERFORMED in one line
naming what a person would need to confirm, and grade on everything else. The
Lord tests it himself afterwards; a false PASS wastes his time and an idle wait
wastes everyone's.

**It grades; it does not build.** This gate writes no product code and commits
nothing to the campaign branch. Its branch is legitimately empty and the throne
expects that (`isTerminalGateShadowName`). A gap it finds goes back as a FAIL
naming the unmet requirement and the evidence, which is corrective work for the
Alpha — unlike `99b`, which fixes what it finds.

```markdown
---
deps: [<every ordinary slice>]
---

# 99a — Grade <feature> against what was literally asked for

Fresh independent Shadow. You are not testing the code; you are testing whether
the code is the thing that was requested.

1. Reconstruct the standard. Quote the original request verbatim — the queue
   row's `INTENT:`, `SCOPE:` and `RULINGS:`, and `00_overview.md`'s
   `## Done when` checklist. List every addendum recorded since, and quote what
   each one changed. That quoted set, and nothing else, is the standard.
2. Turn it into a checklist of literal, observable claims. One line per claim,
   each phrased so it can be marked met/unmet with evidence.
3. Exercise the candidate against each claim. Run the actual entry point the
   requester named. Generate the evidence — command, exit code, relevant
   output — rather than transcribing it or reasoning about what it would do.
   Reading the source and concluding it must work is not evidence.
4. Mark each claim MET, UNMET, or UNPERFORMED (human-only residue), each with
   its evidence or its one-line reason.

## Out of scope

- Fixing what you find. Gaps are reported, not repaired — `99b` owns fixing,
  and it owns fixing test and lint failures, not unmet requirements.
- Test and lint execution as such. That is `99b`'s job; you may run them for
  context but a green suite is not evidence of conformance.
- Judging whether the requirement was wise. It was asked for; that settles it.

## Deliverable

- End with exactly one `**Conformance outcome:** PASS` or
  `**Conformance outcome:** FAIL`.
- PASS requires every claim MET or UNPERFORMED-with-reason, with evidence
  cited per claim. A claim you could not exercise at all is UNMET, not
  UNPERFORMED — UNPERFORMED is only for the human-eyes residue of a claim you
  otherwise proved.
- FAIL names each unmet claim, quotes the requirement text it comes from, and
  states what evidence would have satisfied it. Never a vague "does not meet
  the objective".
- Your branch carries no product commits. That is the expected shape.
```

## The verify todo (`99b_verify_<topic>.md`)

Always the second terminal executable todo and always a fresh real Shadow. It
runs only after `99a` returns an explicit `**Conformance outcome:** PASS`, and
does exactly one job: run the
bundle's tests and lint/static analysis against the assembled candidate, fix
whatever fails, and re-run until green. It is a fixing gate, not a verdict
gate — it commits its own repairs on the campaign branch. In `no-git` mode it
runs whatever checks are naturally applicable and records the rest as N/A with
the classifier evidence.

```markdown
---
deps: [99a]
---

# 99b — Run the tests and lint for <feature>, and fix what fails

Fresh independent Shadow. Run the bundle's verification commands against the
assembled candidate — the test suite, the linter, type/static analysis, and any
repository contract check the project already owns. Record every command, its
exit code, and its relevant output; generate that evidence rather than
transcribing it.

Fix every failure you find. A failing test, a lint violation, a type error, or a
broken build is corrective work you do here and commit on the campaign branch —
not a finding you hand back. Re-run the full set after each fix and finish on a
clean run.

**You own the fixing. Do not punt to the Alpha.** Reporting a failure upward and
waiting for someone else to repair it is not an available move, and neither is a
FAIL whose stated blocker is "this needs a code change" — making the code change
IS the assignment.

For the suite command specifically, do not credit exit 0 alone: read
`run-suite-container.mjs`'s own stdout to its end and record the
`run-suite-container: tests executed: N` line it prints for every real run. A
truncated log, a signal death, or a completed run reporting `tests executed: 0`
or `tests executed: unknown` is never a PASS, whatever the exit code says.

## Deliverable

- End with exactly one `**Verify outcome:** PASS` or `**Verify outcome:** FAIL`.
- PASS requires a final clean run of every applicable command, cited with its
  exit code and the suite's `tests executed: N` line.
- FAIL only when repair is genuinely impossible for you — a requirement nobody
  wrote, two slices whose designs contradict, or an environment you cannot fix.
  Name that precise blocker; never forward a raw test or lint failure as one.
- Fix and commit; do not merge, do not deliver, and do not touch the target
  branch.
```

## The delivery todo (`99c_deliver_<topic>.md`)

Always the final executable todo and always a distinct fresh real Shadow. It
runs only after explicit `99b` PASS and owns delivery together with the
conflicts delivery hits in `git-repo` mode: it merges the latest target branch
into the campaign branch, resolves every conflict there, and then delivers the
result to the target. In `no-git` mode it invokes no merge tooling: it records
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

## What does NOT go in a todo

- **Step-by-step recipes** ("first do X, then do Y, then …"). Give the executor the semantic contract and deliverable, not a procedure; recipes rot the moment surrounding code moves.
- **Planner-invented implementation mechanics.** Apply the planning-altitude law above instead of choosing internal identifiers, control-flow shape, helper extraction, file-local structure, or comment wording before recon.
- **Duplicated context.** If todo 03 pins the bus encoding, todo 04 says `(see todo 03)`, not a re-paste.
- **TBD / open-question content.** If a slice depends on an unresolved product decision, resolve it during step 1 — best-judgment answer, logged to `000_current_questions.md` — or drop the slice. Don't ship a todo whose body is "decide X first."
- **An execution log.** Strictly `/execute-todos`'s output.

## Cross-references — bundle-internal ONLY

- **Same bundle**: reference by number (`see todo 03`, `unblocks todo 14`). Numbers are stable inside the folder.
- **Different bundle**: reference by full folder name + number (`todo-2026-04-22-1100-iot-module/14`).
- Don't reference by filename — filenames are renameable, numbers and folder names are not.

**These references may exist ONLY inside the bundle folder.** A todo bundle is an
ephemeral planning artifact — markdown plans the user reads, then deletes once the
work lands; it is NOT documentation and NOT a citation namespace. Nothing that
ships — code comments, doc comments, specs, READMEs, AGENTS.md — may cite a todo,
bundle, or slice number ("per todo 25", "(todo NN)", "scaffolded by slice 03").
When a slice pins a contract the code will need to explain, the plan must direct
the executor to restate that contract in the shipped code/spec itself; the plan
file is not a place a shipped comment can point. Git history + the bundle's
execution logs carry the how-it-got-done story; shipped artifacts state only what
IS. (This rule exists because past bundles left ~60 dangling "(todo NN)" citations
in code after the folders were deleted — a full sweep had to clean them up.)

## Patterns that pay off

### One concern per todo

If a title needs an "and" or a comma, it's probably two todos. `Implement store and page` → split into `Implement store` + `Implement page`. Smaller slices = smaller worker context windows = better outcomes.

The floor on that: each half must still be worth a Shadow's fixed orchestration
overhead, and the split earns its keep when the halves have disjoint `touches:`
(they then run concurrently). Two "concerns" that edit the same three files and
take ten minutes between them are one slice with two sections, not two slices.

### Pin contracts that cross todo boundaries

When todo N's deliverable becomes todo N+1's input, its semantic contract MUST be pinned somewhere — either inside todo N, or in a dedicated early todo (`01 — Lock shared contract`). Pin externally fixed interfaces such as a wire format, public API, on-disk schema, or error envelope, plus the invariants and observable outcomes the next slice relies on. Do not invent internal function names, local file layout, algorithms, or a call graph for the executor.

### Empirical recon needs a quiescent tree

Planning is normally read-only. But some contracts can only be pinned by trial and error against the real build — measuring current stack headroom, verifying a linker symbol name, checking which `clippy.toml` keys the pinned toolchain accepts. That probing mutates the tree (scratch edits, builds, generated files), so it carries an execution-grade constraint: do it ONLY when no one else is writing to the tree — no in-flight slice workers or validation gates on the same worktree/branch, no dirty files you didn't create. Two writers probing/committing one tree interleave badly (`execute-todos` rule 3 owns the execution-side twin of this rule).

When you do probe:

- Leave the tree byte-identical afterward — revert scratch edits; `git status` clean apart from your bundle folder.
- Bake measured facts into the slice as pinned numbers WITH provenance ("measured on HEAD, <date>, <command>") so the executor doesn't blindly re-derive them — and knows to re-measure if HEAD has moved.
- If the tree is busy, don't idle: write the slice so the EXECUTOR measures at execution time (often the better design anyway — execution-time numbers can't go stale) and pin only the measurement procedure.

### Mirror project structure

For folder-by-feature projects, one todo per feature folder is usually the right granularity. For changes that span layers (frontend page + firmware route), one todo per side with a cross-reference between them.

### Out-of-scope is load-bearing

Every todo with non-obvious boundaries gets an explicit `## Out of scope` section. It's what stops the executor from scope-creeping mid-implementation.

### Deliverable = outcome + verification

State both:
- The visible outcome (`/inverter route shows model picker`).
- The verification command (`pnpm exec vitest run` exits 0; `cargo build --release` exits 0).

Without the verification command, the executor self-grades and the bar drifts. The same rule scales up: `00`'s `## Done when` is the whole bundle's deliverable, `99b` runs the tests and lint and fixes what fails, and `99c` merges the latest target and delivers the result to it.

### Match the project's naming style

Action-shaped titles, targets baked in: `Implement inverter page`, `Wire pnpm build into gate.sh`, `Audit partition table for recovery slot`. No padding verbs (`Implement`, not `Go ahead and implement`). The user's "name user-facing actions" rule applies to todo titles too.
