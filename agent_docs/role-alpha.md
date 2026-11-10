# The Alpha's duties

The duties that bind an Alpha alone, moved word for word from AGENTS.md; the law that binds every role stays there.

### Shadows are real harnesses in the throne (throne-only todo skills)

The todo skills — `/write-todos`, `/execute-todos`, `/write-and-execute-todos`,
and their alias skills — are **throne-only** (the Lord's order of 2026-07-20).
They live under the throne's own `.claude/skills/`, run ONLY inside the throne
orchestrator, and refuse loudly anywhere else. Every per-slice worker is a real
**Shadow** — a herdr-tab harness via `./bin/throne-cli create-agent` (its own
tab, its own worktree, addressable in the chain of command) — NEVER an
in-harness Task subagent nested invisibly inside the caller. Only real Shadows
are visible in `agent-statuses`, watchable via `agent-logs`, and reachable by
name.

Rules:

- **One method exists (Lord's order, 2026-07-20).** The former
  in-harness-subagent worker mode and the "both methods must keep working"
  posture are struck: there is no fallback mode to preserve and no dual-mode
  conditional in the skills. Outside throne context the skills do not degrade —
  they refuse, naming the remedy (run from a throne session, or have the Regent
  spawn a campaign Alpha); the alias skills and `/write-and-execute-todos`
  inherit the refusal.
- **Throne context is the entry gate.** The live throne root is the main checkout
  owning `src/tools.ts` (never a worktree's copy; the main checkout has a real
  `.git/` directory while a linked worktree has a `.git` file). It resolves
  two ways: the nearest such ancestor of the orchestrator's cwd (fast path),
  else — when the orchestrator runs from a target-repo worktree and the throne
  is no ancestor — the cwd of the **unique** live Regent, re-validated by the
  SAME source + main-checkout owner check. This fallback engages only
  when that live root also registered the current Alpha:
  `~/.throne/data/<Alpha>/identity.md` exists, and its `tree-base.json` names the same
  Alpha handle and records an absolute target-repo path. An absent or ambiguous
  Regent, a failed owner check, or invalid or mismatched Alpha registration
  must NOT establish throne context — the skills refuse instead of guessing.
- **Status: built.** `/execute-todos` (and `/write-and-execute-todos`, which
  chains it) implement the mandate: each per-slice worker is a real Shadow — the
  orchestrator first runs `derive-shadow-name-from-alpha <the Alpha>
  <slice-id>`, then uses the exact returned handle for `spawn-git-tree` (a
  campaign Shadow tree bases on the supervising Alpha's branch),
  `create-agent --role Shadow --name <handle> --supervisor <the Alpha>
  --escalation Regent --cwd <slice tree>`, the assignment ledger, monitoring,
  `merge-git-tree` (which lands the slice in the tree's recorded Alpha branch),
  and reap. Large multi-section briefs stay file-based; `send-agent`
  preserves real newlines when the complete body is one quoted argument, while
  separate prompt arguments are space-joined. The Alpha's primary
  completion signal is each Shadow's DONE `send-agent`, with `agent-logs` as a
  long-interval backstop, and it merges each tree back into its own branch —
  merges strictly one at a time even when slices ran concurrently. Slices
  themselves are not serial by default: `/execute-todos`' Rule 3 scheduling
  contract runs dependency-independent slices with disjoint `touches:`
  footprints in parallel, up to its concurrency cap, and serializes conflicts,
  dependencies, integration slices, and the final `99` gate. The full per-slice
  sequence lives in `/execute-todos`' Rule 2.
