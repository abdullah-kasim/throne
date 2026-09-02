---
name: plan-task-split
description: 'Shape a large piece of work into tasks as a STAR — independently-testable spokes around a wiring core — instead of a dependency chain. Use BEFORE writing the plan OR before starting the work. Explicit planning words: "plan this", "make a plan", "how should we approach", "split this up", "break this down", "break into tasks", "divide into subtasks", "multiple tasks", "multiple agents", "multiple shadows", "parallelise this", "phases", "milestones", "roadmap", "todo bundle", "campaign", "epic", "slices", "which order should these go in". ALSO bare build/fix imperatives whose target is large — "go fix it", "go build it", "implement this", "do it", "make it work", "ship this", "handle this" — when the target is a spec, a queue objective, a list of several items, several files, or anything you would touch more than about three files for: the shape decision is made the moment work starts, whether or not anyone said the word "plan". Also when reviewing someone else''s breakdown, or when a plan already in flight has stalled behind one blocked task. NOT for genuinely small single-seam work — one bug, one file, one function.'
version: 1.0.0
user-invocable: true
---

# Planning a split — aim for a star, not a chain

This file is self-contained. It depends on no document outside this repository.

It exists because the guidance it carries was not being read. Whoever is
splitting an objective into slices does not think of that as coding, skips the
coding docs, and files a chain. That happened on 2026-08-25 and cost a full
stall — the evidence is at the end of this file.

**It triggers on bare imperatives too — "go fix it", "implement this", "do it" —
and not only on the word "plan".** The shape of the work is decided the moment
work starts, not when someone says the word. On the same night, "go fix it"
against a two-part feature produced six units built one after another by a
single worker, because nobody paused to ask whether they were spokes. Nothing
went wrong; nothing was parallel either, and no one made that choice
deliberately.

## Who this is for — two roles, two different jobs

The shape is decided in one place and destroyed in another, so this skill has
two audiences and neither can be substituted for the other.

- **The Stager DECIDES the shape.** Consolidating the Lord's objective into a
  queue plan body is where the seams get pinned and the spokes get named. The
  consolidation checklist already demands independently-executable slice
  boundaries; this skill is how that demand is met. A body filed as a phase list
  has already lost the parallelism before any Alpha reads it.
- **The Alpha PRESERVES or DESTROYS it.** `/write-todos` turns the plan body
  into `NN_<description>.md` slice files, assigns each a `touches:` footprint,
  and declares any inter-slice dependencies. A perfect star in the plan body
  becomes a queue of one if two spokes are handed an overlapping footprint —
  `/execute-todos` Rule 3 serializes on footprint collision regardless of what
  the plan calls them.

Read this at both moments. A Stager reading it once does not protect an Alpha's
footprints, and an Alpha reading it once cannot re-cut seams the plan body never
pinned.

## When this does NOT apply

Say so and move on. One bug, one file, one function, one obvious edit — there
is no shape decision to make, and a skill that fires on "fix this typo" is a
skill people learn to skip, which costs more than it ever saved. The rough line
is: **more than about three files, or more than one seam, or any work you would
naturally describe in a numbered list.** Below that, just do the work.

## The shape

```
        unit A ──┐
        unit B ──┤
        unit C ──┼──> CORE: wire them together, prove the whole
        unit D ──┤
        unit E ──┘
```

Every spoke depends on **nothing**. The core depends on **all** of them. That is
the whole topology, and it has three properties you want and cannot get from a
chain:

- **Depth is exactly 2, by construction** — not kept short by discipline,
  structurally incapable of being longer. There is no rule to remember, because
  there is nowhere for a third link to go.
- **Every spoke starts on day one**, in parallel, in any order.
- **One failure costs one spoke**, not a tail. The other spokes are already
  done and the core waits for one repair instead of an entire line.

The core is drawn as a single node for clarity. It does not have to be one
task, and with many spokes it should not be — see step 4.

A phase split ("phase 1 the config, phase 2 the daemon, phase 3 the UI") looks
orderly and is the opposite shape: a line, where every task waits on the one
before it, the plan runs at the speed of a single worker, and any one failure
stalls everything behind it.

## Do this, in order

1. **Find the seams and write them down FIRST.** Data shapes, function
   signatures, file formats, exit codes, states. The seam is the contract; every
   spoke is written and tested against it. Pinning contracts up front is not
   bureaucracy — it is the thing that makes parallelism legal.
2. **Test each proposed spoke with one question:** *can this be finished and
   proven correct with nothing else in the plan existing yet?* If no, you cut in
   the middle of a seam rather than at one. Re-cut. Give every spoke its own
   verification that does not require its neighbours; a fake **at the seam** is
   correct here — you are not faking the code under test, you are supplying the
   contract its neighbour will later satisfy.
3. **Hunt spoke-to-spoke edges. Target zero.** The moment one unit task depends
   on another unit task, a chain has grown out of a spoke and brings every
   problem of a chain with it. Some edges feel real — a schema does have to
   exist before the code that reads it — so ask whether the dependency is on the
   other task's **completion** or merely its **contract**. It is almost always
   the contract, and a contract can be written down today, which turns two
   chained tasks into two spokes. Where a genuine edge survives that
   examination, you have a chain of 2 hanging off the star: tolerable once, if
   you say out loud why. **Three tasks in a line is an antipattern —
   restructure, do not schedule.** The fix is almost never merging tasks; it is
   noticing that most links are the planner's reading order leaking into the
   schedule.
4. **Split the core once there are many spokes.** One monolithic integration
   task is a single point of failure at the worst moment — everything built, one
   bad seam between unit 5 and unit 6 fails the whole assembly. Use incremental
   wiring steps, each joining a few units and proving the subset assembled so
   far. This buys two things, and the second is the one people miss:
   - **Partial progress survives** — a failure at the 5-to-6 seam leaves 1-4
     wired and 7-10 wirable. One joint repaired, not an assembly restarted.
   - **The error names the seam** — "the 5-to-6 seam failed" is a bug report;
     "integration failed" is a mystery, and the least useful sentence in a plan.

   A chain **between wiring steps** is fine, and is the only place a chain costs
   nothing: by wiring time every spoke already exists, so the sequencing gives
   up no parallelism that was ever available. Keep each wiring step
   independently verifiable anyway. Where wiring steps are genuinely
   independent of each other — joining A+B has nothing to do with joining C+D —
   make them spokes of a smaller star with a final join at its core, and you get
   both properties at once.
5. **State the dependency graph explicitly in the plan.** Writing "B depends on
   A" out loud is most of the cure — a chain is obvious in a list and invisible
   in prose.

**A unit that cannot be tested alone is telling you something.** It usually
means a seam is missing, not that the work is inherently sequential. Add the
seam.

## What the core is NOT

A place where features get finished. If spokes are still being completed during
wiring, the spokes were not done, and the plan is a chain wearing a star's
diagram.

## Where this bites in the throne

The star is not an abstraction here; it maps onto machinery this repo already
has, and a chain filed into that machinery silently discards its parallelism.

- **`AGENTS.md` already carries this law** — see the bullet under "Hard rules of
  the court" beginning "Planning a large task, or splitting work into
  subtasks/agents". This skill is the trigger and the working procedure for it.
- **The queue objective body is where the seams get pinned.** By the time an
  Alpha reads it, the contracts must already be written down — an unpinned seam
  becomes a guess made independently by several Shadows, and no gate catches
  agreement that never existed.
- **Slice files are the spokes.** Each `NN_<description>.md` must be
  independently executable, because the Shadow that runs it holds only that file
  and cannot infer a boundary from a sibling slice's context.
- **The `touches:` footprint is the parallelism declaration.**
  `/execute-todos`' Rule 3 runs dependency-independent slices with **disjoint**
  `touches:` sets concurrently, up to its cap, and serializes everything else.
  Two spokes that overlap a file are not spokes. Cut footprints as deliberately
  as you cut seams.
- **A declared dependency serializes.** A slice declaring a dependency on
  another slice is a spoke-to-spoke edge in executable form: a deliberate cost,
  stated with its reason, never a default.
- **The terminal gate chain is core work, not a spoke.** `99a` conformance,
  `99b` tests-and-fixes, `99c` merges-and-delivers run last and in order. That
  chain is the sanctioned one; its existence is not licence for chains
  elsewhere.
- **Never manufacture a spoke.** A finding discovered mid-campaign is reported,
  not converted into work — restructuring a plan is re-cutting the work already
  authorised, never adding more of it.

## Measured, not theorised

Two plans, one night, same planner:

- **A phase-chained plan** — spikes → core → guest provisioning → daemon →
  desktop → install. Six tasks in one line, a pure chain, zero spokes. One spike
  failed for a trivial mechanical reason: a malformed command-line argument and a
  missing service in a VM. Four tasks stalled behind it, the workers sat idle,
  and unblocking it needed a human ruling about an architecture nothing had
  disproved. A bad quote in a command line had been promoted into an
  architectural blocker purely by the shape of the plan. Worth naming what the
  chain was *not* protecting: three of those four never needed the spike's
  *completion* — only its *answer*, which is a contract that could have been
  written on day one against a stated assumption, with the spike running in
  parallel to confirm it or trigger one rework.
- **A star-shaped plan** the same hour — six feature areas as spokes against a
  shared schema and route contract fixed up front. Each was provable on its own.
  They ran concurrently and landed within hours of each other.

Same workers, same difficulty, different cuts.
