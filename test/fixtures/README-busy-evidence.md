# Live busy/draft composer-classification evidence (Claude harness)

All captures below are real `.ansi` frames pulled from genuinely live throne
agents via `herdr agent read <name> --source visible --format ansi` on
2026-08-13, then run through `inspectSupportedAgentScreen` /
`isSupportedComposerEmpty` / `activeBottomComposerHasDraft`
(`src/codex-screen/composer/composer.service.ts`) exactly as `send-agent`
does. No `.ansi` content was hand-written; every byte came from a real
terminal snapshot.

## Fixtures and their classification today

- `claude-live-fleet-busy-midtool-tool-running.ansi` — captured against
  `alpha-cia-childless-idle` (`herdr agent read alpha-cia-childless-idle
  --source visible --format ansi`, 2026-08-13T03:13:02Z) mid an actively
  running `Bash` tool call ("Fermenting… 11m 59s · 38.8k tokens"). Classifies
  as `state: "empty"`, `isSupportedComposerEmpty: true`. Confirms a busy pane
  mid-tool-call, not just a plain idle spinner, still reads correctly empty.

- `claude-live-fleet-interactive-select-menu.ansi` — captured against
  `alpha-tio-test-isolation` (`herdr agent read alpha-tio-test-isolation
  --source visible --format ansi`, 2026-08-13T03:11:xx Z) while it sat at a
  real interactive numbered-choice prompt ("Holding for
  shadow-tio-99b-file-size's DONE report — proceed with waiting rather than
  polling? 1. Wait... 2. Poll... 3. Type something. 4. Chat about this").
  Classifies as `state: "draft"`, `hasDraft: true` — the menu's own rendered
  option text is picked up as composer text. This is a real non-empty,
  non-draft-in-the-human-sense state that the current Claude branch of
  `inspectSupportedAgentScreen` cannot distinguish from a genuine resident
  draft (Claude has no `modal` branch — only OpenCode does). It is NOT the
  reported bug (it correctly blocks delivery, which is safe), but it is
  evidence that `"draft"` on Claude today is overloaded to mean "any
  non-empty composer-region text," menu or human.

- `claude-live-fleet-resident-draft.ansi` — a genuine resident-draft negative
  control against `alpha-bsy-busy-not-draft` (idle/`done` status at capture
  time). Real keystrokes ("evidence capture test draft - do not send") were
  injected into the live pane via `herdr pane send-text w2:p1VB "…"` (real
  terminal input, not a hand-edited `.ansi` file), then captured with `herdr
  agent read alpha-bsy-busy-not-draft --source visible --format ansi`
  (2026-08-13T03:1x Z), then cleared with `herdr agent send-keys
  alpha-bsy-busy-not-draft ctrl+u` immediately after capture (verified back to
  `empty` afterward — the target agent's pane was left exactly as found).
  Classifies as `state: "draft"`, `hasDraft: true`. This is the required
  negative control future regression tests anchor to: real unsent text must
  never be treated as safe-to-overwrite, and today it isn't.

## Repeated time-sampling across long continuous generation

Per the amendment to this campaign (production correlation: repeated
~90-minute-late deliveries against `regent` and `alpha-tio-test-isolation`,
always via the "resident draft did not clear" deadline error, always during
long continuous generation), single steady-state frames were not enough —
the hypothesis was that a *transient* mid-redraw frame during a long
generation might momentarily misparse as non-empty. Sampled repeatedly at
~1–1.5s intervals via the same `herdr agent read <name> --source visible
--format ansi` command:

- `regent` (continuously `working`): 105 frames over ~3 minutes — **all 105
  classified `empty`**.
- `alpha-cia-childless-idle` (continuously `working`, includes multiple live
  Bash tool calls): 200 frames over ~4 minutes — **all 200 classified
  `empty`**.
- `shadow-tio-99b-file-size` (continuously `working`): 200 frames over ~4
  minutes — **all 200 classified `empty`**.

505 total sampled frames across three genuinely busy Claude panes, zero
transient non-`empty` misclassifications caught. (An earlier attempt to
sample `shadow-tio-99a-initial-absorb` failed silently partway through
because that agent completed and was reaped mid-sampling — its output was
discarded, not counted above, since the captures were empty/erroneous once
the target pane stopped existing.)

**What this does and doesn't show:** at ~1s sampling resolution, no
categorical or transient busy-classification defect reproduces on Claude
tonight — busy-with-active-tool-call reads empty exactly like busy-idle-
spinner. This does not rule out a much shorter-lived redraw glitch (sub-
second) that 1s polling would simply miss, nor a race specific to
`waitForEmptyComposer`'s own poll/deadline timing rather than a static
classification miss (see the `00_overview.md` architecture note flagging
this as a real alternative). Given the interactive-select-menu finding above,
the more concrete, evidenced lead is that Claude's `"draft"` state is
overloaded across "real human text" and "any other non-empty composer-
region content" (menus, and by extension possibly other transient chrome) —
worth checking against `waitForEmptyComposer`'s deadline/poll behavior
directly rather than assuming a new static classification bug.

## Codex

No live Codex-harness agent existed anywhere in the throne fleet during this
capture session (`throne-cli agent-statuses` / `herdr agent list` showed
every live agent — `regent`, `alpha-bsy-busy-not-draft`,
`alpha-cia-childless-idle`, `alpha-tio-test-isolation`,
`shadow-bsy-01-capture-evidence`, `shadow-tio-99b-file-size` — running
`harness: "claude"` per each agent's `spawn.json`). Capturing genuine live
Codex evidence requires either waiting for a live Codex agent to be running
in the fleet, or deliberately spawning one for this purpose; this slice did
neither (out of scope for an evidence-only capture pass), so no Codex
fixture is included here. Codex coverage remains outstanding for a future
capture pass once a live Codex agent is running.
