# Throne-only skills

Runtime scope and discovery scope are separate decisions. A skill can require the
live throne at runtime yet still be discovered globally, or be intentionally
scoped to the throne for discovery as well.

`update-harnesses` is throne-locally discovered from
`throne/.claude/skills/update-harnesses` (moved there from a global
skills tree on 2026-09-02, by the Lord's order): its whole
subject is throne-managed harness artifacts, it requires a live throne root, and
global discovery only surfaced it where it could never run. The skill checks, updates, or rolls back throne-managed
Claude Code and Codex CLI artifacts. Its deterministic
script stages and probes each harness in isolation and has no live Herdr
operation. See `throne/.claude/skills/update-harnesses/SKILL.md` for the operator flow and evidence contract.

`gap-analysis-model` is throne-locally discovered AND throne-only at runtime: its
implementation lives at `throne/.claude/skills/gap-analysis-model/`, discovered
natively from a throne cwd like the todo skills, so it does not surface in
global Claude/Codex discovery. It may be invoked only by a registered Alpha in
the authoritative live throne. It depends on the live throne registry, real
Shadow agents, throne-owned worktrees, and `src/tools.ts`; a Shadow must not
invoke it.

- **`gap-analysis-model`** — orchestrates a multi-model gap-analysis campaign
  (two clean-room nested campaigns → stronger-model distillation) across
  harnesses/models using throne worktrees and agents. Its durable product is
  published outside the throne, in per-model-family guidance directories
  (`Claude/`, `GPT/`) that each harness's global instructions read.

`frontend-critic` is throne-locally discovered at
`throne/.claude/skills/frontend-critic/` (the Lord's order, 2026-09-09: most
of his coding runs through the throne, so the review lives where the work
does). It is the measured visual and state review of a web UI change: render the
served build, measure the changed element against its neighbours with
`getBoundingClientRect()`, check every state in Chromium only (section 4 of
the skill), act mid-request, away-and-back and past the first page on every
piece of state the change keeps (section 3d), hunt for the bugs the
checklist misses (section 3e), and report each defect with its cause and
fix. It binds every role:
`write-todos` stamps `frontend: true` on bundles whose slices touch CSS,
markup, or component paths and puts the critique block into `99b`, so the
verify gate runs it for campaign work; a Stager or a no-alpha session runs it
directly (AGENTS.md "The Stager"; `no-alpha` step 5). It drives the browser
through the global `agent-browser` skill.

`queue-objective` is throne-locally discovered AND Stager-only at runtime: the
file-then-notify procedure from AGENTS.md "The Stager" (STAR shaping, four
markers, verified nouns, lint, `add-to-queue` with launch facts, pointer
notification), packaged so a reader finds it without excavating AGENTS.md.
It adds no law of its own and cites the paragraph each step comes from.

`autoscaler` is throne-locally discovered AND Stager-only at runtime, a
sibling of `switch-campaign-model`: `/autoscaler off | on | status` flips
`steering.autoscaleEnabled` in the live `config.user.ts` to pause or resume
the court's spawning. It exists because the alpha-autoscale env switch is
permanently armed in both service templates since 2026-09-02 (the Lord's
order), so the operator pause moved to config. The worker re-reads the file
every tick; no restart in either direction.

`where-i-stand` is throne-locally discovered at
`throne/.claude/skills/where-i-stand/`. It answers with the link to the
Lord's page, the one agent-written file `where-i-stand.md` under the throne
data home shown below a table of his pull requests, corrects it
in the background from the forges, the queue and the live agents, and keeps
its tailnet copy up. Any role may run it, and it carries the writing rules
for every agent that edits the page. Its forge reader, `where_i_stand.py`,
sits beside it with its own tests
(`python3 .claude/skills/where-i-stand/test_where_i_stand.py`) and takes
hosts and tokens from the user's own configuration, never from this
repository. Serving the page uses the machine's own `tailnet-preview` skill,
which `.claude/skill-dependencies.tsv` records as `global`.

Skills intentionally scoped to the throne for discovery too live under
`throne/.claude/skills/`, alongside the todo skills: Claude Code discovers that
directory natively from a throne cwd, live root and worktree alike. The
launcher additionally exposes any `agent_docs_local/project-skills/.claude/skills/`
the launch repo carries — a per-repo convention the throne itself does not use.
Every skill there, and every new one, must open with the operator-extension
step described in `agent_docs/skill-extensions.md`.

`agent_docs/global-decoupling.md` records which of the throne's remaining
out-of-throne references are deliberate and which are full-sever material.

## Review skills the throne ships (`pr-description`, `pr-media`, `agent-browser`)

Moved into `throne/.claude/skills/` on 2026-09-14 by the Lord's order. They are
discovered from every court cwd because the launcher adds the throne root to
every spawn (`bin/agent-launcher-lib.sh`, `--add-dir "$throne_root"`), so an
Alpha or Shadow in a target-repository worktree sees them too.

- **`pr-description`** is the house style for every PR body: `## What`, `## Why`,
  `## How`, a hidden `## Sequence` diagram of the change's runtime flow, an
  optional `## Screenshots`, and a `## Testing` walkthrough of
  numbered steps written for a reviewer who is not an engineer and did not watch
  the work, closed by a mandatory **Not tested** alert, then a hidden
  `## Agents` section with the setup steps an AI agent follows to stand the
  change up for the reviewer, and last, only when the PR differs from its
  ticket, a hidden `## Ticket Status` section. `99c` composes every PR with it.
- **`pr-media`** captures screenshots and a click recording of a UI change with
  `agent-browser`, stages them under `~/tmp/pr-media-<pr>/` (never committed),
  and prepares the `## Screenshots` placeholders the human drops the files into.
  Its two helpers, `cursor-overlay.js` and `glide.sh`, sit beside the skill and
  are addressed through `$THRONE_LIVE_ROOT`, which every court tab exports.
- **`agent-browser`** is the discovery stub for the CLI both of the above drive;
  the usage guide is served by the CLI itself (`agent-browser skills get core`).
  `install.sh` installs the CLI globally with npm and runs `agent-browser
  install` for its browser; it is deliberately unpinned (Lord, 2026-09-14: the
  throne is not sensitive to its changes). `ffmpeg` is needed only for
  recordings and is a warning, not a failure.

Why they live here: the point of the court is that the human never opens an
editor. He reads the PR, follows its manual test, watches the recording, and
comments; the agents do the rest. The contract test is
`test/vendored-review-skills.test.ts`.
