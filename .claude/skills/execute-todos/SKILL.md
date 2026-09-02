---
name: execute-todos
description: 'This skill should be used when a throne campaign Alpha executes a todo bundle (typical layout `todo-<timestamp>-<topic>/<NN>_<description>.md` under `~/.throne/data/<alpha-name>/`, authored by /write-todos). Invoked by /execute-todos (aliases: /run-todos, /do-todos, /process-todos), or when the tasking says "execute the todos", "run the todos", "work through the todo folder", "process all the todos", "do the todos", or "kick off the todo queue". Runs ONLY inside the throne orchestrator and refuses elsewhere; every per-slice worker is a real Shadow.'
version: 0.23.0
user-invocable: true
---

# Execute a folder of todos

You are the campaign Alpha. When your objective is to execute a todo bundle
(typical layout: `todo-<timestamp>-<topic>/<NN>_<description>.md` under
`$THRONE_DATA/<alpha-name>/`, authored by `/write-todos`), follow this
protocol. Every per-slice worker is a real **Shadow** — its own herdr tab and
worktree, addressable in the chain of command — and slice work executes
against the campaign's target repo, resolved once by the entry guard below.

## Entry guard — throne context only, resolved once

This skill runs ONLY inside the throne orchestrator — the Lord's order of
2026-07-20; the throne `AGENTS.md` section "Shadows are real harnesses in the
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
  this law are complementary and neither substitutes for the other.
- **ENFORCEMENT IS MANDATORY — `npm test` FAILS on a violation.** Not warns, not
  reports. The Lord's follow-up: _"npm test should fail if something ran for more
  than 10 seconds."_ He was asked to reconsider on flakiness grounds and
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

Apply the global `claude/agent_docs/coding_principles.md` section “Name the logic
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

## Task-focused commit-message contract — single owner

This section is the one owning policy for every commit created by this workflow.
Planning skills, chained workflows, terminal gates, correction passes, reports,
checkpoints, and aliases inherit it by reference; they must not copy or weaken it.

A commit message describes the repository change, never the machinery that caused
it. Apply the contract to the complete subject and body before every commit:

- Write a concise imperative subject naming the shipped task-domain behavior. An
  optional body may preserve useful technical detail: rationale, important
  implementation choices, compatibility effects, and concrete validation.
- Reject provenance or orchestration narration anywhere in the subject or body:
  todo-skill execution, workflow/campaign mechanics, Herdr, terminal tabs, agents,
  or the role names Alpha and Shadow. Do not mention assignment files, execution
  logs, slice/gate ceremony, supervisor messages, merge choreography, or who did
  the work.
- Reject campaign/objective identifiers and their abbreviations as commit scopes,
  tags, or prose (for example `BUD`, `CMG`, `docs(bud)`, or `checkpoint(cmg)`). A
  product acronym is allowed only when it is independently meaningful in the
  repository's task domain rather than provenance for this run.
- Do not erase technical specificity to satisfy the rule. `Fix retry backoff after
quota refresh` is better than `Update code`; `Validate retry timing with fake
timers` is valid detail. The forbidden axis is internal provenance, not precise
  engineering language.

The same check applies to every commit class: implementation, validation-only,
delivery/integration, corrective repair, report/documentation, checkpoint, and
all chained or aliased workflow commits. Examples:

| Class           | Accept                                         | Reject                             |
| --------------- | ---------------------------------------------- | ---------------------------------- |
| implementation  | `Enforce task-focused commit messages`         | `Run todo 01 commit-message work`  |
| validation      | `Cover commit-message rejection cases`         | `Record Shadow validation gate`    |
| delivery        | `Publish commit-message safeguards`            | `Deliver CMG campaign`             |
| correction      | `Preserve technical detail in commit subjects` | `Fix Alpha review finding`         |
| report          | `Document commit-message policy evidence`      | `Report Herdr execution results`   |
| checkpoint      | `Save commit-message policy baseline`          | `checkpoint(cmg): finish slice`    |
| chained / alias | `Apply commit-message policy across workflows` | `Run plan-and-execute agent chain` |

Before committing, inspect the final message exactly as Git will receive it. If
any rejected-axis term appears, rewrite the message around the shipped repository
behavior. A message that cannot explain the task-domain change without workflow
provenance is not ready to commit.

### 2. One worker per todo — a fresh real Shadow every time, never continue

**Every todo gets a brand-new worker, and a worker is a real Shadow** — a
herdr-tab harness with its own worktree, spawned via `create-agent` and
addressable in the chain of command — never a worker nested inside your own
session, and never a reused one. Do NOT reuse a previous Shadow across todos
(no follow-on tasking via `send-agent` to a prior slice's Shadow; no
resuming/continuing a prior worker). Even if the previous worker finished
cleanly, even if the next todo seems closely related, even if "it'd save
tokens".

Why this is non-negotiable:

- A continued worker carries its prior context — wrong paths it explored, assumptions it made, drift from the principles file. A fresh spawn starts clean.
- Token costs: a continued worker re-loads its entire prior conversation. A fresh worker only loads what its assignment + its reads bring in. Counterintuitively, fresh-per-todo is cheaper at scale.
- Isolation: if worker N hit a bug or made a questionable call, that bias doesn't infect worker N+1.

Each Shadow:

- Receives a self-contained assignment (it has not seen the conversation) via its `ASSIGNMENT.md` ledger (step 4 below).
- Reads the relevant context files explicitly (see rule 4).
- Executes one todo end-to-end: code + execution log + commit (one commit, not two).
- Reports a brief DONE status (≤200 words) to its supervisor (you) so the orchestrator can pick the next todo.
- When ready to be reaped, tells its supervisor first (the primary, never-dropped
  requirement), then publishes the canonical claim supplied by the generated
  assignment's completion section. Do not duplicate that literal protocol here.

The bullets' worktree, commit, and merge mechanics apply only to `git-repo`.
For `no-git`, the fresh Shadow runs in the generated managed empty workspace,
while the separately named `TARGET_PATH` remains the operational target and
delivery authority. The Shadow makes no Git commit and returns objective-native
evidence plus its ledger execution log.

The orchestrator (you, the Alpha) holds the queue, picks the order, evaluates results, and decides whether to continue / pause / spawn a follow-up. The orchestrator NEVER continues a Shadow's work itself — when the queue advances, that's a fresh spawn.

- **Per slice** (one fresh worker each, scheduled per Rule 3):
  Every campaign Alpha records its contract once at launch with
  `--objective-code <code>`. The code is a lowercase ASCII alphanumeric token in
  the canonical `alpha-<code>-...` handle, and `create-agent` records it in the
  Alpha's identity and spawn evidence. A Shadow inherits that evidence; it never
  receives a hand-copied objective code. Deliberate Alpha or Shadow infrastructure
  outside a campaign must opt out explicitly with `--non-campaign`. The Regent is
  orchestration infrastructure rather than a `create-agent` campaign agent and is
  exempt.

  1. **Derive the full Shadow handle from the live Alpha contract.** The `ALPHA`
     variable above is the current Alpha's canonical handle. For each slice, ask
     the live throne command for the complete descendant handle and keep its exact
     output in one variable:

     ```bash
     slice_id="<slice-id>"
     slice_addr="$(node "$THRONE/dist/src/tools.js" derive-shadow-name-from-alpha "$ALPHA" "$slice_id")" || exit 1
     ```

     The result is the full address (`shadow-<code>-<slice-id>`). Do not construct
     it, copy the code into it, or pass an objective-code flag to a Shadow. The
     command reads the Alpha's durable spawn evidence and refuses contradictory,
     invalid, missing, or unreadable evidence. For a pre-contract Alpha whose
     readable evidence has neither `objective_code` nor `non_campaign`, its
     narrowly scoped compatibility fallback takes only the first canonical token
     after `alpha-`; this fallback never guesses through unreadable evidence. A
     non-campaign Alpha can only have deliberate non-campaign Shadow infrastructure,
     which must pass `--non-campaign` explicitly and therefore has no derived
     campaign handle.

     Use `$slice_addr` for every subsequent step — the worktree, the create-agent
     call, the data path, and all downstream tooling calls. This keeps the exact
     handle returned by the live contract command as the single name source.

     **This name-match is now TOOL-ENFORCED — you cannot silently strand a tree by diverging.** `create-agent` REFUSES (exit 1, nothing spawned or written) when an explicit `--cwd` sits inside a managed worktree whose name differs from the derived agent name, and `reap-agent` exits 1 naming the surviving worktree + `~/.throne/data/<tree>/tree-base.json` instead of falsely reporting success when a mismatched tree's residue would be stranded (a stranded tree also surfaces on the Regent's periodic `checkStrandedTrees` sweep). Using `$slice_addr` for BOTH the tree and the agent, as above, satisfies both guards; passing a bare `<slice-id>` to `spawn-git-tree` while letting the role prefix derive `shadow-<slice-id>` is exactly the divergence they now catch loudly at spawn or teardown — not the silent worktree/branch/`tree-base.json` leak it used to be.

  2. **Git repo: its own worktree; no-git: the operational target** —
     In `no-git`, this is an explicit treeless/read-only campaign path: pass
     `--empty-worktree` and use the generated empty workspace as the
     `create-agent --cwd`; never initialize Git there. The generated
     `AGENTS.md` states that the workspace is not a target checkout or Git
     delivery authority; target mutation/delivery must use its separately
     named repository worktree. In `git-repo`,
     spawn the slice tree against `$CAMPAIGN_REPO` using the derived address:
     ```bash
     repo_flag=(); [ -n "$CAMPAIGN_REPO" ] && repo_flag=(--repo "$CAMPAIGN_REPO")
     node "$THRONE/dist/src/tools.js" spawn-git-tree "$slice_addr" "${repo_flag[@]}"
     ```
     Because `$slice_addr` is shaped `shadow-<code>-…`, `spawn-git-tree` treats
     it as a campaign Shadow: it bases the tree on the supervising **Alpha's
     branch** (the branch named exactly like you — a `createTree` invariant),
     resolving the Alpha from the name's objective code, so the whole campaign
     accumulates on your branch instead of braiding into the target branch. Two
     loud escape hatches exist, neither of which a mid-campaign slice should
     need: `--alpha <name>` pins the supervising Alpha explicitly when
     name-based resolution is ambiguous, and `--non-campaign` forces
     current-branch basing for deliberate infrastructure trees outside any
     campaign. A missing or ambiguous Alpha, a missing Alpha branch, or a
     recorded-repo mismatch refuses BEFORE any write — no worktree, no branch,
     no `tree-base.json` left behind.
     The command prints the tree's inner **project dir** (for an external repo that is that
     repo's project dir, NOT a throne dir); the slice's coding happens there
     (AGENTS.md worktree discipline), never the live checkout. Passing `--repo` is
     what lets `merge-git-tree`/`reap-agent` resolve the SAME target repo later — they
     read each tree's own recorded `tree-base.json` — so cross-repo merge-back and
     teardown follow automatically, with no extra flags on those steps. For a
     campaign Shadow the record also carries `branch` = your Alpha branch: the
     merge target step 6 lands in.
  3. **The Shadow harness/model — resolve it inside the active role pool.**
     Re-read the live `active_plan` at spawn time. Ordinary slices select from
     `rolePools.Shadow`; `99a`, `99b` and `99c` all select from
     `rolePools.ShadowSlice99`. Preserve
     pool order while applying the slice requirement, then quota/availability.
     ```bash
     node "$THRONE/dist/src/tools.js" create-agent \
       --harness <selected in-pool harness> --model <selected in-pool model> \
       --name "$slice_addr" \
       --supervisor <your own herdr name — you are the Alpha> --escalation Regent \
       --role Shadow --cwd <the slice tree's project dir that spawn-git-tree printed>
     ```

     A perceptual bundle's `NNz_critique_<module>` gate DOES carry
     `--deliverable-shape verdict-only` — it is an ordinary-band slice whose
     branch is empty by design, and the name-pattern exemption below covers
     only the `99` terminal gates (see "Rubric critique gates" under
     "Patterns that pay off").
     No terminal gate carries `--deliverable-shape verdict-only`: `99b`
     legitimately commits the fixes it makes, and `99c` legitimately commits
     the target absorb. `99a` genuinely produces no diff — it grades and never
     repairs — and a `99b` that found nothing to fix correctly produces none
     either; `merge-git-tree` accepts both no-diff merges on the terminal
     gate's own name shape rather than on a declared deliverable shape. Keep
     the role word in every terminal slice address (`99a-conform-…`,
     `99b-verify-…`, `99c-deliver-…`): classification reads the verb, not the
     letter, because the letters mean different things across bundle
     generations.

     Native Codex needs no extra permission flag. Omit `--effort` on every
     fresh spawn — the engine resolves the model's lowest available effort and
     refuses a divergent explicit score. Request an ordinary slice inside the
     execution-shadow allowed set: any Codex GPT row, or any Anthropic row
     EXCEPT `fable`, which is reserved for Alphas and the 99 gate. The engine
     then applies executable usage/quota routing. It may keep the request or
     remap to any equivalent qualifying pair still admitted by the selected
     pool, including changing model and harness, and records why.
     Usage steering is mandatory, so an explicit in-set request is not
     necessarily exact. Accept and record the admitted final route. Terminal
     slices use the same policy-selected request path. Provider/company
     identity is not a selection axis.

     `--name "$slice_addr"` passes the full handle returned by the live
     derivation command. A REAL Shadow uses that exact value for its herdr tab,
     worktree, ledger, and address, so it appears in `agent-statuses` and is
     watchable via `agent-logs $slice_addr`.
     `--role Shadow` records the role in `data/$slice_addr/identity.md`; the two
     addresses are court law — **supervisor = the spawning Alpha** (routine),
     **escalation = Regent** (blockers only).

     For an ordinary Shadow, quota routing evaluates only the surviving
     `rolePools.Shadow` pairs. `create-agent` first excludes harnesses absent
     from that pool, then may choose the admitted harness with higher
     weekly-remaining headroom and apply the Claude 5-hour reservation floor.
     Every remap must land on an equivalent pair still present in the pool. If
     the requested pair, remap, upgrade, or fallback is excluded, the spawn
     pauses rather than substituting an arbitrary model.

     Every bypass flag means exactly what the "Steering + bypass contract"
     section says and nothing more — none of them touches a role pool. The
     steering decision (active preset, selected role pool, requested and final
     harness/model, effort, and why) is recorded on the `Spawned …` line,
     visible via `agent-logs $slice_addr`; copy that routing evidence into the
     todo's `## Execution log`. `create-agent` owns the final route: accept a
     successful admitted route even when quota or usage steering changes the
     requested model or harness. Record the requested pair, final pair, and
     routing reason in the todo's `## Execution log`. Non-quota divergence
     without the tooling-named narrow bypass remains a refusal —
     `--bypass-model`, Lord-authorized only. A tooling refusal remains
     authoritative.

     `--role Shadow` is also now the ONLY way a slice worker may spawn:
     `create-agent` refuses any non-preset role (`{Alpha, Shadow}` are the
     presets) without `--bypass-preset-agent`, so the generic `--role Agent`
     default is refused here — this convention is tool-enforced, not just
     guidance.

  4. **Deliver the assignment via a file, not inline.** `create-agent`'s opening
     prompt is only the identity sentence — it carries no task. Write the full
     self-contained slice prompt (everything Rule 4 lists, plus the verbatim Rule
     5 / Rule 7 / Rule 8 mandates and the resolved personality + its definition)
     to `"$THRONE_DATA/$slice_addr/ASSIGNMENT.md"` (the durable `data/$slice_addr/ASSIGNMENT.md` ledger), then point the Shadow at it:

     ```bash
     "$THRONE/bin/throne-cli" send-agent "$slice_addr" \
       "Read and execute your assignment at $THRONE_DATA/$slice_addr/ASSIGNMENT.md. Do all coding in your cwd worktree, make exactly one commit, then report DONE to your supervisor via send-agent. Genuine blockers go to Regent."
     ```

     Issue exactly this one ordinary `send-agent` call. Let it derive the
     Alpha's canonical sender name automatically and deliver one
     recipient-visible `<sender-name> said: <prompt>` turn through the shared
     submit engine; do not hand-prefix the text or add a follow-up send/Enter.
     Write the prompt to a FILE, never inline into `send-agent`: real newlines
     inside one quoted argument survive, but separate prompt arguments are
     space-joined and large bodies remain unproven at this seam. A file the
     Shadow reads is the reliable channel for this large assignment.

     **MANDATORY gate before `create-agent`/`send-agent`:** hand-writing the
     Rule 6 completion section into `ASSIGNMENT.md` is no longer sufficient
     — build it with the `src/slice-assignment/slice-assignment-template.ts`
     renderer (or hand-append its fixed marker exactly) and then run `node
node "$THRONE/dist/src/tools.js" lint-slice-assignment
"$THRONE_DATA/$slice_addr/ASSIGNMENT.md"` against the file you just
     wrote. A nonzero exit is a hard stop: fix the assignment file and
     re-lint before spawning. Do not `create-agent`/`send-agent` a Shadow
     whose assignment file fails the lint.

  5. **Wait for completion events (Rule 3).** The Shadow's DONE or blocker
     `send-agent` message is an immediate supervision event and the primary
     wake-up path. When no work is dependency-ready, become idle: schedule no
     sleep, query, or follow-up model turn. Use `agent-logs "$slice_addr"` only
     for one completion review, an explicit blocker, or silence beyond the
     30-minute Regent heartbeat interval. Never use `agent-statuses` as a
     short-cadence substitute. Per-slice verification is the slice's own focused tests
     and mutation checks plus the mechanical checks over its own diff, under
     "Mechanical checks shift left into the slice that creates the defect"
     below; a slice that reports DONE with one of those failing has not
     delivered. The full suite is never a per-slice run — it runs
     baseline-comparative exactly once over the assembled candidate, under
     "Three verification layers, and the layers are not interchangeable"
     below. Whether the
     next slice's Shadow spawns now follows Rule 3's scheduling contract, not
     a blanket wait.
  6. **Merge back into YOUR branch, then reap.** On a verified DONE, merge and
     reap promptly — merges strictly one at a time, teardown never batched.
     In `no-git`, skip merge-back and worktree teardown with the recorded N/A
     reason, verify the requested state plus ambient-state preservation, then
     reap only the Shadow tab/ledger through ordinary throne tooling. In
     `git-repo`,
     Land the slice with `node
`node "$THRONE/dist/src/tools.js" merge-git-tree "$slice_addr" "<slice message>"`: it reads the tree's
recorded `tree-base.json`and merges into the recorded`branch`— your
Alpha branch, never the target branch, and never a silent fallback to
root HEAD. **Transport is flexible; the destination is not:** it lands at
the root checkout when that branch is current there, inside the
registered worktree that has it checked out (normally your own tree), or
via a temporary worktree it creates and removes when the branch is
checked out nowhere — topology inconvenience is never a failure. The one
refusal is fail-closed metadata: an absent/legacy record with no usable`repo`+`branch`refuses because the target cannot be known safely; treat
that as a campaign metadata/process defect and repair the record or the
step that failed to write it — do not guess a branch and do not add
another merge validator. The stash → merge → unstash discipline over a
dirty destination and the conflict-abort semantics are the command's own;
you never need raw git here. **PX2 merge-round tripwire (Lord):** a merge
must land its intended content in one round; at most two rounds, the
second only for a diagnosed fixable cause; a needed third round means you
(the Alpha) merge by hand with plain documented git in your own tree and
file the recurrence as a process defect. The tripwire counts merges
attempted against a live destination only; absorb iterations inside the
delivery rehearsal's private copy are not integration rounds and never
count toward it. A slice with nothing to merge — a zero-diff validator,
a finding-only slice, a gate whose absorb turned out to be a verified
no-op — still calls`merge-git-tree`unconditionally: the no-op merge
itself publishes the completion stamp that makes the Shadow reapable
via plain`complete-agent`, and skipping the call because "there's
     nothing to merge" leaves it with no completion proof at all.

     **Confirm, then wait for the claim — never reap in the same turn as the
     merge.** Immediately after `merge-git-tree` succeeds, send the Shadow
     exactly one `send-agent` confirmation that its merge landed (e.g. "merged
     into <branch>; you may publish your reapability claim"). Then end your
     own turn idle, publishing `{"blocked":true}` with a
     `__BLOCKED_BY_<slice_addr>__` marker per the existing blocked-marker
     convention (Rule 3 above) — do not call `reap-agent` in the same turn
     you send the confirmation. Reaping immediately would give the Shadow no
     turn to publish its claim and recreate the same deadlock one message
     later. The Shadow's own reapability-claim message is what wakes you; only
     in the turn that message arrives do you tear the Shadow down (tab +
     worktree + `data/$slice_addr/`) via
     `reap-agent "$slice_addr" --reason completed`. A Shadow that stays silent
     past the standing heartbeat interval is not a new waiting policy — it
     falls to the same "When a Shadow dies or is rate-limited mid-run"
     decision above: one `agent-logs` check, then relaunch the registered dead
     Shadow or reap it and spawn a fresh one with a tightened assignment. If
     you ever need to resend the confirmation (for example after a relaunch),
     make it differ in content from the first — a byte-identical resend is
     deduplicated by content hash and returns the same message id, so an
     identical retry never lands as a new message.

     **Commit-before-report is machine-gated, not merely instructed.** Both
     `complete-agent` and plain `reap-agent --reason completed` (no
     `--force`) run `checkOwnWorktreeCommittedPrecondition`
     (`src/slice-evidence/agent-evidence-gate.ts`) and refuse to reap an
     agent whose own recorded worktree still carries uncommitted **tracked**
     changes — staged, modified, or deleted files git already knows about.
     Untracked debris (a scratch note, a stray probe script, a stray
     `node_modules`) never trips it; the check is equivalent to `git status
--porcelain --untracked-files=no`. The refusal names the concrete
     remedy (`git add -A && git commit`) and the agent's own branch. Three
     cases are exempt, each its own distinguishable outcome rather than a
     shared silent pass: `deliverable_shape: "verdict-only"` agents (an
     answer-only deliverable produces no diff by design),
     `isTerminalDeliveryShadowName` (`99c`, and legacy `99b`/`99e`) agents (their content lands via
     their supervising Alpha's branch, not their own), and agents with no
     resolvable `spawn.json` cwd / `tree-base.json` branch (nothing to check
     against). **Honest limit:** this does not recover uncommitted
     in-progress work lost before a commit — it only prevents an agent from
     being accepted as COMPLETE while committed-but-unreported work still
     sits on disk. `--force` still tears the agent down over a dirty tree
     but prints a loud warning naming what was skipped instead of silently
     skipping it.

  The orchestrator (you, the Alpha) still owns the queue, ordering, active-plan
  resolution (Rule 6), and merge-back; a Shadow executes only its one slice.
  `99a_conform`, `99b_verify` and `99c_deliver` run in order after all ordinary slices as three distinct fresh real Shadows when applicable. If a 99 slice is not applicable to the exact request, simulate its contract, record `N/A — no-op` with the reason, and do not spawn or execute it; report the no-op explicitly. Applicable gates retain their normal dependency chain and use `rolePools.ShadowSlice99`; none may be Alpha-executed.

  The following campaign-topology rules are `git-repo` only. **Propagation is
  deliberate:** a slice tree no longer inherits what other campaigns land
  while it works; when your campaign needs the target branch's latest, pull it
  into your own tree with plain documented git — `git -C <alpha-tree> merge
<target-branch>` (usually `main`) — and resolve any conflict there.
  **The campaign lands once:** your Alpha branch accumulates every slice and
  reaches the target branch exactly once, via your own merge-back at campaign
  end — one reviewable branch, never slices braided one by one into the
  target.

### 3. Scheduling contract — concurrency with honest serialization

Throughput comes from running slices that genuinely cannot collide, and from
serializing everything that can. The contract below is the whole law; the
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
7. **Concurrency cap.** At most 3 live slice Shadows per campaign, so
   supervision, merge quality, and quota stay honest.
8. **Honest serialization.** Shared-file conflicts, true dependencies,
   integration slices, the assembled-candidate preflight, `99a`, `99b`, and
   `99c` are strictly serialized. A seam slice (`NN_seam_<wave>`) intersects
   every core path and therefore serializes against everything; a critique
   gate (`NNz_critique_<module>`) runs once its builder and the evidence tool
   have merged and never after `99a` has started. `99a` runs only after every ordinary slice is
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

### 4. Every worker MUST read the global CLAUDE.md

Every Shadow's `ASSIGNMENT.md` must explicitly direct it to read:

- The global agent instructions — claude: `~/.claude/CLAUDE.md`; codex: `~/.codex/AGENTS.md` (which chains to the same CLAUDE.md). They carry terminal naming, commit conventions, communication style.
- `$THRONE/agent_docs/CRITICAL_coding_a_feature_masterplan.md`.
- `$THRONE/agent_docs/coding_principles.md` — SRP, DRY, self-documenting names, no surprises, contract-based design.
- `00_overview.md` if the bundle has one — the north-star for the whole bundle (the feature, the architecture, the `## Done when` acceptance checklist). Gives the worker the big picture its single slice plugs into, so local choices serve the global goal.
- The resolved todo-run personality (`default`, `focused`, or `perfectionist`)
  plus the matching definition from this skill.
- The specific todo file the worker is executing.
- Any cross-referenced todos (list them by filename in the assignment).
- Project `AGENTS.md` if present (project-level invariants).
- `question-log-template.md` (alongside this SKILL.md) — the required format for logging an unpinned decision to `000_current_questions.md` (see rule 5). Pass its absolute path so the worker reads it before writing any question entry.

Without these, workers drift to whatever defaults they were trained on. The principles file in particular enforces non-obvious habits like "no comments restating what code does" and "rule of three before extracting a helper".

### 5. Don't halt the queue to ask — route EVERY decision through the question log

When running this skill, do **NOT** stop and wait on the user (no interactive question tool — claude's `AskUserQuestion` or any harness equivalent — no "should I…?" pauses) — for ANY decision, **blocking or non-blocking**. Halting strands the whole queue while the user is away, and a blocking decision is precisely the case where a stall costs the most. The question log is **not** a non-blocking-only escape hatch; it is the single channel for every decision the todos left unpinned, blocking ones included. The discipline:

1. **Try hardest to answer it yourself first.** A genuinely blocking decision earns _more_ effort to resolve — from the code, the specs, the schematics, the bundle's `00_overview.md` — not a halt. Most "blockers" dissolve once you actually dig.
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

If todo N is a hard prerequisite for N+1 but ordered later, pull it forward. Document the reorder in the execution log of both todos. Example: build/flash workflow (toolchain config, partition table) often gets pulled before any firmware-side todo because every subsequent task needs a working build.

### Hybrid duplicate detection — the `99b` static-analysis contract

This is the single owning contract for duplicate detection. `99b` applies it as
part of its static-analysis run; planners and generated terminal todos point
here instead of restating a drifting copy.

**Stage 1 runs first: invoke deterministic clone detection.** Resolve the local
command before running the gate: prefer executable `$HOME/bin/jscpd`, then
`command -v jscpd`. If neither exists, install the pinned global tool with
`npm install -g jscpd@5.0.14`, then resolve it again. Invoke the resolved command
as `jscpd --reporters json`; never use `npx`, including its offline mode, and do
not add jscpd to `package.json`. (Proven live, 2026-08-11: `campaign-evidence`'s
duplicates section parses the report via `JSON.parse`, so `--reporters ai` cannot
work as documented — if the `ai` reporter's richer shape was the original intent,
`campaign-evidence` still needs to learn it; this line records only what is
proven to work today.) Obtain
the pre-campaign base from the campaign's recorded base commit, verify that it
is an ancestor of the assembled HEAD, and run the detector on baseline and HEAD
with the same configuration and campaign-relevant code-file scope. Compare
stable quoted site pairs, not aggregate totals; feed the two detector reports to
the evidence command's `duplicates` section
(`--baseline-duplicates <path> --head-duplicates <path>`) and record its exit
code rather than summarizing the reports by hand. If the detector cannot run,
record `UNVERIFIED`, the command and error, and do not report a clean duplicate
check.

The tuned starting configuration uses minimums of 8 lines and 70 tokens. Scan
source and test code that the campaign changed or that forms the other side of a
reported clone. Exclude generated and build output, dependency and vendored
trees, dedicated fixture and snapshot trees, lockfiles, and ephemeral throne
ledger/worktree data: those are generated, third-party, deliberately repetitive
test data, machine-maintained metadata, or orchestration state rather than
maintained implementation. Record the actual command, version, paths,
exclusions, thresholds, exit code, and report in `99b`; any adjustment must state
which false positive or missed candidate justified it. Do not add jscpd to
`package.json` or introduce a network requirement into `npm test`; global
installation is setup performed before the gate, not part of the test command.

**Only after Stage 1 has produced its report may Stage 2 begin.** Stage 2 reviews
only the functions touched by the campaign diff and the exact site pairs Stage
1 reported. Whole-repository AI ingestion is forbidden. Use the semantic-function
map's existing predicates, transformations, decisions, and effects vocabulary
to judge differently shaped implementations of the same domain rule. Every
deterministic or semantic finding quotes both sites and classifies the pair as
**genuine duplication to fix, deliberate and justified, or trivial and exempt**
under the anti-cargo-cult boundary.

Clones present in the baseline report are report-only debt. Only a clone or
duplicated semantic decision introduced by the campaign fails `99b`; an
unchanged baseline pair cannot fail merely because the detector found it again.
Never use the aggregate duplicated-line or duplicated-token percentage as a
PASS/FAIL threshold. A new duplicated semantic decision fails however small its
percentage contribution, while a large non-duplicated change does not fail for
moving a repository-wide ratio.

### Responsibility-oriented decomposition — the shape of a terminal-gate corrective refactor

This is the single owning contract for how a terminal-gate finding's corrective
refactor must be shaped. It applies whenever a terminal-gate finding returns work that reshapes
files or modules: a genuine duplicate to fix, a module that has accumulated
unrelated work, or a home that changes for several unrelated reasons. Generated
terminal todos and planners point here instead of restating a drifting copy.

The required shape is **responsibility-oriented decomposition** — the
module-level and recursive application of the **Single Responsibility
Principle**. A module has exactly **one reason to change**. Split by independent
reasons to change, considering these axes in order:

1. **Public API or orchestration** — the entry point callers bind to. It
   composes the other modules and owns no lower-level detail itself.
2. **Platform-, harness-, or backend-specific handling** — each variant that
   changes for its own vendor, protocol, or environment reason gets its own home.
3. **Major effects** — send/deliver, create/spawn, and persistence/IO. Each
   effect family changes for its own reason and is its own module.
4. **Shared semantic predicates and transformations** — extracted last and only
   when genuinely reused; a one-call-site wrapper is not a responsibility.

**Recursive** means the same test is re-applied to every module the split
produces: a module that still carries two reasons to change is split again.
Stop when each module has one reason to change and a further split would only
add trivial indirection.

`99b` **rejects**, as not-decomposed and regardless of the resulting line
counts: arbitrary size-balanced chunks; numbered or lettered parts (`<name>2`,
`<name>-part2`, `<name>-extra`, `<name>-misc`); layers that still mix change
axes inside each layer; an unchanged monolith relocated or renamed; and a
re-export barrel that restores the monolith as the only consumer surface. File
size or line count is a symptom that prompts the question — it never defines the
split, and no size target is the acceptance criterion.

Where substantial type or interface declarations obscure the implementation
they describe, a responsibility slice may also split along **companions that
share one responsibility stem** — implementation, contract, and proof, named
like `create.ts`, `create.types.ts`, and `create.spec.ts` — subject to the
repository's own file-naming conventions, which win over these illustrative
suffixes. Companions are optional: never create an empty or otherwise
unnecessary companion, and a slice whose declarations do not obscure anything
stays one file. `99b` **rejects** as not-decomposed: a generic `types.ts` junk
drawer collecting declarations of unrelated owners; type-only extraction used to
game a size target; a duplicate interface declared beside the one it copies; and
any companion that introduces a new import cycle. Each companion is admitted
only when it carries the **semantic ownership** of its stem — the same one
reason to change — and preserves the **public compatibility** of the surface its
callers already bind to.

Worked example, deliberately path-free: one module owning a terminal
workspace-manager integration's entire surface decomposes into an
orchestration/public-API module, one module per harness-specific behaviour, one
module per major effect (send a message, create a workspace entry, persist the
registry), and — only where a rule genuinely decides behaviour at several sites
— one small shared-predicate module. Reproduce the reasoning, not those names.

The planning/execution boundary still holds. `write-todos` names **hypothesized
responsibility modules** at high level, by their reason to change and at file
granularity; the executing Shadow refines their names, boundaries, and count
after recon. A planner's hypothesis is never the acceptance criterion, and a
deviation from a hypothesized module name is never a terminal-gate finding.

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
   mean something.
2. **Once before the terminal chain** — exactly one baseline-comparative
   full-suite run over the assembled candidate, at the assembled-candidate
   preflight, before the terminal chain begins. `99b` re-runs the suite as its
   own deliverable; `99c` does not repeat it, and within a round carries it
   forward against the frozen candidate.
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
   detection to catch it after the fact.
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
node "$THRONE/dist/src/tools.js" campaign-evidence --base <recorded base commit> \
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

### `99a` grades conformance, `99b` verifies and fixes, then `99c` merges the latest target and delivers

The terminal chain is three fresh real Shadows: one that checks the assembled
candidate is the thing that was actually asked for, one that makes it green,
and one that gets it onto the target branch. Nothing else. The older five-gate
chain (absorb, file-size, static analysis, overview validation, delivery) was
retired for being more machinery than any executor could hold in one head; the
three gates below carry its whole job.

The conformance gate was inserted at the Lord's direct order on 2026-08-25,
ahead of the existing pair, because a bundle can pass every test the campaign
wrote for itself and still not be what was requested. Tests grade the code
against the campaign's own understanding; `99a` grades that understanding
against the request.

**Persist the raw suite log before DONE/reapable.** Any terminal gate or
ordinary slice whose deliverable runs a full suite (`npm test`) must write
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

#### `99a` — grade the candidate against what was literally asked for

`99a_conform_<topic>.md` runs first, after every ordinary slice has landed and
the tree is quiescent. It is a fresh real Shadow, and it is a VERDICT gate: it
writes no product code, commits nothing to the campaign branch, and its empty
diff is the expected shape.

**The standard is literal, and it is the request, not the plan.** Reconstruct it
by quoting the queue row's `INTENT:`, `SCOPE:` and `RULINGS:` and
`00_overview.md`'s `## Done when`, then every recorded addendum since. If the
Lord said `./install.sh` installs the app and leaves him able to open a
`.desktop` file, the objective is unmet until the gate has run `./install.sh`,
shown the `.desktop` file exists, and shown that file actually launches the
installed application. "The installer exits 0" is a different claim. "We
implemented installation" is not a claim at all.

**Only a recorded addendum moves the standard.** An errata entry, an explicit
Lord ruling, or a queue-row amendment relaxes or redirects a requirement, and
the gate grades against the amended text. A slice's own view that a requirement
was unreasonable does not, and neither does an Alpha's decision to descope. An
unmet requirement with no addendum behind it is a FAIL.

**`99a` never waits on a human.** Where a claim genuinely needs eyes, it
exercises the closest machine-checkable proxy — run the entry point, assert the
artifact, parse it, invoke what it points at, confirm the process starts —
records the residual as UNPERFORMED in one line naming what a person would
confirm, and grades everything else. A claim it could not exercise AT ALL is
UNMET, not UNPERFORMED.

**`99a` reports; it does not repair.** Unlike `99b`, a gap it finds goes back as
a FAIL naming the unmet claim, quoting the requirement text, and stating what
evidence would have satisfied it. That is corrective work for the owning Alpha,
after which the chain re-runs `99a` fresh. Evidence is generated — command,
exit code, output — never reasoned about: reading the source and concluding it
must work is not evidence.

It ends with exactly one `**Conformance outcome:** PASS` or
`**Conformance outcome:** FAIL`. `99b` runs only after an explicit PASS.

#### `99b` — run the tests and lint, and fix what fails

`99b_verify_<topic>.md` runs second, only after `99a` returns an explicit
`**Conformance outcome:** PASS`. It runs the bundle's verification commands against the
assembled candidate — the test suite, the linter, type/static analysis, and any
repository contract check the project already owns — records each command with
its exit code and relevant output, and **fixes every failure it finds**, on the
campaign branch, re-running until the whole set is clean.

This is a fixing gate, not a verdict gate. A failing test, a lint violation, a
type error, or a broken build is corrective work `99b` does itself; it does not
hand findings back and wait.

**`99b` owns the fixing outright. It does not punt to the Alpha.** Reporting a
failure upward and waiting for someone else to repair it is not an available
move, and neither is a FAIL whose stated blocker is "this needs a code change."
Making the code change IS the assignment. The old chain returned findings to the
owning Alpha for a corrective iteration; that route is closed for anything `99b`
can repair itself, which is nearly everything a suite or a linter reports.
`99b` escalates only when repair is genuinely impossible for it — a requirement
nobody wrote, two slices whose designs contradict, an environment it cannot fix
— and it names that precise blocker rather than forwarding the raw failure.

It commits those repairs like any other worker, so
its branch legitimately carries a diff — and equally legitimately carries none
when the candidate was already green.

When its run includes the suite, exit 0 alone never credits a PASS: read
`run-suite-container.mjs`'s own stdout to its end and record the
`run-suite-container: tests executed: N` line it prints for every real run. A
truncated log, a signal death, a `tests executed: 0`, or a `tests executed:
unknown` line is a FAIL regardless of the exit code.

It ends with exactly one `**Verify outcome:** PASS` or `**Verify outcome:**
FAIL`. FAIL is reserved for a failure genuinely beyond the gate's reach — a
missing requirement, a design conflict between slices, an environment it cannot
repair — and must name precisely what blocked it. It performs no merge, invokes
no delivery tooling, and never touches the target branch.

#### `99c` — merge the latest target, resolve conflicts, deliver

Only after explicit `99b` PASS, `99c_deliver_<topic>.md` runs as the final fresh
real Shadow, and it owns delivery together with the conflicts delivery hits. It
uses **plain git throughout** — no `absorb-git-tree`, no `merge-git-tree`, no
throne merge tooling of any kind. Merge the recorded target branch INTO the
campaign branch in the Alpha worktree:

```bash
git -C "$alpha_worktree" merge "$target_branch"
```

Both branch arguments are local refs; this step issues no `git fetch` and never
names `origin/...`. Bracket the live operation with path-qualified status,
tracked-diff, and untracked-content evidence so ambient dirt is unchanged —
plain git carries no stash-and-restore of its own, so the bracket is the only
protection that dirt has.

**`99c` owns the conflict resolution outright. It does not punt to the Alpha.**
Every conflict the absorb raises is `99c`'s to resolve, on the campaign branch,
by reading both sides and deciding — never returned upward as a finding, never
left for a corrective slice, never handed to a fresh Shadow. A merge conflict is
the expected content of this assignment, not an obstacle to report. Escalate only
if resolving it would require a decision the bundle never made — a genuine
semantic fork between two landed slices — and say exactly which two.

It resolves every conflict there — on the campaign branch, never on the way
past and never on the target — re-runs the bundle's checks on the merged
result, then re-reads the target HEAD and repeats that absorb-and-recheck cycle
for as long as the target keeps moving. Only when the campaign branch is current
with a target whose HEAD is unchanged since that final check may it deliver.
Resolving on the campaign branch is what keeps the target free of half-merged
states.

Before any real integration it proves the merge in a private copy of the
recorded target repository by the rehearsal procedure below, and records the
absorbed target HEAD; the real round proceeds only while the live target branch
still equals that recorded HEAD. Then deliver with plain git — check out the
target branch in the live target repo and merge the campaign branch into it:

```bash
git -C "$repo" checkout "$target_branch"
git -C "$repo" merge --no-ff "$ALPHA" -m "<delivery message>"
```

A target that moved during rechecking sends the loop round again; `99c` never
fast-forwards a target it has not checked against.

Merge exactly once for one integration round, inspect the resulting target diff
and content, and run meaningful named smoke checks of the delivered feature on
the target. Then prove delivery with plain git rather than asserting it: show
the campaign's commits reachable from the target tip and an empty diff over the
delivered paths, and paste that exact output into the report.

```bash
git -C "$repo" log --oneline "$target_branch" | head
git -C "$repo" diff "$ALPHA".."$target_branch" -- <the campaign's touched paths>
git -C "$repo" rev-parse --abbrev-ref HEAD
```

A `**Delivery outcome:** PASS` without that cited output is not a valid terminal
report, and a non-empty diff over the delivered paths — or a target left checked
out on the wrong branch after the merge — forces FAIL.

**This is not merely a reporting convention: `complete-agent` and `reap-agent`
independently re-run a path-wise candidate/target tree-identity proof
(`checkTerminalDeliveryPrecondition` in `agent-evidence-gate.ts`) against the
live git state at completion time, for every delivery-shaped Shadow, regardless
of what the report claims.** That check reads the campaign's recorded
provenance and compares git state; it does not care which command performed the
merge, so a plain `git merge` that genuinely landed the content satisfies it
exactly as the retired tooling did. Pasted git output that was fabricated, or was
true when pasted but has since gone stale, does not substitute for it —
completion is refused until the real check, re-run right now, agrees. (See
`HDL_DELIVERY_PRECONDITION` — a `shadow-pln-99e` reported `**Delivery outcome:**
PASS` in prose having merged nothing to the target, and nothing forced the real
check at the time.)

It ends with exactly one `**Delivery outcome:** PASS` or `**Delivery outcome:**
FAIL`. `99c` is delivery plumbing: it must not repeat a landed integration to
prove it twice, demand or record SHA/history ceremony as merge proof, perform
commit-graph archaeology, or smuggle in a second validation ceremony.

Never leave the live target in a conflicted merge state. An unexpected conflict
during real integration is abandoned, the target is returned to its pre-merge
baseline, and delivery is re-proved from a fresh private copy before any further
attempt. A live abort is not treated as a proven-safe undo — the rehearsal
exists to make a live conflict and abort unnecessary.

#### The delivery rehearsal — absorb the target inside a private copy

**Where the copy lives.** A clone of the recorded target repository, never a
linked worktree of it: a linked worktree shares the live repository and puts the
live checkout one command away from a conflicted state. Every input is read from
the campaign's `data/$ALPHA/tree-base.json`, whose two branch-shaped fields are
easy to invert: `branch` is the TARGET branch
(`src/nest-commander/spawn-git-tree/spawn-git-tree-runtime.ts` owns campaign
tree-base recording, and
`src/merge-git-tree/merge-git-tree-runtime.ts` passes the
recorded branch to `mergeBack`, named `targetBranch` in
`src/git-lifecycle/merge.ts`),
while `name` is the CANDIDATE branch — the Alpha's own branch, recorded by
the Nest Commander `spawn-git-tree` runtime. Clone into scratch outside every live
checkout:

**Naming convention for this and every other `$HOME/tmp` clone a terminal
Shadow creates:** prefix the dirtemp name with your own agent name, then a
purpose word — `<your-agent-name>-99c-rehearsal-XXXXXX` below, matching this
repo's existing `mkdtempSync(path.join(root, prefix))` idiom (e.g.
`src/create-agent/custom-harness.service.ts`). Reap-agent's teardown globs
`$HOME/tmp/<agent-name>-*` to find and remove its own scratch at reap time,
which only works if the prefix names the owning agent.

```bash
alpha_tree_base="$THRONE_DATA/$ALPHA/tree-base.json"
repo="$(jq -r .repo "$alpha_tree_base")"              # the recorded target repository
target_branch="$(jq -r .branch "$alpha_tree_base")"   # `branch` = TARGET branch
candidate_branch="$(jq -r .name "$alpha_tree_base")"  # `name`   = CANDIDATE branch
live="$repo"                                          # the live target checkout
mkdir -p "$HOME/tmp"                                  # never /tmp: a reboot wipes
agent_name="<your own herdr agent name>"              # the prefix reap-agent globs on
sim="$(mktemp -d "$HOME/tmp/${agent_name}-99c-rehearsal-XXXXXX")"  # the pre-images mid-recovery
git clone --no-hardlinks "$repo" "$sim/copy"
git -C "$sim/copy" checkout "$candidate_branch"   # the Alpha branch, not the target
git -C "$sim/copy" config commit.gpgsign false    # rehearsal commits are thrown away
git -C "$sim/copy" var GIT_COMMITTER_IDENT >/dev/null 2>&1 || {
  # A clone inherits no identity from the source repo's own .git/config, and a
  # merge that needs a merge commit dies without one.
  git -C "$sim/copy" config user.name "$(git -C "$live" config user.name)"
  git -C "$sim/copy" config user.email "$(git -C "$live" config user.email)"
}
```

**The copy's lifetime.** `$sim` is created before the first absorb and deleted
only after the real round's post-checks pass, or after a recovery restoration
has completed. Nothing earlier may delete it: it holds the inventory AND the
only surviving copy of the live target's pre-operation bytes. It lives under
`~/tmp`, never `/tmp`, so a reboot mid-round cannot wipe the pre-images before
restoration runs.

**The absorb loop.** The copy holds the candidate and absorbs the target; the
target itself is never touched here.

```bash
git -C "$sim/copy" fetch origin "$target_branch"
git -C "$sim/copy" merge FETCH_HEAD      # target absorbed INTO the candidate
<the bundle's merge-result checks>       # run on the absorbed result
```

Repeat fetch → merge → check until a freshly fetched `FETCH_HEAD`
merges with `Already up to date.` and no iteration hit a conflict. That pair is
the definition of "proved"; a conflict is a block, not a step of the loop. These
iterations happen inside the copy and are NOT integration
rounds — they never count against the merge-round tripwire in Rule 6.

**Why a clean absorb is evidence about the live round.** The absorb joins the
target tip into the candidate inside the copy; the real round joins those same
two tips the other way round on the live repository. Same merge-base, same two
tips, therefore the same conflict set — so a conflict-free absorb whose checks
pass is evidence that the real round is conflict-free too. It is not the same
commit and nothing from the copy is shipped: the real round performs its own
three-way merge of the untouched Alpha branch. The rehearsal proves a merge; it
does not manufacture one.

**The recorded value.** `absorbed_head="$(git -C "$sim/copy" rev-parse
FETCH_HEAD)"` — the target commit the copy proved against. Write it into the
delivery todo's execution log _before_ any real integration; an unrecorded
absorbed HEAD means the rehearsal proved nothing checkable.

**The delivery precondition.** Real integration proceeds only while
`git -C "$live" rev-parse "$target_branch"` still equals `$absorbed_head`. If
the target moved, the copy absorbs the new tip, the merge-result checks run
again, and the recorded HEAD is replaced before delivery is attempted.

**The failure gate.** A conflict at any absorb iteration or a failing
merge-result check in the copy blocks real integration until `99c` fixes it. Do
not resolve it _in the copy_ and do not resolve it _on the live target_ — the
copy is disposable and the target is not yours to half-merge. Resolve it where
resolution belongs: absorb the target into the Alpha branch for real, in the
Alpha's own worktree, which touches no live target, resolve the conflicts and
repair the failing checks there **yourself**, then rehearse again from a fresh
clone. The rehearsal copy resolves nothing anywhere; `99c` resolves everything
on the campaign branch. This is not a hand-off to ordinary Shadows or a re-gate
— that was the old five-gate route, and it is closed.

**The recovery path.** If the real round conflicts anyway, abort it yourself —
plain git leaves the merge in progress rather than unwinding it for you, so run
`git -C "$repo" merge --abort` as the first action. Then confirm the live target
carries no in-progress merge and matches its pre-merge baseline, restore from the
recorded pre-images whatever the diffs report, and start a fresh clone and absorb
loop.

```bash
# --absolute-git-dir, not --git-dir: the latter commonly answers a bare `.git`,
# which then resolves against the executor's cwd — a Shadow worktree whose own
# `.git` is a file — and the MERGE_HEAD test passes over a live mid-merge.
git_dir="$(git -C "$live" rev-parse --absolute-git-dir)"
test ! -e "$git_dir/MERGE_HEAD"                       # no in-progress merge
git -C "$live" status --porcelain --untracked-files=all >"$sim/inventory.after"
( cd "$live" && git ls-files --others --exclude-standard -z \
    | xargs -0r sha256sum ) >"$sim/manifest.after"
git -C "$live" diff HEAD --binary >"$sim/dirty.after.patch"
diff "$sim/inventory.before" "$sim/inventory.after"
diff "$sim/manifest.before" "$sim/manifest.after"
diff "$sim/dirty.before.patch" "$sim/dirty.after.patch"
  # Any difference is restored from the recorded pre-images, never by hand:
  #   git -C "$live" reset --quiet --hard HEAD
  #   tar -C "$live" -xf "$sim/preimage.tar"
  # Baseline first, then the recorded bytes over it. That restores content, not
  # index state; `inventory.before` records which paths were staged, and
  # `git add` re-stages them.
  # Re-run all three diffs until clean. $sim holds the only copy of those
  # bytes, so it is deleted only after they verify — and only then:
rm -rf "$sim"
```

Hand-resolving a conflict inside the live target is forbidden.

**The pre-operation inventory.** Before ANY merge or abort on the live target —
the copy is disposable, the live checkout is not — capture
a path-qualified dirty inventory and a content manifest, plus the bytes:
tracked modifications, staged entries, and untracked paths including the
recursive contents of untracked directories. A bare directory entry is not an
inventory, and a hash is not a restoration — a diff that proves a file changed
cannot put it back. Every path the inventory covers must also have recoverable
bytes recorded, or the restoration this procedure mandates is unsatisfiable.

```bash
git -C "$live" status --porcelain --untracked-files=all >"$sim/inventory.before"
# `xargs` inherits no `-C`: hash from inside $live or the names resolve against
# the executor's own cwd and hash unrelated same-named files.
( cd "$live" && git ls-files --others --exclude-standard -z \
    | xargs -0r sha256sum ) >"$sim/manifest.before"
# Hashes detect; only bytes restore. One archive carries every dirty path —
# untracked, tracked-modified, and staged alike:
{ ( cd "$live" && git ls-files --others --exclude-standard -z )
  ( cd "$live" && git diff HEAD --name-only --diff-filter=d -z ) ; } \
  | tar -C "$live" --null -T - -cf "$sim/preimage.tar"
git -C "$live" diff HEAD --binary >"$sim/dirty.before.patch"   # the tracked/staged detector
```

`status --porcelain` records state and path, never content: a tracked `M` file
whose bytes change from A to B while it stays `M` is invisible to the inventory
and absent from the untracked manifest. `diff HEAD --binary` is what closes
that hole, and it is also the only artifact from which those bytes come back.

After the operation, regenerate all three, `diff` them against the recorded set, and
restore anything that vanished or changed.

**Why the bracket, stated as observation rather than mechanism.** No loss
mechanism is asserted here, because none reproduces. On git 2.55.0 a
merge that would overwrite an untracked path refuses up front — exit 2, no
`MERGE_HEAD` written, the untracked bytes intact — whether the rest of the merge
is clean or conflicted, and whether or not the untracked bytes match the
incoming side; the abort is simply never reached. Note what `99c` gave up when
it moved to plain git: `mergeBack` (`src/git-lifecycle/merge.ts:60-84`) stashes
`--include-untracked` around the landing, so `merge-git-tree` exposed no
untracked file to its internal abort. A plain `git merge` has no such stash, so
the inventory bracket below is now the ONLY thing standing between a live abort
and the ambient dirt.
One live untracked-file loss has been reported in this repository's memory tree
under conditions nobody has since reproduced, which is a reason to bracket and
not a mechanism to restate. The inventory is therefore a cheap
bracket around a live mutation, not a defence against a demonstrated
deletion. Do not treat "the merge aborted cleanly"
as evidence that the working tree survived — that is unexamined, not proven.

**Structural preference.** Gate the live round on a conflict-free absorb so that a
live abort is never required. A live abort is the already-damaged path:
reachable, bracketed by the inventory, and followed by explicit restoration —
never the routine one.

**The absorb loop and the failing-merge tripwire are different mechanisms, and a
reader who collapses them breaks one of them.** The tripwire bounds a merge that
WILL NOT LAND: at most two rounds, the second only for a diagnosed fixable cause,
after which the Alpha merges by hand with plain documented git and files the
recurrence as a process defect. The absorb loop bounds nothing by a retry
counter: it re-converges on a MOVING TARGET and ends when the target goes quiet.
Applying the tripwire's two-round cap to the absorb loop caps a legitimate
re-convergence; applying the absorb loop's patience to the tripwire licenses
unbounded retries of a broken merge. Neither bound substitutes for the other.

**`99c` is the one gate that must not be pre-staged with verdict-dependent
content.** A delivery gate's payload depends on the verify verdict that precedes
it, so only verdict-independent preparation — target-branch resolution and
merge-base capture — may be pre-built. Launch still requires `99b`'s explicit
PASS plus the candidate-HEAD equality check the pre-staging rule already
mandates.

**Legacy compatibility.** A pre-amendment bare `99_validate_<topic>.md` remains a
historical validation gate. The two-gate `99a` verify-and-fix / `99b`
merge-and-deliver chain that preceded the 2026-08-25 renumber keeps its authored
meaning, as does a pre-amendment `99b_validate_<topic>.md` /
`99c_merge_<topic>.md` pair, and a pre-amendment five-gate bundle (`99a` absorb,
`99b` file-size, `99c` static analysis, `99d` validate, `99e` deliver) keeps that
authored chain too. Because the same letter means different things across these
generations, terminal gates are classified by their ROLE WORD, not their letter.
Run those legacy files with fresh terminal Shadows under
`rolePools.ShadowSlice99`; do not reinterpret or rewrite ledger history. New
bundles use only the three-gate chain
above.

**Fresh-worker independence, not provider identity or effort, is what makes a
gate strong.** Spawn both terminal gates using the request selected by
executable policy. Same-company and cross-company
workers are equally valid routes. A gate is a fresh reader on a clean context; it
takes the model's lowest available effort like every other fresh spawn. Do not
pin its effort, and do not "compensate" with `--bypass-effort`.

`99b` re-runs the whole bundle's checks, not just the slices' own: a slice can
pass its own deliverable while the assembled candidate still breaks (an
integration seam nothing tested, a criterion no slice actually covered). That is
what running the suite over the assembled tree catches, and what `99b` then
fixes. Surface the result in the final verification matrix — a criterion the
bundle never covered is a real follow-up, not a footnote.

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

### Rubric critique gates — Shadow-run, bounded, resumed weakest-first

A bundle stamped `bundle_content: perceptual` carries `NNz_critique_<module>`
gate files authored by `write-todos`' "Perceptual-quality bundles". This
section owns how they execute. Everything here happens under the one
campaign Alpha: the critic is a Shadow, the fix is a Shadow, the re-grade is
a fresh Shadow, and at no point does anything ask the Regent for another
Alpha — the Lord's ruling of 2026-09-02, after a multi-Alpha fix chain left
the Regent queueing corrections without end. `review-loop`'s fixer-Alpha
model is NOT the route for a campaign-scoped critique.

1. **Spawn.** A critique gate is scheduled like any ordinary slice — it runs
   when its `deps:` (the builder it grades and the `01` evidence tool) have
   merged — and always before `99a`. Spawn it with `--deliverable-shape
   verdict-only`: it writes no product code and its branch is legitimately
   empty, and that flag is the property-keyed no-diff exemption
   `merge-git-tree` honours (the name-pattern exemption covers only the `99`
   terminal gates). Address it `shadow-<code>-NNz-critique-<module>`.
2. **Grade.** The critic runs the gate's `evidence_cmd` itself for every
   pinned preset, in its own worktree — a builder's own captures are never
   evidence. It scores each axis, produces one overall score, a ranked issue
   list, and the explicit line `**Critique outcome:** PASS` or `FAIL`. PASS
   requires score `≥ threshold` AND zero errors in every evidence JSON. The
   gate's per-Shadow `REPORT.md` carries the scores and the evidence paths.
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
         "score": 7.5,
         "threshold": 8.5,
         "verdict": "FAIL",
         "open_issues": ["<ranked issue, verbatim from the critic>"],
         "evidence": ["<path>"]
       }
     }
   }
   ```

   Never round a score up, never drop an open issue to make a row look
   closed, and never write a verdict the critic did not emit. `STATUS.json`
   is bundle ledger, not product: it lives in the todo folder and is never
   committed onto the campaign branch.
4. **Correct.** A FAIL is corrective work for the owning Alpha. Spawn exactly
   one fresh corrective Shadow, `NNy_fix_<module>_r<round>`, whose scope is
   the critic's ranked issue list verbatim and whose `touches:` is the
   module's own folder. If the list names a core change, the fix Shadow
   appends it to `core-requests.md` and the next seam slice carries it — the
   fix Shadow does not touch core. The corrective slice merges like any
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
   errata entry or Lord ruling explicitly relaxes that criterion.
7. **Resume weakest-first.** When this bundle is re-entered — a `/loop`
   iteration, a crash reconciliation, a Lord order to "keep going" — the
   Alpha reads `STATUS.json` before the todo folder and starts with the
   lowest-scoring uncapped `FAIL`, then the next lowest, before any unstarted
   work. A module already at `PASS` is never re-graded unless a later merge
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
module, rounds spent, final score against threshold, verdict, and whether it
was capped — measured rows and carried-forward rows visibly distinct, exactly
as for the `99` gates.

### Skip todos that aren't actionable

- "Later" todos that say "do this once X happens".
- Decision docs whose output is a choice, not code (e.g. wire-protocol design where bit rate / field list aren't pinned). Don't block on these — log the open decision and your assumed answer to `000_current_questions.md` (rule 5), then skip the doc itself as a code slice.
- Open-questions lists (those are user worklists, not executable work).
- **`00_overview.md` is not a slice** — it's read-first context for the whole bundle. Load it into every worker's assignment (rule 4); never run a worker to "do" it, even though it matches the `NN_` glob.

Document each skip in your final status report so the user sees what was deliberately not done. (`00_overview.md` is consumed as context, not skipped — don't list it.)

### `todo!()` for unpinned bodies

If a todo's wire-format / external-API contract isn't pinned but its public API IS pinned, implement the API surface fully and use `todo!()` in the bodies. Subsequent code references the contract and only fills in bodies later. This is how dependency cycles between todos resolve cleanly.

### `501 Not Implemented` over fake 200s

When a route depends on infrastructure that doesn't exist yet, return `501 Not Implemented` with a `{"error": "not_implemented", "blocked_by": ["todo NN"]}` body. **Never return 200 with placeholder data** — it pollutes the API contract with lies and makes future debugging painful.

### Pre-commit gate must include release build (embedded)

For embedded targets (`xtensa-esp32-none-elf`, `thumbv7em-none-eabihf`, etc.), `cargo check` is dev-profile and silently masks release-only issues:

- `queries overflow the depth limit` (needs `recursion_limit = "N"`).
- Monomorphisation explosions that only manifest under `--release` optimization passes.
- Linker errors from `lto = true` profiles.

Add `cargo build --release` to the pre-commit gate. It's slower (~30 s on a clean build) but catches the bug class that would otherwise fire only when flashing real hardware.

### When a Shadow dies or is rate-limited mid-run

- `git status` + `git diff` in its tree to see what it left on disk.
- Run the gate script to confirm the WIP at least compiles.
- Append a partial-progress log to the todo file (commit it with the WIP).
- Decide whether to relaunch the registered dead Shadow (`create-agent` relaunches its exact stored recipe) or reap it and spawn a fresh Shadow with a tightened assignment (better when little context was banked). The orchestrator never finishes the slice itself.

## Final report shape

The campaign stays incomplete while the latest verify verdict is absent or
FAIL; only an explicit PASS from the latest fresh `99b` gate permits delivery.
That PASS permits only the mandatory delivery-only `99c`; successful
fresh-Shadow target inspection and delivered-feature smoke checks remain
required before completion is reported. The `99c` report also carries the
completed private-copy rehearsal's recorded absorbed target HEAD.
The final report must surface the latest fresh gate's exact
`**Verify outcome:** PASS` or `**Verify outcome:** FAIL` in both campaign
status and the verification matrix. A completed failed gate remains a failed
campaign, not a completion.

When the queue has an explicit `**Verify outcome:** PASS` and the subsequent
`99c` Shadow has completed its mode-specific terminal contract — exact-one-commit
delivery plus target inspection/smoke checks for `git-repo`, or explicit Git N/A
evidence plus independent final operational-state validation for `no-git` — the
**first terminal action** before
anything else — is writing
`$THRONE_DATA/$ALPHA/REPORT.md`: the durable completion signal `complete-agent`
and `listCompletedAgents` verify before a campaign Alpha can be reaped. Only
after that file lands do you send the chat summary to your supervisor. Never
write `REPORT.md` mid-work, speculatively, or on a FAIL/absent verdict — its
presence on disk IS the reap-ready signal, not a courtesy copy of the chat
report. When you are ready to be reaped, tell your supervisor first (the
primary, never-dropped requirement), then publish the canonical claim supplied
by the generated assignment's completion section.

`REPORT.md` (and the chat summary you send afterward) both carry three separate
required sections before the existing campaign bookkeeping:

1. **Implementation accounting** — exactly what was implemented to fulfill the
   requested scope: changed files, delivered behavior, key decisions, and
   explicit boundaries. This section is mandatory in both `REPORT.md` and the
   Alpha DONE to Regent. It must stand on its own and must not be blended into
   the E2E section. Bare `done` is invalid.
2. **Real E2E run** — the exact real proof that ran: real stack/transport,
   setup, exact commands/actions, observations/evidence, verdict, and any
   deviation from the plan. This section is mandatory in both `REPORT.md` and
   the Alpha DONE to Regent. A bare `E2E passed` claim or a synthetic/mock-only
   route is invalid.
3. **Platform-first audit** — the concrete audit that governed planning and was
   re-checked after recon: current stdlib/platform/installed-dependency
   primitives considered, reuse or thin-wrapper decision, any custom machinery
   accepted, and concrete evidence for each guarantee the existing primitives
   could not provide. This section is mandatory in both `REPORT.md` and the
   Alpha DONE to Regent. A custom mechanism without the audit or without
   evidence for a claimed gap is invalid.

After those three sections, `REPORT.md` (and the chat summary you send afterward)
also carry:

4. **Done** — list of todos completed, one line each, each tagged with the actual harness/model plus the effort the engine resolved (e.g. `03 wire_route — claude sonnet / effort 1` or `03 wire_route — codex gpt-5.4 / effort 1`). Lead the section with the active plan preset and exact role pools used, active `MODE`, todo-run personality, and model mix (e.g. "preset=UnifiedRouting; optimized: 5×sonnet, 1×opus, 1×gpt-5.6-sol; personality=focused").
5. **Skipped** — list of todos skipped + reason (later / blocked-on-user / not-actionable).
6. **Verification matrix** — begin with the latest fresh `99b` gate's explicit `**Verify outcome:**` line, then show what was actually verified (the commands it ran + their pass/fail) vs what's only structurally assumed (e.g. "compiles" vs "tested on hardware"). For an explicitly legacy bundle carrying an older gate chain, fold in its per-criterion pass/fail against the whole authoritative `00_overview.md`. Keep measured rows (a command and its outcome) visibly distinct from rows carried forward from a prior gate (that earlier verdict plus its untouched-proof); a reader must never have to guess whether a row was measured or carried forward.
7. **Real follow-ups** — partial work, infrastructure gaps the workers flagged, things the user owns next.
8. **Open questions digest** — the full `000_current_questions.md` (or a digest of it), leading with the blocking / irreversible ones, so the user knows what assumptions the run rode on.

Be honest about what's NOT verified — runtime panics from `todo!()` bodies, hardware behavior, memory budget under load. Mismatched optimism here costs trust and debugging time later.
