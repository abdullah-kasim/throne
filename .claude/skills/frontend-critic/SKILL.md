---
name: frontend-critic
description: This throne-locally discovered skill should be used after any visual or layout change to a web UI, before the change is declared done or shown to the Lord. Trigger on "critique the UI", "check the alignment", "does this look right", "review the layout", "front-end review", or whenever a diff touches CSS, markup, or component rendering. The `99b` verify gate runs it for every bundle stamped `frontend: true`; a Stager or a no-alpha session runs it directly. It renders the change in a real browser, measures it, and reports every visual defect with the fix, so the Lord is never the one who has to notice that something is a pixel off.
version: 0.1.0
user-invocable: true
---

# Front-end critic

Passing tests and a correct DOM are not evidence that a UI looks right.
On 2026-09-08 a link that met every Playwright assertion still sat one
to two pixels below its neighbours, and the Lord had to notice, describe
the offset, and prescribe the fix. This skill exists so that never
happens again: the agent looks, measures, and criticises its own work
before anyone else sees it.

It binds every role in the court. In a campaign it is part of the `99b`
verify gate whenever `00_overview.md` carries `frontend: true` (see
`write-todos`, "Front-end bundles"). Outside a bundle, a Stager or a
no-alpha session runs it itself before reporting a UI change done. Run it
twice at least: after the first implementation, and again after every fix
until the report is empty. Use the global `agent-browser` skill for the
browser and the global `pr-media` skill's capture techniques.

## 1. Render the real thing

Never critique from the test fixture alone. Rebuild whatever serves the
page and confirm the served bytes contain the change (`curl | grep` a
distinctive selector) before looking. Under podman-compose a rebuilt
image does not replace the running container without `--force-recreate`.

Open every place the change is visible, at the viewport the Lord works
at (1400x900 unless told otherwise), in the theme he uses (dark unless
told otherwise). Wait for async data; `networkidle` is not enough for a
table that fills later. Make sure the data the view needs exists in the
current time window, and mint some if it does not.

## 2. Measure, do not eyeball

Eyeballing a screenshot at scale finds nothing under 3px. Measure with
`agent-browser eval` and `getBoundingClientRect()`, comparing the
changed element against its siblings on every axis that matters:

- **Baseline.** For inline text, compare the bottom edge of the text
  node's box (not the padded anchor or button) against a neighbour's.
  Anything over 0.5px is a defect. Rows of labels and values share one
  baseline; a pill or button around one of them does not excuse it.
- **Vertical centre.** For things that should be centred in a row or
  cell, compare centres. A stretched flex box hides a misaligned child,
  so measure the child's text, not the flex item.
- **Horizontal rhythm.** Gaps between siblings in a row should be equal
  where the design uses equal gaps. Compare left edges minus previous
  right edges.
- **Size.** Click targets are at least 24px tall inline and 40px in a
  table cell, and fill the cell they live in. Elements that were one
  size before the change are the same size after, unless the change is
  about size.
- **Overlap and clipping.** No element's box intersects a sibling's;
  nothing is cut off by an `overflow: hidden` ancestor; nothing wraps
  onto a second line that did not before.
- **Neighbours.** The change moved nothing else. Measure the siblings'
  positions before and after (toggle the class, or check out the base)
  and require them to be identical.

Then take a zoomed crop of the changed region at 2x or 3x and read it.
Look for: text sitting below its neighbours, a glyph too close to its
text, an underline that does not span the text, a hover background that
is not vertically centred on the text, a focus ring that clips.

## 3. Check every state

Default, hover, focus-visible, active, and the empty or fallback
variant (no host, no data, zero rows). Hover with `agent-browser hover`
and re-measure: hover styles that add padding or borders shift text.
Tab to the element and screenshot the focus ring.

Check the other place the same component renders. A style added for a
table cell leaks into a header; a fix for the header breaks the cell.

## 3b. Check accessibility, scoped to the change

Run the axe audit on each changed surface, scoped to the container that
holds the change so pre-existing debt elsewhere on the page does not
enter the report:

```bash
agent-browser a11y --selector "<container of the change>" --tags wcag2a,wcag2aa --json
```

Then tab through the change with `agent-browser press Tab` and record,
for every new or edited control, that focus reaches it in a sensible
order, that the focus ring is visible, and that its accessible name
(from `agent-browser snapshot -i`) says what the control does rather
than where it goes or what it looks like. Check contrast of new text and
that no state is conveyed by colour alone.

**Fix only what the diff touched.** A violation on an element the change
added or edited is a defect in the report and gets fixed. A violation on
an element the change did not touch is listed under a separate heading,
"Pre-existing, not fixed", so it is known and stays out of this slice.
Widening the audit to the whole page, or fixing the neighbours, turns a
slice into an accessibility campaign nobody planned.

## 4. Check the other browsers

Chromium, Firefox and WebKit round text metrics differently. A baseline
that matches in Chromium can be off by a pixel in WebKit. Run the
measurement in all three (Playwright projects, or agent-browser against
each) before calling alignment correct.

## 5. Report before fixing

Write the report first, then fix, then run the skill again. The report
is a list, one defect per line, each with:

- **Where:** page, element, state.
- **Measurement:** the numbers, e.g. "link text bottom 2.6px below
  `duration` text bottom".
- **Cause:** the CSS responsible, e.g. "`inline-flex` with `min-height`
  centres the text in a taller box".
- **Fix:** the specific rule change.

If the report is empty, say what was measured, which container the axe
audit covered, and in which browsers.
"Looks fine" without numbers is not a report. In `99b` the final empty
report, with the browsers named, is part of the PASS evidence.

## Known traps, from the record

- `display: inline-flex; align-items: center; min-height: N` on an
  inline element lowers its text baseline. Use `inline-block` with
  padding and a matching negative margin, on a row that uses
  `align-items: baseline`.
- `align-items: center` on the row hides the problem in one font and
  shows it in another. Centre never substitutes for baseline in a text
  row.
- Geometric baseline equality can still read one pixel low when the
  element carries a background pill or a glyph. A `position: relative;
  top: -1px` nudge is acceptable after measurement, never before, and
  the test must then encode the nudged position.
- A test that asserts within 2px passes a visible defect. Assert within
  0.5px on text edges.
- Element screenshots inside a scrolling container paint the clipped
  region black; crop the viewport screenshot instead.
