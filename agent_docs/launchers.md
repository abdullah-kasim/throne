# Throne launchers

The throne owns its yolo launchers, and every spawn goes through them. They live
at `throne/bin/`:

- `claudey` — Claude Code in yolo mode (permission prompts skipped, repo
  checkpoint pushed, skill dirs wired in via `--add-dir`).
- `codexy` — Codex in yolo mode (approvals/sandbox bypassed, repo checkpoint
  pushed, backup notice injected into the prompt argument).
- `opencodey` — opencode in yolo mode (`--auto` auto-approves permissions,
  repo checkpoint pushed, backup notice injected into the prompt argument).
- `agent-launcher-lib.sh` — the helpers both entry scripts source.
- `launcher-bash-guard.sh` — the bash version guard both entry scripts source
  *before* the library.

They are self-contained in the sense the port needed: nothing under
`throne/bin/` reads, sources, or execs anything stowed into `~/bin`, and the
one path they derive from the harness discovery link — the global skills dir at
`agent-launcher-lib.sh:186` — is used only when it already exists. They do
require an ordinary POSIX host: both entry scripts open `#!/usr/bin/env bash`,
so `/usr/bin/env` must exist outside `$HOME`, and a bash of at least 4.3 must
be findable (the guard's own candidates include `/opt/homebrew/bin/bash` and
`/usr/local/bin/bash`).

## How a spawn finds them

`throneLauncherPath` in `src/harness.ts` is the single resolver. `buildLaunchArgv`
(every `create-agent` spawn, every startup-reconciliation resume) and the Regent
resurrection in `src/regentstate.ts` both name their launcher through it, so a
spawn's argv[0] is an absolute path and no `PATH` lookup decides which copy runs.
`opencodey` is a throne launcher exactly like `claudey`/`codexy`; opencode's
launch argv is `<opencodey> -m <model>`.

The directory it joins against is:

1. `THRONE_LAUNCHER_DIR`, when that variable holds a non-empty value; else
2. the `bin/` sibling of `src/`, resolved from the module's own location.

Being script-relative, a worktree's `tools.ts` spawns through *that worktree's*
`bin/` — which is what makes a pre-merge canary in a campaign worktree prove
anything about the code under review.

`claudey-all` is the exception: it is not a throne launcher, so it stays a bare
name resolved from `PATH` (the stowed `agent-launchers` package provides it).
Exact stored legacy Claude/GPT resumes reach it, and fresh GPT launches reach
it whenever `ACTIVE_GPT_HARNESS_POLICY_NAME` selects the Claude-harness forward
path. Inspect `./bin/throne-cli list-harnesses-and-models` for the live
selection.

herdr recognizes harness processes by executable **basename**
(`executableName` in `src/herdr.ts`), so absolute launcher paths classify as
claude/codex/opencode exactly as bare names did — for liveness, restored-tab
takeover, and the send-agent composer preflight alike.

## `opencodey`

`opencodey` is opencode's throne-owned launcher, mirroring `claudey`/`codexy`:
it resolves the real `opencode` binary through the shared
`yolo_resolve_real_bin` helper — `OPENCODE_BIN` first, else a PATH scan that
deliberately skips `$YOLO_OVERRIDE_DIR`, so a yolo-mode shim planted there
cannot bounce the launch back through another wrapper; a missing real binary
exits 127 with a diagnostic. It pushes the launch repo's checkpoint backup
through the same `claudey_setup_backup` helper the other entry scripts use,
then `exec`s `opencode --auto "$@"` — `--auto` is opencode's permission
auto-approval flag (its yolo equivalent of claude/codex approval bypass), and
every argument passes through verbatim: `-m <model>` selects the model (the
launch argv `buildLaunchArgv` emits for opencode is exactly
`<opencodey> -m <model>` — no effort token, because opencode has no native
effort flag; see MODEL_POLICY.md), and `-s <id>` resumes a session.

The stowed `agent-launchers` package is unchanged by opencode support: no
`opencodey` copy is added there, the throne's `bin/opencodey` is the only
opencode launcher, and the interactive `~/bin` copies remain claudey/codexy
only.

### Rollback

`git revert --no-commit 17d2c3d` (the repoint commit) does not return
immediately. Test-driven on 2026-07-21 and aborted: it exits 1 with four
conflicts — content conflicts in `throne/agent_docs/global-decoupling.md`
(where a later commit rewrote the same §1 spawn-path paragraph this commit
added), in `throne/agent_docs/launchers.md`, and in `throne/src/harness.ts`;
plus `CONFLICT (modify/delete)` on `test/throne-launcher-path.test.ts`, which
`d247c09` modified after `17d2c3d` created it, so git leaves HEAD's version in
the tree instead of deleting it. `throne/AGENTS.md` and
`throne/agent_docs/commands.md` auto-merge, and both still mention
`THRONE_LAUNCHER_DIR` afterwards. The stowed `~/bin`
launchers were never touched, so the underlying spawn behavior — bare
`claudey`/`codexy` resolved from `PATH` — is recoverable by reverting just
the resolver/argv code paths (`src/harness.ts`, `src/regentstate.ts`,
`src/herdr.ts`); the doc and test files then need manual reconciliation, not
an automatic return.

## Minimum bash: 4.3

`agent-launcher-lib.sh` writes results back to callers through `local -n`
namerefs, which arrived in bash 4.3. Stock macOS still ships bash 3.2 at
`/bin/bash`, so on a Mac the launchers would otherwise fail deep inside the
library with an unhelpful error.

`launcher-bash-guard.sh` prevents that. Both entry scripts source it and call
`throne_launcher_require_modern_bash` before sourcing the library, so the guard
itself must run on the old bash it exists to catch: it uses no namerefs, no
`${var^^}`, no associative arrays, and no `readlink -f`.

Behavior when the running bash is older than 4.3:

1. Candidates are tried in order — `$THRONE_LAUNCHER_BASH`,
   `/opt/homebrew/bin/bash`, `/usr/local/bin/bash`, then every `bash` on
   `PATH`.
2. Each candidate is asked its own version by running a `BASH_VERSINFO` test
   through it. `--version` prose is never parsed; its shape varies by build.
3. The first candidate that answers "4.3 or newer" is `exec`ed with this
   script's path and the original arguments.
4. Before that exec, `THRONE_LAUNCHER_BASH_REEXEC=1` is exported. A second pass
   that still finds itself on an old bash fails instead of re-execing again, so
   a candidate that misreports its version cannot produce an endless loop.
5. With no usable candidate, the launcher exits **78** (sysexits `EX_CONFIG` —
   the machine is misconfigured, no argument can fix it) and prints the
   minimum, the searched locations, and the remedy.

### Overrides and test seams

| Variable | Effect |
| --- | --- |
| `THRONE_LAUNCHER_BASH` | Explicit bash to re-exec into; tried before every built-in candidate. The documented remedy on a machine whose modern bash lives somewhere unusual. |
| `THRONE_LAUNCHER_FORCE_BASH_VERSION` | Read only when set; overrides the *running* version reading (e.g. `3.2`) so a modern bash can be walked down the old-bash path deterministically. Test seam. |
| `THRONE_LAUNCHER_BASH_REEXEC` | Loop sentinel, exported by the guard itself. Not something to set by hand. |

`test/launcher-bash-guard.test.ts` drives all four guard paths — rejected old
candidate, successful re-exec, modern pass-through, loop guard — with real
child processes against stub `bash`/`claude`/`codex` executables in a temp
`HOME` and a controlled `PATH`. No real harness is ever launched.

## `--add-dir` policy (claudey)

`claudey_build_add_dir_args` builds the set, in order:

1. **The launch repo's skill dirs**, when the launch is inside a git repo:
   `agent_docs_local/project-skills` (only when the repo has `.agents/skills`,
   symlinked in on demand) and `agent_docs_local/skills`.
2. **The throne root, always.** It is resolved script-relative — the launcher
   sits in `<throne>/bin`, so the throne root is that directory's parent. This
   is what carries `throne/.claude/skills` into every spawn, including spawns
   whose cwd is a different repo entirely. Because it is script-relative, a
   worktree's launchers expose that worktree's throne, not the live one.
3. **The global agent-skills package dir, resolved from `$HOME/.claude/skills`, only when it
   exists.** The personal global skills tree is a convenience on this box, not
   a dependency; on a machine without that tree the argument is simply
   omitted rather than pointing `--add-dir` at nothing.

`codexy` builds no add-dir set — Codex discovers skills through its own
`.agents/skills` path. It does not pass its arguments through untouched,
though: it drops every `--dangerously-bypass-approvals-and-sandbox` from the
caller's arguments (`bin/codexy:49-53`) and re-adds one as `exec`'s first
argument (`:61`), so the effective flag set is preserved but the argument
order is not. The prompt argument is rewritten too, to carry the backup and
commit notice.

## macOS compatibility

Every external command the launchers call exists on stock macOS and on Linux,
with no GNU-only flags:

- `readlink -f` is not on older stock macOS. Each entry script resolves its own
  path with a `readlink`-per-hop loop plus `cd -P … && pwd -P`. That block is
  inline in both scripts by necessity — it runs before any sibling file can be
  sourced, because it is what finds them.
- The library compares paths with bash's `-ef` (same device and inode, resolved
  through symlinks) rather than by string-comparing resolved paths, which is
  both portable and a stricter answer to the only question being asked: "is
  this candidate the wrapper itself, or a shim in the yolo override dir?"
- `md5sum` (Linux) vs `md5` (macOS) is chosen at runtime by `yolo_path_hash`,
  which hashes with `printf` — no trailing newline — on both.

## Relationship to the stowed `agent-launchers` package

The stowed `agent-launchers/bin/` copies remain the interactive launchers: they
are what `~/bin/claudey`, `~/bin/codexy`, and the `enable-yolo-mode` shims in
`~/bin-override` point at. They are untouched by the throne copies and keep
working exactly as before.

- The throne copies are canonical **for throne spawns**.
- `claudey-all` is not ported. It stays PATH-resolved, preserves exact stored
  resume and manual compatibility, and also serves fresh GPT launches whenever
  the live forward policy selects the Claude-harness GPT path. Inspect
  `list-harnesses-and-models` for the current selection. It is Linux-only by
  nature because it routes through CLIProxyAPI.
- The two trees will drift. Deduplicating them is a deliberate follow-up for
  the Lord to call, not a silent maintenance chore — until then, a fix that
  matters to both belongs in both.

## Custom harness executables

Resident `--harness-executable` launches store the absolute executable and exact post-`--` argv in `spawn.json`; current configured launcher flags are not added, and dead resumes replay those fields exactly. There is no `--bypass-harness` flag to contradict a custom executable with — it does not exist. `--run-custom-harness-to-exit` uses the same executable and argv boundary but is disposable: no registration, composer prompt, or resume; caller-only environment and evidence paths are mandatory, timeout kills the process group, and the visible caller-named tab closes on exit. The scrubbed launcher JSON records requested and filesystem-resolved executable paths, argv, cwd, environment key names, timeout, result, timing, and resolved harness/model/effort policy without environment values. Duplicate environment keys are refused, the timeout exit-status file contains `124`, and one-shot-only flags are refused outside one-shot mode before policy or lifecycle effects.
