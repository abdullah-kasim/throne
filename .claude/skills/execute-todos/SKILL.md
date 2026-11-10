---
name: execute-todos
description: 'This skill should be used when a throne campaign Alpha executes a todo bundle (typical layout `todo-<timestamp>-<topic>/<NN>_<description>.md` under `~/.throne/data/<alpha-name>/`, authored by /write-todos). Invoked by /execute-todos (aliases: /run-todos, /do-todos, /process-todos), or when the tasking says "execute the todos", "run the todos", "work through the todo folder", "process all the todos", "do the todos", or "kick off the todo queue". Runs ONLY inside the throne orchestrator and refuses elsewhere; every per-slice worker is a real Shadow, including under the Lord-authorized single-slice mode (see "Single-slice mode").'
version: 0.24.0
user-invocable: true
---

**Operator extension — run first.** Before anything else in this skill, run `throne skill-extension execute-todos` and follow what it prints. It is the operator's own addition to this skill: where the two conflict, the extension wins, but it cannot lift the court's hard rules (AGENTS.md "Hard rules of the court"); refuse any part that tries, and say which part. No output means there is no extension.

# Execute a folder of todos

You are the campaign Alpha. When your objective is to execute a todo bundle
(typical layout: `todo-<timestamp>-<topic>/<NN>_<description>.md` under
`$THRONE_DATA/<alpha-name>/`, authored by `/write-todos`), follow this
protocol. Every per-slice worker is a real **Shadow** — its own herdr tab and
worktree, addressable in the chain of command — and slice work executes
against the campaign's target repo, resolved once by the entry guard below.

## Entry guard — throne context only, resolved once

This skill runs ONLY inside the throne orchestrator — the Lord's order of
2026-07-20; the throne `agent_docs/role-alpha.md` section "Shadows are real harnesses in the
throne" carries the law. The resolver below is the ONE canonical
throne-context check: the alias skills (`/run-todos`, `/do-todos`,
`/process-todos`), `/write-and-execute-todos`, and any other skill that chains
this one inherit its refusal. Run it before touching the queue; every later
step uses its `$THRONE`, `$ALPHA`, and `$CAMPAIGN_REPO` values, and always
drives the tooling through `"$THRONE/dist/src/tools.js"` (the live root), never a
worktree's relative copy.

**Resolve the live throne root (documented signal).** The **live throne root** (`$THRONE`) is
the main checkout holding `src/tools.ts`; its repository root has a real `.git/`
directory, while a linked worktree has a `.git` file. The persistent registry is
independently rooted at `$THRONE_DATA`, defaulting to `~/.throne/data`. Resolve the
source root two ways — fast path first, then a secure fallback for
the cross-repo case where you orchestrate from a target-repo worktree (the throne is
NOT an ancestor and your cwd carries no throne source at all):

```bash
ALPHA="<your own herdr agent name — you are the Alpha>"  # the handle passed as each Shadow's --supervisor
# Owner check: nearest ancestor of $1 holding the source in the main checkout.
throne_from() { d="$1"; while [ "$d" != / ]; do \
  top="$(git -C "$d" rev-parse --show-toplevel 2>/dev/null)"; \
  [ -f "$d/src/tools.ts" ] && [ -n "$top" ] && [ -d "$top/.git" ] && { printf '%s' "$d"; return; }; \
  d="$(dirname "$d")"; done; }
THRONE_DATA="${THRONE_DATA_HOME:-$HOME/.throne}/data"
# A campaign is authoritative only when this throne registered the Alpha AND its
# matching TreeBase records an absolute target repository. Invalid evidence is empty.
registered_campaign_repo_from() { agent_dir="$THRONE_DATA/$ALPHA"; \
  [ -f "$agent_dir/identity.md" ] || return 0; \
  node -e 'try{const b=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));const p=require("node:path");if(b.name===process.argv[2]&&typeof b.repo==="string"&&p.isAbsolute(b.repo))process.stdout.write(b.repo)}catch{}' "$agent_dir/tree-base.json" "$ALPHA" 2>/dev/null; }
registered_alpha_from() { [ -f "$THRONE_DATA/$ALPHA/identity.md" ]; }
# Fast path: orchestrating FROM the throne root (or a subdir of it).
THRONE="$(throne_from "$PWD")"
CAMPAIGN_REPO=""
[ -n "$THRONE" ] && CAMPAIGN_REPO="$(registered_campaign_repo_from "$THRONE")"
# Fallback: orchestrating from a target-repo WORKTREE. Read the trusted herdr
# session's roster and select the Regent with THE THRONE'S OWN name contract —
# `sameAgentName` (case-insensitive on both sides) plus `resolveAgent`'s
# exactly-one-match rule — then re-run the owner check and require this Alpha's
# authoritative campaign registration. Do NOT ask `herdr agent get <name>` to do
# the matching: herdr resolves a target EXACTLY, so a single hardcoded spelling
# (`Regent` vs the live lowercase `regent`) silently misses the live Regent and
# strands a legitimate campaign Alpha outside throne context. A bare caller
# sharing the session has neither identity nor TreeBase, so it stays outside
# throne context. An absent or ambiguous Regent yields empty.
if [ -z "$THRONE" ]; then
  REGENT_CWD="$(herdr agent list 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const want=process.argv[1].toLowerCase();const m=(JSON.parse(s).result?.agents??[]).filter(a=>typeof a?.name==="string"&&a.name.toLowerCase()===want);if(m.length===1&&typeof m[0].cwd==="string")process.stdout.write(m[0].cwd)}catch{}})' Regent 2>/dev/null)"
  if [ -n "$REGENT_CWD" ]; then
    CAND="$(throne_from "$REGENT_CWD")"
    [ -n "$CAND" ] && CAMPAIGN_REPO="$(registered_campaign_repo_from "$CAND")"
    [ -n "$CAND" ] && registered_alpha_from "$CAND" && THRONE="$CAND"
  fi
fi
```

`$THRONE` non-empty ⇒ throne context established. Empty (no throne root above
your cwd AND the Regent fallback cannot establish both one unambiguous
registry owner and your authoritative campaign registration) ⇒ you are NOT in
the throne ⇒ **REFUSE and stop.** Tell the operator plainly — never a stack
trace: this skill is throne-only; either run it from a throne session (a
campaign Alpha spawned by the Regent, working from the throne or its
registered campaign worktree), or have the Regent spawn a campaign Alpha for
the objective. Do NOT degrade into executing slices in the calling session or
nesting workers inside it.

**Resolve the campaign's target repo ONCE (cross-repo propagation).** A campaign
may target a repository that is NOT the throne's own; every slice tree must then be
branched off THAT repo, not the throne. The target is already recorded by the
throne tooling that spawned you — your own `~/.throne/data/<your-alpha-name>/tree-base.json`
`repo` field, written by the `spawn-git-tree` that created your Alpha worktree.
The guard above reads and validates it once into `$CAMPAIGN_REPO`: a
**cross-repo** campaign yields that external repo's path; **self-work** yields the
throne's own path (identical to `spawn-git-tree`'s default); a **manually-launched
Alpha beneath the throne with no recorded tree** yields empty (fall back to the
default throne). Never hand-guess the path — it MUST come from this recorded source,
so a slice can never silently branch off the wrong repo.

## A TEST ITEM OVER TEN SECONDS IS A BUG. MOVE THE BOOTSTRAP OUT.

**Lord's law, 2026-08-21, verbatim:** _"also i declare that any test item that
takes more than 10 seconds as a bug. if the test involves bootstrapping, then do
the bootstrapping outside of the test. Update the todos skills on this."_

**The second sentence is the mechanism, not an aside.** He is not asking for
tests to be deleted or assertions weakened. He is naming _why_ they are slow —
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
  this law are complementary and neither substitutes for the other. This rule
  binds the heavy group only.
- **The slow and container groups are agent-chosen (Lord, 2026-10-15).** His
  words on slow tests: _1. By default, do not run the slow tests - I think we
  already did this, so let's add some more to the slow test list._ On container
  tests: _we should isolate those away and disable them by default. Only an agent
  can judge whether to run them._ A file listed in `test/slow-tests.json` (with
  its measured seconds and why it is slow) is skipped by the default `npm test`
  and runs with `npm run test:slow` or `THRONE_SLOW_TESTS=1`. A file that starts
  a podman or docker container is listed in `test/container-tests.json` and runs
  with `npm run test:containers` or `THRONE_CONTAINER_TESTS=1`; an agent runs that
  group only on its judgment that the change reaches what those tests cover, and
  records that decision in its execution log or report. For these two groups the
  rule above and the shrinking manifest below are superseded by that ruling; the
  heavy group keeps both. The law still binds every default run.
- **ENFORCEMENT IS MANDATORY — `npm test` FAILS on a violation.** Not warns, not
  reports. The Lord's follow-up: _"npm test should fail if something ran for more
  than 10 seconds."_ He was asked to reconsider on flakiness grounds and
  reaffirmed. An earlier ruling calling this a bug-not-failure threshold is
  WITHDRAWN — do not revive it. Contention is real, so state any margin with its
  reasoning, and make the failure message name **both** the measured duration and
  the threshold.
- **Existing slow tests are not grandfathered.** They bind under a manifest that
  may only shrink. For the slow and container groups this is superseded by the
  Lord's 2026-10-15 ruling above; the heavy group keeps it.

**Report, do not file.** If you find a slow test outside your slice's scope, name
it in `REPORT.md` with its measured duration. Do not create a queue item for it —
see the direct-blockers law above.

## EVERY TEST IS AN INTEGRATION TEST, NAMED FOR THE REQUIREMENT

**Lord's law, 2026-08-21, verbatim:** _"update the todos skill to ensure that all
tests are integration tests - I don't want unit test, i want a test that when I
say 'we should be able to message the user', then the test would be named 'we
should be able to message the user'. The test is named based on the requirement,
NOT 'x function must return y'."_

Two rules, and the second is the enforceable one.

**1. NO UNIT TESTS. Every test is an integration test.** A test exercises the
behaviour through the real path a user or a caller would take. It does not reach
into one function, hand it arguments, and assert on its return value in
isolation.

**2. THE TEST NAME IS THE REQUIREMENT, IN THE LANGUAGE THE REQUIREMENT WAS
STATED.** If the Lord says _"we should be able to message the user"_, the test is
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
- It does not license **vague names**. _"messaging works"_ is not a requirement,
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

**Lord's law, 2026-08-21, verbatim:** _"also, no end-to-end test shall be
written. they're too costly."_

Combined with the rule above, the permitted band is exactly one wide:
**not unit, not end-to-end — integration only.**

**THE BOUNDARY, because a campaign frozen between two laws ships nothing.** The
line is _what the test starts up_, not how many layers it touches:

|                 | starts up                                                                                                                                  | verdict                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| unit            | one function, arguments in hand                                                                                                            | FORBIDDEN — too narrow, names the implementation |
| **integration** | **the real code path by CALLING THE FUNCTION THAT DOES THE WORK, in-process, real collaborators behind it**                                | **REQUIRED**                                     |
| end-to-end      | real external infrastructure — spawned agents, live terminal sessions, containers, systemd units, networks, third-party accounts (browsers struck 2026-09-02, see amendment below) | FORBIDDEN — too costly                           |

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

**Lord's clarification, 2026-08-21, verbatim:** _"for integration test - do not
include public entry point - but the underlying function instead. I don't want
use to do tests for './bin/throne-cli update-queue' but instead, test
'updateQueue()'."_

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

**The argument parsing is not the requirement.** _"we should be able to update a
queue item's priority"_ is a promise about `updateQueue()`. Whether the flag is
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
  is _shall be written_ — it governs new tests. Whether the existing real-infra
  tests are removed, kept behind their gate, or rewritten as integration tests is
  a separate decision and not a campaign's to take unilaterally.

**In a todo bundle:** the `## Deliverable` section states requirements as
sentences, and those sentences become the test names verbatim. If a deliverable
cannot be written as a sentence someone would say out loud, it is not yet a
requirement and the slice is not ready to plan.

## DO NOT MANUFACTURE MORE WORK. DIRECT BLOCKERS ONLY.

**Lord's law, 2026-08-21, verbatim:** _"ok make this law. this isnt working out.
the todos skill MUST NOT ask regent to create more alphas or create more queue
items UNLESS they are direct blockers to the task at hand."_

Read **"this isnt working out"** as the operative half. It is a judgement on
outcomes, not on queue hygiene. A court that delivers steadily while every
campaign spawns successors leaves the Lord further from his own objectives, not
closer. This rule stops a growth process.

**DIRECT BLOCKER** means _this campaign's own stated deliverable cannot be
completed until that work is done._ Not "would be better if". Not "we noticed
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
work — inside this campaign, as a numbered corrective slice — and then deliver.
Do NOT hand it to the Regent, do NOT ask for another Alpha, and do NOT stop and
wait. There is nowhere to pass it to: `add-to-queue` now admits the Stager role
alone, and the Stager files only on the Lord's own instruction, so a blocker
you punt upward does not become someone else's objective — it becomes nothing,
and your campaign stalls holding it.

This is the one case where widening the slice list is correct rather than scope
growth, and the distinction is the same one the rest of this rule already
draws: the blocker is work your ALREADY-STATED Done-when cannot be reached
without. Fixing it does not change what the bundle promises; refusing to fix it
means the bundle's promise is never kept. "Would be better if" is still not a
blocker, and the burden is still on you — an unclear case still resolves
against widening.

Record it honestly rather than silently: name the blocker in the bundle's
question log and in `REPORT.md`, say why the deliverable was unreachable
without it, and number the corrective slice like any other. A widened bundle
that says so is a campaign doing its job; a widened bundle that hides the
widening is the manufactured-scope failure this rule was written to stop.

**The escape hatch is the Lord, and it is narrow.** Escalate only when the
blocker cannot be fixed inside the campaign at all — it needs a decision the
Lord alone can make, it would change the Done-when itself, or repairing it is
genuinely outside what this campaign can reach. Then report it to your
supervisor for the Lord, name it precisely, and keep every other part of the
work moving in the meantime.

**Correcting your own incomplete decomposition is not scope growth** and remains
yours under the mid-flight amendment contract. The test is whether the
**Done-when changed** — not whether the slice list did. An unchanged Done-when
whose slices could never have delivered it is an error you fix; a changed
Done-when is a new objective and only the Lord may expand an active bundle.

**Note for implementers:** this prohibition is stated because the banned
behaviour is _emergent_, not instructed. No todos skill ever contained an
instruction to file queue rows. Grepping for one and finding nothing disproves
nothing.

## Delivery-mode classification — single owner

Classify once from the target itself, never from preference. Resolve an absolute,
existing `TARGET_PATH`: use the registered `tree-base.json.repo` when present;
otherwise require the objective or `00_overview.md` to name the operational
target path explicitly. Run `git -C "$TARGET_PATH" rev-parse --show-toplevel`.
A successful probe whose returned root contains the target is `git-repo`; a
failed probe against the existing target is `no-git`. Missing or unreadable
target evidence is an error, not `no-git`. Record `delivery_mode`, target path,
command, exit code, and output in `00_overview.md`; execution re-runs the probe
and refuses if the evidence changed. Never run `git init` to alter the result.

`git-repo` uses the existing worktree/candidate/terminal flow, with slice
merge-back through the live throne's `merge-git-tree` transaction and final
delivery through plain git in `99c`. `no-git`
uses real fresh Shadows in a throne-managed `--empty-worktree` scratch workspace,
serializes all mutations against the separately named `TARGET_PATH`, and records
progress in the throne ledger. The scratch workspace is not the target checkout
or Git delivery authority; it exists to provide the required managed cwd and
generated instructions for a treeless/read-only campaign. `no-git` skips commit,
merge-back, Git cleanliness/history gates, and Git delivery with the probe-backed
N/A reason. Applicable checks still run, `99a` grades conformance against the request,
`99b` runs and fixes the naturally applicable ones, and `99c` independently
confirms the final operational state
and emits the final outcome. Preserve pre-existing ambient state and any objective-native
rollback evidence. This is classification and guarding only: do not add an SSH,
transport, or remote-operations framework.

## NO PROCESS DEVIATION. THE GATE CHAIN IS NOT OPTIONAL.

**The Lord's order of 2026-08-14, after THREE campaigns skipped the chain in a
single day, each with a polite explanation.**

**You run the full real-Shadow gate chain. Every slice. Every campaign. No
exceptions, no abbreviations, no "I did the equivalent checks myself".**

**WE DO NOT CARE ABOUT YOUR MODEL'S CAPABILITY, REASONING BUDGET, CONTEXT
BUDGET, OR SELF-ASSESSMENT. JUST DO IT.**

### The excuses that are now explicitly forbidden

Every one of these was offered in good faith by a competent agent, and every
one is refused:

- "At my reasoning budget, faking a chain I could not verify was worse than
  doing the work directly." — **No. Run the chain.**
- "The diff is small enough for one competent reader to review in full." — **No.
  Diff size does not predict blast radius.**
- "This was ad-hoc work, not a planned todo bundle, so the chain's machinery
  does not attach." — **Then author the bundle and run the chain.**
- "I ran every check that chain would have run — typecheck, lint, tests,
  format, file-size, secrets." — **Running the checks is not the point.**
- "It is only test constants / only a config file / only two numeric values."
  — **No.**

### Why capability is the wrong argument

**The chain is not a competence test you can pass out of.** Its value is that
the reader is NOT YOU: a separate Shadow, with separate context, that did not
form your assumptions and cannot inherit your blind spot. A self-check
reproduces the reasoning that created the defect.

Measured, same day this rule was written:

- A campaign self-certified a two-constant test change. Fine in isolation — it
  silently raised a HARD safety bound (`COMMAND_DEADLINE_MS` 8s -> 12s),
  disclosed in a parenthesis as "unrelated".
- A campaign self-certified a retry loop. The author, the Regent reading the
  full diff, and every local test passed it. It gave each attempt a FRESH
  900s lane budget — 3 x 900s against a 975s sandbox kill and a 1005s lock —
  which would have made BullMQ reclaim the job and **deliver the message twice
  into a live pane.** The broken invariant was documented in a file the diff
  never touched. **Only an independent re-derivation catches that.**
- The one campaign that DID run the full chain had its terminal gate **mutation-test its
  own claim** — reverting the fix to confirm the test then failed. That is a
  thing you cannot do to yourself convincingly.

**Small diffs are where this bites hardest**, because small diffs are exactly
what feels safe to wave through.

### If you genuinely cannot run it

**Stop and report to your supervisor. Do not proceed and disclose afterwards.**
An honest deviation reported after the merge is still a deviation, and the
merge has already happened. Ask BEFORE, not after.

Deviation is a **Regent-or-Lord decision, never yours** — the same rule as
every other bypass in this skill. Saying so plainly in the report earns you
credit for honesty and **does not make the deviation authorised.**

## Todo-run personality — read before spawning

Before choosing execution order or spawning the first slice, resolve the bundle
personality:

1. Read `00_overview.md` YAML frontmatter for `todo_run_personality:` first,
   then `personality:` as a backward-compatible alias.
2. If no frontmatter stamp exists, read the first explicit `default`,
   `focused`, or `perfectionist` value under `## Run personality`.
3. If neither exists, default to `default`. Reading unstamped OLD bundles as
   `default` is a deliberate retroactive choice (the Lord's order of
   2026-07-21, the named successor to the 2026-07-20 flip away from
   assumed-perfectionist), even though they were authored when `perfectionist`
   was the default: perfectionist's add-more-when-it-improves-the-result
   appetite is what accumulated the complexity that once demanded per-slice
   capability stamps, and the
   2026-07-20 flip to a restrained posture is the root-cause fix — `default` is
   its named successor, governed by the original promise rather than generic
   cleanup appetite, so the restrained reading wins for old plans too.

All three of `default`, `focused`, and `perfectionist` are valid; `focused` and
`perfectionist` run only when the bundle names them explicitly. If the bundle
names any other value, log a question in `000_current_questions.md`, assume
`default`, and continue.

- **focused** (explicit request only; the strictest): no discretionary work at
  all — no sidequests AND no discretionary refactors, not even a
  behavior-preserving simplification. Limit execution to the bundle's objective
  and the work required to keep that objective coherent, tested, maintainable,
  and honest. A scope limit that makes the user's objective incomplete is not
  focused; it is a miss — this posture forbids only discretionary additions.
- **default** (the default): identify the feature's original promise, intent,
  and acceptance contract, choose the smallest implementation that fulfills
  it, and ship as soon as it is fulfilled. Add no feature, abstraction,
  configurability, speculative edge-case machinery, future-proofing, or
  optional robustness. Complexity may increase only when named concrete
  evidence shows the simple implementation misses an original requirement or
  a reproduced bug requires a correction, and the added mechanism must stay
  minimal to that cause. Validation grades the initial promise and known bug
  fixes; it must not manufacture requirements, edge cases, robustness goals,
  unrelated findings, or other scope. Under `default`, admissible work is
  limited to exact user-requested outcomes, candidate-caused regressions, and
  the minimum defect-clearing work required when a discovered issue truly
  blocks that requested outcome. A discovered unrelated or pre-existing defect
  is report-only: record it as a separate finding, but do not let it become a
  corrective slice, candidate failure, gate restart, or acceptance criterion. A
  simple implementation that misses any original acceptance criterion is
  incomplete, not ready to ship. Boy Scout cleanup under `default` is limited
  to behavior-preserving structural hygiene: DRY/SOLID conformance,
  readability, local duplication and dead-structure cleanup, and keeping
  production files within the repository's 500-line boundary. It never
  authorizes fixing a different functional bug.
- **perfectionist** (explicit only): complete every planned sidequest and, when
  it improves the experience without breaking the objective, create and finish
  additional sidequests — features and experience improvements included. If a
  sidequest is substantial, add a numbered todo before the terminal chain and run a
  fresh worker for it; if it is tiny and local, fold it into the current slice
  and record it in that slice's execution log.

The personality never overrides the question log, the one-fresh-worker rule,
cleanup, or validation. Pass the
resolved value and its definition into every slice worker's assignment.

## Active throne plan — live, mechanically spawnable role pairs

Against the entry guard's resolved live root, run:

```text
<live-throne>/bin/throne-cli list-harnesses-and-models --json
```

Read top-level `active_plan` before availability. Preserve the order of its
full-pair allowlists:

- this ORCHESTRATOR uses `active_plan.rolePools.Alpha`;
- ordinary slice workers (`01`–`98`) use `active_plan.rolePools.Shadow`;
- all three terminal workers (`99a` conformance, `99b` verify-and-fix and `99c` delivery) use
  `active_plan.rolePools.ShadowSlice99`.

A missing or malformed live root, plan, selected role pool, or pair pauses the
run; never reconstruct it from prose. The shared `resolveSpawnAdmission` seam
admits only a canonical mechanically spawnable pair from the applicable preset
pool, campaign pin/allowlist, valid human `model_hint`, or durable human
exception. It never remaps, upgrades, escalates, or retries through another
pair. Record the requested pair, final pair, and admission reason in each
todo's execution log. A refusal goes to the Regent for a human route decision.

## Admission and exception contract — the single home

Every fresh spawn passes through the shared resolver. A valid queue
`model_hint` is persisted on its Alpha and inherited only by that Alpha's
recorded descendants. Role pins, non-empty allowlists, dated
evidence-based disqualifications, and Lord/Regent authorization are admission
inputs, not ranking signals. Existing migration routes remain available until
their documented retirement criteria are met. Exact registered resumes retain
their stored recipe. Effort is a launch setting and never an admission ranking.

There is no automatic fallback, escalation, or retry ladder. A refusal is
evidence for the Regent to make a human route decision; do not blindly rerun
the request or select a supposedly stronger model.

## Hard rules

### 1. Recon, map the semantic functions, then log progress in the todo

Apply the throne's `agent_docs/coding_principles.md` section “Name the logic
before implementing it” by reference; do not restate it as a second doctrine.
Every **non-trivial coding slice** — one that introduces or changes reusable
domain logic or multi-step control flow — records a semantic-function map after
code recon and before its first implementation edit. A purely mechanical edit
or an obvious single expression is trivial and owes no map.

Write the map in the todo's own `## Execution log`. It names the slice's
**predicates, transformations, decisions, and effects** in domain language. All
four categories appear; state a category is empty when recon finds no member
instead of inventing filler. Each entry records the existing-code search for
that meaning and then either identifies the function it will reuse or explains
why a new extraction is warranted. Without the recorded search and
reuse-or-justify result, the entry is incomplete.

The executing Shadow owns the concrete function names and implementation. A
planner-invented name, local algorithm, or speculative call graph is never
binding. The Shadow may refine names and map entries as evidence changes, but
must preserve the overview and slice contract: its semantic decisions,
invariants, reuse obligations, evidence, and deliverable. Changing that
contract is an amendment and follows Rule 9 rather than a quiet map revision.
Update the map when implementation evidence changes it so the execution log
records the vocabulary that actually landed.

After recon, also refine the slice's suspected READ / CHANGE / CREATE file
inventory. It is a search-starting hypothesis, never an allowlist: the Shadow
may use unlisted files and may leave listed files untouched without an
amendment. Log every material deviation and its reason in the execution log. A
material deviation means either a file expected to CHANGE was not changed, or
an unlisted file was changed or created; additional reads are ordinary recon
and need no itemized log.

The overview's `## Proposed function contract map` is the planner's proposal and
carries exactly the status of that file inventory: a search-starting shape, never
an allowlist and never frozen mechanics. Suggested names, parameters, and
signatures are NOT mandatory identifiers; after recon the Shadow may refine any
of them. It must record material deviations in its execution log and preserve
each contract's stated responsibility, inputs, outputs, and failure outcome —
refine the vocabulary, keep the contract.

These are one handoff, not two doctrines. The proposed function contract map is
what the planner suggested before code recon; the semantic-function map above is
what the executing Shadow recorded after it. Where they differ, the recorded map
is what landed and the deviation log says why.

Trivial expressions earn neither map entries nor extraction. Arithmetic,
formatting, obvious single-use comparisons, purely mechanical edits, and
one-line wrappers added only to appear compliant must not pad the map; such
wrappers are a defect, not evidence of semantic design.

### Platform-first audit — re-check after recon

Execution inherits the planner's platform-first audit and must re-check it after
recon, then again whenever repeated repairs or dependency evolution suggest the
bundle may have grown duplicated ownership. Inventory the current stdlib,
platform, and installed-dependency primitives against the needed guarantees
before accepting a new tool, transport, parser, wrapper, or state machine.
Prefer direct reuse first, then a thin wrapper, and accept custom machinery only
when concrete evidence shows every candidate primitive still misses a required
guarantee.

The current slice-launch transport is the ordinary `send-agent` path shown in
Rule 2 below. The current herdr agent prompt path is a different mechanism and
must not be treated as equivalent by mention alone. When a regression or review
claims a transport gap, it must say which guarantee `send-agent` lacks, what the
current herdr path provides instead, and what evidence proves the missing
guarantee. Unsupported claims are findings, not justification.

Each todo file gets an `## Execution log` section appended when its work lands:

```markdown
## Execution log

**Status:** completed (or "completed (X stub pending Y)").

- One-line summary of what shipped.
- Key files + line counts, taken from the evidence command's `inventory` and
  `line-sizes` sections rather than counted by hand.
- Decisions you made that the todo didn't pin.
- Verification results (gate exit code, test counts, the shift-left mechanical
  checks' commands and exit codes).
- Unblocks todo NN.
```

**Do NOT include the commit SHA in the log.** The Shadow's single commit cannot self-reference its own SHA, and `git log` is the source of truth for SHAs anyway. The execution log captures the WHY and the deltas — not git plumbing.

### 2. One worker per todo — a fresh real Shadow every time, never continue

**Every todo gets a brand-new worker, and a worker is a real Shadow** — a
herdr-tab harness with its own worktree, spawned via `create-agent` and
addressable in the chain of command — never a worker nested inside your own
session, and never a reused one. Do NOT reuse a previous Shadow across todos
(no follow-on tasking via `send-agent` to a prior slice's Shadow; no
resuming/continuing a prior worker). Even if the previous worker finished
cleanly, even if the next todo seems closely related, even if "it'd save
tokens".

The procedure — the reasons, what each Shadow does, and the spawn steps — is in `shadow-spawning.md`.

### 3. Scheduling contract — concurrency with honest serialization

Throughput comes from running slices that genuinely cannot collide, and from
serializing everything that can. The contract below is the whole law; the

The contract itself is in `scheduling.md`.

### 4. Every worker MUST read the global CLAUDE.md

Every Shadow's `ASSIGNMENT.md` must explicitly direct it to read:

- The global agent instructions for the worker's harness (claude: `~/.claude/CLAUDE.md`; codex: `~/.codex/AGENTS.md`), when present. They carry the operator's own conventions.
- Its memory directory — `throne memory-dir --json .` from its cwd (the same path its identity names): `ls` it and read anything relevant before the slice, and write every correction, busted assumption, or dead end there the moment it happens. The throne's memory law is `AGENTS.md` "Discovery + learning"; the resolution contract is `agent_docs/commands.md` under `memory-dir`.
- `$THRONE/agent_docs/CRITICAL_coding_a_feature_masterplan.md`.
- `$THRONE/agent_docs/coding_principles.md` — SRP, DRY, self-documenting names, no surprises, contract-based design.
- `00_overview.md` if the bundle has one — the north-star for the whole bundle (the feature, the architecture, the `## Done when` acceptance checklist). Gives the worker the big picture its single slice plugs into, so local choices serve the global goal.
- The resolved todo-run personality (`default`, `focused`, or `perfectionist`)
  plus the matching definition from this skill.
- The specific todo file the worker is executing.
- Any cross-referenced todos (list them by filename in the assignment).
- Project `AGENTS.md` if present (project-level invariants).
- `question-log-template.md` (alongside this SKILL.md) — the required format for logging an unpinned decision to `000_current_questions.md` (see rule 5). Pass its absolute path so the worker reads it before writing any question entry.
- The files of this skill its slice type needs, by absolute path, and no others. From this SKILL.md every Shadow reads the capital-titled sections and hard rules 1, 5, 7, 8 and 10, not the whole file; then:
  - ordinary slice (`01`–`97`): `commit-messages.md`, `slice-work.md`.
  - `98_ticket_`: `commit-messages.md`, `slice-work.md`, `gate-99a-conformance.md`.
  - `NNz_critique`: `commit-messages.md`, `slice-work.md`, `rubric-critique-gates.md`.
  - `99a`: `commit-messages.md`, `slice-work.md`, `gate-chain.md`, `gate-99a-conformance.md`.
  - `99b`: `commit-messages.md`, `slice-work.md`, `gate-chain.md`, `gate-99b-verify.md`.
  - `99c`: `commit-messages.md`, `slice-work.md`, `gate-chain.md`, `gate-99c-deliver.md`.
  - `99d`: `commit-messages.md`, `gate-99d-record.md`.

  `shadow-spawning.md`, `scheduling.md`, `single-slice-mode.md` and `final-report.md` are the Alpha's alone; no assignment names them.

Every Shadow's `ASSIGNMENT.md`, gates included, also carries the background-wait rule: when it ends a turn to wait on background work it started (a test or suite run, a monitor, a queued container slot, a background agent), it ends that message with `{"blocked":true} BLOCKED_BY_own-background-run (<what>)`, for example `{"blocked":true} BLOCKED_BY_own-background-run (candidate and base suites)`. Its next ordinary message clears the marker. Otherwise no-idling pages the Regent every minute about an agent that is not idle.

Without these, workers drift to whatever defaults they were trained on. The principles file in particular enforces non-obvious habits like "no comments restating what code does" and "rule of three before extracting a helper".

### 5. Don't halt the queue to ask — route EVERY decision through the question log

When running this skill, do **NOT** stop and wait on the user (no interactive question tool — claude's `AskUserQuestion` or any harness equivalent — no "should I…?" pauses) — for ANY decision, **blocking or non-blocking**. Halting strands the whole queue while the user is away, and a blocking decision is precisely the case where a stall costs the most. The question log is **not** a non-blocking-only escape hatch; it is the single channel for every decision the todos left unpinned, blocking ones included. The discipline:

1. **Try hardest to answer it yourself first.** A genuinely blocking decision earns _more_ effort to resolve — from the code, the specs, the designs, the bundle's `00_overview.md` — not a halt. Most "blockers" dissolve once you actually dig.
2. Append the question to `000_current_questions.md` in the bundle's todo folder (create it if missing), write your **best-judgment answer** underneath, and proceed on that answer.
3. Keep going. The user reads `000_current_questions.md` in the background and answers back **in the same file** — even for blocking decisions — out of band, without you waiting. When they do, reconcile (see below).

The point: a blocking decision is not a reason to stop; it is a reason to (a) work harder at your own answer and (b) flag it louder (`Reversible? no`, surfaced first in your final report) so the user prioritizes it. The queue keeps moving on your best judgment; the user's later answer corrects course.

**Entry format lives in [`question-log-template.md`](./question-log-template.md)** (alongside this SKILL.md) — the authoritative, self-contained spec for the file header and per-question entry. It is its own file precisely so each fresh slice worker can be pointed at it and reproduce the format exactly; do NOT rely on a worker inheriting the format from prose it never reads.

**Orchestrator mandate (non-negotiable):** every slice worker's assignment MUST include the absolute path to `question-log-template.md` and the instruction: _"if you log a question, append it to `000_current_questions.md` using the format in that file verbatim — every entry ends with a blank `**User answer:**` line."_ This is the mechanism that failed in the past: the template was buried in SKILL.md prose (which workers never read), so they drifted into freeform notes with no `User answer:` slot and the user had nowhere to type. The template file + this mandate close that gap.

The cardinal rule (repeated here because it is the whole point): **always emit the `**User answer:**` line and always leave it blank.** It is the user's slot — when they fill it in, treat it as the authoritative decision and reconcile any work already done on the assumed answer (re-do the reversible bits, flag the irreversible ones), updating that entry's `**Status:**` to `RECONCILED — applied`.

Rules for this log:

- It covers **both blocking and non-blocking decisions** — scope, contract shape, naming, ordering, AND the load-bearing calls that would traditionally make you stop and ask. Not for trivia you can settle from the code.
- ALWAYS pick a defensible default and move on. A wrong-but-reversible default the user can veto beats a stalled queue. For a blocking call, invest more in getting the default right _and_ mark it `Reversible? no` when undoing it is costly, so the user triages it first.
- Surface the full `000_current_questions.md` (or a digest of it) in the final report so the user knows what assumptions the run rode on — lead with the blocking / irreversible ones.

This overrides any instinct to confirm before acting: a _decision_ — even a blocking one — never pauses the queue; you answer it yourself and proceed. The only thing that genuinely halts progress is a **mechanical** blocker (a broken build the worker can't get past, a missing credential, a tool that won't run) — and even then you log it, **fix it as a numbered slice in this bundle**, and meanwhile skip to any slice not downstream of it rather than idling. Clearing a mechanical blocker is in scope by definition: the bundle's stated Done-when cannot be reached while it stands (see "DO NOT MANUFACTURE MORE WORK" above, which owns the expand-and-clear contract). It is not something to report and wait on.

**A blocker is a conclusion, not an initial observation.** Before reporting one,
exhaust reasonable repository-controlled remedies: investigate the cause,
search existing and authoritative sources, acquire or configure missing
dependencies, implement missing pieces that are within scope, try a supported
alternative, and continue independent work. Report a blocker only when the
remaining requirement depends on authority or evidence the agent genuinely
cannot obtain or create. State what was tried, what exact evidence is missing,
and what would clear it; never convert absence, inconvenience, or an untried
setup path into a stopping condition. And note where such a report GOES: to
your supervisor for the Lord, never to the Regent as work to dispatch. The
Regent cannot file it — `add-to-queue` admits the Stager role alone, and the
Stager files only on the Lord's own instruction — so anything you could have
fixed yourself and chose to report instead simply does not get done.

### 6. Run each todo on the admitted model pair

Read `<live-throne>/agent_docs/MODEL_POLICY.md` before the first spawn. The
active preset supplies `rolePools.Alpha`, `rolePools.Shadow`, and
`rolePools.ShadowSlice99`; campaign pins, allowlists, and a human queue
`model_hint` may supply the applicable permitted pair set. Use the shared
`resolveSpawnAdmission` behavior through `create-agent`, record the admitted
pair and reason, and preserve its durable spawn evidence.

Do not rank models, calculate a floor, remap to a fallback, or retry through a
stronger route. A mechanically unspawnable or disallowed pair is a refusal for
the Regent to resolve with a human decision. Exact registered resumes retain
their recorded recipes. Effort is not an admission signal.

### 7. Code cleanup is mandatory — delete what your change makes stale

Git history is the archive; code is the present. When a slice's change supersedes existing code, that code gets DELETED in the same commit that lands the replacement. Never preserve a replaced implementation "for reference":

- No commented-out blocks of the old version.
- No `_old` / `_legacy` / `_v2` parallel copies alongside the new code.
- No dead feature flags guarding paths the change removed.
- No re-exports or shims kept only for history.

Anyone who needs the old version has `git log`. Every slice worker's assignment MUST include this mandate verbatim alongside the rule-4 reading list. If the todo carries a `## Kill list` section (from `/write-todos`), executing every entry is part of the slice's deliverable — the slice is not complete while superseded code survives. If the todo has no kill list but the change obviously strands old code, delete it anyway and record the deletion in the execution log.

### 8. Shipped artifacts never cite the plan

Todo bundles are ephemeral planning artifacts — markdown the user reads, then
deletes once the work lands. They are NOT documentation and NOT a citation
namespace. Everything a slice ships — code comments, doc comments, specs,
READMEs, AGENTS.md — must stand alone in the present tense:

- NEVER write "(todo NN)", "per todo 25", "slice 03 adds…", "this bundle…",
  "todos/<file>.md", or any other pointer at the plan into a shipped
  artifact. Once the bundle is deleted, every such pointer dangles (a past
  cleanup swept ~60 of them out of shipped code).
- Where a todo pins a contract the code needs to explain, RESTATE the
  contract in the shipped comment/spec — never point at the plan file that
  pinned it.
- The two sanctioned homes for plan/history context: the todo file's own
  `## Execution log` (rule 1) and git (commit messages may carry the bundle
  prefix). Nothing else.

**Orchestrator mandate (non-negotiable):** every slice worker's assignment MUST
include this prohibition, alongside the rule-5 question-log mandate and the
rule-7 cleanup mandate. The default failure mode is a worker helpfully
"citing its sources" — forbid it explicitly, every spawn.

### 9. Mid-flight steering amends the overview before it changes the work

New user steering that arrives mid-run — objective, scope, or acceptance — is an
amendment, and the amendment lifecycle has exactly one normative home:
[`write-todos/SKILL.md`](../write-todos/SKILL.md) → "Mid-flight amendments — the
one reconciliation contract". Read it there. What follows is only this phase's
operational summary of the orchestrator's obligations under it — it adds no
exception and defines no alternative lifecycle, and that contract governs
wherever this summary is thinner:

- Append user steering that arrives through the chat/steering channel verbatim as
  the next ordered source turn in `00_overview.md` and reconcile every surface
  that contract names BEFORE dispatching further work in the amended area;
  unaffected in-flight slices keep running.
- Expand the active bundle only for a direct Lord amendment. Regent may relay
  the Lord's exact wording verbatim with its provenance intact, clarify existing
  requested scope, and coordinate the minimum correction of a candidate-caused
  regression or a defect demonstrably blocking the requested outcome. A
  Regent-originated feature, unrelated bug, robustness goal, cleanup outcome, or
  new acceptance criterion is a finding queued as a separate objective with a
  new Alpha, never an amendment appended to this bundle.
- Never let a chat/steering amendment live only in a Shadow's assignment prose or
  the final report. A `000_current_questions.md` answer is the other channel and
  stays in it: it is never promoted into the ordered source turns, even when it
  changes an execution decision, and reaches the bundle only through the rule-5
  question log plus the same surface reconciliation.
- A numbered queue amendment reaches you as a short pointer from
  `throne amendment` (and every amendment recorded before launch is in your
  situation brief). Read it whole with `throne render-queue --status
  in-flight`, append it verbatim as the next source turn with its
  `AMENDMENT <n>` provenance, reconcile, and set
  `**Queue amendments reconciled through:** <n>` in `00_overview.md` to the
  highest number reconciled. This one is enforced in code, not only by the
  gate Shadows: the push guard and `merge-git-tree` run
  `throne check-queue-amendments-reconciled` and refuse delivery while the
  number is below the row's highest amendment. An amendment that lands after
  a terminal PASS makes that PASS stale, exactly as below.
- Re-stamp `**Amendments reconciled through:** Source turn N`; a missing
  `**Amendments reconciled through:**` line, or one naming a lower turn than the
  last recorded source turn, is a preflight FAIL returned to the Alpha (rule 9).
  When the amendment lands after a terminal PASS, treat that PASS as stale and
  spawn a fresh real Shadow over the amended bundle before any `99c`: `99a`
  when the amendment changes what was asked for, `99b` when it changes code.

### 10. Legacy code is frozen to new features — capability lands in `src/nest-commander/`

The durable law is the "The legacy-feature freeze" section of the throne's
`AGENTS.md`; the executable decision, and the frozen record of which in-flight
scope is grandfathered, live in `src/nest-commander/`. Read the verdict there.
This rule states only what the orchestrator and its workers must DO about the
freeze, and it adds no exception to it. The freeze binds this repository's own
`src/` tree: a campaign whose target repository is not the throne has no
`src/nest-commander/` and is unaffected.

**Orchestrator mandate (non-negotiable):** every slice worker's assignment MUST
include this obligation verbatim, alongside the rule-5 question-log mandate, the
rule-7 cleanup mandate, and the rule-8 plan-citation prohibition:

> When your slice needs a new command, a new user-visible capability, or an
> expansion of an existing feature, implement it under `src/nest-commander/` —
> never in legacy `src/`. Legacy `src/` is open to your slice only for bug fixes,
> behavior-preserving refactors, compatibility maintenance, tests, and thin
> `src/exec.ts` migration plumbing. If the capability belongs to a command that
> has not been ported to `src/nest-commander/` yet, STOP and report that to your
> supervisor instead of implementing it: that command's migration is expedited
> first, and the capability is implemented only afterwards, only in
> `src/nest-commander/`. A temporary legacy implementation is forbidden — you do
> not get to decide that an interim legacy implementation is acceptable because
> the port has not happened yet. That decision was already made, and refused.

The worker this mandate exists for is the Shadow mid-slice who has just found
that the tidiest home for its code is a legacy file, with nobody watching. That
is why the obligation rides every spawn instead of living where only a careful
reader of this skill would meet it.

**Both gates judge it,** because location and intent are different faculties:

- The **static-analysis gate** checks location mechanically. Its deterministic
  manifest carries an entry listing the campaign's changed paths under `src/`
  outside `src/nest-commander/`, and each such path must be a permitted legacy
  change kind or recorded grandfathered scope. A command sees a path for free and
  cannot be talked out of it.
- The **substantive validation gate** judges what no command can: whether a change
  that reads as a permitted refactor is a new feature wearing a refactor's
  clothes, and whether a slice quietly implemented a capability that belongs to a
  command nobody has ported yet.

## Patterns that pay off

The patterns live in the supporting files below, one file per reader.

## Supporting files

- `commit-messages.md` — read before the first commit of a slice, of a gate, or of any Alpha commit.
- `shadow-spawning.md` — read before spawning the first Shadow of the run.
- `scheduling.md` — read before deciding which slices run concurrently, and when a Shadow dies or a todo is not actionable.
- `single-slice-mode.md` — read when the Lord authorizes single-slice mode for this run.
- `slice-work.md` — read before starting any slice, gates included.
- `gate-chain.md` — read before writing the first `99` assignment, and when running any `99a`, `99b` or `99c` gate.
- `gate-99a-conformance.md` — read when writing the `99a` assignment, when running `99a`, and when the bundle has a `98_ticket_` todo.
- `gate-99b-verify.md` — read when writing the `99b` assignment, when running `99b`, and when shaping a corrective refactor slice.
- `gate-99c-deliver.md` — read when writing the `99c` assignment and when running `99c`.
- `gate-99d-record.md` — read when writing the `99d` assignment and when running `99d`.
- `rubric-critique-gates.md` — read when the bundle has an `NNz_critique` todo or a rubric threshold.
- `final-report.md` — read before writing the campaign's final report.
- `question-log-template.md` — read before writing any entry in `000_current_questions.md`.
