# Perceptual-quality bundles — evidence tool first, seam slices, rubric critique gates

Some objectives are graded by eye, ear, or measurement rather than by a test
that returns 0 or 1: a rendered scene, a UI, generated audio, a latency
budget, a document judged against reference material. The tests-and-lint
gates still run for these bundles, but they cannot answer "does this look
AAA" — and a bundle that has no machine-runnable answer to that question
ships whatever the builder Shadow *claims* it looks like. This section is the
one home for the three planning shapes that close that gap. Stamp
`bundle_content: perceptual` in `00_overview.md` when the objective's
`## Done when` contains any criterion a test cannot settle; skip the whole
section otherwise. It adds machinery to nothing else. A `frontend_row: builder`
bundle never stamps it: its critic row owns those criteria (see "Front-end
bundles").

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

The rubric grades visual (perceptual) quality only. Functionality is never an
axis on that curve: in a bundle whose `00_overview.md` stamps
`frontend: true`, every critique gate carries the **functional parity check**
section below, a pass/fail check that fails the gate on any FAIL line whatever
the score. A gate in any other bundle omits that section and keeps the generic
rule: PASS at `≥ threshold` with zero errors in every JSON log. A
`frontend_row: builder` bundle has no critique gates, so none of this applies
to it.

Critique gates may run concurrently; `/execute-todos` owns the size of their
pool. Each concurrent critic uses its own worktree, its own dev-server and e2e
port (never one another live critic holds), and its own agent-browser session
from `agent-browser session id --scope worktree --prefix <critic name>`, which
it closes when it is done.

```markdown
---
deps: [NN, 01]                     # the builder it grades, plus the evidence tool
gate: critique                     # role word; the executor spawns this verdict-only
module: src/<module>/              # the folder under judgment — the critic never edits it
threshold: 8.5                     # visual score to reach; PASS also needs zero evidence-log errors, and in a frontend bundle zero functional FAIL lines and a green e2e suite
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

Visual (perceptual) axes only; functionality is the functional parity check, not an axis.

- <Axis 1 — e.g. materials, lighting, silhouette, motion, timing>
- <Axis 2>
- <Every preset the critic must capture: at least three, spanning the domain's hard cases — night, dusk, close zoom, empty state, overload>

## Functional parity check

Mandatory when `00_overview.md` stamps `frontend: true`; omit this section in any other bundle.

- Through the real UI in agent-browser, at the viewport the presets pin, in the critic's own session: list every interactive element the reference has (buttons, links, tabs, menus, sheets, forms and their fields, toggles, pickers, cards that open things, gestures) and every state change the reference shows.
- Perform each and check the result against what the reference does: the screen or sheet that opens, the text that appears, the value that changes, the data created, edited or deleted and whether it is still there after navigating away and reloading, validation and empty or error states, back and dismiss behaviour.
- Record one line per check: `action | expected (from the reference) | observed | PASS or FAIL | capture path`.
- A FAIL line is: a reference element with no working counterpart, a control that does nothing, a wrong destination, a missing or wrong state change, data that does not persist after navigating away and reloading, a crash, a dead end, or any console or page error.

## Deliverable

- The critic runs `evidence_cmd` ITSELF for every listed preset — never grades a builder's own captures.
- A score per axis and one overall visual score, with the evidence paths that justify each.
- In a frontend bundle, every functional parity line, each with its capture.
- A ranked issue list: functional FAIL lines first, worst first; then the rubric issues, most damaging first, each naming the axis, the preset, and the file the fix most likely lives in.
- `**Critique outcome:** PASS` or `FAIL`. In a frontend bundle, PASS only at zero functional FAIL lines AND zero console or page errors AND the project's e2e suite green AND score `≥ threshold`; with any FAIL line the critic reports "visual N, capped at <cap> by functional failures", the cap one step of the gate's scale below `threshold` (79 at a threshold of 80). In any other bundle, PASS only at `≥ threshold` with zero errors in every JSON log.
- Writes no product code; commits nothing to the campaign branch.
```

Write the rubric anchors in the target's own vocabulary — the table above is
the shape, not the text. Pin the presets: an unpinned critic captures the
flattering angle. `reference_set: none` is legal when nothing external exists
to compare against; then the anchors carry the whole standard and must be
concrete enough that two critics would score within a point of each other.

**Scoring honesty is a hard rule.** The critic reports the number the
evidence supports, never the number that closes the round; the capped report
is that honesty applied, so a score at or above threshold always means
functional parity held. A round that fails is a failed round in `STATUS.json`
and in the final report, with what is still missing named. `/execute-todos`
owns what happens next — the corrective round, the fresh critic, the round
cap, and the weakest-first resume — under "Rubric critique gates" there; plan
nothing about that here.
