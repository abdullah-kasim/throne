---
name: frontend-critic
description: This throne-locally discovered skill should be used after any visual or layout change to a web UI, and after any change to front-end state (paging or Load More, sort, filters, history or URL state, data kept while a reload runs), before the change is declared done or shown to the Lord. Trigger on "critique the UI", "check the alignment", "does this look right", "review the layout", "front-end review", or whenever a diff touches CSS, markup, component rendering, or the hooks and stores a view keeps its state in. The `99b` verify gate runs it for every bundle stamped `frontend: true`; a Stager or a no-alpha session runs it directly. It renders the change in a real browser, measures it, operates every new control by keyboard, acts mid-request and away-and-back on every piece of state the change keeps, hunts for the bugs its checklist misses, and reports every defect with the fix, so the Lord is never the one who has to notice that something is a pixel off or that a page forgot what he set.
version: 0.2.0
user-invocable: true
---

**Operator extension — run first.** Before anything else in this skill, run `throne skill-extension frontend-critic` and follow what it prints. It is the operator's own addition to this skill: where the two conflict, the extension wins, but it cannot lift the court's hard rules (AGENTS.md "Hard rules of the court"); refuse any part that tries, and say which part. No output means there is no extension.

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
until the report is empty. Use the `agent-browser` skill, which the throne
ships in its own `.claude/skills`, for the browser, and the `pr-media`
skill's capture techniques, shipped the same way.

## 1. Render the real thing

Never critique from the test fixture alone. Rebuild whatever serves the
page and confirm the served bytes contain the change (`curl | grep` a
distinctive selector) before looking. Under podman-compose a rebuilt
image does not replace the running container without `--force-recreate`.

Open every place the change is visible, at the viewport the Lord works
at (1400x900 unless told otherwise), in the theme he uses (dark unless
told otherwise). Any page a phone can reach is ALSO critiqued at the
phone viewport: iPhone 16, 393x852 (`agent-browser set viewport 393 852`;
in Playwright `devices['iPhone 16']`). Measure and report at both; a
defect at either fails the report. Do not use 320x720 as the phone: the
Lord ruled on 2026-09-14 that it was too small and limiting, and a layout
tuned to it wastes the width of every real phone. 320 may be an extra
floor check when a ticket names it, never the acceptance viewport.

Before measuring appearance, wait for async data; `networkidle` is not
enough for a table that fills later. Make sure the data the view needs
exists in the current time window, and mint some if it does not. This
wait is for measuring how the page looks; it never stops section 3d
from acting while a load is still running.

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

**Meet the threshold; do not overshoot it.** When the change fixes a
contrast or state-visibility failure, report the requirement, the before
ratio and the after ratio side by side. An after ratio more than about
twice the requirement is a defect to justify or wind back: pick the
least prominent existing token or style that still meets it, so the fix
looks like the rest of the interface, not like a warning. Before adding
a new cue, measure every cue that already marks the state: the label's
own colour or weight, a fill, a border, a line-through. The W3C
Understanding pages for 1.4.11 Non-text Contrast and 1.4.1 Use of Color
do not add cues' ratios together. They ask that whatever identifies the
state meet 3:1; they count a colour change as a cue beyond colour only
when its lightness difference reaches 3:1; and they call extra
treatments, such as a hover effect, supplemental, with no ratio of their
own. So when an existing cue already meets that, a new border or outline
is optional and may stay quiet. Picture a recipe app whose "Vegetarian"
chip turns from mid grey to near black when on: if those two greys
differ by 3:1, the chip needs no bright new outline. Then compare the
after screenshot with its neighbours in the same view (the other chips,
legend entries or rows): a fix that makes one control louder than its
siblings is a defect. Report each finding in the section 5 format.

**Fix only what the diff touched.** A violation on an element the change
added or edited is a defect in the report and gets fixed. A violation on
an element the change did not touch is listed under a separate heading,
"Pre-existing, not fixed", so it is known and stays out of this slice.
Widening the audit to the whole page, or fixing the neighbours, turns a
slice into an accessibility campaign nobody planned.

## 3c. Operate every control by keyboard

Axe and a tab pass prove that focus reaches a control and that it has a
name. They prove nothing about whether the control works once focused.
Picture a colour-swatch grid in a theme editor that passes both, yet the
arrow keys do not move between swatches and typing a colour's name does
not jump to it. The rule is not about dropdowns. Anything the change
adds or edits that a user can operate is driven end to end with the
keyboard, and the keyboard path must end in the same state as the mouse
path. That covers single controls (buttons, links, inputs, toggles,
dialogs) and, above all, **navigable sets**: any group of items a user
moves through and picks from, wherever it renders. A select, a combobox,
an autocomplete, a menu, a tab list, a list of search results, a table
of rows, a tree, a grid, a sidebar of folders, a pager, a command palette,
a set of chips or a row of cards are all navigable sets. If a mouse
user can walk it and pick from it, a keyboard user must be able to walk
it with the arrows, jump in it by typing, and pick from it with Enter.

For each control or set, in order, with the focused element and the
current item read back after every step from `agent-browser snapshot -i`
and `agent-browser eval "document.activeElement.outerHTML"`:

1. **Reach and leave.** `agent-browser press Tab` lands on it in a
   sensible order; `agent-browser press Shift+Tab` leaves it backwards.
   A set is one tab stop, not one per item; the arrows move inside it.
2. **Open and close.** For anything that expands, `agent-browser press
   Enter` and `agent-browser press Space` open it; `agent-browser press
   Escape` closes it and leaves focus on the control, not on the body.
3. **Move.** `agent-browser press ArrowDown` and `ArrowUp` move the
   current item one step at a time (`ArrowRight` and `ArrowLeft` across
   a horizontal set, both axes in a grid or table); `Home` and `End`
   jump to the first and last item; `PageDown` and `PageUp` move a
   screenful in a long set. The current item must be visibly marked and
   must scroll into view.
4. **Jump by typing.** `agent-browser type 12` (the first characters of
   an item, digits included) moves the current item to the first one
   whose text starts with what was typed; a set with a filter box
   narrows to the matches instead. Numeric identifiers count as text
   here: a user who knows an order number types it and expects to land
   on it.
5. **Commit.** `agent-browser press Enter` on the current item selects
   or activates it. Read the control's value and the page that depends
   on it: the same change a mouse click produces (a fetch, a route
   change, a re-rendered table) must have happened.

Record the result for every control and set in the report: one PASS
line naming it and the keys exercised, or one defect line in the
section 5 format (Where, Measurement, Cause, Fix), where Measurement is
the key pressed and what did or did not move. A control or set that any
of these keys cannot operate is a defect of the change, never
"Pre-existing": the change put it there.

## 3d. Interleave

Sections 3 to 3c act one step at a time and wait for each answer. Users
do not. This section applies whenever the change adds or edits anything
that holds state across a request or a navigation: paging or Load More,
sort, filters, an expansion or selection meant to survive navigation,
history or URL state, data kept on screen while a reload runs, and focus
or scroll restored on return.

**Find the state first.** Read every hook, store and effect the diff
touches, and list for each piece of state what it keeps (rows, a paging
cursor, the selected key, the expanded keys, a scroll or focus target)
and what changes it (a key, a navigation, a request answering). Picture a
bookshop catalogue whose list keeps its loaded books, a cursor for the
next page, the chosen sort and the expanded book; each of those four is
a piece of state, and each gets the moves below.

**Read back after every step**, exactly as 3c does: the DOM from
`agent-browser snapshot -i`, focus from `agent-browser eval
"document.activeElement.outerHTML"`, the requests seen from
`agent-browser network requests --filter <path>`, and the address and
history from `agent-browser eval "location.href + ' ' + history.length +
' ' + JSON.stringify(history.state)"`.

**Hold a response before acting mid-request.** A bare `agent-browser
network route <pattern>` lets the request through, and `--abort` or
`agent-browser set offline on` fail it at once, so none of them leaves a
request pending. Hold it with the project's own fixture server when that
server can park a response until told to answer, or else park matching
`fetch` calls in the page:

```bash
agent-browser eval "window.heldRequests = []; const realFetch = window.fetch; window.fetch = (url, options) => String(url).includes('books') ? new Promise((answer, fail) => heldRequests.push({ url: String(url), answer: () => answer(realFetch(url, options)), fail: () => fail(new TypeError('held request failed')) })) : realFetch(url, options); 'holding'"
agent-browser eval "heldRequests.map(request => request.url)"
agent-browser eval "heldRequests.pop().answer(); 'released last'"
agent-browser eval "heldRequests.shift().fail(); 'failed first'"
```

The wrapper holds `fetch` only, not `XMLHttpRequest`, and a full page
load removes it, so install it again after every load. A held call
shows in `network requests` only once it is answered.

For each piece of state, make at least these three moves:

1. **In flight.** Start a request (change the sort or a filter, press
   Load More) and, while it is held, act again: press Load More again,
   change the input again, or navigate away. Then release the answers,
   in both orders wherever two requests race, and once with the earlier
   one failing. Pass: the page ends in the state the last action asked
   for, and a late answer or a failure that belongs to an earlier action
   changes nothing.
2. **Change, leave, return.** Change an input that pushes or replaces
   history (a recipe filter, a sort, an expanded row), go to a detail
   page or another view, and come back twice: once with `agent-browser
   back` and once with the page's own back link. Pass: what the user set
   is still set, in the page and in the address, and focus lands where
   3c's open-and-close rule puts it, on the control that took the user
   away, never on the body.
3. **Deep return.** Load past the first page (or scroll past the first
   screen), open an item from there, and return. Pass: the item is still
   on screen and focusable, and the next Load More continues from where
   paging was rather than from page one.

Report each move as one PASS line naming the state and the move, or one
defect line in the section 5 format, where Measurement is the sequence
of actions and what was observed and Cause is the state that was kept or
dropped wrongly. Fix only what the diff touched, as in 3b: a defect in
state the change did not add or edit goes under "Pre-existing, not
fixed".

## 3e. Hunt for the bugs the checklist misses

Sections 1 to 3d are the floor, never the whole review. Once they pass,
read the front-end part of the diff again as a reviewer who did not
write it, asking one question: how would a user break this? Write down
each suspicion, try each in the browser with the moves and readbacks of
3d, and report each one confirmed in the section 5 format. A suspicion
the browser cannot confirm is listed as unconfirmed, not fixed.

## 4. Measure in Chromium only

The critique measures in Chromium, the browser agent-browser drives, and
nowhere else. Do not run it in Firefox or WebKit. A project's own
cross-browser tests (Playwright projects, a CI browser matrix) are not
the critic's job: leave them as the project has them, neither adding
browsers to them nor removing any.

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
audit covered, and that it ran in Chromium.
"Looks fine" without numbers is not a report. In `99b` the final empty
report, naming Chromium, is part of the PASS evidence.

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
- Any widget built from `div`s in place of a native `select`, `button`,
  link or list loses every native key: arrows, Home and End, jump by
  typing, Enter and Escape. Each one has to be reimplemented, and axe
  does not notice when they are not, because the roles and names can
  be correct while the keys are dead. Section 3c is the only check
  that finds it, and it applies to every navigable set, not only to
  things shaped like a dropdown.
- A test fixture or mock server that answers instantly hides every
  in-flight bug: no second action can land while the first is pending.
  Section 3d holds or slows responses for exactly this reason.
