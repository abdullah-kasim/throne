# Throne architecture

The throne is an **agent-agnostic orchestrator**: a thin, typed CLI over `herdr`
plus systemd-scheduled background nudges. The hierarchy (Lord → Regent → Alpha
→ Shadows) is defined in `AGENTS.md`; this file covers the machinery.

## Language + runtime

- **TypeScript, run directly by Node** (`./bin/throne-cli <command>`). Node
  v24 strips types natively — there is **no build step and no `tsx`**.
- Type-stripping only _erases_ types; it does not _transform_. So **no `enum`,
  no `namespace`, no parameter-properties, no decorators** — they need a real
  compiler. Use `const` objects + union types instead of enums.

## Layout (target)

```
throne/
├── AGENTS.md                 # the court: roles, rules, command surface
├── CLAUDE.md                 # redirect to AGENTS.md
├── package.json              # "type": "module"; scripts are thin wrappers
├── tsconfig.json             # editor/typecheck only (not a build)
├── agent_docs/
│   └── architecture.md       # this file
├── src/
│   ├── tools.ts              # CLI entry: parse argv[2] → dispatch subcommand
│   ├── herdr/                # responsibility-owned typed Herdr modules (JSON I/O)
│   ├── src/codex-screen/  # versioned Codex pane evidence adapter
│   ├── src/shared-policy/recipient-pane-lock.service.ts  # per-pane kernel exclusion across submit processes
│   ├── harness.ts            # (harness, model, effort) → launch argv mapping
│   ├── config.ts             # declarative active-plan presets + role pools
│   ├── harnessrouting/        # usage, capability, admission, and steering policy
│   ├── src/create-agent/native-availability.ts # exact Fable/Opus quota interpretation
│   ├── gittree/              # git runner, placement, worktree, and branch lifecycle helpers
│   ├── src/agentdata/  # Nest-owned durable agent-data services
│   └── commands/
│       ├── assert-herdr.ts
│       ├── agent-statuses.ts
│       ├── agent-logs.ts
│       ├── send-agent.ts
│       ├── create-agent.ts
│       ├── reap-agent.ts
│       ├── complete-agent.ts
│       ├── spawn-git-tree.ts
│       ├── merge-git-tree.ts
│       └── keep-going.ts
├── systemd/                  # linux unit sources, tokenized (throne-herdr, throne-backend, ntfy, sweep timers)
├── launchd/                  # mac LaunchAgent sources, tokenized (throne-herdr, throne-backend, ntfy)
└── data/                     # gitignored: per-agent persistent data
    └── <agent-name>/         #   todos (<todo-name>/), identity, notes, scratch
```

Worktrees are NOT part of this tree — they live outside the repo entirely, under
a throne-owned `~/.throne/worktrees/` home (see "Git worktrees" below).

## Managed harness ownership

Claude Code and Codex CLI updates use the one throne-local skill at
`throne/.claude/skills/update-harnesses`, discovered natively from a throne cwd
alongside the todo skills; the architecture has no harness-specific skill copy
or discovery overlay.

The strict feature loader is the ownership boundary. Missing or false
`harness-decouple` leaves PATH/system harnesses entirely outside throne
control, so every updater action exits before discovery or filesystem effects.
When explicitly true, each local harness transaction proceeds serially through
authoritative discovery, package and integrity verification, isolated staging,
non-destructive CLI and throne-contract probes, and atomic promotion with the
previous artifact retained for rollback. Mode `0600` JSON evidence records
local old/new CLI versions, provenance, probes, and promotion/rollback paths.
Hosted services and model behavior remain mutable outside that local evidence.

The probe boundary uses staged binary overrides and hermetic launcher,
create-agent, and stored-resume tests. It does not authenticate, resume a live
session, attach to Herdr, or mutate a remote. Herdr is only reported as eligible
for separate planning when `shouldOwnHarnessUpdates()` and
`shouldUpdateHerdrInHarnessUpdate()` are both true; the updater has no live
Herdr operation or restart path.

## The herdr contract

`herdr` is the terminal workspace manager every harness runs under. Legacy
commands shell out to it through the responsibility-owned modules under
`src/`. Nest-owned capabilities keep their current-pane and agent-list
queries in their respective domains.
Its durable mode comes from `$XDG_CONFIG_HOME/throne/features.json` (fallback
`~/.config/throne/features.json`), whose strict JSON boolean
`{"herdr-decouple": true|false}` defaults OFF when absent. OFF preserves legacy
bare-PATH Herdr and its implicit/default session. ON selects the verified owned
client and isolated named `throne` session. Changing the flag never touches a
live server; service handoff is a separate operator action.

- **List/status:** `herdr agent list` returns JSON
  (`{result:{agents:[{agent, agent_status, cwd, focused, pane_id, terminal_id,
...}]}}`). `agent_status` is one of `idle|working|blocked|done|unknown`.
- **Addressing is by name.** Agents default to the label `agent` (e.g. every
  claude shows as `claude`), so the wrapper must resolve a caller-supplied
  **unique name** (set at spawn via `herdr agent start <name>` or later via
  `herdr agent rename <target> <name>`) to a single agent, and **fail loudly**
  if zero or >1 match. This is the backbone of the reliability rule.
- **Read (logs):** `herdr agent read <target> [--source visible|recent|
recent-unwrapped] [--lines N] [--format text|ansi]` returns a JSON envelope
  (`{result:{read:{text}}}`); the wrapper extracts `.result.read.text` so
  `agent-logs` prints readable pane text, never the raw envelope. Alphas use it
  only for one completion review, an explicit blocker, or silence beyond the
  30-minute Regent heartbeat interval; Regents retain diagnostic use.
- **Send:** delivery is the platform primitive — `herdr agent prompt <target>
<text> --wait --until <state> --timeout <ms>` — which owns the write, the
  Enter, and its own queue semantics (a non-working start must first observe a
  state change within 5s else `agent_prompt_stalled`; it then matches
  `idle`/`done`/`blocked` by default or any exact `--until` state).
  `submitToAgent(agent, senderName, prompt, {omitSenderAttribution,
forceFileBackedDelivery, promptWaitTimeoutMilliseconds,
onDeliveredWhileLocked})` is the thin throne wrapper around that primitive,
  and both `send-agent` and `keep-going` route through it. It formats exactly
  `<sender-name> said: <prompt>` and delivers that logical body to the resolved
  recipient through the platform call.

  `filebackeddelivery.ts` splits transport at 4096 UTF-8 bytes. The classification
  judges the exact attributed logical body. A large body is staged byte-identical
  in a unique owner-only file under `~/.throne/payloads/`; only a comfortably
  sub-threshold pointer enters the platform prompt. Staging remains
  after recipient identity refresh and inside the pane lock. Immediately before
  writing, `stagePayload` launches (but never awaits) an opportunistic TTL reap;
  the rejection path reports through stderr and cannot alter the send outcome.
  Smaller bodies use the direct route unchanged.

  The pointer is one line: `Large message — read then delete: node
<JSON-quoted tools.ts path> read-payload <JSON-quoted payload path>`.
  `consumePayload` validates the owned path, awaits a complete Buffer read, and
  only then removes the file. Its discriminated outcomes separate success,
  missing-at-read, unreadable, cleanup failure, and invalid path. The command
  publishes the exact body only after cleanup succeeds and emits a SHA-512
  receipt over the recovered bytes, enabling recipient-side canary proof
  without echoing 51KB through another composer.

  The exported `submitToAgent` boundary owns cross-process exclusion before it
  invokes the platform prompt. `recipient-pane-lock.service.ts` hashes the initially resolved
  pane id with SHA-256, opens the resulting stable `.lock` file under the
  user-private `~/.throne/locks/recipient-panes/` directory, and passes that
  descriptor to a short util-linux `flock --exclusive 3` helper. The Node
  process retains the same open file description after the helper exits, so the
  kernel lock remains held until its `finally` closes the descriptor. Tests may
  isolate this directory with `THRONE_RECIPIENT_LOCK_DIR` or inject the lock
  dependencies. The directory is mode `0700` and each file is mode `0600`.

  The file path is stable and file existence conveys no ownership. Release,
  suspected staleness, and recovery never unlink, rename, replace, or reclaim
  it. Process exit, signal death, crash, and reboot close descriptors and release
  kernel ownership without a PID/mtime lease; retaining the inode prevents two
  contenders from locking different files for one pane. Same-pane processes
  wait, while distinct pane hashes remain independent.

  After acquisition, `submitToAgent` re-resolves the original unique recipient
  name and requires the same name, pane id, terminal id, and harness before any
  read or delivery effect. Acquisition and identity failures are typed not-sent.
  The critical section then spans the draft-protection read, file staging when
  applicable, the platform prompt call, and the delivered receipt.
  Background/systemd `keep-going` cannot bypass the seam. Cleanup failure never
  replaces an already confirmed or typed callback outcome.

  The one throne-side pane read in the critical section is the draft-protection
  gate: because the platform writes straight into the composer and presses
  Enter, a resident draft would be merged into and submitted with the sent text.
  The throne reads the recipient's composer once (`observeSupportedScreen` over
  the shared `inspectSupportedAgentScreen` classification, with the pane's
  foreground harness authority checked) and refuses typed not-sent — before the
  platform call — unless the composer is provably empty. A read failure, an
  unrecognized harness, a covered/dialog composer, or any non-empty composer
  all refuse. A human mid-sentence outranks every agent in the court; agent
  traffic never types into or submits his draft.

  The platform's typed outcomes map to the throne's verdict contract
  (`classifyAgentPromptExecution`). A platform refusal before any write
  (`agent_not_found`, `agent_not_ready`, `empty_agent_prompt`,
  `agent_prompt_failed`, or a command that never ran) is typed not-sent,
  surfaced as `SubmitNotSentError` with the original cause; the identical call
  is retry-safe. A settled recipient state (`idle`/`done`/`blocked`) is typed
  delivered/queued evidence and the function returns normally. `agent_prompt_stalled`,
  `timeout`, `agent_not_running`, an unknown error code, or a succeeded-but-
  unparseable command is typed `SubmitIndeterminateError`: text was written and
  may still be pending, so text is never resent. Receiver transcript and
  acknowledgement remain useful post-hoc outcome evidence, but they never
  upgrade an indeterminate verdict. The settled-state wait is bounded by the
  throne's `HERDR_PROMPT_SETTLED_TIMEOUT_MS` default, overridable per call.

- **Spawn:** each agent opens in its OWN new tab (piling agents into one tab as
  panes does not scale). `herdr agent start` can only target an EXISTING `--tab`,
  so `startAgent` creates the tab first — `herdr tab create --label <name>
--no-focus` (→ `{result:{tab:{tab_id}, root_pane:{pane_id}}}`) — then `herdr
agent start <name> --tab <tab_id> -- <argv>`, and trims the idle root pane
  `tab create` opens (`herdr pane close`, guarded so it never closes the agent's
  own pane, best-effort so a trim failure never fails the spawn). `create-agent`
  derives the agent's **name** from the supplied role: `lowercase(role)+'-'`
  (e.g. `Shadow` → `shadow-`, `Alpha` → `alpha-`, default `Agent` → `agent-`),
  applied idempotently (no double-prefix if `--name` already starts with the
  prefix), with blank role or case-insensitive `none` leaving the name unchanged.
  For a campaign Alpha or Shadow, that role prefix is only the outer naming
  shape: the canonical objective code must also appear immediately after it.
  The derived name is THE addressable handle: used everywhere in the registry,
  identity, spawn spec, and `send-agent`. The herdr tab label is simply the name
  (`startAgent` passes the name straight to `createTab`; there is no separate
  tab-label option). `argv` is the
  harness launch command with model/effort flags derived by `harness.ts` (whose
  `resolveModel` validates/aliases the model slug, e.g. `opus-4.8`→`opus`,
  **before** spawning so an invalid `--model` fails loudly here, not silently
  inside a launched harness), and nothing else. The complete composed opening
  instructions — the identity sentence, then an `Alpha` standing instruction to
  run `/write-and-execute-todos`, then any `--prompt` objective brief — are
  validated before persistence. `tree-sitter` with the maintained
  `tree-sitter-bash` grammar supplies synchronous Bash AST structure; a small
  local semantic layer performs static quote removal, escape normalization,
  assignment skipping, and `env`/`command`/`builtin` wrapper resolution. Alpha
  text containing a loop whose executed command graph combines a timer with
  `agent-logs` or `agent-statuses` is refused, including nested groups,
  subshells, pipelines, background lists, and heredoc-adjacent commands.
  One-shot diagnostics, quoted/comment/heredoc data, and loops missing either
  conjunct remain outside the predicate. The deprecated `mvdan-sh` package and
  stale `bash-parser` were rejected; `sh-syntax` is maintained but asynchronous,
  which would unnecessarily change the synchronous prompt-composition and
  registration contract.
  Accepted instructions are persisted before launch in
  `~/.throne/data/<name>/opening-prompt.md`. Native Claude and
  resident custom harnesses receive that complete body after launch through
  `deliverOpeningPrompt`. Native Codex receives a compact bootstrap naming the
  exact absolute opening-record and authoritative identity-record paths; it must
  read both before acting. The shorter transport payload stays completely
  observable, while the durable record retains every omitted byte.
  Enqueuing that prompt is not proof it landed: for a genuine resident launch
  carrying a caller-supplied `--prompt` on the Claude harness,
  `deliverAgentOpeningPrompt` (`src/create-agent/opening-prompt.ts`) awaits a
  bounded, transcript-evidence-backed confirmation
  (`awaitSpawnTaskingConfirmation`, `src/session/runtime-model-acceptance.ts`)
  before deriving the typed `SpawnTaskingOutcome` it reports alongside the
  unchanged spawn success line — see `agent_docs/commands.md`'s `create-agent`
  section for the outcome values and evidence-file layout.
- **Presence check:** the migrated `assert-herdr` route runs `herdr pane current`
  through its Nest-owned capability. Client success confirms a live herdr
  session; any failure denies presence. Legacy presence helpers retain the same
  current-pane contract under `src/`.

## Active-plan admission, routing, and native quota gates

Native Claude uses `claudey`; fresh Codex-family agents use
`codexy-all-omni`. Routing and steering may still express the logical `codex`
harness, but the final pre-effect policy boundary converts every fresh native
Codex outcome to the Omni harness — there is no `--bypass-harness` flag to
opt out. Historical
stored native `codex` recipes fail closed before trust, durable writes, tab
creation, or launch and remain byte-identical migration evidence. Explicit
configured non-native alternates remain available. Unknown slugs refuse before
anything launches.

### Declarative active plan (`config.ts`)

`config.ts` owns the forward-launch `(harness, model)` pairs and five role-pool
presets. Capability and usage metrics select among the rows admitted by the
active pool; harness routing remains an independent execution concern. Inspect
bare `throne-cli list-harnesses-and-models --json` for the live court's active preset and
its current role pools. Legacy Claude/GPT rows are deliberately absent from
every pool.

After argument/model/name validation and durable registration reconciliation,
`create-agent` classifies only a genuinely new spawn as `Alpha`, `Shadow`, or
`ShadowSlice99`. For a campaign Shadow, the classifier uses its validated
objective evidence to locate the slice token; an objective code of `99` therefore
does not make an ordinary `shadow-99-01-...` worker look like slice 99. Its exact
requested pair must be in that role's immutable pool before capability or usage
filters run.
Every router candidate and remapped pair is selected from that same pool, and a
final defense checks the exact resolved pair again. An excluded explicit pair
refuses instead of being silently substituted. Ad-hoc roles admitted through
`--bypass-preset-agent` receive no `PlanRole`, so they skip plan membership but
not later launch gates; no flag bypasses plan membership for Alpha or Shadow.
No role-specific post-admission rewrite exists: declarative pool membership
and the ordinary later filters are the complete policy.

### The steering engine (`harnessrouting/steering.ts`)

Every model, usage, and effort steer for a fresh spawn — and every steering
message — lives behind one entry point, `steerSpawn`. It is pure: the caller
injects both harnesses' usage telemetry and the supervising Alpha's pair, and the engine
returns a launch (pair, effort, note, plus structured `desperation` and
`effortOverrideNote` markers, and durable exceptional routing evidence) or a refusal naming the steer, the compliant
spawn, and its bypass flag. `create-agent` is a thin caller holding no steer
logic of its own; the four steer families it composes (Alpha allowed-set +
capability balance + usage redirect, the metric-selected `99` gate,
the execution-shadow reserve + usage balance, and the all-pairs fresh-effort
default via `resolveFreshEffort`) are documented as the routing law in
`agent_docs/MODEL_POLICY.md`. Floors (`thinkingRoleCapabilityGuard`) and pool
admission stay OUTSIDE the engine, as gates the caller runs regardless of any
steer bypass. The retired `fableBalanceSpawnGuard` and its edge constant were
deleted when the engine absorbed the routing law; usage-driven preference is now
a steer with a bypass, not a standalone refusal guard.

**Native Codex is not a runnable agent harness.** Logical Codex routes remain
normal steering inputs, then the final policy boundary selects
`codexy-all-omni`. There is no `--bypass-harness` flag to restore native
`codex`. Non-native exact resumes remain exact; historical native recipes refuse without mutation.
`pickShadowHarness` first derives
the admitted harnesses from the active role pool, then compares only those
telemetry readings. A healthier excluded harness cannot influence selection,
signal health, or exhaustion. If both admitted harnesses are usable, Claude wins only when its projected
remaining at reset — current remaining when sufficient forecasts are
unavailable — leads Codex's by at least the inclusive
`CLAUDE_PROJECTION_LEAD_THRESHOLD_PCT` in `harnessrouting/usage.ts`; every smaller
lead conserves the scarcer Claude pool and routes to Codex. The Claude 5-hour reservation floor
named by `SESSION_FLOOR_PCT` excludes Claude only when an admitted fallback
exists. Inspect `list-harnesses-and-models` for its current value. Every chosen/remapped pair must remain in the active role pool.
`list-harnesses-and-models` (`commands/list-harnesses-and-models.ts`) is the
read-only view over these same tables — see `agent_docs/commands.md`.

### Objective-coded campaign names

The objective contract is a new-spawn admission rule for the preset `Alpha` and
`Shadow` roles. A campaign Alpha supplies `--objective-code <code>` once. The
code is one ASCII-alphanumeric token, canonicalized to lowercase, and the
canonical name is `alpha-<code>-...`. `create-agent` validates this contract
before trust, usage, registration, tab, or launcher effects, then stores the
code in both `identity.md` and `spawn.json` during pre-launch registration.
`--objective-code` and `--non-campaign` cannot be combined.

A campaign Shadow does not accept an independently supplied objective code. It
inherits the supervising Alpha's durable `objective_code` evidence and must use
`shadow-<code>-...`. The read-only command
`derive-shadow-name-from-alpha <supervising-alpha-name> <slice-id>` is the
single derivation seam: it prints the complete handle, and the throne
`/execute-todos` recipe passes that exact value to the tree, agent, ledger,
monitoring, merge, and reap steps. Hand-copying a code would create a second
source of truth and is not part of the contract.

`objectiveContractFromAlphaEvidence` accepts only these durable states:

- a canonical `objective_code` whose Alpha name begins
  `alpha-<objective_code>-`, which yields a campaign Shadow name;
- `non_campaign: true`, which identifies explicit non-campaign infrastructure;
- for a pre-contract Alpha, readable spawn evidence with neither field, which
  permits only the narrow first-token-after-`alpha-` fallback.

Contradictory fields, invalid values, a code/name mismatch, missing evidence, or
unreadable evidence refuse derivation before any Shadow registration or launch
mutation. A non-campaign Alpha's Shadow infrastructure must also pass
`--non-campaign` explicitly; no campaign code is inferred. The Regent is not a
`create-agent` registration and is exempt. Ad-hoc roles admitted with
`--bypass-preset-agent` do not enter the Alpha/Shadow contract.

### Exact native target and hard quota gate

An explicit request already admitted by the Alpha steer is exact for an Alpha;
the capability and usage metrics select the final model. Inspect
`list-harnesses-and-models` for the current pairs and never remaps across companies. For an
ordinary Shadow it is not: the usage steer may route the spawn to the other
company and remap the requested model to the equivalent coding tier there, with
the reason recorded; usage steering is mandatory and no flag pins the requested pair exactly.
After all permitted routing/remapping resolves the launch
pair, `create-agent` applies the same hard native gate to new spawns and dead
registered resumes whose exact final pair is native Fable/Opus. Legacy
Claude/GPT, Codex, Sonnet, Haiku, and all other pairs are outside this gate.

`src/create-agent/native-availability.ts` selects the general readable `5h` window plus the
requested model's matching scoped weekly signal, falling back to aggregate
weekly only when no matching scoped signal exists. Fresh, finite
`remaining_pct <= 0` in either applicable window is authoritative
`exhausted`; the refusal names the exact native model and cap/reset evidence.
A stale cached payload is always `stale-unknown`, including cached zero.
Duplicate/malformed/missing applicable allowances are `unknown`; source errors
are `source-failure`. Those non-authoritative states warn once and proceed.

The full sensor-to-steering path is:
`plan-usage-remaining` / `codex-usage-remaining` read the provider sensor and
persist the bounded JSONL history; `create-agent`'s `buildHarnessUsage` owns
the forecast step by calling `readUsageLogRaw`, slicing the bounded rows, and
deriving projected remaining at reset from that history before it hands the
injected harness usage to `steerSpawn`; `steerSpawn` then chooses the fresh
spawn. Projected remaining at reset is the primary forecast signal, and
current remaining is the fallback only when the forecast is insufficient or
unreadable. In other words, the route is sensor -> bounded history -> forecast
inside `create-agent` -> injected harness usage -> unified steering.

Usage steering, bounded-history forecasting, and history reads are mandatory for fresh spawns. Pools, floors, availability, native quota, effort, and stored-resume contracts remain separate gates.

One per-run memoized Claude-usage Promise is shared when Shadow routing and the
final gate both need telemetry, so they cannot disagree through a second fetch.
The gate completes before Codex trust, registration/ledger writes,
`afterRegistration`, tab creation, or harness execution. Refused new spawns
therefore leave no registration or launch mutation. Refused dead resumes retain
byte-identical ledgers; live registered names refuse even earlier, before any
quota read.

The actual-command canary in
`test/create-agent-native-quota.canary.test.ts` executes `node
throne/src/tools.ts create-agent …` under a scratch `HOME` with synthetic
credentials, an import hook that owns the sole usage request, a fake
first-in-`PATH` `herdr`, and fake native launchers reached through
`THRONE_LAUNCHER_DIR`. It proves exhausted Fable refuses with
reset evidence and without registration, herdr mutation, real network, or
harness execution; `finally` cleanup covers failed assertions.

## Thinking-role capability and legacy resume policy

`harnessrouting/capabilities.ts` owns runtime planning, non-coding, and validation scores.
The stable planning and validation floors are checked on the FINAL pair the
steering engine resolved, not the requested one. Inspect
`list-harnesses-and-models` for current scores, floors, and qualifying pairs. A
below-floor Alpha needs the loud one-spawn `--bypass-alpha-guardrail`, while a
recognized Shadow `99` has no validation bypass. The one automatic exception is a
launch the engine marked as the Alpha desperation redirect: it clears the
planning floor without a flag, because the routing law names Sol as that
redirect's target, and the exception is recorded loudly as a policy override.
Override evidence is rendered target-named into both
`~/.throne/data/<agent-name>/identity.md` and the complete durable
`~/.throne/data/<agent-name>/opening-prompt.md` record. There is no validation bypass.

`create-agent` reconciles registration before applying forward policy. A
genuinely new GPT request follows configured routing, then any final native
Codex outcome becomes `codexy-all-omni`. Exact stored legacy Claude/GPT recipes
remain compatibility behavior; stored native Codex recipes refuse and require
explicit reap plus fresh Omni registration.

A registered-but-absent agent first conflict-checks the supplied launch flags,
then uses the stored harness/model/effort/cwd exactly. It skips current
active-plan membership, capability admission, usage routing/remapping,
final pool defense, and identity/spec writes. Existing override evidence
therefore survives a state change. A stored native Fable/Opus pair alone still
uses the common final native quota gate; all other resumes skip Claude quota
reads. This registered re-run is a fresh harness process from the stored recipe,
not native session continuity. `spawn.json` contains `harness`, `model`,
`effort`, `cwd`, optional `spawned_at`, and the objective evidence
(`objective_code` or `non_campaign`) when the agent was registered under the
contract; there is no session ID, native resume argv, or native-session state.
Objective flags on a registered re-run are optional, but when supplied they must
agree with the stored evidence. The resume keeps the stored name and evidence
exact, including pre-contract records with no objective fields.

`list-harnesses-and-models` exposes the same runtime facts without copying
policy logic. It labels each row `new-and-registered`,
`new-with-bypass-or-registered`, or `registered-resume-only`, prints active
role pools, and reports the selected forward GPT policy plus exact resume
routes. A `new-with-bypass-or-registered` alternate is selected by naming its
model directly with `--model` — there is no `--bypass-harness` flag. It never
reads a toggle marker or probes usage.

## The reliability rule (why background tasks double-check)

`keep-going` and any future timer message an agent only **after** confirming
exactly one agent resolves for the target name. Messaging a stale/absent agent
is the failure mode we design against — hence name-based resolution with a hard
fail on ambiguity or absence.

## Git worktrees (`gittree/` / `spawn-git-tree`)

All coding runs in a worktree, not the live checkout, and every worktree
function is **repo-parameterized**: `repoRoot`, `currentBranch`,
`currentCommit`, `createTree`, `mergeBack`, and `removeTree` each take an
optional `projectDir` (default `THRONE_PROJECT_DIR`, the throne's own project
dir), so self-work (omitting `--repo`) behaves exactly as before
repo-parameterization. The internal `reflinkDirs` helper (not exported) also
takes a `projectDir`, but always an already-resolved one passed down from
`createTree` — it has no default of its own.

`spawn-git-tree <name> [--repo <path>]` makes a worktree for a target
**project dir** (`--repo`, default: the throne's own), resolved to its git root
via `git rev-parse --show-toplevel`. The subpath — the project dir's path
relative to its git root, realpath-normalized so a caller-passed `/home/...`
path and git's canonical `/var/home/...` root (a symlink on this box) don't
yield a garbage `../../..` relative path — is `''` for a root-project repo
(tree == worktree root) or e.g. `'throne'` for a subdir-project like the
throne's own (nests the project dir under the tree). The tree is placed under
the **throne-owned** `~/.throne/worktrees/<repo-basename>/<name>` —
**outside the target repo** (overridable via `THRONE_WORKTREES_HOME`) — via
plain `git worktree add -b <name> <path> <base>`, never a repo-hosted
`worktrees/` dir: an external repo has no `.gitignore` entry for a nested
checkout, so a tree inside it would pollute that repo's `git status`. To make
trees usable without a full reinstall, the project-relative hydration plan
selects ecosystem defaults or `data/gittree.dependency-hydration.json`
overrides. It accepts only contained ignored dependency paths, refuses
secrets/runtime state and symlink escapes, preserves existing destinations, and
copies independent files with nested symlinks dereferenced. The legacy
reflink-dir override is read only for compatibility. The typical flow: note the
target repo's current branch + commit, branch a tree off it, do the todo's
work there, then merge back to the target repo's branch when the slice is
done. **`mergeBack` must not clobber a dirty target checkout: if the
destination has uncommitted changes, stash → merge → unstash.**

The two halves of this lifecycle are CLI commands so the flow never needs raw
git: `spawn-git-tree <name> [--repo <path>]` creates the tree and records its
target in `~/.throne/data/<name>/tree-base.json`; `merge-git-tree <name>` fails closed on
missing metadata and invokes the shared `mergeBack` delivery transaction.

A completed ordinary agent whose delivered tree is unchanged reaches one
REPORT-backed publication decision. That decision reads only the named live
ledger and requires a regular, nonempty Markdown report newer than spawn/tree
registration whose identity name, campaign objective, supervisor, tree name,
repository, and target branch all agree. Only an accepted decision may invoke
the existing content-empty completion-stamp primitive; every other delivery,
ancestry, locking, and validation guard remains in force. Spawn-time
`verdict-only` remains independent until ten consecutive completion-time
campaigns need no fallback, accepted and refused cases are observed, callers
are audited, and the Regent approves retirement.

That transaction snapshots the latest target tip, computes the delivered tree
via the shared squash algorithm (`buildSquashPreview` in
`src/git-lifecycle/squash.ts`), and fails before publication on conflicts. It
creates exactly **one** commit — `createParentedCommit`, single-parented by
the snapshotted target tip only, never the candidate tip — then fast-forwards
the checked-out branch or compare-and-swaps an unchecked-out ref. A race
therefore cannot publish a stale-parent result, and the delivered commit is
provably reachable from the target. Candidate refs survive unchanged; equal
target/result trees are explicit no-ops. Dirty checkout state is stashed and
restored around only the fast-forward. Git tree objects carry all entry types
directly, avoiding file-copy semantics. `commit.gpgsign` is honored and a
signing failure leaves refs untouched. The core remains exported as
`mergeBranchInto(checkoutDir, name)` for disposable-repo verification.

`removeTree(name, projectDir?)` is the worktree half of the teardown counterpart
to `createTree`: it identifies the tree by its **branch** (`createTree` always
does `-b <name>`) via `git worktree list --porcelain`, so teardown finds it
wherever it lives instead of reconstructing a drift-prone path. Removal uses
`git worktree remove --force` + `git worktree prune`, never raw `rm -rf`, and is
idempotent. The force is deliberate: `reap-agent` owns the liveness and memory
refusal gates before this primitive runs.

The branch half is separate and transaction-aware. `reap-agent` accepts a
candidate only from a structurally complete `tree-base.json` whose canonical
`name` exactly matches the reaped name and whose `repo` names the target; the
record's `branch` field is the spawn-time target branch, not the dedicated
branch candidate. Missing/unreadable records authorize no branch deletion; a
legacy exact record without `repo` preserves the branch and continues the old
worktree/archive path with a warning, while readable corrupt or mismatched
provenance refuses before mutation. `preflightBranchCleanup` resolves only the
eligible recorded repo and proves the exact local candidate tip is reachable
from the recorded merge-target branch (`tree-base.json` `branch` — the same
field `spawn-git-tree`/`merge-git-tree` honour, so a Shadow proves against its
Alpha branch and an Alpha tree against its spawn-time target branch). When that
recorded target has disappeared, ordinary orphan cleanup resolves the repository's
durable default branch from `refs/remotes/origin/HEAD` (never any checkout's
`HEAD`, and no branch name is special-cased), requires its local `refs/heads/`
counterpart to exist, and requires the exact candidate tip to remain reachable
from that branch — an unresolvable authority refuses;
`--force` explicitly permits cleanup without that retention proof. An absent
candidate ref is idempotent. For ordinary reap, a tip
unreachable from the recorded merge-target branch, a candidate checked out in
the retained primary worktree, or duplicate candidate checkouts refuses before
tab closure or git/data mutation. `deleteBranchCleanup` runs only after
`removeTree`, rechecks the tip, the preflighted retention authority, and zero
remaining checkouts, then deletes with `git branch -D`: git's own `-d` proves merged-ness
against `HEAD` — the wrong base for a Shadow that lands in its Alpha branch —
so the recorded-branch proof replaces it. No remote deletion or generic branch
scan exists. If
deletion fails after worktree removal, `restoreBranchCleanup` keeps or recreates
the preflighted ref and restores the clean worktree when practical, while the
live ledger remains unarchived for retry.

`reap-agent <name> --reason cancelled --archive-cancelled-unmerged` is the
deliberate opposite branch disposition, and the supported replacement for FPC's
historical manual provenance rename. `cancelled` and
`--archive-cancelled-unmerged` are a mandatory pair; `--force` remains only
the liveness/live-child override and `--force-discard-memories` only permits
discarding uncommitted agent-memory files. This path still requires exact,
readable, name-matching target-repository provenance and every normal Regent,
liveness, child, and memory gate.

Before any lifecycle mutation, `preflightCancelledUnmergedBranch` proves the exact
existing `refs/heads/<name>` resolves to a full object ID, is intentionally
not reachable from the recorded merge-target branch, and is checked out in at most its
one dedicated managed worktree (never the retained target, a foreign tree, or
duplicate trees). The initial preflight refuses merged, missing, corrupt,
mismatched, foreign, or duplicate-checkout authority before tab closure or
worktree/ledger mutation. A retry after the dedicated worktree was already
removed is allowed only when the same ref and provenance proofs still hold.

After preflight succeeds, the accepted path closes an eligible live tab, removes
the dedicated worktree when present, preserves the original `tree-base.json`
bytes as `tree-base.cancelled-unmerged.json`, and re-verifies the unchanged
unmerged ref/tip and zero remaining checkouts. If the ref moves after preflight,
archival refuses at that post-teardown verification stage while the moved ref
and preserved provenance marker remain in the live ledger for recovery with the
same explicit command. An initial proof failure is earlier and leaves the tab,
worktree, and ledger untouched.

After verification succeeds, the path records the `cancelled` timing reason and
rotates the complete ledger under `.reaped`. It emits `CANCELLED-UNMERGED`
with the retained ref and exact tip. It never merges, calls `git branch -d` or
`git branch -D`, deletes an `update-ref` or remote ref, renames the branch,
or bypasses same-name reuse. The retained local ref deliberately makes exact-
name `spawn-git-tree` creation fail; a later lifecycle uses a new name unless
an operator first inspects and explicitly resolves the recovery ref.

Until archival succeeds, the preserved provenance marker is an in-progress
cancellation marker: ordinary reap refuses it with that exact retry command
rather than treating branch authority as absent, and changed or ambiguous
provenance also refuses. Ordinary reap treats an already-gone branch, worktree,
or data dir as an idempotent no-op. Explicit cancellation instead requires live
`tree-base.json` or preserved `tree-base.cancelled-unmerged.json` authority
until archival succeeds; rerunning it after successful archival is an authority
failure, not the ordinary already-gone no-op path.

## Per-agent data (`src/agentdata/`, `~/.throne/data/<agent-name>/`)

`data/` is **gitignored** persistent storage, one subdir per agent. Todos live at
`~/.throne/data/<agent-name>/<todo-name>/`; identity (who the agent is + its supervisor),
the recorded base branch/commit, and any scratch also go there. `create-agent`
writes `~/.throne/data/<new-agent>/` **before launching** — seeding `identity.md`
(supervisor, escalation, role, plus an optional Alpha policy-override statement)
and `spawn.json` (harness/model/effort/cwd plus optional `spawned_at` and
objective evidence) as a durable contract so re-runs know what was registered.
The objective fields are `objective_code` for a campaign or
`non_campaign: true` for an explicit infrastructure exemption; they are absent
from legacy records. The override field is
identity evidence only; GPP did not add it or any session/native-resume field to
`SpawnSpec`. This guarantees no agent escapes launch unregistered: a throw
between registration and `startAgent` leaves a registered-but-not-launched
record (relaunch-or-refuse on re-run), while a throw after `startAgent` never
deletes a live agent's registration. No agent ever questions the Lord; the
Regent only summarizes outcomes upward.

`~/.throne/data/<name>/` dirs are **heterogeneous**: an agent dir carries `identity.md`
(seeded by `create-agent` → `writeIdentity`); a dir with only `tree-base.json`
is worktree bookkeeping keyed by tree/branch name, not an agent; `~/.throne/data/regent/`
holds the Regent's queue and has no `identity.md`. `agent-statuses` treats
`identity.md` as the discriminator when it surfaces DEAD (registered-but-not-live)
agents via the Nest agent-statuses roster's `computeAgentStatusesRoster`, so worktree records and the
`regent` dir never show as spurious dead agents; the live↔registry join is
case-sensitive on `name`. The lifecycle is modeled open — `AGENT_LIFECYCLE = ['live','dead','complete']`, a const-array + union (not a hardcoded binary). A registered agent whose process is gone but whose bundle finished — evidenced by a `REPORT.md` in its `~/.throne/data/<name>/` — is COMPLETE (reap-ready), distinct from a DEAD agent that died mid-work.

Reaping archives evidence only after required git cleanup succeeds:
`archiveAgentData(name)` **moves** `~/.throne/data/<name>/` to
`~/.throne/data/.reaped/<name>/`, then `<name>-2`, `<name>-3`, and so on without modifying
an earlier archive. Successful branch deletion makes the exact canonical name
available to real `createTree` again; fresh `identity.md` and `spawn.json` can
occupy a new live `~/.throne/data/<name>/` independently of archived generations. A
branch-delete failure leaves that live ledger in place. If archival itself
fails after safe branch deletion, the ledger likewise remains live and
retryable while the deleted tip remains reachable from the recorded merge-target branch.
Because `listRegisteredAgents` / `listCompletedAgents` scan only top-level
`data/`, an archived agent drops out of the registry and `agent-statuses`.
`.reaped/` remains gitignored.

`complete-agent <name>` (command) is reap-on-complete: it gates `reap-agent` on
the COMPLETE lifecycle. It reads `getRoster()` and reaps ONLY when the named
agent's `lifecycle === 'complete'` (process gone AND a `REPORT.md`), refusing a
LIVE agent (still working) or a DEAD one (died mid-work, no report — a D2/Regent
orphan decision, not E2's). Teardown delegates to `reap-agent`'s `run` verbatim,
so no completion-detection or teardown logic is re-implemented; an unknown name
is an idempotent no-op success. `--all` sweeps every COMPLETE agent, failure-
isolated (a non-zero aggregate exit if any single reap fails).

## Background scheduling

Timers are **systemd user units** (agent-agnostic; survive any harness). Each
timer's `ExecStart` is `<throne>/bin/throne-cli <command>`. Install/refresh
with `systemctl --user daemon-reload && systemctl --user enable --now
throne-keep-going.timer` — or just run `ensure-heartbeat`, which does the same
thing idempotently. The timer layer only resolves the target agent and sends
the heartbeat; it does not inspect queue state or choose the next objective.

## Self-configuration on launch

A fresh throne harness arms itself with no manual steps. Both harnesses run a
SessionStart hook on launch, from a location chosen to be committable:

- **claude** — the tracked, throne-local `throne/.claude/settings.json`.
  Claude Code merges the session cwd's project-level `.claude/settings.json`
  into the run and executes its `SessionStart` hooks, so every harness
  launched with a throne checkout as cwd — the live root or a campaign
  worktree — fires it. The hook command runs the INSTALLED global CLI, not
  the checkout's own: it tries `~/.local/bin/throne-cli` and
  `~/bin/throne-cli` (the symlinks `install-services` plants, both resolving
  to the live throne root), then `throne-cli` on PATH, and only then the
  checkout's `bin/throne-cli`. The Lord's ruling (2026-09-02): the `throne`
  CLI is global, so a session's startup uses the original throne folder,
  never its cwd. The fallback matters because a worktree's `bin/throne-cli`
  lazily `npm install`s and builds that tree on first use, which blew the
  hook's 10-second budget on the very first Stager the floor raised on a
  mac; the installed CLI needs no build.
- **codex** — the throne-scoped `throne/.codex/hooks.json`, a machine-rendered
  artifact: the committed source is the token-bearing
  `throne/.codex/hooks.json.template`, and `install-services` renders the real
  file from it into the checkout (same substitution core and refuse-on-leftover
  rule as the service units; `--throne-root` moves the substituted path). The
  rendered file is gitignored because Codex reads it IN PLACE — at both the cwd
  level and the git root, merged — so scoping it to `throne/` fires only for
  throne sessions and composes with the machine-local `~/.codex/hooks.json` axi
  hooks. Codex trust-gates the file by a content hash, so it prompts once to
  trust it, and again only when the rendered bytes change.

Both hooks reach the same command against the live throne root — resolved
through the installed global shim in the Claude settings file, substituted
for `{{THRONE_ROOT}}` in the rendered Codex hook:

```bash
<throne root>/bin/throne-cli throne-startup
```

`throne-startup` resolves its own herdr pane and is a full no-op unless that
pane's `cwd` is the throne root, so a broadly-scoped hook fires harmlessly for
every non-throne session. Once confirmed as the throne top-level harness, it
renames itself to `Regent` ONLY when it is unnamed AND no `Regent` already
exists (a named agent, e.g. a `create-agent`-spawned Shadow, is never
renamed), **banners the Regent's desired-state** (`RUNNING`|`DISMISSED`, read
via `regentstate.ts`'s `readDesiredState` seam — see "Surfacing the queue at
launch") and **prints the QUEUE digest** (see below), then always runs the
`ensure-heartbeat` core regardless of the rename outcome. It always exits 0, so
it can never disrupt harness launch. See `agent_docs/commands.md` for both
commands in detail.

### Surfacing the queue at launch

A booting Regent holds nothing in conversation, so its situational awareness must
be reconstructed from disk (the "Regent's boot ritual" in `AGENTS.md`). To make
that automatic, `throne-startup`'s confirmed-throne-root branch prints a compact
digest of the Regent's durable backlog — the in-flight (🟢) and next-up (⚪)
objective headings of `~/.throne/data/regent/QUEUE.md`, plus the file's
full path for a deeper read — to stdout. The whole mechanism is
that stdout: the SessionStart hook's output is already injected into the
harness's opening context (the same path by which `renamed self to "Regent"`
appears at session top), so no new plumbing is needed. The queue path resolves
from the module dir like `THRONE_ROOT` (never cwd); a missing/unreadable queue
prints one "no queue found" line and launch continues (always exit 0). Landed
(✅) objectives are omitted — the digest is what is live and next, not the
archive. The Regent reconciles live/current campaign state, continues or merges
active work, and only when there are no current tasks dispatches the next
dependency-eligible queued objective. This is objective A''.

## Self-heal watchdog

`keep-going` first reads the Regent's desired state on the default path. When
desired state is `running`, it resolves the uniquely named live Regent and
submits the heartbeat literal through the common engine with explicit sender
`keep-going`. On that live-Regent path the exact `HerdrAgent.agent` label is
the sole pacing selector: `codex` reads only Codex/GPT usage, `claude` only
Claude usage, opposite-provider telemetry cannot affect cadence, and
matching-provider pressure keeps the existing hysteresis / progressive finite
slowdown / never-full-stop law. A harness change or legacy driverless state
starts a fresh pacing domain — band and `lastNudgeAt` memory never leak across
providers; only same-driver matching-sensor unavailability may retain that
driver's prior band. Unsupported labels read no provider getter and fail open
to an explicit NORMAL/unthrottled pacing status. A throttle-evaluation failure
nudges unthrottled (NORMAL); a state-read failure can still compute a matching
non-NORMAL band; a state-write failure can retain a computed non-NORMAL band —
no failure ever suppresses the heartbeat. Output is byte-identical to the plain
literal only when the evaluated band carries no advisory: the literal,
optionally followed by a single space and that one band advisory, is the whole
of it. When no live Regent exists, it resurrects one instead of reading any
sensor.
When desired state is `dismissed`, it no-ops. An explicit `--name` skips
desired-state and resurrection entirely: a named Regent gets the queue-aware
literal, and any other named agent gets the preserved generic nudge, both still
with sender `keep-going` and no current-agent inference. The timer layer
remains a messenger and does not own queue dispatch, and genuine ambiguity or
resolution failure is the only nonzero path. Because both direct and systemd
invocations call the same `submitToAgent` boundary, heartbeat delivery shares
the per-pane kernel lock with every other producer.

Just above the queue digest, the same confirmed-throne-root branch **banners the
Regent's desired-state** (`RUNNING`|`DISMISSED`) read via the shared
`regentstate.ts` `readDesiredState` seam — never a hand-rolled marker parse — so
a booting Regent's opening context shows whether the court is meant to self-heal
or has been stood down. Like the digest it fails safe (an unreadable marker ⇒
`RUNNING`) and never aborts launch. The same banner (via the shared
`describeDesiredState` descriptor) is what `agent-statuses` prints above its
roster table. This is objective K.

The existing `alpha-autoscale` hosted tick owns a second level-triggered floor:
exactly one live Stager while the desired state is `running`. Its shared
decision/effect lives under `src/alpha-autoscale/` and is also called after
confirmed-Regent startup reconciliation. It projects the shared status roster,
fails closed on unreadable, role-unknown, or multiple-candidate evidence, and
uses the normal managed worktree plus `create-agent --role Stager` path when
absence is positively known. Running breaches are logged and acted on every
evaluation with no grace or operational-hold exemption; `dismissed` is the sole
court-wide `STAY DOWN` exemption.

Every signal the autoscale family reads is dual-platform (the Lord's order of
2026-09-02: "all of the signals need to support both linux and mac"). The
queue, ledger, roster, kill switch, cooldown and launch-ledger inputs never
touched the host. The two that did were Linux-only until that day: the
capacity-pressure verdict read `/proc/pressure/*` (PSI) and so was `unknown` on
every tick on a Mac — the gate failed closed and spawned nothing — and
`listProcessesUnderPath`, which reap-agent (and through it autoreap) uses to
terminate a reaped agent's leftovers, enumerated `/proc/<pid>/cwd` and found
nothing. `src/keep-going/keep-going-pressure-report.ts` now dispatches on
platform to `src/pressure-signal/darwin-pressure-reader.ts` (cpu utilisation
sample, kernel memorystatus, io unmeasurable and graded 0 — stated, not
hidden) through the unchanged classifier and thresholds, and
`src/process-inspection/proc-scan.ts` dispatches to
`darwin-process-scan.ts` (`lsof -d cwd` + `ps`). The hourly `procwatch`
runaway-process detector is NOT ported — it is built on per-pid `/proc`
deltas — and skips on darwin with a stated reason instead of failing its tick.

Queue launch eligibility is explicit structured intent, never a classification
of prose. The intentional filer—normally the Stager after consolidating a
launchable plan—either supplies the canonical objective code and complete launch
metadata when calling `add-to-queue`, or marks an existing open row with
`mark-queue-launch-eligible`. The latter atomically records the Alpha name,
target repository, target branch, base commit, and eligibility bit. The Regent
may use the command as a compatibility path, but routine launch admission does
not depend on Regent action. This explicit criterion leaves rulings,
corrections, and observations safely ineligible; inferring launch intent from
their prose would trade a little filing convenience for accidental Alpha
launches. The auto-brief/floor consumer remains the only component that turns
eligible queue state into a staged brief and spawn attempt.

### Startup reconciliation — resume-or-reap (objective D2)

The live herdr roster is a half-truth: after a crash/reboot every process is
dead, but the persistent registry (`~/.throne/data/<agent>/`) survives (see AGENTS.md,
"Surviving a restart"). So the confirmed-Regent branch of `throne-startup` runs
one more step — Nest-owned startup reconciliation — to heal the
court. It cross-references the registry against the live roster it already
fetched: every registered `~/.throne/data/<agent>/` with no live process is an **orphan**,
and each is **resumed** or **reaped** by a documented policy (COMPLETE ⇒ reap;
DEAD with unfinished work ⇒ resume; DEAD with none ⇒ reap — see AGENTS.md for the
full table). It reuses the lower-level Nest-owned agent-data service seams
(`listRegisteredAgents`/`listCompletedAgents`/`hasResumableWork`) rather than
the agent-statuses roster, so it is decoupled from the roster-display code.

- **Resume** relaunches the orphan under its own name, reconstructing the exact
  launch flags from `~/.throne/data/<agent>/spawn.json` — the respawn recipe `create-agent`
  records at registration time (harness, model, effort, cwd) — mirroring how
  `regentstate.ts` records the Regent's harness kind for faithful resurrection.
  The spawn.json contract guarantees that a re-run of `create-agent` with the
  same name either resumes faithfully (spec matches what was requested, or new
  flags agree with what was stored) or refuses cleanly when flags conflict.
  `normalizeSpec` makes this total: an absent recipe (a legacy agent) or a
  corrupt/garbage one falls back to claude/opus/ultracode at the throne root.
  Current `spawn.json` has neither native session identity nor exact native
  resume argv, so recovery is a fresh harness launch, not conversation
  continuity. It uses an absolute throne-root ledger-rebrief prompt that tells
  the harness to re-read its identity and continue its in-flight bundle or
  ASSIGNMENT.md, then emits an honest native-conversation-state-loss warning.
  Exact native continuity would require exact resume argv to exist in durable
  state; it does not today.
- A restored tab proves only persistent layout, not Claude/Codex harness
  liveness. Registered resume reuses one eligible exact-label tab and restricts
  process checks to panes inside that exact target tab. An incomplete foreground
  process row is unknown, never shell-only evidence: exact-pane inspection
  retries it boundedly and fails closed if complete telemetry never arrives. A
  unique anonymous live Claude/Codex pane is claimed through Herdr's rename
  primitive only when its pane cwd and sole recognized harness process cwd both
  equal the recorded launch cwd, no raw owner conflicts, and stable post-claim
  inspection proves the exact owner on the same tab, pane, and terminal. Any
  missing, mismatched, duplicate, or unstable evidence fails closed without a
  duplicate launch. A
  shell-only stale owner of the unique registered name is first renamed to a
  deterministic quarantine
  name; the replacement then atomically claims the registered name in the same
  tab. Pre-existing restored panes are closed only after that launch succeeds,
  so launch failure preserves the restored tab and quarantined registration for
  retry. No exact-label tab uses ordinary new-tab launch; multiple exact-label
  tabs fail closed instead of guessing.
- **Reap** goes through H's `reap-agent` primitive (close tab, remove
  worktree, safely delete the eligible merged branch, and archive
  `~/.throne/data/<name>` → `~/.throne/data/.reaped/`). Startup reconciliation invokes ordinary
  reap with `--reason completed` for COMPLETE orphans and `--reason orphan`
  for inert DEAD orphans; it never selects
  `--reason cancelled --archive-cancelled-unmerged` and therefore never
  automatically retains a cancelled-unmerged recovery ref.
- **Payload drain.** The real `reconcile()` entry first awaits the required
  `ReconcileDeps.reapStalePayloads` seam. Production binds it to the real
  24-hour-TTL reaper; tests must supply an explicit fake so they can never drift
  into the operator's live payload directory. Success writes the reaped/retained
  counts into the boot summary. Failure warns, writes a failed summary, and still
  continues into orphan reconciliation. Together with the nonblocking
  before-stage caller, this means an expired file is removed at the next large
  send or confirmed-Regent startup — TTL alone is not a timer, and recipient
  cooperation remains assumed rather than enforced.
- **Gated to the Regent.** A `create-agent`-spawned Alpha also boots with cwd =
  throne root and reaches the confirmed-throne-root branch; reconciliation is
  gated on `isRegent` so an Alpha never reaps or resumes its siblings. Orphans
  are processed sequentially (no `herdr tab create` races), each in its own
  try/catch, and the whole pass is non-fatal — like the rest of `throne-startup`
  it always exits 0.

Wired through `ThroneStartupDeps` as an OPTIONAL `reconcile(liveAgents)` seam
(absent ⇒ skipped, the pre-D2 behaviour and what guard-only tests want;
`REAL_DEPS` wires the real reconciler), so the gating and non-fatality are proven
with injected fakes, mirroring the existing startup-guard tests.

## Custom harness run-to-exit boundary

`create-agent` keeps resident and one-shot custom processes separate. Resident recipes persist exact executable and argv fields in `spawn.json`, deliver opening prompts through the composer, and share exact resume/startup reconciliation. One-shot recipes create no agent registration. For this custom-process path, `herdr.ts` is the Herdr/process authority: it rejects a duplicate tab label, creates the visible tab, launches one generated single-path runner through the Herdr pane, and closes the tab after scrubbed launcher evidence proves process exit. The Node child runner spawns the caller executable with an argv array and caller-only environment, captures both output streams, measures wall time, and terminates the detached process group on timeout. No shell joins caller argv.
