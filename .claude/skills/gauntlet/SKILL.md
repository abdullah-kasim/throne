---
name: gauntlet
description: 'This throne-only, STAGER-ONLY skill turns one request from the Lord to make a product match its reference (a mockup, a prototype, a design file, a brand kit) into two filed queue rows: a critic-gated builder campaign that rebuilds the product screen by screen, and a deferred whole-product checker campaign that keeps scoring and fixing it until it passes. Invoked by /gauntlet or its alias /oneshot, or when the Lord says "make this app match its design", "match the mockup", "match the reference", "make it look like the prototype", or "rebuild it to the design", or asks for a gauntlet on a list of behaviour bugs rather than a visual match. Only a registered Stager may run it, and only on the Lord''s own instruction — a request relayed from the Regent, an Alpha or a Shadow is reported to the Lord, not actioned.'
version: 1.1.0
user-invocable: true
---

# Gauntlet: match a product to its reference

One request ("make the recipe app look like its mockup") becomes two queue
rows filed in one sitting:

- a **builder** row that rebuilds the product as a STAR of slices, each one
  scored by a separate critic against the reference before it may merge;
- a **checker** row, deferred on the builder, that scores the whole product
  and keeps fixing it until it passes or runs out of rounds.

The Lord's defaults below are already ruled on. Ask him only what step 12
lists. Every mechanic that another skill already owns is named here and not
copied: follow that skill for the detail.

## Who may run it

The Stager, on the Lord's own instruction, and nobody else. The entry rules
are `queue-objective`'s ("Who may run it, and on whose word"): a request
relayed from the Regent, an Alpha, a Shadow or a sweep is reported to the
Lord as a request and not actioned; your own initiative does not count.

## 1. Survey before planning

Open the reference and the current product with `agent-browser` at the
target viewport (a phone app at the phone viewport `/pr-media` uses). Capture
both with `/pr-media` in capture mode (its sections 1 to 3): never publish,
never touch a pull request. Look at the captures, then tell the Lord the real
size of the gap in one or two plain sentences. A request framed as "small
edges" can be a full rebuild; size the plan to what the captures show, not to
the framing, and say so in `SCOPE:`. In bug-fix mode the survey reads the
code first (see "Bug-fix mode" below) and sizes the plan to the bugs, not to
a rebuild.

## 2. Freeze the reference

Copy every reference file to `~/.throne/references/<project>/` and point both
bodies at that copy, never at a Downloads folder the Lord may clean while the
campaign runs. Never freeze it under `~/tmp`: the `~/tmp` sweep
(`sweep-tmp-scratch`, on a user timer) deletes every directory there idle for
more than two hours that no live agent holds, and a campaign runs far longer.
Loose files in `~/tmp` survive the sweep; directories do not. Capture folders
under `~/tmp` stay where they are, because every run regenerates them. Record
each reference file's sha256 in `VERIFIED-NOUNS:`. A reference URL behind a
login is unusable by agents; name the local copy as the reference of record
and say the URL is not to be used.

## 3. Shape a STAR

Apply `/plan-task-split`. Slice 01 is both the shared core (tokens, shared
components, the app shell, any schema change every screen needs) and the
evidence tool (step 4). The spokes are one per screen or module, all
parallel after 01, each with `deps: [01]` and a `touches:` list of its own
files only. A spoke that needs a shared change appends a dated entry to the
bundle's `core-requests.md` and works around the gap inside its own files
until a seam slice lands it: `write-todos` "Perceptual-quality bundles",
section 2, owns that mechanism. Write this rule into the builder body; the
checker's fix Shadows follow it too.

## 4. The evidence tool is slice 01

Slice 01 ships one command that, for a named preset, captures the product
and the reference side by side at the same viewport into a `/pr-media`
folder with its contact sheet, and writes a JSON log with at least: the
preset, console errors, the capture paths, and every measured metric (step
8). One preset per screen and per sheet or menu state; list them in the body
and have slice 01 pin the exact invocation and JSON keys in its
`## Semantic contract`.

It needs a development-only fixture that pins the data and the clock, so the
product shows the same state as the reference: the recipe app opens with the
mockup's six sample recipes and "today" fixed to the mockup's date. Without it
the two sides show different content and no score means anything. Slice 01
proves the fixture is absent from production builds (a grep of the built
output for the fixture's marker returns nothing).

## 5. A critic gate on every slice

Stamp the builder bundle's `00_overview.md` with `bundle_content: perceptual`
and `frontend: true`. Every implementation slice `NN`, 01 included, gets a
gate `NNz_critique_<screen>` with:

- `threshold: 80` on a 0–100 scale, and `max_rounds: 3`;
- `requires: non-coding>=4`;
- a fresh, verdict-only critic that never grades its own fixes, runs the
  evidence tool itself, views the contact sheet in `agent-browser`, runs
  `/frontend-critic` on the same screens, and runs the functional parity
  check (step 6) on every screen it grades;
- PASS only when all four hold: zero FAIL lines in the functional parity
  check, zero console or page errors, the project's e2e suite green, and a
  visual score of 80 or more. Any functional FAIL line fails the gate
  whatever the visual score, and the critic reports "visual N, capped at 79
  by functional failures", so a score of 80 or more always means
  functionality matches the reference and is bug-free;
- FAIL output lists functional failures first, worst first, then visual
  issues. It spawns one `NNy_fix_<screen>_r<round>` Shadow with that list
  verbatim; the fix Shadow fixes the functional failures first and adds one
  e2e spec per functional behaviour it fixes. Then a NEW critic grades the
  next round.

`execute-todos` "Rubric critique gates" owns the loop, `STATUS.json`, and the
cap; write-todos "Perceptual-quality bundles" section 3 owns the gate file.
Do not restate either. One thing the body must add: the Lord's ruling that a
slice still below 80 after round 3 merges anyway, with its score and open
issues in `STATUS.json` and the errata for the checker to inherit, ONLY when
the shortfall is visual and its functional parity check is clean. A slice
with a functional FAIL line still open after round 3 is never carried by
that ruling: the Alpha stops that slice (no further rounds, not accepted,
not delivered) and reports the open functional failures to the Regent;
other screens continue. Without that ruling in `RULINGS:`, `99a` fails the
capped slice.

Critique gates run concurrently, in the critique pool `execute-todos` owns
(up to 7, outside the cap of 3 live slice Shadows). Each concurrent critic
uses its own worktree, its own dev-server and e2e port (never one another
live critic holds), and its own `agent-browser` session from
`agent-browser session id --scope worktree --prefix <critic name>`, closed
when it is done.

For slice 01, the critic grades the shell (background, navigation, header)
on a placeholder screen against the reference's matching screen and ignores
the screen body.

## 6. The anchored scale and the functional parity check, verbatim in every body

Paste this block unchanged into both bodies, so a score means the same thing
in every round of every campaign:

```text
ANCHORED SCALE (0–100), visual fidelity only; functionality is the
FUNCTIONAL PARITY check, never a share of this score. The critic names the
two anchors its score sits between and why.
  95 = indistinguishable from the reference at a glance, side by side.
  85 = the same design with small flaws only a close comparison finds
       (a radius, a shade, a spacing step).
  80 = PASS line: the same design, a few visible but minor differences,
       nothing structurally wrong.
  70 = clearly the same design, with differences a user would notice
       (wrong icon set, off colours, misaligned grid).
  50 = right layout, wrong styling (colours, type, components do not match).
  30 = a different design.
WEIGHTS (visual weights): layout and structure 40, colour and typography 25,
component detail (icons, radii, spacing, borders, illustrations) 25, copy and
content 10.
Device frame and status bar are excluded.
Never inflate a score. Report failed rounds as they happened.
```

Paste this block unchanged into both bodies too, beside the anchored scale,
so a PASS means the same thing everywhere:

```text
FUNCTIONAL PARITY (pass/fail, never scored on a curve). On every screen it
grades, the critic works through the real UI in agent-browser at the pinned
viewport, in its own session. It lists every interactive element the
reference screen has (buttons, links, tabs, dock items, FAB and menus,
sheets, forms and their fields, toggles, pickers, cards that open things,
gestures) and every state change the reference shows, performs each action,
and checks the result against what the reference does: the screen or sheet
that opens, the text that appears, the value that changes, the data that is
created, edited or deleted and whether it is still there after navigating
away and reloading, validation and empty or error states, and back or
dismiss behaviour. One line per check:
  action | expected (from the reference) | observed | PASS or FAIL | capture path
A FAIL line is: a reference element with no working counterpart, a control
that does nothing, a wrong destination, a missing or wrong state change, data
that does not persist after navigating away and reloading, a crash, a dead
end, or any console or page error.
PASS = zero FAIL lines AND zero console or page errors AND the project's e2e
suite green AND visual score 80 or more. Any FAIL line fails the gate
whatever the visual score; the critic reports "visual N, capped at 79 by
functional failures", so 80 or more always means functionality matches the
reference and is bug-free.
FAIL output lists functional failures first, worst first, then visual issues.
```

## 7. Builders look before "done"

No builder or fix Shadow reports done until it has run the evidence tool on
its own screens and looked at the captures (read the images, or open the
contact sheet in `agent-browser`). Its report names the capture paths it
viewed. A report with no captures is not done.

## 8. Measure what can be measured

**Smoothness.** For every gesture the design has (a sheet dragged down, a
card swiped aside), the evidence tool gains a preset that scripts the gesture
in `agent-browser` and records frame timing from the page into the JSON log:
total frames, frames over 20 ms, and their ratio. The gate is a dropped-frame
ratio of at most 0.05. Measure the reference the Lord names for how the
gesture should feel once, the same way, and record its ratio beside the
product's.

**Stepped interaction** is one of the functional parity checks. For every
draggable sheet or card, an e2e spec AND
the critic's `agent-browser` check drag it by 10%, 20%, 30% … 90% of the
element's size, one depth per trial, holding at each depth before release.
At each held depth the element follows the input within 4 px. On release
below the dismiss threshold it snaps back; at or past it, or on a fast flick
at any depth, it completes. Slice 01 chooses the threshold and names it in its
semantic contract. Each depth is one line of the functional parity check,
and an element that only works through a button is a FAIL line.

The critic also records the gesture with `agent-browser record` (capture
mode) and fails the gate when the element does not follow the drag.

## 9. End-to-end tests are mandatory

Every slice adds end-to-end specs (Playwright, or the project's own e2e
framework) for its own flows, run against the fixture where data matters, and
the e2e suite green is a merge gate for every slice, not only the terminal
one. In the checker, every fix round keeps the suite green and adds a spec
for each defect it fixes that a test can observe. Name the project's
existing typecheck, lint, unit, build and e2e commands in both bodies as
the pre-merge gate.

## 10. The checker campaign

File a second row in the same sitting, then defer it on the builder at once:

```bash
throne update-queue --objective-code <checker> --status deferred --depends-on <builder>
```

The checker body says:

- It is one perceptual bundle under ONE Alpha. It reuses the builder's
  evidence tool and fixture (the checker's own slice 01 repairs them only if
  they are broken) and reads
  the builder's final `STATUS.json` and errata first: screens that ended
  below 80 there are where it starts.
- Every capture goes through `agent-browser`; no other browser tool
  substitutes.
- One whole-product gate, `threshold: 80`, `max_rounds: 10`,
  `requires: non-coding>=4`. A fresh critic per round runs every preset and
  scores every screen on the anchored scale and runs the functional parity
  check on every screen. The overall score is the mean of the per-screen
  visual scores. PASS is overall 80 or more AND no screen below 70 AND zero
  console or page errors AND the e2e suite green AND zero functional FAIL
  lines, including cross-screen flows (a flow that starts on one screen and
  ends on another: a recipe created on one screen, seen on another, and
  still there after a reload). The whole-product gate is one critic per
  round; the critique pool does not apply to it. A FAIL spawns one fix
  Shadow per round under the same Alpha; it fixes functional failures first,
  worst first, then the worst screen's visual issues, and adds one e2e spec
  per functional behaviour it fixes.
- It does NOT use `/review-loop`: that loop's mandatory no-progress stop can
  end it before the score bound, and it requests fixer Alphas from the
  Regent, which the Lord ruled out on 2026-09-02.
- TRAP: the checker's recorded base commit predates the builder's delivery.
  Before grading anything, the Alpha brings its tree up to the target branch
  and confirms the builder's delivery commit is present; grading the old
  tree scores the product before it was rebuilt.
- The terminal report gives the score history round by round, which bound
  ended the loop (PASS or the 10-round cap), and the open issues if the cap
  fired.

## 11. Blind final gate (checker only)

After the whole-product gate passes and before delivery, a fresh judge
Shadow (never a critic or fixer from this campaign; verdict-only,
`requires: non-coding>=4`) receives each screen as `A.png` and `B.png`, one
the reference and one the product, in an order from a seeded shuffle that the
Alpha records in `STATUS.json` and does not reveal. For each pair the judge
says which is better made and why, and which it believes is the reference.
The unblinded result goes into `STATUS.json` and the terminal report. This
gate reports and does not block delivery; a screen the judge picks against
with a clear reason is listed as an open issue.

One thing the checker body must add: the Lord's ruling that the blind judge
is this fresh verdict-only Shadow, never a critic or fixer from the
campaign, that it runs after the whole-product gate passes and before
delivery, and that it reports without blocking. Without that ruling in
`RULINGS:`, `execute-todos` "Rubric critique gates" item 8 has the same
critic judge the comparison inside the last critique gate.

## 12. Ask the Lord only what changes the work

Before filing, ask only:

- the threshold and round caps, if he wants something other than 80, 3 and
  10;
- delivery: a pull request, or straight onto the target branch;
- the model, only if he names one.

Bug-fix mode adds one question; see "Bug-fix mode" below.

Everything else takes the defaults above. Record every answer under
`RULINGS:` with his words. A change after filing goes through `/amendment`
with his quoted words, never `update-queue --append-body`.

## 13. File both rows

File each row with `/queue-objective`: its five markers, its noun
verification, its reuse survey, `add-to-queue` with the launch facts, and the
Regent pointer line, once per row. Run the lint bare, once per body:

```bash
throne lint-queue-plan --body-file ~/tmp/<builder>-body.md
```

Never pipe it (`| tail`, `| head`): a pipeline's exit status is the last
command's, so a piped lint always exits 0 and a failed lint files anyway.
File the builder, then the checker, then defer the checker (step 10).

## Bug-fix mode

Use it when the Lord asks for a gauntlet on a list of behaviour bugs rather
than a visual match, often bugs that survived an earlier gauntlet or an
ordinary campaign. Steps 1 to 13 still apply except where this section
replaces them; the gate loop, `STATUS.json` and the cap stay
`execute-todos`'s, filing stays `/queue-objective`'s (step 13), and a change
after filing goes through `/amendment`.

**Why the ordinary gauntlet misses bugs.** The FUNCTIONAL PARITY check
compares the product against what the reference demonstrates, so behaviour
the reference never shows is never exercised, and a whole-product checker
can PASS with zero FAIL lines while the bugs remain. This has happened: a
checker passed at round 6 with zero functional FAIL lines while four
behaviour bugs were live, because the prototype it graded against showed
none of the four behaviours.

**The behaviour spec is the functional reference.** Write a BEHAVIOUR SPEC:
numbered acceptance lines per bug (B1.1, B1.2, … for bug 1, B2.1 for bug 2),
each stating an action and its exact expected result, including whether the
result is still there after a reload, and the negative case. For a recipe
app whose shopping list forgets items:

```text
B1.1 Tap "Add to list" on a recipe needing 2 lemons -> the list shows "2 lemons" once.
B1.2 Reload the page -> "2 lemons" is still on the list.
B1.3 Open a recipe with no ingredients -> "Add to list" is disabled; the list is unchanged.
```

Paste the spec verbatim into both the builder and the checker body. Every
critic runs every applicable spec line as a FUNCTIONAL PARITY line whose
"expected" is the spec line. The drawn reference, if there is one, stays the
VISUAL reference, and only for the screens the campaign changes. New UI the
reference does not draw is graded for consistency with the reference's
existing patterns.

**Survey code first.** Pin each bug to `file:line` before planning, and put
those findings in `SCOPE:`. Captures are still taken for every screen the
fix changes.

**A functional-only gate for screenless slices.** A slice that changes no
screen has no visual score (not applicable); it passes when every applicable
spec line passes, the suites are green, and there are zero console errors.

**The fixture reaches both cases.** The step 4 fixture must be able to reach
both the positive and the negative case of each spec line: for example a
pinned-date override, so one date has a meal planned and another has none.

**The Lord can rule behaviour in.** Behaviour the reference deferred or ruled
out of scope is in scope when the Lord rules it in. Quote him under
`RULINGS:`, naming the reference line his ruling overrides.

**Unverifiable lines are NOT VERIFIED.** A spec line that cannot be verified
on this host (a native build with no toolchain, real hardware) is checked as
far as possible (the configuration is present, unit tests pass against a
mock) and reported NOT VERIFIED, never marked PASS.

**The checker adds flows.** The checker's critic also runs cross-screen flows
built from the spec lines, numbered F1, F2, …, each ending with a reload.

**One more question.** Step 12's questions still apply. Bug-fix mode adds
one: when a bug is really a missing feature, ask about the scope choices
that change the work (for example, foreground-only against background
tracking).

## When a gate rule changes mid-flight

A change to how the critic grades reaches campaigns already filed only when
the Stager carries it there:

- **Row not yet ended** (in flight, open or deferred). Record the change
  with `/amendment` (`throne amendment`) on every builder and checker row.
  The amendment requires a fresh critic round under the new rule for every
  slice that already passed under the old one.
- **Row already ended** (delivered, complete, or its Alpha wrote
  `REPORT.md`). `throne amendment` refuses it; see `/amendment`'s table of
  row states. File a continuation objective with `/queue-objective` against
  the delivered branch that re-grades every screen under the new rule with
  the same gate loop and fixes what fails.

## Where this method comes from

The shape follows the prompt at
https://github.com/rawprogress/fable-cities/blob/main/PROMPT.md, which calls
its per-module critic rounds a "gauntlet". Each of its ideas maps to
machinery this throne already has:

| PROMPT.md idea | Carried by |
| --- | --- |
| Architecture first | slice 01 as the shared core; `/plan-task-split`'s STAR; own-files-only `touches:` (step 3) |
| Verification tooling before features | slice 01 as the evidence tool with its fixture (step 4) |
| Dependency waves | spokes with `deps: [01]`, `core-requests.md` and seam slices (step 3) |
| A separate critic that writes no code | verdict-only `NNz_critique_<screen>` gates with a fresh critic each round (step 5) |
| An anchored scale | the verbatim anchored-scale block and its visual weights, with the FUNCTIONAL PARITY block beside it (step 6) |
| A blind final gate | the checker's A/B judge (step 11) |
| Persisted state | `STATUS.json` and the errata, inherited by the checker (steps 5 and 10) |
| Behaviour spec as the functional reference (bug-fix mode) | the numbered behaviour spec pasted into both bodies and run as FUNCTIONAL PARITY lines ("Bug-fix mode") |
