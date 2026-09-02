# throne

An agent-agnostic orchestrator: a typed CLI over [`herdr`](#requirements) that
runs a standing hierarchy of AI coding agents across any repository.

Self-modification is only the bootstrap case. A campaign targets whatever repo
it is pointed at; the throne holds the agents, the ledger, and the worktrees,
while the target repo supplies only the code being changed.

`AGENTS.md` is the operating law for agents working inside it and is the longer
read. This file is the front door: what the thing is, how to run it, and what
its current portability limits are.

## Install

The throne stands alone. On a machine with no `herdr`, no Claude Code and no
Codex on it:

```bash
git clone <this repo> && cd throne
claude      # or codex, or opencode — then ask it to run ./install.sh
```

The installer is run **by an agent, not by hand**: it refuses to start
without `I_AM_AN_AGENT=1`, which the agent supplies when it runs it. An agent
reads whatever breaks on your particular machine, fixes it, and re-runs until
the install is clean; its last message tells you to quit it and run `throne`.
The script installs the node dependencies, compiles the CLI, downloads all
three harnesses at pinned versions, pulls the ntfy image, installs and
starts every service, and then seats the court: it runs `keep-going`, so a
Regent is live before the installer returns (a `dismissed` desired-state is
honoured), sends a newly raised Regent its install order, and waits for the
Stager that the Regent's startup hook raises — applying the same floor
directly if the hook did not. It is
**idempotent** — re-run it after every `git pull` to apply a moved pin; a
no-op run takes about a second and changes nothing.

Then:

```bash
./bin/claude      # Claude Code in yolo mode, on the throne's pinned binary
./bin/codex       # Codex in yolo mode, on the throne's pinned binary
./bin/throne      # open/attach the throne herdr session
./bin/throne-cli  # the court's command surface
```

Everything downloaded is gitignored and reproducible from the manifests:

| what | where | pinned by |
| --- | --- | --- |
| Claude Code, Codex | `./vendor/` | `vendor-pins.json` |
| herdr | `~/.local/share/throne/herdr/<tag>/` | `src/install-services/herdr-release.service.ts`, with a per-artifact sha256 |
| node deps, compiled CLI | `./node_modules/`, `./dist/` | `package-lock.json` |

herdr sits outside the repo deliberately: campaign worktrees are separate
checkouts that must all resolve the same herdr binary.

Take it back down by asking an agent to run `./uninstall.sh` (add `--purge`
to drop `dist/` and `node_modules/` too; same `I_AM_AN_AGENT=1` contract). Your `config.user.ts`, the `~/.throne/` ledgers, and the
checkout itself are never touched. Note that stopping herdr drops every live
agent pane, so check `./bin/throne-cli agent-statuses` first.

Only two things must already exist: **bash ≥ 4.3** (macOS ships 3.2 — `brew
install bash`) and **Node ≥ 24**. The installer checks both and refuses early
with instructions rather than failing halfway.

## The peerage

Work flows down. Escalations flow up one link at a time. No tier below the
Regent holds the whole map.

| Tier | Role | Mandate |
| --- | --- | --- |
| 1 | **Lord** | The human. Wills objectives into being, speaks only to the Regent, and is never asked a question — the court reports outcomes, never decisions to make. |
| 2 | **Regent** | The harness running in the throne itself. Relays the Lord's will downward and delegates everything; does no execution work. |
| 3 | **Alpha** | Spawned by the Regent, one per campaign. Plans, splits, assigns, monitors, and resolves every ambiguity itself. |
| 4 | **Shadow** | Spawned by an Alpha, one per slice. Executes its assigned slice. Routine questions go to its Alpha; genuine blockers go to the Regent. |

Each tier spawns only the tier directly below it (sole sanctioned exception:
the `/gap-analysis-model` skill's launcher Shadows spawn that run's pinned
second-tier campaign Alphas). Every spawned agent is a real
`herdr` harness with its own tab, context, and worktree — addressable by name,
watchable through `agent-logs` — never a subagent nested invisibly inside its
caller.

The tier titles, the address title, and the roleplay persona are display text
and are configurable (see [Persona config](#persona-config)). Agent-name
prefixes, ledger paths, and CLI command names are machine identifiers and are
not.

## Core concepts

**Campaign.** One objective, carried by one Alpha, accumulating on one branch
named for that Alpha. Every campaign agent carries a lowercase objective code
immediately after its role prefix (`alpha-<code>-…`, `shadow-<code>-…`); a
Shadow's full handle is derived from its Alpha by
`derive-shadow-name-from-alpha`, never hand-copied.

**Todo bundle.** An Alpha plans an objective into a folder of executable slice
files — `00_overview.md` (the objective, scope, invariants, and a `## Done
when` checklist), `NN_<task>.md` per slice, and the five terminal gate files
`99a`–`99e` — under its own `~/.throne/data/<alpha-name>/`. `/write-todos` authors the
bundle; `/execute-todos` runs it, spawning one Shadow per slice. Decisions a
slice cannot settle from the code are appended to a `000_current_questions.md`
log with a best-judgment default rather than halting the queue.

**The terminal gate chain.** A bundle ends in five fresh workers, each gated on
the previous one's explicit PASS: `99a` privately rehearses and then performs
one authoritative absorb of the current target into the assembled candidate
before judgment, `99b` decides whether the campaign caused a
file-size regression, `99c` runs linting and static analysis including
duplicate detection, `99d` grades the assembled result against `00_overview.md`
and emits one explicit `**Overview outcome:** PASS` or `FAIL`, and `99e`
re-absorbs advances since `99a` and delivers the accepted state to the target. The `99d` gate
runs in four tiers: a deterministic manifest of commands that always runs in
full (suite, typecheck, greps for forbidden patterns, citation re-derivation,
no-change proofs), one validator working the lens list selected by the bundle's
content class over what commands cannot judge, a re-gate scoped to the
corrective diff, and a depth that scales to the bundle's declared `gate_risk`.
Green slices do not imply a green bundle: a slice can satisfy its own
deliverable while the objective still misses a criterion no slice covered, or
an integration seam nothing tested. Catching that is the gate's job.

**Worktree isolation.** All coding happens in a git worktree, never in a live
checkout. Trees are created for a named target repo but placed under a
throne-owned home — `~/.throne/worktrees/<repo-basename>/<name>`, overridable
with `THRONE_WORKTREES_HOME` — so throne scaffolding never lands inside the repo
being worked on. An Alpha's tree bases on the target repo's current branch; a
campaign Shadow's tree bases on its Alpha's branch, so slices land in the Alpha
branch and the campaign reaches the target branch once, as one reviewable merge.
Heavy gitignored directories (`node_modules`, `.venv`, `target`) are
reflink-cloned into each tree rather than symlinked.

**The external ledger.** Mutable runtime state lives under `~/.throne/data/`,
with one directory per agent at `~/.throne/data/<name>/`. The repository's
runtime `data/` tree has been removed. Production code resolves this location
through `resolveRuntimeDataHome`; tests may set the
absolute `THRONE_DATA_HOME` override to isolate a temporary home. The ledger
records what the agents are doing, never the code they change, and survives a
reboot that kills every live process, which lets a booting Regent reconcile
in-flight work instead of reading an empty roster as a clean slate.

## Command surface

Everything concrete is a `throne-cli <command>`. Command spelling carries
authority: bare `throne-cli` means **the live court**, while
`./bin/throne-cli` means **this checkout**. Use the bare command for court
state, active-plan, and routing questions; use the relative command when
validating a candidate checkout or its self-update behavior. Both are correct
for their respective questions, so never tidy one spelling into the other
without checking which authority the caller needs. The
table covers all 32 commands; each is registered under `src/`, and
`./bin/throne-cli` with no argument prints the same list with fuller
descriptions.

### Agent lifecycle

| Command | Purpose |
| --- | --- |
| `create-agent` | Spawn a herdr harness for a new agent and seed its identity and chain of command into `~/.throne/data/<name>/`. |
| `derive-shadow-name-from-alpha` | Print the canonical Shadow handle for a slice under a named supervising Alpha. |
| `reap-agent` | Tear a named agent down: close its herdr tab, remove its worktree, and archive its `~/.throne/data/<name>/`. Requires an explicit `--reason`. |
| `complete-agent` | Reap a named agent only once its bundle reported complete; refuses a live or unfinished agent. |
| `send-agent` | Deliver one message into a named agent's composer without overwriting a resident human draft. |
| `agent-statuses` | Print a table of every herdr agent and its status, including registered agents whose process is gone. |
| `agent-logs` | Print a named agent's recent pane output. |
| `notify-lord` | Send one message to the Lord through the configured ntfy transport. |

### Regent and queue

| Command | Purpose |
| --- | --- |
| `keep-going` | Nudge the live Regent — or a `--name`d agent — and resurrect a dead Regent unless it has been dismissed. |
| `summon-regent` | Mark the Regent running and resurrect one now if none is live. |
| `dismiss-regent` | Mark the Regent dismissed and reap the live harness so the watchdog stops resurrecting it. |
| `throne-startup` | On session start, rename the throne's own top-level harness to Regent and arm its heartbeat timer. |
| `add-to-queue` | Add a new open item to the SQLite-backed Regent queue store. |
| `trim-queue` | Remove terminal (complete/abandoned) items from the Regent queue store; dry-run by default. |

### Worktrees

| Command | Purpose |
| --- | --- |
| `spawn-git-tree` | Create a git worktree for a target repo under `~/.throne/worktrees/`, based on whatever the tree's kind requires. |
| `merge-git-tree` | Merge a worktree's branch back into the target repo and branch recorded in its `tree-base.json`. |

### Host services

| Command | Purpose |
| --- | --- |
| `install-services` | Render and install the throne's own host service units for the current user. |
| `ensure-heartbeat` | Idempotently arm the `throne-keep-going` timer for the current user. |
| `assert-herdr` | Refuse to run unless the caller is inside a herdr session. |

### Telemetry

| Command | Purpose |
| --- | --- |
| `plan-usage-remaining` | Report Claude plan-usage % remaining per cap window, read-only from the on-disk OAuth credentials. |
| `codex-usage-remaining` | Report Codex plan-usage % remaining per cap window, read-only from `~/.codex/auth.json`. |
| `opencode-go-usage-remaining` | Report OpenCode Go usage % remaining per dashboard-declared rolling/weekly/monthly window; dashboard credentials are separate from inference API keys. |
| `usage-rate` | Report plan-usage burn rate (%/hour) per harness and cap window from the throne's usage log. |
| `agent-stats` | Report trailing-7-day stall rate and average completion by harness from the agent timing log. |
| `list-harnesses-and-models` | List the live active preset and role pools, the forward-versus-resume-only launcher policy, and model capability scores. |

Usage routing now treats projected remaining percentage at reset as the primary
signal whenever sufficient forecast history exists, with current remaining as
the explicit fallback when the forecast is insufficient. Because Claude is the
scarcer premium pool, a usage-routed Shadow goes to Claude only when Claude's
point projection leads Codex's by at least the inclusive
`CLAUDE_PROJECTION_LEAD_THRESHOLD_PCT`; smaller leads route to Codex. The local usage log
keeps eight days or 4,096 rows, and the sensor/cache boundary stays read-only:
the usage readers still use the on-disk OAuth credentials or `~/.codex/auth.json`
without writing them. Usage steering and its bounded-history reads are mandatory for every fresh spawn; pools, floors, availability, native quota, effort, and stored-resume contracts remain separate gates.

## Requirements

`./install.sh` satisfies everything in this list except bash and Node. It is
here so you know what the installer is doing on your behalf.

- **`herdr`** — the terminal workspace manager every harness runs under. Its
  runtime is selected by the durable `herdr-decouple` feature flag described
  below. OFF uses bare `herdr` from `PATH` and its implicit/default session. ON
  (what `install.sh` sets) uses the throne-owned pinned `v0.8.0` release,
  checksum-verified per artifact, and an isolated named `throne` session while
  allowing an unrelated default session to coexist.
- **Node and the compiled Nest runtime.** Run `npm run build` and execute
  `npm start -- <command>` (or `node ./dist/src/tools.js <command>`). The
  checked-in TypeScript remains convenient for development, but invoking
  `src/tools.ts` directly with Node does not apply this project's legacy
  decorator transform or emit runtime metadata and is not a production path.
- **An agent harness** — Claude Code or Codex, vendored into `./vendor/` at the
  version pinned in `vendor-pins.json` and launched through the throne's own
  yolo launchers. `bin/claude` and `bin/codex` are the human entrypoints: each
  pins the real binary to the vendored copy (so no global install can shadow
  it) and hands off to `bin/claudey` / `bin/codexy`, which do the yolo work.
- **`flock`** — the recipient-pane mutex shells out to it before every pane
  write. util-linux provides it on linux; macOS ships none, so `install.sh`
  installs the compatible `flock` brew formula there (2026-09-02: without
  it every delivery on the mac failed with `spawn flock ENOENT`).
- **A POSIX host with bash ≥ 4.3.** Both launcher entry scripts open
  `#!/usr/bin/env bash` and source a version guard before anything else.

No runtime dependencies: `package.json` lists only `devDependencies`
(`typescript`, `@types/node`), needed for `npm run typecheck` rather than to
run anything.

## Operator Runbook

The authoritative feature file is
`$XDG_CONFIG_HOME/throne/features.json`, falling back to
`~/.config/throne/features.json`. It is a strict JSON object:

```json
{"herdr-decouple": false}
```

`herdr-decouple` must be a JSON boolean; unknown keys and non-booleans are
rejected. An absent file or absent key defaults OFF.

- **OFF (default):** throne runtime calls bare `herdr` through `PATH` with no
  session selector, preserving the legacy implicit/default-session behavior.
  `install-services` still installs unrelated hooks and services, but does not
  acquire or verify the pinned client, install the public `throne` attach seam,
  install or control the decoupled Herdr service, or claim named-session
  isolation.
- **ON:** throne verifies and uses the owned v0.7.5 client, explicitly targets
  the isolated `throne` session, exposes the public `throne` PATH attach seam,
  and includes the decoupled Herdr service in `install-services`. The default
  session remains available for unrelated work.

Writing either value only changes what the next throne process selects. It
never touches, stops, starts, reloads, or restarts a live server. Enabling,
disabling, and service handoff are separate operator actions; perform any
handoff explicitly between agent runs.

```bash
./bin/throne-cli assert-herdr    # preflight: refuses outside a herdr session
./bin/throne-cli install-services [--offline] [--dry-run]
throne --help                       # show the fixed named-session contract
throne                              # attach to the throne-managed named session
```

### Automatic CLI builds

`throne-build.service` is retired (BCL campaign, 2026-08-14): a separate
build watcher meant "built" and "running" could silently diverge, which is
exactly what cost the court real messages when `throne-backend` sat on a
stale build for hours. Its job is now `throne-backend`'s own
`SelfRebuildHostedWorker` (`src/throne-backend/self-rebuild.hosted-worker.ts`):
when the checkout's source settles after a change, it rebuilds via the same
atomic `scripts/build-and-publish-dist.mjs` publish (staging dir + `rename(2)`
symlink swap — a failed build never touches the running `dist`), and restarts
`throne-backend` itself ONLY once that build succeeds and it is safe to do so
(the instance has proven stable, and no BullMQ delivery is queued or
in-flight). `install-services` retires a pre-collapse `throne-build.service`
found already installed rather than installing it again. The canonical
`./bin/throne-cli` wrapper executes the emitted `dist/src/tools.js` entrypoint.

Compile-success is not runtime-success: a rebuilt generation can still crash
or never reach `READY=1`. `throne-backend.service`'s `ExecStartPre=`
(`scripts/throne-backend-rollback-guard.mjs`) runs before every single start
attempt, including every iteration of a crash loop, and atomically rolls
`dist` back to the last generation that DID reach readiness once a
generation has already failed to do so — see
`src/throne-backend/generation-readiness-marker.ts` for the state machine
and `src/throne-backend/rollback-guard-real-systemd.spec.ts` for the
acceptance proof against a real systemd unit.

With `herdr-decouple` ON, `install-services` owns the pinned herdr client and
decoupled service for the current user. The authoritative release is currently
`v0.7.5`:

- Owned binary: `~/.local/share/throne/herdr/v0.7.5/herdr`
- Cache root: `~/.cache/throne/herdr`
- Linux units: `systemd/`
- macOS LaunchAgents: `launchd/`
- Session hook: `.codex/hooks.json.template` rendered to `.codex/hooks.json`
- User PATH command: `~/bin/throne` and `~/.local/bin/throne`, both pointed at `bin/throne` — bare `throne` with no arguments opens/attaches the herdr session, `throne <subcommand>` forwards straight through to the CLI

When ON, the installer first verifies or installs the owned herdr release and
public attach seam. In both states it renders the checkout-local Codex hook and
installs unrelated host services; while OFF it leaves every existing pinned
client, public seam, and Herdr service artifact and runtime state untouched.
Sources carry
`{{THRONE_ROOT}}` / `{{HERDR_BIN}}` substitution tokens rather than machine
paths, and any rendered file that still contains a token is refused. The
installer is idempotent and failure-preserving: a checksum mismatch, version
mismatch, missing cached artifact, or other install failure leaves the prior
verified binary in place and reports the error instead of half-installing a
replacement.

`--offline` uses only a verified cache hit under the cache root above. That mode
never downloads; when no verified artifact exists it fails loudly and leaves the
previous binary untouched. `--dry-run` prints the render/install plan and writes
nothing. Supported targets are the four release artifacts derived by HEAD:
`linux-aarch64`, `linux-x86_64`, `macos-aarch64`, and `macos-x86_64`.

When ON, the installed `throne` PATH command is a thin attach command over the
owned binary. Its internal dispatcher name is `attach-throne-herdr`; that is not
a second public command. In this mode, `throne --help` advertises the
named-session contract, not a generic attach surface, and the command resolves
the repository-owned executable directly. The command is fixed to the `throne` session, refuses
selector arguments that could target another session, and fails before any
attach when the running herdr evidence is missing or points at the default
session instead of the isolated `/sessions/throne/` socket. The default herdr
session may still exist for unrelated use; throne neither attaches to it nor
mutates it.

Changing the flag itself performs no installation and no service-manager
operation. During an explicit ON-state `install-services`, changed live units
are reported, not restarted. If an installed unit's content
changes while that unit is already running, the installer prints the changed
basename and leaves the live process alone. The handoff point is explicit: apply
the new bytes between agent runs, then restart or reattach deliberately. For
herdr-server that means a planned stop/start by the operator, because a reload or
restart drops every live agent pane.

### Repair the current pin

This procedure requires `herdr-decouple` ON. Re-running `install-services`,
online or with `--offline`, can only verify and
repair the authoritative v0.7.5 declaration. It can reuse the current verified
owned binary or the checked v0.7.5 cache entry; it has no release selector and
cannot roll back to an older release.

### Roll back to a retained prior release

Rollback is a bounded emergency procedure, separate from the installer. It
requires the prior owned binary to have been explicitly retained and its
SHA-256 to match the trusted digest published for that release. The following
POSIX shell procedure selects the v0.7.4 digest for the current supported
target, verifies both the retained source and staged replacement report v0.7.4,
preserves the displaced/current v0.7.5 binary with a timestamp, and commits by
same-directory rename at the owned active path:

```sh
set -eu

ROLLBACK_VERSION=0.7.4
ACTIVE="$HOME/.local/share/throne/herdr/v0.7.5/herdr"
RETAINED="$HOME/.local/share/throne/herdr/v0.7.4/herdr"

case "$(uname -s):$(uname -m)" in
  Linux:aarch64) EXPECTED_SHA256=544e0002de42806d1ab64ccdef3a7e7414f24717b0b6b022bc9e57d2eefd26a2 ;;
  Linux:x86_64) EXPECTED_SHA256=bc0fc02d4ba500f9cac2353a43e67fe036785ecca6eb55378e050fac3c103059 ;;
  Darwin:arm64) EXPECTED_SHA256=24992e1625dbdcb18354a59e299e4b263c312400b31396cdc07cd46ed57f24a7 ;;
  Darwin:x86_64) EXPECTED_SHA256=ddf430133352e1712413d5d865b34a485546f4658893fc89986257d65a7585a8 ;;
  *) echo "unsupported rollback target: $(uname -s):$(uname -m)" >&2; exit 1 ;;
esac

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo "need sha256sum or shasum" >&2
    return 1
  fi
}

[ -x "$RETAINED" ]
[ "$(sha256_file "$RETAINED")" = "$EXPECTED_SHA256" ]
[ "$("$RETAINED" --version)" = "herdr $ROLLBACK_VERSION" ]

BACKUP="$ACTIVE.failed-$(date -u +%Y%m%dT%H%M%SZ)"
STAGED=$(mktemp "$ACTIVE.rollback.XXXXXX")
trap 'rm -f "$STAGED"' EXIT HUP INT TERM
ACTIVE_SHA256=$(sha256_file "$ACTIVE")
cp -p "$ACTIVE" "$BACKUP"
[ "$(sha256_file "$BACKUP")" = "$ACTIVE_SHA256" ]
cp "$RETAINED" "$STAGED"
chmod 755 "$STAGED"
[ "$(sha256_file "$STAGED")" = "$EXPECTED_SHA256" ]
[ "$("$STAGED" --version)" = "herdr $ROLLBACK_VERSION" ]
mv -f "$STAGED" "$ACTIVE"
trap - EXIT HUP INT TERM
printf 'installed herdr %s; displaced binary retained at %s\n' "$ROLLBACK_VERSION" "$BACKUP"
```

Do not perform the handoff while any agent run is active: changing the server
drops every live pane. After the copy succeeds and between runs, explicitly
stop and then start the one owned server service; these are deliberately
separate operator actions, never an installer-triggered live restart.

Linux:

```sh
systemctl --user stop herdr-server.service
systemctl --user start herdr-server.service
```

macOS (procedure documented from the rendered plist and tested dry-run branch,
not from a live macOS host):

```sh
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.throne.herdr-server.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.throne.herdr-server.plist"
```

This binary rollback does not rewrite the repository's authoritative v0.7.5
declaration. Its exact-version preflight will therefore refuse normal throne
mutations until the operator either restores the preserved v0.7.5 binary at
`$ACTIVE` by the same verified staging procedure or deliberately checks out and
reviews a repository revision whose declaration supports the older release.
Neither path touches the unrelated default herdr session.

The linux path runs live on the development host. The mac branch is verified by
dependency-injected tests and `--dry-run`; no real macOS host exists in this
project, so the README makes no claim of live launchd evidence.

### Future harness updates

The throne-local `update-harnesses` skill manages local Claude Code and
Codex CLI artifacts only when the strict `harness-decouple` feature flag is
explicitly `true`. The skill lives once under
`throne/.claude/skills/update-harnesses`, beside the other throne-local skills,
and Claude Code discovers it natively from a throne cwd — live root or
worktree. It is not in the global skill tree, so it no longer surfaces in
repositories where it could never run. There is no Codex-only copy.

Absent or false `harness-decouple` is OFF: `check`, `update`, and `rollback`
exit before release discovery, download, staging, evidence creation, or managed
path mutation. ON gives the throne ownership of the managed local CLI
artifacts. From the skill directory, the operator runs its
`scripts/update-harness.mjs` once per harness:

```sh
node scripts/update-harness.mjs check --harness claude --throne-root /path/to/throne
node scripts/update-harness.mjs update --harness claude --throne-root /path/to/throne
node scripts/update-harness.mjs rollback --harness claude --throne-root /path/to/throne
```

Use `--harness codex` for Codex. `check` performs authoritative release
discovery without promotion; `update` verifies provenance and integrity, stages
outside active paths, runs non-destructive CLI/auth/session/remote and
launcher/create-agent/resume probes, then atomically promotes; `rollback`
atomically swaps the retained current and previous releases without registry
access. Run one harness transaction at a time. The default evidence records are
mode `0600` JSON files under
`~/.local/share/throne/harnesses/evidence/`; `--managed-root` and `--evidence`
provide isolated paths for dry runs and tests.

Herdr is never acquired, stopped, restarted, attached to, or otherwise touched
by this workflow. Evidence reports it as eligible for separate planning only
when both `harness-decouple` and `herdr-decouple` are true, via
`shouldOwnHarnessUpdates()` and `shouldUpdateHerdrInHarnessUpdate()`. A feature
flag transition is not permission to hand off a live server. Evidence records
the old and new local CLI versions and provenance; it does not freeze hosted
services or model behavior, which remain mutable independently of these local
artifacts.

Installed alongside is the **keep-going heartbeat**, which runs `keep-going` on
a schedule: it reads the Regent's desired state, nudges the live Regent to work
its queue, and resurrects one if none is live and it has not been dismissed. On
linux this is a systemd timer at `OnBootSec=5min` / `OnUnitActiveSec=30min`; on
mac, launchd documents no timer object separate from a job, so the pair becomes
a single `StartInterval` agent. Scheduling belongs to the host service manager
rather than any harness's own cron so it survives whichever agent is driving.
The heartbeat slows under quota pressure and never stops entirely.

A throne harness also self-configures at launch: a SessionStart hook runs
`throne-startup`, which renames the unnamed top-level harness to Regent and arms
the heartbeat, so no `systemctl --user enable --now` is run by hand. The Codex
hook registration is a machine-rendered artifact: `install-services` renders the
gitignored `.codex/hooks.json` from the committed `.codex/hooks.json.template`.
The Claude one is the tracked `.claude/settings.json` in this folder; its hook
runs the installed global `throne-cli` (`~/.local/bin` or `~/bin`, planted by
`install-services`) so a worktree checkout never tries to build its own
`dist/` inside the hook's 10-second budget, falling back to the checkout's
own `bin/throne-cli` only when nothing is installed yet. Service activation is intentionally
non-destructive: installing the units does not restart a live court, and an
operator must hand off or restart explicitly between agent runs when applying a
changed server unit.

Verification from the throne root:

```bash
npm run typecheck
npm test
```

## Two-mode design

The throne always layers on whatever global agent config the operating human
has. It is designed for two modes:

- **Global** — the machine already carries an extensive `~/.claude` (or
  `~/.codex`) of personal instructions. The throne adds to it and defers to it.
- **Local** — the machine carries a stock, near-empty global config. The throne
  still runs, supplying its own conventions.

The intent is that the throne requires neither the creator's global config nor
clobbers anyone else's. The split it draws is between **competence** and
**taste**: engineering discipline that any operator would want — coding
principles, the memory/learning system that records corrections so they are not
repeated — belongs to the throne folder and travels with it; personal taste —
communication style, tool preferences, machine-specific conventions — stays in
each operator's own global config and is never overwritten.

**Current state, measured.** The competence half of that split now lives inside
the folder: the memory/learning tree is a real, git-tracked directory at
`agent_docs/MEMORY`, and throne-local copies of the coding masterplan
and coding-principles documents sit in `agent_docs/`, byte-compared against the
global originals by a drift test whenever those originals are present.
`agent_docs/standalone-extraction-audit.md` is the audit that found the earlier
gaps; its §4 records the executed fix for each, with the proof.

**Portability status.** A clean extraction is verified: a scratch clone built
from this folder's own history — the repo root being the throne itself, under a
stock `$HOME` with no surrounding parent repository — passed `npm run typecheck` and
the full test suite with exit 0, rendered its service units and the Codex hook
token-free from `install-services --dry-run`, and passed the suite's
create-agent spawn-path canary
(`agent_docs/standalone-extraction-audit.md` §4, step 10). No one-command
standalone install is claimed here. What still resolves outside the folder does
so deliberately — host and provider facts, machine-wide launcher conventions —
each kept coupling inventoried with its reason in
`agent_docs/global-decoupling.md`.

## Persona config

Display text — how agents address the human, what the three tiers are called in
prose, and the roleplay paragraph seeded into every new agent's identity — is
layered config.

The committed defaults in `src/application-config.service.ts` are deliberately generic, so a
fresh clone with no override speaks a neutral court. An optional `config.user.ts`
at the throne root supplies a partial override; copy `config.user.example.ts` and
edit it. That file is gitignored, so local flavour never reaches the committed
tree.

Overrides are merged per key, so setting one tier title leaves the others alone.
An absent override file is silent. An invalid one — unknown key, non-string
value, empty string — throws at load time naming the file and the offending
field, because an override that quietly does nothing is worse than a loud
failure.

The override is resolved from the module's own location rather than the process
working directory. Because it is untracked, campaign worktrees do not carry it
and resolve the generic defaults; only the live throne root speaks the
configured persona.

Machine identifiers — agent-name prefixes, plan roles, CLI command names, herdr
registry names, and ledger paths — are deliberately outside this config.
Renaming any of them is a breaking change to existing agent registrations,
in-flight ledgers, and the cross-references between them, so no config field
offers it.

## Skills

Throne-only skills live under `.claude/skills/` and are discovered by the
harness of whichever agent is seated in the live throne. Each refuses outside
the live throne root; the "who" column is the role that may invoke it.

| skill | who | what |
|---|---|---|
| `/write-todos` (aliases `/create-todos`, `/make-todos`, `/plan-todos`, `/draft-todos`) | Alpha | plan an objective into a `todo-<iso-timestamp>-<topic>/` bundle of executable todo files |
| `/execute-todos` (aliases `/run-todos`, `/do-todos`, `/process-todos`) | Alpha | execute a todo bundle, one real Shadow per slice, through the terminal 99 gates |
| `/write-and-execute-todos` (aliases `/plan-and-run-todos`, `/do-all-todos`) | Alpha | chain the two above with no human checkpoint between planning and execution |
| `/plan-task-split` | Alpha | shape large work as a STAR of independently testable spokes around a wiring core, before the bundle is written |
| `/review-loop` | Alpha | bounded reviewer/fixer loop against a named target and reviewer model; every reviewer and fixer is requested from the Regent |
| `/gap-analysis-model` | Alpha | one pinned nested campaign per compared harness/model pair, distilled into per-model capability guidance |
| `/no-alpha` (alias `/na`) | Regent or Stager | do the Lord's scoped task directly in the invoking session, after a mandatory scope confirmation, without spawning an Alpha |
| `/usage` | Regent or Stager | quota dashboard: limits, remaining, burn rate, reset times, projected percentage at reset |
| `/switch-campaign-model [model]` | Stager only | move Alpha, Shadow, and ShadowSlice99 onto one model (default `sonnet`) by rewriting `steering` in the gitignored `config.user.ts`; the Stager's own `claude/opus` pin is untouched |

## Publishing to the public mirror

`./publish.sh` snapshots the tracked tree of this checkout into
`~/repos/throne-public` (override with `--target`) as **one** squashed commit,
"Pushing changes from private repo", on a fresh `publish/<utc-stamp>` branch —
private history never crosses. Only `git ls-files` content is copied, so nothing
gitignored (`config.user.ts`, ledgers, worktrees, `dist*`, `vendor/`) can leak;
`publish.sh` and its rule file are excluded by name. Every rule in the
gitignored `publish-scrub.sed` (copy `publish-scrub.sed.example`) is applied
to every text file, then every `# verify:` pattern in that file is grepped over
the result; a single surviving hit aborts before anything is written. It never
pushes — review `git -C ~/repos/throne-public show --stat`, then push yourself.
`--dry-run` stages and verifies without touching the target; `--include-dirty`
publishes the working tree instead of `HEAD`.

The two repos share no history, so correspondence is one tracked file,
`current_public_commit.txt` (never published): the public commit this tree
corresponds to. `publish.sh` writes the commit it created there and commits
that; `./import-from-public.sh` writes the public `main` it imported.
`publish.sh` refuses unless public `main` is the recorded commit or an ancestor
of it (an unmerged publish branch) — anything else is a public-side change (a
merged contribution, a non-fast-forward merge) that a fresh snapshot would
silently overwrite. `import-from-public.sh` applies the diff of public `main`
since the recorded commit (`git apply --3way`, then `--reject`) and commits it
with the updated file; on any rejected hunk it records nothing and leaves
`.rej` files plus the patch for manual resolution, after which
`--mark-only <hash>` records the hash.

## Layout

```
throne/
├── AGENTS.md              # the operating law: roles, hard rules, command surface
├── README.md              # this file
├── config.user.example.ts # template for the gitignored persona override
├── agent_docs/            # architecture, commands, launchers, skills, model policy,
│                          #   global-decoupling and standalone-extraction audits
├── src/
│   ├── tools.ts           # CLI entry: dispatch argv[2] through Nest
│   ├── herdr.ts           # legacy Herdr subprocess boundary; migrated Nest routes own their queries
│   ├── gittree/            # shared Git runner, placement, worktree, and branch lifecycle helpers
│   ├── personaconfig.ts   # committed persona defaults + config.user.ts layering
│   └── src/    # Nest-owned command registration and implementations
├── bin/                   # the throne's own yolo launchers (claudey, codexy)
├── systemd/               # linux unit sources, tokenized
├── launchd/               # mac LaunchAgent sources, tokenized
├── test/                  # node --test suite over the TypeScript sources
└── .claude/skills/        # throne-only skills — see "Skills" above
```

The ledger and worktrees are not in this tree. They live under
`~/.throne/data/` and `~/.throne/worktrees/`, outside every repository.
