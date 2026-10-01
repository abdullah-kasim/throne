# Throne skills

These skills ship in `.claude/skills`. A harness discovers them when it runs
from the throne checkout, the live root and every campaign worktree alike, and
the launcher adds the throne root to every spawn, so an agent working in
another repository's worktree sees them too. You invoke each one as `/<name>`.

## Anyone talking to the court

- `/usage` — shows a table of every harness's current limits, remaining percentage, burn rate, reset time and projected percentage at reset; reach for it when you ask about quota or how close a limit is.
- `/no-alpha` — has the agent you are talking to (the Regent or a Stager) do a task directly in its own session instead of spawning an Alpha, after it confirms the exact scope with you; reach for it when you say "no alpha"; aliases: /na.
- `/modify-config` — changes the machine-local `config.user.ts` safely: where it lives, what it can change, how to edit it without losing sections, and how to prove the edit loaded; reach for it to put a role on another model or effort.
- `/throne-startup` — boots the court after an install or a Regent resurrection, and diagnoses a startup hook or Regent seating that went wrong; reach for it when the court is headless after a reboot or messages sit undelivered.
- `/update-harnesses` — checks, updates, pins, promotes or rolls back the throne-managed Claude Code and Codex installations, only when durable harness ownership is enabled; reach for it to check for or move to a new harness release.
- `/restart-harnesses` — restarts every live agent's harness in place, each into its own session and pane, so the court runs the newly pinned binary; reach for it after `/update-harnesses` moved the pin.
- `/pr-review` — reviews someone else's pull request and leaves line comments as an unsubmitted pending review for you to edit and submit; reach for it when you want a pull request looked over.
- `/publish` — reads the prose that would ship in a public release over a staged dry-run snapshot for private content, fixes it at the source, and only then lets the real publish run; reach for it before cutting a public release.

## Stager only

- `/queue-objective` — turns your objective into a launch-ready queue row: shapes it, writes the body, verifies every code noun against the live tree, files it and tells the Regent; reach for it when you say "queue this".
- `/amendment` — records your change to a queue row that is already filed, numbers it, and tells the row's in-flight Alpha and the Regent; run by a Stager or the Regent when you amend filed work.
- `/autoscaler` — pauses, resumes or reports the court's spawning by flipping the autoscaler setting in `config.user.ts`; reach for it to stop or restart the spawning of Alphas.
- `/switch-campaign-model` — moves the whole campaign workflow (Alpha, Shadow and the final gate Shadows) onto one model; reach for it to run every campaign role on a given model.
- `/throne-fork` — creates a real forked Stager with `create-agent --fork-of`, never a harness subagent; reach for it when you say "fork this".
- `/pr-address-feedback` — reads every review comment on a pull request against the code, shows you which are sound, and files one queue row that fixes the sound ones and replies on every thread; reach for it to answer reviewers; aliases: /pr-feedback-address, /pr-review-feedback.
- `/pr-merge` — lands a stack of pull requests by rolling every upper one into the root, proving the scenario you name on the rolled branch, and squash-merging the root as one commit; reach for it to land a stack.
- `/pr-split` — splits one large pull request into several reviewable ones: the Stager agrees the cut with you and files one queue row per resulting pull request, and each row's Alpha carves its own; reach for it when a pull request is too big.

## Campaign Alpha: todo planning and execution

- `/write-todos` — plans an objective into a `todo-<timestamp>-<topic>/` folder of numbered, executable todo files; reach for it to break a campaign into slices; aliases: /create-todos, /draft-todos, /make-todos, /plan-todos.
- `/execute-todos` — runs a todo bundle slice by slice, each worked by a real Shadow, through to the final gates; reach for it to execute a written bundle; aliases: /do-todos, /run-todos, /process-todos.
- `/write-and-execute-todos` — chains `/write-todos` and `/execute-todos` in one unattended run, logging every question to the bundle instead of blocking; reach for it to plan and ship in one go; aliases: /do-all-todos, /plan-and-run-todos.
- `/review-loop` — alternates reviewer rounds with fixer Alphas on a named target, using a named reviewer model, until one of its termination bounds fires; reach for it to review and fix something in a loop.
- `/gap-analysis-model` — runs one pinned nested campaign per compared model and harness on the same task and distills per-model capability guidance from the stronger one; reach for it to compare two models.

## Any agent

- `/plan-task-split` — shapes a large piece of work into independently testable spokes around a small wiring core instead of a dependency chain; reach for it before planning or starting anything that touches more than a few files.
- `/pr-description` — the house style for every pull request body; reach for it whenever a pull request is about to be opened or its description rewritten.
- `/pr-media` — captures before and after screenshots and click videos of a UI change, builds a side-by-side contact sheet, and publishes it to the pull request; reach for it when a pull request needs screenshots or a recording.
- `/frontend-critic` — renders a web UI change in real browsers, measures it, operates every new control by keyboard, and reports each visual or keyboard defect with its fix; reach for it after any visual or layout change.
- `/agent-browser` — the browser automation command line for agents: navigating, filling forms, clicking, taking screenshots and extracting data; reach for it whenever a task needs a real browser.
- `/skill-writer` — writes, edits, ports or moves a `SKILL.md` so the result is generalized and scrubbed before it ships; reach for it whenever a skill is authored or relocated.
- `/herdr` — controls Herdr, the terminal multiplexer the court runs in, to inspect panes, tabs and agents; generated at spawn for the Stager and the Regent rather than tracked in the repository, so a fresh clone does not hold it; reach for it only when you ask about Herdr panes or tabs.

The discovery and runtime-scope rules for these skills are in [agent_docs/skills.md](../agent_docs/skills.md).
