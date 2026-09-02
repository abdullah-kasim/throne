# Global decoupling — what still ties the throne to the machine's Claude setup

The throne used to be unrunnable without three external props: the stowed
`agent-launchers` package in `~/bin`, the canonical global skills tree (which
held the throne's own model vocabulary and its runtime-only gap-analysis
skill), and the global `~/.claude/CLAUDE.md` preamble. Two of the three are
gone. This document inventories what is left, says which threads are kept on
purpose, and describes — without executing it — what a full sever would take.

Every row cites the evidence that produced it. The inventory is the output of a
`git grep` sweep of the whole `throne/` tree on 2026-07-21 for out-of-throne
resolvers: `~/parent repository`, `$HOME/parent repository`, `<home>/parent repository`,
`~/.claude`, `~/.codex`, `~/bin`, `bin-override`, `agent-launchers`,
`claudey`/`codexy`/`claudey-all`, `CLIProxyAPI`, `../../`, `homedir()`, and
`$HOME`. Ordinary `grep` on this box is a gitignore-respecting `ugrep` wrapper
that silently hides tracked-but-ignored paths such as `throne/.claude/`, so
`git grep` is the only sweep that sees the whole tree — repeat it that way.

## 1. Severed

| Coupling | Where it landed |
| --- | --- |
| Spawn launchers no longer need the stowed `~/bin` copies | `throne/bin/claudey`, `throne/bin/codexy`, `throne/bin/agent-launcher-lib.sh`, `throne/bin/launcher-bash-guard.sh` (commit `f4b9dfa`); contract in `throne/agent_docs/launchers.md:1` |
| The model vocabulary left the global skills tree | `throne/agent_docs/MODEL_POLICY.md` (commit `2100e54`); read by `throne/test/model-policy.test.ts:22`; cited by the Nest harness-routing capability domain, `throne/.claude/skills/write-todos/SKILL.md:33`, and `throne/.claude/skills/execute-todos/SKILL.md:454` |
| The gap-analysis skill left the global skills tree | `throne/.claude/skills/gap-analysis-model/` (commit `97115c3`); described at `throne/agent_docs/skills.md:7` and `throne/.claude/skills/gap-analysis-model/SKILL.md:15` |
| The `update-harnesses` skill left the global skills tree (2026-09-02, by the Lord's order) | `throne/.claude/skills/update-harnesses/`; described at `throne/agent_docs/skills.md:7`, `throne/agent_docs/architecture.md:57` and `throne/README.md:445`. Its whole subject is throne-managed harness artifacts and it requires a live throne root, so global discovery only surfaced it where it could never run. Native Codex agents lose it with the rest of `throne/.claude/skills/` — the consequence already accepted below. |
| ~~The gap-analysis skill's durable output root left the global tree (was F5 below)~~ **REVERSED 2026-07-22 by the Lord's order** | The output root is deliberately global again, and `throne/agent_docs/model-capability/` is deleted. See K12 in §2. |
| The coding masterplan and coding-principles docs left the global reading list (was F2 below) | Byte-verbatim copies at `throne/agent_docs/CRITICAL_coding_a_feature_masterplan.md` and `throne/agent_docs/coding_principles.md`; the execute-todos reading list points at them (`throne/.claude/skills/execute-todos/SKILL.md:424,425`); `throne/test/coding-competence-docs-drift.test.ts` byte-compares them against the global originals when those exist — the sync check the old F2 row said the sever would need |
| The keep-going nudge literal no longer hard-codes the live-throne path (was K8 in §2) | `throne/src/keep-going/keep-going.command.ts` resolves the command through the Nest-owned tree; the nudge path is derived from the throne root and covered by the command tests. The nudge thereby joins the service-unit sources and the Codex launch hook, whose committed sources carry `{{THRONE_ROOT}}` / `{{HERDR_BIN}}` tokens (`throne/src/install-services/service-unit-renderer.service.ts`) that `install-services` substitutes at install time |

Consequence already accepted in writing: skills under `throne/.claude/skills/`
are invisible to native Codex agents, which discover only the canonical tree.
See the dated Cross-harness section of the repo-root `CLAUDE.md`.

**The spawn path consumes them.** `throneLauncherPath` in
`throne/src/harness.ts` is the single resolver; `buildLaunchArgv` and the Regent
resurrection in `throne/src/regentstate.ts` both name `bin/claudey` or
`bin/codexy` by absolute path, overridable with `THRONE_LAUNCHER_DIR`. No throne
spawn resolves a launcher from `PATH` any more, except the legacy `claudey-all`
below.

| Coupling | Where it landed |
| --- | --- |
| Throne-scoped skill discovery no longer defers to the global preamble's `ls` ritual | `throne/agent_docs/skills.md:19-23` (commit `2318876`): Claude Code discovers `throne/.claude/skills/` natively from a throne cwd, live root and worktree alike |

## 2. Kept deliberately

Each of these resolves outside the throne dir and stays that way. (K8,
formerly a row here, has since been severed — see the §1 Severed table; the
remaining rows keep their numbers.)

| # | Coupling | Evidence | Why it stays |
| --- | --- | --- | --- |
| K1 | `claudey-all` (Claude-harness GPT via CLIProxyAPI) is not ported and stays `PATH`-resolved | `throne/src/harness.ts:203` (`buildLaunchArgv`'s `'claudey-all'` branch), `throne/src/list-harnesses-and-models/list-harnesses-and-models.command.ts`, `throne/src/create-agent/create-agent.command.ts`, `throne/agent_docs/architecture.md:258`, `throne/agent_docs/MODEL_POLICY.md:35`, `throne/AGENTS.md:90` | It serves exact stored legacy registrations, explicit standalone/manual calls, and whichever fresh GPT launches the live `ACTIVE_GPT_HARNESS_POLICY_NAME` currently routes through the Claude harness. Inspect `list-harnesses-and-models` for the current selection. It is Linux-only by nature (it needs the local CLIProxyAPI service), so porting it would still drag a platform-specific path through the throne. |
| K2 | Yolo checkpoint backups live under `$HOME/.claude/.claude_repo_backups/` | `throne/bin/agent-launcher-lib.sh:137` | The recovery helpers in the shells hash the repo root the same way and read the same location. Moving it under the throne would orphan every existing backup and break recovery from outside a throne session. |
| K3 | The yolo override dir defaults to `$HOME/bin-override` | `throne/bin/agent-launcher-lib.sh:15` | It is the machine's highest-priority `PATH` dir. The launchers must know it in order to *skip* it when resolving the real `claude`/`codex` binary — without that guard the shims recurse. It is already overridable via `YOLO_OVERRIDE_DIR`. |
| K4 | `$HOME/parent repository/claude/agent_docs/skills` is added to `--add-dir`, but only when it exists | `throne/bin/agent-launcher-lib.sh:186`, documented `throne/agent_docs/launchers.md:119-122` | Conditional by construction: a machine without the surrounding parent tree simply omits the argument. A convenience, not a dependency. |
| K5 | Historical 2026-07-21 evidence: `herdr` was unconditionally resolved through the repository-owned pinned release and named `throne` session | `throne/src/install-services/herdr-release.service.ts`, `throne/src/shared-policy/feature-flags.service.ts`, `throne/src/herdr.ts` | This row records the earlier decoupling result, not current unconditional behavior. The durable `herdr-decouple` strict JSON boolean now defaults OFF: OFF restores bare PATH/default-session compatibility; ON retains the owned pin and named session. |
| K6 | Host credential and config readers: `~/.claude/.credentials.json`, `~/.codex/auth.json`, `~/.codex/config.toml` | `throne/src/plan-usage-remaining/plan-usage-remaining.command.ts`, `throne/src/codex-usage-remaining/codex-usage-remaining.command.ts`, `throne/src/codex-trust/codex-trust.service.ts` | These *are* the provider state. The throne reads them (and, for credentials, never writes them). There is no throne-local substitute for a machine's login. |
| K7 | Machine-local state roots under `~/.throne/` — worktrees, recipient-pane locks, usage cache | `throne/src/gittree.ts:55`, `throne/src/shared-policy/recipient-pane-lock.service.ts`, `throne/src/usagecache.ts:132` | Deliberately outside the repo so transient agent state never lands in git. Already seam-overridable (`THRONE_WORKTREES_HOME`, injected `homedir`). |
| K9 | The launcher wires a per-repo `agent_docs_local/project-skills/.claude/skills` symlink to that repo's `.agents/skills` | `throne/bin/agent-launcher-lib.sh:166` | This is the generic per-repo skill convention the launcher provides to *any* repo it launches in, not a throne dependency. The throne itself has no such directory. |
| K10 | Phone notifications post to a host ntfy server | `throne/src/notify-lord/notification.service.ts:8` | A LAN service, unrelated to the Claude setup; the operator contract is `throne/agent_docs/ntfy-phone-notifications.md`. |
| K11 | The throne's service units are installed into the directories the host's own service manager reads: `$XDG_CONFIG_HOME/systemd/user` (falling back to `~/.config/systemd/user`) on linux, `~/Library/LaunchAgents` on mac. They land as rendered REAL files, not symlinks — `install-services` writes the whole set, `ensure-heartbeat` the keep-going pair, both through the same core | `throne/src/install-services/service-unit-renderer.service.ts`, constants `USER_UNIT_DIR` and `LAUNCH_AGENTS_DIR`; the Nest-owned command boundaries in `throne/src/` and the shared `installUnitFiles(` core | Those are where `systemctl --user` and launchd themselves look, so the throne has no local alternative location either would ever read. Host-integration by design, not a Claude-setup dependency. |
| K12 | The gap-analysis skill publishes its durable capability guidance into the global `claude/agent_docs/Claude/` and `claude/agent_docs/GPT/` family directories | `throne/.claude/skills/gap-analysis-model/SKILL.md` (the guidance output configuration point, `GUIDANCE_SUBDIR`); consumed by `claude/.claude/CLAUDE.md` (Step 2b) and `codex/.codex/AGENTS.md` (Model Capability Guidance) | The product characterizes MODELS, not the throne. It is only useful where a Claude or Codex session already bootstraps, and both harness families must reach their own family's file through the discovery ritual they already run. A throne-local copy would be undiscoverable by the agents it exists to instruct. The path is repo-relative and resolved against the distiller's own worktree, so it still lands through `merge-git-tree` rather than writing into the live checkout. |

## 3. Full-sever material

These are the threads a full sever would still have to cut. **None of them is
cut.** (F2 and F5, formerly rows here, have since been severed — see the §1
Severed table.) Each row says what cutting it would concretely take.

| # | Coupling | Evidence | What severing it takes |
| --- | --- | --- | --- |
| F1 | Every dispatched worker is told to read the global agent instructions — `~/.claude/CLAUDE.md` for Claude, `~/.codex/AGENTS.md` for Codex | `throne/.claude/skills/execute-todos/SKILL.md:423` | A throne-local preamble that restates what the throne actually needs from those files (terminal naming, commit conventions, communication style, the clipboard-staging rule, scratch-file staging), plus rewriting that reading-list bullet to point at it. That covers the *mandate* only. The Claude harness separately auto-loads `~/.claude/CLAUDE.md` at session start, but that auto-load **is** preventable from the throne's own launcher — measured, with its cost, in §4 item 4. The roleplay-persona thread of this coupling is already severed: the persona previously supplied only by the global `~/.claude/CLAUDE.md` now seeds from the throne's own `src/application-config.service.ts` (default config, optionally overridden by a local `config.user.ts`), so cutting the global file no longer loses it. |
| F3 | ~~The Claude launch hook that arms the throne lives outside the throne, in the operator's user-level settings~~ — **SEVERED 2026-08-09.** The throne now registers its own `SessionStart` hook in the tracked project file `.claude/settings.json` (re-included in `.gitignore` for exactly this), invoking `"${CLAUDE_PROJECT_DIR:-$PWD}/bin/throne-cli" throne-startup` so no machine path is committed. The user-level entry was removed in the same change, so the hook is registered once, not twice. Arming is now project-scoped — an effective no-change, since `throne-startup` already no-ops outside the throne root. The operator's remaining user-level `SessionStart` entry belongs to herdr's own Claude integration (`~/.claude/hooks/herdr-agent-state.sh`, `HERDR_INTEGRATION_ID=claude`), which herdr installs and overwrites on every reinstall — it is not the throne's to carry. | `.claude/settings.json`, `.gitignore` | Severed. |
| F4 | ~~The suite's copy-drift check reads a global project-report skill~~ — **SEVERED 2026-08-09.** That dispatch contract was project-specific and never belonged in the throne: its dispatch doc and grader test were removed by the Lord's order, and the repository's history was rewritten so neither ever existed here. Nothing in the suite reads a global skill any more. | — | Severed. |
**Negative findings worth recording** (a sweep result is evidence too):

- No file under `throne/` references the global `claude/agent_docs/MEMORY/`
  tree or the global learning-mode doc. Throne law already directs
  learning-mode writes to `agent_docs_local/MEMORY/`
  (`throne/AGENTS.md`, "Discovery + learning (every prompt)"), a real tracked
  directory inside the throne (the repo-root path is a symlink into it) so a
  Shadow's memory survives its worktree. The global preamble's own
  memory-write instruction reaches throne agents through F1 — by the mandate
  and by the session-start auto-load alike — so there is nothing throne-side
  to repoint.
- No file under `throne/` still names the old canonical locations of the model
  policy or the gap-analysis skill.
- The historical bundle folders `throne/todo-2026-07-16-*/` and
  `throne/todo-2026-07-17-*/` contain six files with global paths in their
  frozen prose (e.g.
  `throne/todo-2026-07-17-0110-reap-strand-guard/01_reap_agent_loud_strand_detection.md:4`).
  They are archived records of what was true when they ran; they resolve
  nothing at runtime and are deliberately left alone.

## 4. What a full sever would take

Executing the F-rows is **a separate decision by the Lord and is not part of
the work that produced this document.** Recorded here so the decision can be
made on evidence rather than re-derived.

Order matters, cheapest and least reversible-looking first. Items 1 and 3 have
since been executed, item 2 is resolved for extraction (its conditional read
stays); F1 and F3 remain open:

1. **F5 — move the gap-analysis output root into the throne. REVERSED
   2026-07-22** — severed on 2026-07-21, then deliberately un-severed by the
   Lord's order: the durable capability guidance is global again, split by model
   family, and `throne/agent_docs/model-capability/` is deleted. It is no longer
   a sever candidate. See K12 in §2 for why this coupling is now intentional.
2. **F4 — resolve the cross-tree test. DONE for extraction** — the suite now
   grades the throne-owned dispatch contract and checks the global copy only
   when it is present (see the F4 row above for the landed shape and what a
   full sever would still cut).
3. **F2 — throne-local coding docs. DONE** — severed; see the §1 Severed
   table. The sync check this item warned would be needed shipped with it
   (`throne/test/coding-competence-docs-drift.test.ts`).
4. **F1 — a throne-local preamble.** Two halves with very different prices;
   it is ordered here by the expensive one. **Suppressing** the harness's
   auto-load of `~/.claude/CLAUDE.md` costs one variable on
   `throne/bin/claudey:56`, and it is measured to work: in a scratch cwd with
   no `CLAUDE.md` of its own, asked what single word its loaded instructions
   require it to call the user, `claude -p --model haiku` answered `Lord` — a
   rule only the global file carries — and
   `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 claude -p --model haiku` answered `NONE`
   (both arms 2026-07-21, Claude Code 2.1.216, same binary and host, one
   variable apart). The same probe prices it: with a `CLAUDE.md` in that cwd
   defining a codeword, the default arm returned the codeword and the disabled
   arm returned `NONE`, so the variable drops **project-level** `CLAUDE.md`
   as well — a throne that sets it has to carry its own context, which
   `claudey` already does partly through `--add-dir` and
   `--append-system-prompt`. **Authoring** the throne-local preamble is the
   unchanged expensive half: suppression on its own makes throne sessions
   quieter, not portable.
5. **F3 — committed Claude self-configuration.** Relocation is mechanically
   possible: Claude Code merges the session cwd's project-level
   `.claude/settings.json` into the same run it reads user-level settings
   from, and runs `SessionStart` hooks registered there (measured 2026-07-21
   — see F3's row). Two costs, one of them easy to miss. First, the target
   file is ignored today, so it has to be re-included in `throne/.gitignore`
   before it can be tracked at all — F3's row quotes the evidence and the
   negation shape that works. Second, the stow package's entry has to go,
   otherwise both files register the hook (whether Claude Code would then run
   it once or twice was not measured), and arming becomes project-scoped:
   the user-level file arms every session
   today, while a throne-local hook arms only sessions launched at a throne
   cwd — an effective no-change, since `throne-startup` already no-ops
   outside the throne root. (The empirical probe fired with no interactive
   prompting under the bypass-permissions launch mode every throne agent
   uses; behavior of other launch modes was not measured and is not
   claimed.)
   Doing this moves the one piece of throne configuration this document
   finds in the stow package; it does not deny the portability F1 would buy
   (F2's share is already bought).

Risks a full sever carries:

- **Silent drift.** F1 creates a second copy of prose whose original keeps
  changing, with no guard reporting the divergence; the failure mode is agents
  following stale rules for months. (F2's executed sever avoided this by
  shipping with its own drift test; an F1 sever should do the same.)
- **Lost coverage.** F4's remaining sever is dropping the presence-gated
  equality check — losing the only report of divergence between the throne
  master and the global skill copy while both exist on a box.
- **Arming-scope change.** F3's sever narrows hook arming from every-session
  (user-level settings) to throne-cwd sessions (project-level settings) —
  matching `throne-startup`'s effective scope, but a real behavioral
  difference if a future hook is ever added to the same entry expecting
  global arming. It does not give up committed self-configuration: the
  hook moves to a tracked file.
- **No loud failure marks a missing global file.** The old cross-tree test
  failed with `ENOENT` when the global tree was absent (measured 2026-07-21,
  against the pre-redesign test); the redesigned F4 check is presence-gated on
  purpose, so no remaining coupling in this table fails loudly when a global
  file disappears. An F1 sever is prose no test reads and would produce no
  signal on its own — land it with a check that proves the intended files are
  no longer read, or the sever is unverifiable. (F2's executed sever shipped
  with its drift test; F5's was verified by sweep — `git grep
  'claude/agent_docs/model-capability' -- throne/.claude/skills/gap-analysis-model/`
  returns nothing. That sweep records how the 2026-07-21 sever was checked; F5
  itself was reversed on 2026-07-22 and the guidance root is global again, so
  do not cite this line as evidence of a current sever.)

The kept couplings in section 2 are explicitly **not** part of any sever. They
are host and provider facts (K5–K7, K10–K11), machine-wide conventions the
launchers must know in order to work at all (K2, K3, K9), a conditional
convenience (K4), and one deliberately-unported legacy path (K1).
