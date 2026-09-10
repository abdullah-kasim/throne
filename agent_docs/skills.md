# Throne-only skills

Runtime scope and discovery scope are separate decisions. A skill can require the
live throne at runtime yet still be discovered globally, or be intentionally
scoped to the throne for discovery as well.

`update-harnesses` is throne-locally discovered from
`throne/.claude/skills/update-harnesses` (moved there from the global
`claude/agent_docs/skills` tree on 2026-09-02, by the Lord's order): its whole
subject is throne-managed harness artifacts, it requires a live throne root, and
global discovery only surfaced it where it could never run. Codex no longer sees
it through the tracked `codex/.agents/skills` link. The skill may check, update, or roll back throne-managed
Claude Code and Codex CLI artifacts only when `harness-decouple` is explicitly
enabled; OFF performs no discovery or ownership mutation. Its deterministic
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
  published outside the throne, in the global `claude/agent_docs/Claude/` and
  `claude/agent_docs/GPT/` family directories.

`frontend-critic` is throne-locally discovered at
`throne/.claude/skills/frontend-critic/` (the Lord's order, 2026-09-09: most
of his coding runs through the throne, so the review lives where the work
does). It is the measured visual review of a web UI change: render the
served build, measure the changed element against its neighbours with
`getBoundingClientRect()`, check every state in Chromium, Firefox and
WebKit, and report each defect with its cause and fix. It binds every role:
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

Skills intentionally scoped to the throne for discovery too live under
`throne/.claude/skills/`, alongside the todo skills: Claude Code discovers that
directory natively from a throne cwd, live root and worktree alike. The
launcher additionally exposes any `agent_docs_local/project-skills/.claude/skills/`
the launch repo carries — a per-repo convention the throne itself does not use.

`agent_docs/global-decoupling.md` records which of the throne's remaining
out-of-throne references are deliberate and which are full-sever material.
