# Command reference

Every concrete, repeatable action is a `throne-cli <command>`. Bare
`throne-cli` means **the live court**; `./bin/throne-cli` means **this
checkout**. Use bare form for court-state, plan, and routing questions. Use
relative form for candidate CLI and self-update validation. Both forms are
deliberate authorities; never mechanically rewrite one to the other.
Node v24 runs the TypeScript directly — there is no build step. All commands
resolve agents by their unique herdr **name** and fail loudly (non-zero,
sending nothing) on a zero-or-ambiguous match — the reliability rule.

## assert-herdr

```bash
./bin/throne-cli assert-herdr
```

Preflight gate. Exits `0` and prints a confirmation when running inside a live
herdr session; exits non-zero with a relaunch instruction otherwise. Presence is
detected by a successful `herdr pane current`. Run this first — every tier must
be on herdr.

## agent-statuses

```bash
./bin/throne-cli agent-statuses
```

Above the table it banners the Regent's declared **desired-state** —
`RUNNING` (the keep-going watchdog resurrects a dead Regent) or `DISMISSED`
(the Lord stood the court down; the watchdog will NOT resurrect) — so the
self-heal mode is never a hidden setting, and a stood-down court's empty roster
is self-explaining. The banner reads via `regentstate.ts`'s `readDesiredState`
seam (absent/garbage marker ⇒ `RUNNING`, fail-safe) and flips as the Lord runs
`dismiss-regent` / `summon-regent`.

Below the banner it prints a padded table of every herdr agent: `NAME`, `STATE`,
`STATUS`, `CWD`, `PANE`. The `STATE` column is one of **LIVE** / **DEAD** /
**COMPLETE**: a registered agent whose herdr process is gone but whose todo
bundle finished (its `~/.throne/data/<name>/` carries a `REPORT.md`) is COMPLETE
(reap-ready), as opposed to DEAD (registered, process gone, no completion
report). The `STATUS` column (`idle|working|blocked|done|unknown`) is meaningful
only for LIVE agents. The focused agent is marked with `*`; unnamed agents show
their default label in parentheses (e.g. `(claude)`).

## agent-logs

```bash
./bin/throne-cli agent-logs <name> [--lines N] [--source visible|recent|recent-unwrapped]
```

Prints the named agent's recent on-screen / emitted output — the monitoring eye.
`--lines` caps the number of lines (positive integer). `--source` selects what
herdr returns (default `recent`). Exits non-zero if the name resolves to zero or
more than one agent.

## send-agent

```bash
./bin/throne-cli send-agent <recipient-name> <prompt...> [--sender-name <name>]
```

Resolves the recipient uniquely before any sender lookup or delivery. By
default, the sender is the invoking pane's unique canonical live agent name;
`--sender-name` supplies an exact explicit identity, including stable non-agent
origins. The send formats the recipient-visible row as
`<sender-name> said: <prompt>` and delivers that logical body through the
platform primitive.

Delivery is `herdr agent prompt <recipient> <body> --wait --timeout <ms>` — the
platform owns the entire write-and-Enter transaction and its queue semantics.
The throne retains only its own value around that call:

- **Recipient mutex and identity proof.** One exclusive kernel `flock` keyed by
  the initially resolved recipient pane id is acquired before anything else.
  Under the lock the original unique name is re-resolved and must still name
  the same pane, terminal, and harness; acquisition failure or identity drift
  returns typed not-sent with zero delivery effects. Same-pane processes wait
  serially while different pane ids remain independent. Lock files are stable
  SHA-256 names under the user-private `~/.throne/locks/recipient-panes/`
  directory, never ownership markers; ownership is the kernel lock on the open
  descriptor, and normal exit, signal death, crash, or reboot closes it.
- **Draft protection is absolute.** Before the platform call, the throne reads
  the recipient's composer once. `herdr agent prompt` writes straight into the
  composer and presses Enter — it does not queue behind a resident draft — so a
  resident draft would be merged into and submitted with the sent text. The
  throne therefore refuses (typed not-sent, nothing written) whenever the
  composer is not provably empty, unreadable, covered by a dialog, or on a
  harness with no supported grammar. A human mid-sentence outranks every agent;
  agent traffic never types into or submits his draft.
- **Opencode composer-emptiness contract.** The opencode reader
  (`src/composer/prompt-region.ts` `readOpenCodePromptRegion`) selects the
  bottom-most `┃` box closed by a `╹▀▀▀…` edge and reports these states as a
  PROVABLY EMPTY composer:
  - **in-session idle** — the model-status row, recognized by its leading
    shape `^Build(?:\s*auto)?\s*·` plus the `OpenCode Go` token and stripped
    whatever its suffix (` · max`, ` · high`, ` <cwd>:<branch>`);
  - **the cwd:branch artifact / wrapped path variants** — right-aligned
    wrapped path fragments beginning more than `OPENCODE_MODEL_PATH_COLUMN_OFFSET`
    (12) columns past the marker are dropped;
  - **the PRE-SESSION landing screen** — the `Ask anything...` placeholder
    line renders in truecolor neutral grey `38;2;128;128;128`, which the parser
    marks `muted` (`isNeutralGreyMuted`, a neutral grey r==g==b below the 200
    brightness limit in `src/composer/ansi.ts`), and an all-muted content line
    is skipped as placeholder chrome; any `● Tip` line below the box is outside
    the composer box and never content. The captured
    `test/fixtures/opencode-landing.ansi` and its synthesized Buildauto/Tip
    variants each classify `{state:'empty', text:''}`.
    A real resident draft — any bright (non-muted) character, e.g. typed input
    rendered near-white `238;238;238` — still classifies `draft`, refuses typed
    not-sent, and is preserved byte-for-byte (the long-transcript fixture's draft
    text is recovered exactly).
- **File-backed bodies.** The exact attributed UTF-8 payload is classified;
  bodies at or above 4096 bytes are never sent through the prompt path: while
  still under the lock and after identity refresh, the throne stages the exact
  body in a unique `0600` file beneath the `0700` `~/.throne/payloads/`
  directory and submits only a short pointer (see below).
- **Typed outcomes.** The platform's own typed outcomes map to the throne's
  verdict contract: a platform refusal before any write (`agent_not_found`,
  `agent_not_ready`, `empty_agent_prompt`, `agent_prompt_failed`, or a command
  that never ran) is `SubmitNotSentError` — retry-safe, nothing was written.
  A settled recipient state (`idle`/`done`/`blocked`) is delivered evidence and
  records the supervision receipt. `agent_prompt_stalled`, `timeout`,
  `agent_not_running`, an unknown error code, or an unparseable success is
  `SubmitIndeterminateError` — text was written and may still be pending, so
  the caller never resends. The default settled-state wait is bounded by the
  throne's own timeout; `--timeout` beyond that is herdr's platform flag, not a
  send-agent option.

Exits non-zero and sends nothing when the recipient is absent/ambiguous or
required default sender inference fails. Only `--sender-name` is reserved;
`send-agent` intentionally has no harness-selection flag and remains unchanged;
the create-agent `--harness` denial applies only to launch requests, while
registered resumes preserve the harness stored in `spawn.json`.
other dash-prefixed tokens remain prompt text.

### File-backed bodies and `read-payload`

The engine classifies the exact attributed UTF-8 payload. Bodies at or above
4096 bytes are never typed into the composer: while still under the recipient
pane lock and after identity refresh, throne stages the exact body in a unique
`0600` file beneath the `0700` `~/.throne/payloads/` directory and submits only
a short pointer. Below-threshold bodies retain the direct composer path. Before
each large stage, `stagePayload` starts a stale-file reap without awaiting it;
a hung or failed pass cannot delay/fail the send, and failures are reported.

The pointer is one exact line and makes the throne-owned consumer primary:

```bash
Large message — read then delete: node <JSON-quoted tools.ts path> read-payload <JSON-quoted payload path>
```

The command accepts only an absolute `.payload.txt` directly under the throne
payload directory. It reads the complete file before deletion. On success it
prints the exact recovered body to stdout without decoration, prints an exact
byte-count + SHA-512 + deleted-path receipt to stderr, deletes the file, and
exits 0. Defined failures are:

- exit 2: `read-payload: payload missing at read time: <path>`;
- exit 3: `read-payload: payload unreadable at read time: <path> (<error>)`;
- exit 4: complete read succeeded but deletion failed; the body is withheld from
  stdout so nonzero never masquerades as successful consumption;
- exit 5: the path is outside the owned payload directory or has the wrong
  shape;
- exit 64: malformed invocation.

A failed or partial read never deletes. Recipient cooperation remains a soft
edge: throne can define the outcome once invoked but cannot force an LLM to run
the command. The backstop runs again from confirmed-Regent startup
`reconcile()`, where failure is warned, summarized, and isolated from orphan
reconciliation. The 24-hour TTL means eligibility, not an independent timer: an
unread file is removed on the first successful opportunistic-stage or Regent
startup reap after it expires. A fresh payload survives those passes.

### Operator recovery workflow

Inspect the active pane before choosing a delivery mode:

```bash
./bin/throne-cli agent-logs <recipient-name> --source visible
```

Confirm the intended payload and the recipient state. Run an ordinary send
only when the intended payload is not already resident; a resident draft is
preserved — the send refuses typed not-sent without touching it.

Retry the identical ordinary command only after `SubmitNotSentError`. Never
resend after `SubmitIndeterminateError`; inspect first and decide from observed
recipient state. For a subsequent busy message, report it as queued only when
the platform prompt settled with the recipient working on the queued turn, or
the recipient's transcript shows the accepted entry. A status change or an old
transcript occurrence alone is insufficient.

## notify-lord

```bash
./bin/throne-cli notify-lord <message...>
```

Sends one deliberate message to the Lord through the throne's configured
**tailnet-only ntfy transport**. The command joins all message arguments with a
single space and trims the result. An absent, empty, or whitespace-only message
is rejected before any network call with:

```text
notify-lord: message required. Usage: ./bin/throne-cli notify-lord <message...>
```

A valid message is passed to `postNtfyMessage` exactly once and awaited. The POST
uses the explicit ntfy title `Message from the throne`; automatic completion
pushes keep their separate `Throne campaign completed` title. Success prints:

```text
notify-lord: message delivered to the Lord.
```

A transport failure exits non-zero and prints
`notify-lord: failed to notify the Lord (<error>)`. The command does not retry,
so one invocation cannot silently duplicate a delivery.

The command reuses `NOTIFY_CONFIG` from `src/notify-lord/notification.service.ts`: the
server URL and topic from the gitignored `config.user.ts` `ntfy` section (the
committed fallback is the inert `http://127.0.0.1:8410`, topic
`throne-notifications`), and a 5-second request timeout. Set
`THRONE_NTFY_SERVER_URL` or `THRONE_NTFY_TOPIC` before starting the process to
override the first two;
configuration is captured once per process. `THRONE_NOTIFY_SHADOWS` affects
only automatic Shadow-completion pushes and does not gate explicit messages.

Invoking `notify-lord` is an intentional external side effect. Use it for a
message that should reach the Lord's phone, not as a hidden progress-log channel
or as a substitute for `send-agent` within the court.

## create-agent

Fresh campaign Alpha and Shadow launches must pass `--cwd` inside the matching
throne-managed external Git worktree before registration or launch. The live
throne or target checkout, a missing tree, and a mismatched managed tree are
hard refusals. `--empty-worktree` explicitly creates/uses
`~/.throne/worktrees/empty/<agent-name>` with generated `AGENTS.md`; it is
persisted as empty-workspace provenance and cannot act as Git delivery
authority. There is no treeless bypass.

## Run a custom harness to process exit

`create-agent --run-custom-harness-to-exit` is the custom-executable-only, non-resident path. It uses the caller's exact `--harness-executable` and every token after the first standalone `--`; `--prompt` is refused because composer delivery remains resident-only. The mode requires `--clear-environment`, accepts unique `--env KEY=VALUE` entries without inheriting ambient variables and refuses duplicate keys, honors `--cwd`, uses the exact caller-supplied `--name` as its visible Herdr tab label, and closes that tab after real process exit. It writes stdout, stderr, numeric exit status (`124` on timeout), wall milliseconds, and scrubbed JSON launcher evidence with requested and filesystem-resolved executable paths to the five explicit path flags. `--timeout-ms` terminates the child process group. It creates no `~/.throne/data/<name>` registration, has no resume recipe, does not participate in worktree-stranding detection, and refuses an already-visible tab with the same label. Every one-shot-only flag is refused when the mode flag is absent, before policy or lifecycle effects. The `--model` is resolved through the canonical model registry, which supplies the harness; caller-supplied `--harness` is refused. Effort, plan admission, steering, capability, quota, and their normal bypass flags are still evaluated as policy evidence; the custom executable replaces only configured launcher argv. Resident custom recipes remain registered, composer-prompted, startup-reconciled, and exactly resumable from `spawn.json`; legacy records without custom fields retain configured-launcher reconstruction.

Claude CMO cell:

```bash
./bin/throne-cli create-agent --model fable --effort 1 --name cmo-claude-cell --supervisor alpha-cmo-claude-md-optimization --role Agent --cwd "$CELL_HOME/work" --non-campaign --bypass-preset-agent --harness-executable /absolute/path/to/claude --run-custom-harness-to-exit --clear-environment --env "HOME=$CELL_HOME" --env PATH=/usr/local/bin:/usr/bin:/bin --env TERM=dumb --env "CLAUDE_CONFIG_DIR=$CELL_HOME/.claude" --stdout-path "$CELL_HOME/result.jsonl" --stderr-path "$CELL_HOME/result.stderr" --exit-status-path "$CELL_HOME/result.rc" --wall-time-path "$CELL_HOME/result.wallms" --launcher-evidence-path "$CELL_HOME/result.launcher.json" --timeout-ms 120000 -- -p "$PROMPT" --output-format stream-json --verbose
```

Codex CMO cell:

```bash
./bin/throne-cli create-agent --model gpt-5.4 --effort 1 --name cmo-codex-cell --supervisor alpha-cmo-claude-md-optimization --role Agent --cwd "$CELL_HOME/work" --non-campaign --bypass-preset-agent --harness-executable /absolute/path/to/codex --run-custom-harness-to-exit --clear-environment --env "HOME=$CELL_HOME" --env PATH=/usr/local/bin:/usr/bin:/bin --env TERM=dumb --env "CODEX_HOME=$CELL_HOME/.codex" --stdout-path "$CELL_HOME/result.jsonl" --stderr-path "$CELL_HOME/result.stderr" --exit-status-path "$CELL_HOME/result.rc" --wall-time-path "$CELL_HOME/result.wallms" --launcher-evidence-path "$CELL_HOME/result.launcher.json" --timeout-ms 120000 -- exec --json "$PROMPT"
```

Under Throne, CMO uses this seam for live cells. CMO's throne-less staging and analysis mode remains CMO-owned.

```bash
./bin/throne-cli create-agent \
  --model <model> \
  [--effort <1-6>] \
  --name <unique-name> \
  --supervisor <name> \
  [--escalation <name>] \
  [--role <role>] \
  [--cwd <path>] \
  [--prompt <text>] \
  [--requires <capability-expression>] \
  [--bypass-model] \
  [--bypass-zero-quota] \
  [--bypass-opencode-telemetry-unavailable] \
  [--bypass-effort] \
  [--objective-code <code> | --non-campaign] \
  [--bypass-alpha-guardrail] \
  [--bypass-preset-agent] \
  [--harness-executable <absolute-path> [-- <complete harness argv…>]] \
  [--run-custom-harness-to-exit …]
```

There is no `--bypass-harness` flag. `--harness` itself is refused outright for
fresh requests (`create-agent: --harness is no longer caller-selectable; infer
the harness from the canonical model registry by passing --model.`) — the
canonical model registry (`src/harness-routing/model-registry.ts`) derives the
harness from `--model`, so choosing a different harness means choosing a
different `--model`, never a bypass flag. The only escape from the
registry/role-pool machinery entirely is `--harness-executable` plus
`--run-custom-harness-to-exit`, a distinct one-shot custom-executable path
documented under "Run a custom harness to process exit" below — it is not a
routing bypass.

A fresh spawn may declare strict `planning`, `coding`, `validation`, and
`non-coding` minimums with `--requires`. The spawning workflow first reads
`list-harnesses-and-models` and preselects a qualified in-pool pair. Production
then evaluates the actual final harness/model after every model, usage,
harness, configured-forward, and effort transformation. Malformed, unknown, or
duplicate requirements refuse before routing reads. An unscored or below-floor
final route refuses after steering telemetry but before registration, trust,
the independent native quota gate, or launch effects.

Quote the complete expression. An unquoted `>` is shell redirection rather than
part of the argument:

```bash
./bin/throne-cli create-agent ... \
  --requires "coding>=3,non-coding>=4"
```

New successful fresh `spawn.json` records contain machine-readable normalized
requirements, authoritative scores for the final pair, and a passing verdict.
Exact registered resumes skip fresh requirement parsing, steering, final
capability evaluation, and ledger writes while retaining the independent
native quota policy. Effort never changes capability scores. Every existing
model, usage, effort, harness, preset, and Alpha bypass retains only its named
scope; none waives the declared final floor.

This restored final-route check is legacy safety maintenance permitted by the
freeze, not a new legacy command or user-visible capability.

**Effort is steered, not chosen, on EVERY fresh pair.** `resolveFreshEffort`
(`src/harnessrouting/steering.ts`) resolves an omitted `--effort` by clamping the numeric
`ACTIVE_TARGET_EFFORT` from `src/config.ts` into that model's registered
`EFFORT_RANGES` band — for every harness and every model, not a two-pair
exception. Inspect `list-harnesses-and-models` for each model's current ordinary
resolved effort; do not copy the current target into documentation.
Explicit `--effort`
at that ordinary score is equally ordinary; every other explicit score is
REFUSED with a steering message naming the ordinary score and `--bypass-effort`,
which forces the requested score for that one spawn and is recorded as durable
policy-override evidence. That flag clears only the effort steer: it never
bypasses active-plan membership, declared final capability or validation floors,
usage/quota, harness/model validation, objective, role/preset, trust,
registration, or lifecycle checks. Exact registered dead resumes keep their
stored effort without a new `--bypass-effort`; conflicting explicit resume
flags still refuse.

### Objective contract

Objective flags govern only new `Alpha` and `Shadow` campaign roles. A new
campaign Alpha supplies one ASCII-alphanumeric token with
`--objective-code <code>`. The token is canonicalized to lowercase, the stored
handle must be `alpha-<code>-...`, and `create-agent` records
`objective_code: <code>` in `~/.throne/data/<name>/spawn.json` plus
`Campaign objective code: <code>` in `identity.md`. `--objective-code` and
`--non-campaign` are mutually exclusive.

A new campaign Shadow never receives `--objective-code`. It inherits the
supervising Alpha's recorded contract and must use the canonical
`shadow-<code>-...` handle. The read-only derivation command is the single
operator seam for that handle:

```bash
./bin/throne-cli derive-shadow-name-from-alpha <supervising-alpha-name> <slice-id>
```

The command reads the Alpha's `spawn.json` evidence and prints the complete
handle. It refuses contradictory fields, invalid or mismatched recorded codes,
and missing or unreadable evidence. A pre-contract Alpha with readable spawn
evidence that has neither `objective_code` nor `non_campaign` gets only the
narrow compatibility fallback of the first canonical token after `alpha-`.
Unreadable evidence never enters that fallback. The `/execute-todos` throne
recipe uses the exact printed handle for the Shadow tree, `--name`, ledger,
`send-agent`, `agent-logs`, merge, and reap commands; it must never hand-copy an
objective code or pass one independently to a Shadow.

Deliberate Alpha or Shadow infrastructure outside a campaign must opt out with
`--non-campaign`. The flag records `non_campaign: true` in `spawn.json` and
`Campaign status: non-campaign` in `identity.md`. A Shadow under a
non-campaign Alpha must opt out explicitly as well; the exemption is not
inherited as an implicit campaign. The Regent is not registered through
`create-agent` and is exempt, while ad-hoc roles remain outside this contract
only when their explicit role admission uses `--bypass-preset-agent`.

| New or resumed target                       | Objective contract                                                         | Durable evidence and name behavior                                                          |
| ------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Campaign Alpha                              | `--objective-code <code>`                                                  | Lowercase code in `alpha-<code>-...`, identity, and `spawn.json`.                           |
| Campaign Shadow                             | No objective flag; inherit from the supervising Alpha                      | Live derivation returns `shadow-<code>-<slice-id>`; use that exact handle.                  |
| Non-campaign Alpha or Shadow infrastructure | `--non-campaign`                                                           | `non_campaign: true`; no objective code is recorded or required.                            |
| Registered resume                           | Flags are optional; any supplied objective flag must match stored evidence | Stored name, recipe, identity, and evidence remain exact; no retroactive policy is applied. |

Native Claude models launch through `claudey`. Native Codex agent creation is
disabled: every fresh GPT/Codex outcome is finalized as `codexy-all-omni`, even
when steering selects a `codex`-harness model; no fresh `codexy` process is
permitted. There is no `--bypass-harness` flag to temporarily select `codex`
instead — the harness is a pure function of the resolved `--model`. Inspect
`./bin/throne-cli list-harnesses-and-models` for the live selected harness and
launcher. Explicit configured non-native alternates remain available where
policy admits them, chosen via `--model`. Unknown slugs are refused before
spawning. opencode is a first-class registry harness: fresh models whose
canonical entry uses `opencode` are admitted by the normal routing and role pools and launch through the
throne-owned `opencodey` launcher (see `launchers.md`).

`claudey-all-omni` is a separate, experimental standalone launcher, not a
`create-agent` route and not a `switch-agent-model` launcher family. It admits
only `codex/gpt-5.6-sol`, points Claude Code at loopback OmniRoute on port
20128, reads the dedicated mode-`0600` OmniRoute ingress key, and pins all
background/default model selectors to that same provider-qualified model. No
Claude-family identity is admitted: the available candidate lacked successful
end-to-end generation and tool-use proof through CLIProxyAPI, so the route
refuses every `claude/...` spelling rather than relabeling GPT output. Its
OmniRoute policy and provider-row lifecycle is managed by
`provision-claudey-all-omni install|validate|remove`; see `omniroute/README.md`
for prerequisites, exact policy, rollback, and the live proof deferred to the
99b deployment slice. Canonical `claudey-all` remains the direct port-8317
CLIProxyAPI launcher used by stored legacy GPT-on-Claude resumes, so this
experiment changes neither fresh spawn routing nor model-switch behavior.

Fresh GPT registrations follow the configured forward policy by default. An
explicit non-native alternate is admitted by naming it directly with
`--model`, never by a `--bypass-harness` flag — no such flag exists; native
`codex` is never an alternate and is finalized to `codexy-all-omni`.

Spawns a new herdr harness under a unique `--name`. The caller supplies only a
model identity; the canonical model registry supplies its harness and aliases.
Caller-selected `--harness` is refused for fresh requests. The spawn lifecycle is
**registration-before-launch**: guards validate inputs, then `~/.throne/data/<name>/`
(identity + spawn spec) is written _before_ the harness is started, so any
post-spawn failure leaves either no artifacts or a registered agent — never a
live pane without a record.

**Re-run semantics:** when `create-agent` is invoked with the same `--name`
against a registered-but-not-launched agent (e.g., after a prior crash):

- If a **live agent** exists under that name, refuse before any quota read or
  second-pane side effect.
- If the agent is **registered but not running**, conflict-check the supplied
  model/effort/cwd against `spawn.json`, then relaunch the stored recipe
  exactly, marked "Resumed" not "Spawned". The resume skips current active-plan
  membership, capability admission, usage routing/remapping, final pool
  defense, and identity/opening-record/spec writes. A stored native `claude/fable` or
  `claude/opus` pair still passes through the common final native quota gate;
  every other stored pair reads no Claude quota for that gate. "Resumed" means
  a fresh harness process built from the stored recipe, not native-session
  continuation. A refused native resume retains byte-identical identity and
  spawn ledgers. A historical stored native `codex` recipe instead refuses
  before trust, writes, tab creation, or launcher execution. Its durable files
  remain byte-identical; migration is explicit reap followed by a fresh
  `codexy-all-omni` registration.

The launch argv is derived by `harness.ts`'s `buildLaunchArgv`: native Claude
runs `<throne>/bin/claudey --model <model> --effort <token>`; fresh Codex-family
agents run `codexy-all-omni`; opencode runs `<throne>/bin/opencodey -m <model>`
with no effort token (its registered effort band is the fixed ordinary 1–1; an
exact registered opencode resume appends `-s <id>`); and an exact
stored legacy Claude/GPT resume reconstructs `claudey-all --model <model>
--effort <token>`, the one launcher still resolved from `PATH`.
The portable `--effort` score (1–6) maps a launch token: claude
`low|medium|high|xhigh|max|ultracode`, codex `low|medium|high|xhigh|max|ultra`
(effort 6 = the harness's max tier); opencode emits no effort token at all.
The command writes `~/.throne/data/<name>/identity.md`
with the agent's role and two addresses — `--supervisor` (routine contact, the
creator) and `--escalation` (blocker contact, defaults to the Regent) — and
writes the complete composed launch instructions byte-for-byte to
`~/.throne/data/<name>/opening-prompt.md`. A disabled-default Alpha admitted through
`--bypass-alpha-guardrail` gets the exact target-named `Policy override for
<name>:` statement in both durable records. This one-spawn evidence names the
requested `(harness, model)` and survives registered relaunches; ordinary
identities remain byte-identical when no override exists.
`--role` defaults to `Agent` — but the default is no longer silently spawnable:
a non-preset role (including the bare `Agent` default) is refused without
`--bypass-preset-agent` (see below).

The complete opening instructions are built from up to three parts and persisted
before launch in `~/.throne/data/<name>/opening-prompt.md`. They never ride the launch argv:
the harness starts with only its launcher and short model/effort flags. Native
Claude and resident custom harnesses receive that complete body through
`deliverOpeningPrompt`, exactly once and byte-for-byte. Native Codex instead
receives one compact, completely observable bootstrap that gives the exact
absolute paths of both `opening-prompt.md` and authoritative `identity.md` and
orders the harness to read them before acting. The durable opening record retains
every byte of a long or multiline `--prompt`; the compact transport never treats
a clipped prefix as proof. Ordinary `send-agent` transport is unchanged. A spawn
is reported successful only once its selected submission is proven; a delivery
that fails before any text was written is retry-safe, and one that fails after
delivery began is indeterminate and is never automatically resent. The three
complete-record parts are:

- the **identity sentence** (chain of command), always first;
- for `--role Alpha`, a **standing instruction** to execute the objective by
  running `/write-and-execute-todos` — inside the throne, running it means the
  Alpha itself spawns a real Shadow per slice (via `create-agent --role
Shadow`); the Regent never spawns an Alpha's Shadows. DONE and blocker
  `send-agent` messages wake the Alpha immediately; no dependency-ready work
  makes it idle with no scheduled sleep, query, or model turn. `agent-logs` is
  limited to one completion review, an explicit blocker, or silence beyond the
  30-minute Regent heartbeat interval, and `agent-statuses` is not a polling
  substitute. Generated Alpha text containing a shell loop that combines sleep
  with either query command is refused before registration or launch. A non-Alpha
  role gets no such instruction;
- `--prompt <text>`, an optional **objective brief** appended after the identity
  block.

A registered native Codex recipe is historical migration evidence, not runnable
compatibility state; relaunch refuses without rewriting its durable records.

`--role Shadow` applies the `shadow-` role prefix idempotently, but campaign
work must use the complete objective-coded handle returned by
`derive-shadow-name-from-alpha`. That returned name is the single addressable
handle used everywhere: `~/.throne/data/<name>/`, identity, spawn spec,
`send-agent <name>`, `agent-logs <name>`, and the herdr tab label. The
`/execute-todos` Shadow-spawn path obtains this value from the supervising
Alpha's durable evidence rather than constructing `shadow-<slice-id>` itself.

Inside the throne this is how a per-slice **Shadow** is born: `/execute-todos`
(when it detects throne context) first runs
`derive-shadow-name-from-alpha <the Alpha> <slice-id>`, then pairs the exact
returned handle with `spawn-git-tree <handle>` and `create-agent --role Shadow
--name <handle> --supervisor <the Alpha> --escalation Regent --cwd <slice tree>`.
It delivers the slice's assignment through a file the Shadow reads, then uses
the same handle for monitoring, merge, and reap. Large multi-section briefs
remain file-based, and the one-line `send-agent` pointer keeps bulk content out
of pane transport. See AGENTS.md → "Shadows are real harnesses in the throne"
and the `execute-todos` skill's Rule 2 "Throne context" paragraph.

Four boolean flags implement the spawn policy. Two are uniform steer bypasses — `--bypass-model` and `--bypass-effort`, each disabling exactly its own steer and nothing else; usage steering is mandatory (see "Spawn steering" below).
There is no `--bypass-harness` flag; an alternate fresh-GPT harness route is
chosen by naming it directly with `--model`, described above. The
remaining two gate a floor and a role rather than a steer. **`create-agent`
spawns only
the preset roles `{Alpha, Shadow}`** without `--bypass-preset-agent`; every
other role (the generic `Agent` default, `none`, canaries, probes) is refused
(exit 1, nothing spawned or written) unless the flag is passed. The gate keys
ONLY on the spawned role, never the caller's identity — anyone may spawn an
Alpha or a Shadow. A separate cross-role-prefix guard refuses a name carrying
a foreign role's prefix, so the `agent-shadow-02` double-prefix can no longer
occur.

`src/config.ts` is the single declarative source for active-plan membership.
New spawns are classified as `Alpha`, ordinary `Shadow`, or `ShadowSlice99`
(the last by the final `shadow-99…` name), then their exact requested
`(harness, model)` must belong to the live role pool before capability or
usage policy runs. Inspect `./bin/throne-cli list-harnesses-and-models` for
the active preset and its current ordered pools. The active pool is the OUTER
boundary only, admitting every pair a steer or a `--bypass-model` may land on,
so no steer target is walled off by the preset. Which admitted row a given
spawn actually gets is decided by the steers below plus the role floors.

Every routing, validation-model selection, and equivalent-tier remap candidate
is constrained to that same immutable pool, and the exact resolved final pair
is checked again before launch. An excluded explicit
pair refuses clearly and is never silently substituted. There is no active-plan
bypass: `--bypass-preset-agent` only admits a non-preset ad-hoc role; that role
has no `PlanRole` and skips pool membership, while all later gates — including
the final native quota gate — still apply.

### Spawn steering

All model, usage, and effort steering for a fresh spawn is ONE call into the
steering engine: `steerSpawn` (`src/harnessrouting/steering.ts`). `create-agent` parses
the flags, fetches usage, resolves the supervising Alpha's pair, invokes the
engine once, then applies the result — it holds no steer logic of its own, and
`src/config.ts` holds the steer data with no logic. The engine returns either a
launch (pair + effort + a note recorded on the `Spawned …` line) or a refusal
whose message names the steer, the compliant spawn, and the exact bypass flag.
Usage readings are fetched only while a steer that would consume them is
unbypassed; omitted or unreadable usage never blocks a spawn.

**Metric model steer.** The capability registry in `src/harnessrouting/` owns the
current allowed set; inspect `list-harnesses-and-models` before spawning. A
divergent request is refused toward that set unless `--bypass-model`. Within the
set, usage balance prefers the higher projected remaining at reset, comparing
the fable-scoped weekly forecast against the aggregate weekly forecast and
falling back to current remaining only when evidence is insufficient. An exact
tie and an unreadable window both leave the balance inert with a recorded note.
Once Claude aggregate projected remaining at reset (or current remaining when
forecast evidence is insufficient) is at or below the configured
the configured desperation threshold, usage steering selects the strongest
usable candidate at ordinary effort; usage steering is mandatory. When a
telemetry source is unusable the fallback is recorded rather than waiting.

**Capability-based `99` gate steer.** The live capability registry is
keyed by the supervising Alpha's harness, so the gate never grades work in the
voice that produced it. Inspect `list-harnesses-and-models` for the live
eligible validator scores from `list-harnesses-and-models`
for code-level provenance. The Alpha's pair is
read from the supervisor's durable `~/.throne/data/<supervisor>/spawn.json`; an
undeterminable supervisor leaves the steer inert with a loud recorded note
(fail-open, but speaking). While the target IS usable, a divergent request is
refused unless `--bypass-model`. The metric-selected route is best-case: when
its authoritative aggregate or session quota is zero or otherwise unusable, the
engine SUBSTITUTES the strongest actually usable in-pool pair clearing
`validation>=4`, preferring the Alpha's capability-equivalent candidate when it
is available. Durable
routing evidence names the ideal, its unusable state, and the fallback. The
substitution never lands below the validation floor or outside the pool; if no
usable qualifying in-pool pair exists, the hard gates refuse.

**Execution-shadow metric steer (`01`–`98`).** The active role pool owns the
`list-harnesses-and-models`; capability and usage metrics select among its rows.
Everything else is usage-balanced across companies over the reserve-filtered
pool. `create-agent` reads both harnesses' live plan usage through the shared
Nest-owned usage adapter and cache-backed `getUsagePayload` pipeline (see
`plan-usage-remaining` below), so a burst of
spawns reuses a recent reading and rides through a transient endpoint blip
instead of hammering the endpoint or failing. It first filters both harnesses to
the active role pool; excluded telemetry cannot influence signal health,
exhaustion, or selection. Among admitted usable harnesses, Claude is selected
only when its projected remaining at reset leads Codex's by at least the
inclusive `CLAUDE_PROJECTION_LEAD_THRESHOLD_PCT` in `harnessrouting/usage.ts`, with
current remaining as the explicit basis when sufficient forecasts do not
exist; every smaller lead conserves the scarcer Claude pool and routes to
Codex. The recorded route reason names the basis, both values, the computed
lead, and the threshold. Claude is excluded when its 5-hour
remaining reaches the runtime `SESSION_FLOOR_PCT` only when an admitted fallback
exists. Inspect `list-harnesses-and-models` for the current threshold. On a
route to the other admitted harness the requested model is remapped to the equivalent
`MODEL_POLICY` coding tier — so an explicit in-set pair is **not** exact by
itself: the tier is preserved, the harness may be remapped with a recorded
reason, and no flag pins the requested pair against usage steering. No non-coding capability gate participates in the remap.

**Effort steer.** Applied last, on the pair the model steer resolved, exactly as
described under the effort contract above: omitted `--effort` takes the active
preset's ordinary score for that model's range, a divergent explicit score
refuses naming `--bypass-effort`.

**Bypasses are one-to-one.** `--bypass-model` disables only model steering; `--bypass-effort` disables only the effort steer. Usage steering, bounded-history forecasting, and history reads are mandatory. There is no `--bypass-harness` flag; an explicit fresh GPT harness request is made by naming it directly with `--model` — defaults still follow the configured forward GPT policy and exact stored resumes remain exact.

For the explicitly requested OpenCode DeepSeek route,
`--bypass-opencode-telemetry-unavailable` disables only the unusable-telemetry
refusal. Fresh, complete, positive telemetry needs no such flag. Trustworthy
exact-zero telemetry remains refused unless `--bypass-zero-quota` is supplied;
neither bypass implies the other. This admission path is the legacy deepseek
canary, retained for stored `codexy-all-omni` recipes; fresh DeepSeek spawns
use the first-class registry model route instead.

**Floors and pools are separate walls the caller enforces around the engine.**
For a **new Alpha**, `thinkingRoleCapabilityGuard` requires the FINAL resolved
pair to clear `PLANNING_FLOOR` (`planning>=4`). Current scores and qualifying
pairs come from the executable capability registries shown by
`list-harnesses-and-models`. A below-floor Alpha uses the loud
`--bypass-alpha-guardrail` when the durable override contract permits it; a launch the engine marked as
the DESPERATION redirect carries that floor exception automatically, recorded
loudly as a policy override, because the law names Sol as the automatic
desperation target and a manual flag would make the automatic path
non-automatic. `--bypass-alpha-guardrail` overrides default Alpha capability
policy for one spawn only, persists its exact evidence in the new Alpha's
identity/opening prompt, and never creates a validation or active-plan bypass.
For a **new recognized Shadow `99` gate**, the same guard requires
`VALIDATION_FLOOR` (`validation>=4`). The executable validation registry shown
by `list-harnesses-and-models` determines which current pairs qualify. There is no validation bypass.
Registered Alpha/`99` relaunches have already reconciled their stored recipes
before these new-spawn checks.

**Final native quota gate:** once the exact final pair is known, both new spawns
and dead registered resumes targeting `claude/fable` or `claude/opus` evaluate
that exact model through `src/create-agent/native-availability.ts`. Fresh authoritative
`exhausted` evidence hard-refuses and names the native model, exhausted window,
remaining percentage, and reset time. Usage steering cannot clear that refusal. `stale-unknown`, `unknown`, and `source-failure` warn exactly once and
proceed because stale, malformed, missing, or failed telemetry is not proof of
exhaustion. The `5h` window applies to both models; a matching model-scoped
weekly window overrides aggregate weekly for that model. If routing and the
final gate both need Claude telemetry, one memoized promise supplies both.
This gate finishes before Codex trust, registration writes, `afterRegistration`,
tab creation, or harness execution; a refused new spawn leaves no registration
or launch effects, and a refused resume leaves its existing ledgers untouched.

The hermetic acceptance canary
`test/create-agent-native-quota.canary.test.ts` executes the actual
`throne/bin/throne-cli create-agent …` path with a scratch `HOME`, synthetic
Claude OAuth credentials, a fetch preload owning the usage endpoint, a fake
first-in-`PATH` `herdr`, and fake native launchers reached through
`THRONE_LAUNCHER_DIR`. Fresh exhausted-Fable telemetry must
produce a nonzero refusal with reset evidence, no registration, no herdr
mutation, no harness execution, and no un-intercepted network; `finally`
cleanup removes all canary artifacts even when an assertion fails.

**Spawn tasking confirmation.** Enqueuing the opening prompt is not proof it
was ever consumed — `deliverAgentOpeningPrompt`
(`src/create-agent/opening-prompt.ts`) additionally confirms, for a genuine
resident launch that carried a caller-supplied `--prompt` on the Claude
harness, that the spawned agent's own transcript actually shows assistant
activity before `create-agent` reports success. Confirmation calls
`awaitSpawnTaskingConfirmation` (`src/session/runtime-model-acceptance.ts`),
a bounded poll — every 3 seconds (`SPAWN_TASKING_POLL_INTERVAL_MS`), up to a
90-second deadline (`SPAWN_TASKING_BOOT_GRACE_DEADLINE_MS`) — around the same
transcript-attestation primitive (`checkAgentRuntimeModelAcceptance`) the
opening prompt's delivery result is derived from. This is additive: the
existing `Spawned "<name>" ...`/`Resumed "<name>" ...` line and the exit code
for a launch that genuinely succeeded are unchanged, and every non-Claude or
non-resident-launch spawn skips confirmation entirely.

The confirmed result prints as a second stdout line, `Spawn tasking:
<outcome>.`, where `<outcome>` is one of four `SpawnTaskingOutcome` values
(`src/create-agent/create.types.ts`), derived by
`deriveSpawnTaskingOutcome`:

- `tasked` — the enqueue succeeded and the transcript confirmed assistant
  activity following the requested model before the deadline.
- `enqueued-unconfirmed` — the enqueue succeeded but the bounded wait expired
  with no confirming transcript evidence; this is the exact shape of a
  swallowed opening prompt and the outcome an operator should treat as
  "assume untasked, go verify."
- `quarantined-not-tasked` — the enqueue succeeded but the transcript shows a
  different model than requested.
- `not-applicable` — confirmation was never attempted: a non-Claude harness,
  a resume that left the harness already live, or no genuine caller-supplied
  `--prompt` to confirm.

Confirmation evidence is written the same way `checkAgentRuntimeModelAcceptance`
already persists it for every phase, under
`~/.throne/data/<name>/runtime-model-evidence/spawn-<attestation|quarantine>.json`
(`attestation` for a matching model, `quarantine` for anything else) — the
`spawn-` phase prefix keeps it distinct from the files `send-agent`'s own
runtime-model gate writes for its own phases. No existing project doc yet
describes that `send-agent` gate to cross-reference here.

## switch-agent-model

```bash
./bin/throne-cli switch-agent-model <agent> --model <target> [--effort <1-6>] [--confirm] [--bypass-model] [--bypass-effort] [--bypass-alpha-guardrail] [--bypass-zero-quota]
```

Registered Alpha and Shadow switches reapply the applicable active model pool,
steering, effort, capability-floor, role-floor, stored-objective, native Codex,
and exact-zero quota restrictions before closing the old harness.
`--bypass-model` disables only model steering, `--bypass-effort` disables only
effort steering, `--bypass-alpha-guardrail` disables only the thinking-role
capability floor, and `--bypass-zero-quota` disables only exact-zero quota
refusal. Hard pool membership, declared capability requirements, stored
objective evidence, recognized role identity, native-Codex refusal, transaction
safety, and launcher-family preservation remain enforced under every bypass.

Changes the model of one registered, live Claude or Codex agent by closing its
current tab and exact-resuming the same native session under a different model.
The registered name, cwd, chain of command, transcript, identity bytes, optional
tree evidence, and launcher family are preserved. The command does not send a
slash command into the agent and does not write provider defaults such as
`~/.claude/settings.json` or `~/.codex/config.toml`.

Only same-launcher-family moves are supported:

- native Codex models may switch only to another `codexy` model;
- native Claude models may switch only to another `claudey` model;
- legacy GPT-on-Claude models may switch only to another `claudey-all` model.

A native Claude model cannot cross to GPT-on-Claude even though both recipes
record `harness: "claude"`; their launchers and provider sessions differ.
Cross-harness and cross-launcher switching is refused before the current tab is
closed.

Without `--confirm`, the command prints the exact current and proposed recipes,
exits nonzero, and reports `outcome: refused-before-close; spawn.json changed:
no`. Rerun the reviewed command with `--confirm` to execute it. The target uses
the stored effort unless `--effort` is supplied. Either value must be an integer
from 1 through 6 and must fall within the configured range for the target model;
an unsupported effort or model is a pre-close refusal.

The switch is available only when the command can prove all of these conditions
from the live pane and durable registration:

- the name resolves uniquely to the exact registered pane and cwd;
- the agent status is `idle` or `done`, not `working`, `blocked`, or `unknown`;
- the active supported composer is empty and no external editor or modal owns
  the pane;
- `spawn.json` is readable, names a standard supported recipe, and has no custom
  harness executable or passthrough argv;
- the live `/status` result exposes the current model, cwd, and native session;
- a Codex session prefix resolves uniquely against `~/.codex/sessions`, and any
  stored full `session_id` agrees with the live session.

A resident draft is never discarded. A busy/active agent, nonempty composer,
custom recipe, unsupported harness, cwd or pane drift, ambiguous session, or
missing evidence refuses before close where ownership is still certain. Wait for
the agent to settle or preserve/submit the draft through its normal owner; do
not clear a composer merely to force a switch.

After the replacement start is accepted, verification tolerates only startup
frames whose active composer is unavailable or whose screen cannot yet be
parsed. It makes 61 read-only observations at 250 ms spacing, spanning exactly
15 seconds between the first and last observation, while continuously holding
the replacement-pane lock. It never types, clears, submits, presses a key, or
closes a pane during that window. A confirmed nonempty composer, identity or cwd
drift, status rejection, or unsupported harness stops immediately without a
readiness retry. Exhaustion is indeterminate, preserves the replacement pane,
and leaves `spawn.json` unchanged.

On a confirmed switch, phase lines describe the transaction. Target and restored
recipe verification require the same native session, model, cwd, and compatible
effort. Effort is proved from `/status` when the harness exposes it; otherwise
the exact resume launch argv is the bounded evidence. Only after target
verification does the command update and read back `spawn.json`, recording the
new `model`, `effort`, full `session_id`, `switched_at`, and
`switched_from_model`.

The final status line is the operator verdict:

- `outcome: switched; spawn.json changed: yes` means the target exact-resume and
  durable update were both verified.
- `outcome: refused-before-close; spawn.json changed: no` means no tab was
  intentionally closed and retry is safe after correcting the stated refusal.
- `outcome: target-failed/rollback-restored; spawn.json changed: no` means the
  target failed, the previous exact session/recipe was verified running again,
  and durable spawn evidence stayed on the previous recipe.
- `outcome: target-failed/rollback-failed; spawn.json changed: no` means the
  target failed and the previous recipe could not be verified after rollback;
  inspect the named agent and phase log before taking any further action.
- `outcome: indeterminate` means pane ownership, launch state, preserved bytes,
  or durable evidence could not be proved. The accompanying `spawn.json changed:
no|yes|unknown` is the measured durable state, not permission to rerun blindly.
  Inspect `agent-statuses`, `agent-logs <name> --source visible`, and the printed
  phases before recovery.

Startup reconciliation remains backward compatible. A registration with a valid
full `session_id` exact-resumes that native session after a crash or reboot and
uses the transcript-aware recovery prompt. A legacy registration without one
still follows the established fresh-process recovery path from its normalized
stored recipe and work ledger. A successful model switch adds durable session
evidence for subsequent exact startup recovery; this command does not rewrite
legacy records merely by inspecting them.

The real provider/Herdr canaries are opt-in and are never part of ordinary CI:

```bash
THRONE_LIVE_SWITCH_AGENT_MODEL=1 node --test test/switch-agent-model-live.test.ts
```

That command runs native Codex Sol → Terra → Sol, native Claude Sonnet → Opus →
Sonnet, and GPT-on-Claude Sol → Terra → Sol. Each route uses a unique name of at
most 32 characters, a scratch git repository under `~/tmp`, the live
`~/.throne/data` ledger, and finally cleanup that reaps
the tab/registration, removes scratch and archived canary evidence, verifies an
uncommitted sentinel survived, and fails if the relevant global provider config
was not byte-identical. Missing launchers, provider state, session evidence,
quota, network, or any cleanup proof is a canary failure; without the opt-in
environment variable all three routes are explicitly skipped.

## reap-agent

```bash
./bin/throne-cli reap-agent <name> --reason <enum> [--force] [--bypass-marker] [--force-discard-memories]
./bin/throne-cli reap-agent <name> --reason cancelled --archive-cancelled-unmerged [--force] [--bypass-marker] [--force-discard-memories]
```

Tears an agent down entirely through the tooling — the teardown counterpart to
`create-agent` + `spawn-git-tree`, so reaping is never again scattered raw
`herdr pane close` + `rm -rf`. After all refusal-grade checks pass, it closes
the agent's herdr **tab** (via `closeAgentTab` — falling back to its pane),
removes the git **worktree** from the recorded target repo, safely deletes the
exact merged dedicated **branch** for ordinary reaps, and **archives**
`~/.throne/data/<name>/`. The distinct cancelled-unmerged disposition retains its exact
local branch instead; its full contract is below. The worktree is found by
branch rather than a reconstructed path and removed through `git worktree
remove --force` + `prune`; ordinary branch deletion is permitted only through
the separate safety gate below. A reaped agent drops out of `agent-statuses`
entirely.

- **Live reapability claim required.** Before any live agent teardown,
  `reap-agent` reads the target's latest pane message and requires the exact
  one-key JSON claim `{"reapable":"completed"}` (also accepting `cancelled`
  and `task_restart_required`). The same claim may appear as an anchored token
  within the latest message. Retired `reapable_status` / `__REAPABLE_*__`
  markers never authorize teardown. An absent or unreadable claim refuses and
  directs the caller to message the agent to distinguish reapable from merely
  idle. `--bypass-marker` alone overrides this precondition; `--force` does not.
  For a non-working live agent whose durable spawn record declares
  `deliverable_shape: "verdict-only"`, the latest canonical `completed` claim
  proves completion only when the supervising Alpha's delivery/completion stamp
  also exists through `hasDeliveryCommit`. A missing stamp refuses teardown;
  ordinary and working agents retain their existing content-proof refusal.

- **Explicit reason required.** Before archival, reap records `reaped_at` and
  `reap_reason`, then appends the complete lifecycle row to
  `data/stats/agent-timings.jsonl`. `--reason` accepts
  `completed|completed-unpublishable|stalled|force|orphan|superseded|error|cancelled|scratch|other`;
  `completed-unpublishable` records work that finished successfully but could
  not publish, and remains distinct from cancellation in timing, queue, and
  launch-ledger history;
  missing or invalid values are rejected before any teardown mutation.
  `--reason scratch` is for a disposable diagnostic probe that completed no
  real work (e.g. a send-agent canary target) — `agent-stats` excludes
  `scratch` rows from its completion/stall breakdowns entirely, so a
  throwaway probe never inflates or shrinks a harness's measured completion
  or stall rate. Use `scratch`, not `completed` or `other`, for that case.
  `--reason cancelled` is valid **only** with `--archive-cancelled-unmerged`, and that
  mode is valid **only** with `--reason cancelled`; either mismatch refuses
  before teardown.
- **Completion push hook.** A successful `--reason completed` reap evaluates the
  notification predicate in `src/notify-lord/notification.service.ts`: completed **Alphas** notify by
  default, and completed **Shadows** notify only when
  `THRONE_NOTIFY_SHADOWS=1`. The posting target is
  `THRONE_NTFY_SERVER_URL` / `THRONE_NTFY_TOPIC` or the defaults baked into
  `src/notify-lord/notification.service.ts`. See `agent_docs/ntfy-phone-notifications.md` for the live
  server/topic contract and operator steps.

- **Cancelled-unmerged archival is explicit.** The single supported replacement
  for FPC's historical manual `tree-base.json` rename is:

  ```bash
  ./bin/throne-cli reap-agent <name> --reason cancelled --archive-cancelled-unmerged
  ```

  Never rename provenance by hand. This mode inherits every normal Regent,
  liveness, live-child, and uncommitted-memory refusal gate. `--force` retains
  its narrow meaning: it is only the live-agent/live-child override and can
  kill genuinely working agents. `--force-discard-memories` retains its separate
  narrow meaning: it explicitly permits discarding uncommitted
  `agent_docs/MEMORY/` files; `--force` alone does not. In particular,
  `--reason completed` is not a cancellation shortcut: it requires the ordinary
  merged-branch cleanup path.

- **Strict cancellation preflight.** Before any lifecycle mutation,
  cancellation requires readable, structurally complete, name-matching
  target-repository provenance; an exact existing local `refs/heads/<name>`
  with a full object ID; and proof that the tip is intentionally **not**
  reachable from the recorded merge-target branch (`tree-base.json` `branch`;
  an absent merge-target branch refuses outright). The initial preflight refuses a
  merged, missing, corrupt, mismatched, foreign, or duplicate-checkout
  candidate before closing the tab or mutating the worktree or ledger. The ref
  may be checked out only in its one dedicated managed worktree; the retained
  target checkout, a foreign checkout, or duplicate checkouts refuse. A retry
  after the dedicated worktree was already removed is allowed only when all of
  the same ref/provenance proofs still hold.
- **Post-preflight race boundary.** After preflight succeeds, the accepted
  teardown closes the eligible live tab and removes the dedicated worktree
  before preserving provenance and re-verifying the unchanged unmerged ref and
  tip. If the ref moves after preflight, archival refuses at that verification
  stage — after tab/worktree teardown — while the moved ref and preserved
  `tree-base.cancelled-unmerged.json` marker remain in the live ledger for
  recovery with the explicit cancellation command. This is distinct from an
  initial proof failure, which leaves tab, worktree, and ledger untouched.
- **Cancellation disposition.** After preflight succeeds, reap closes the
  eligible live tab, removes the dedicated worktree, and preserves the original
  `tree-base.json` bytes byte-for-byte as
  `tree-base.cancelled-unmerged.json` (or verifies that marker is unchanged on
  retry). It then re-verifies the unchanged unmerged ref and tip. After that
  post-teardown verification succeeds, it records the `cancelled` timing reason
  and rotates the complete ledger under `~/.throne/data/.reaped/`. It emits a prominent
  `CANCELLED-UNMERGED` result
  that names the retained `refs/heads/<name>` and its exact tip. It does
  **not** merge, run `git branch -d` or `git branch -D`, delete a ref with
  `update-ref`, delete a remote ref, rename the recovery branch, or add a
  same-name reuse bypass.
- **`--force` reaps carrying a different reason share the mechanism, not the
  vocabulary.** The ancestry guard also blocks a `--force` reap whose
  `--reason` is anything other than `cancelled` — commonly a history-rewrite
  transplant campaign whose content already landed, so its commits are never
  literally reachable from the target. That case retains the branch through
  the identical mechanism above (ref kept, not merged or deleted, name reuse
  blocked, ledger archived complete) but is reported as `UNMERGED-RETAINED`,
  never `CANCELLED-UNMERGED` — that label, and the "cancelled" framing, is
  reserved for the explicit `--reason cancelled --archive-cancelled-unmerged`
  form. The timing row still records the caller's actual `--reason`
  untouched either way, so `agent-stats` reads it correctly regardless of
  which label was printed.
- **Retry and recovery boundary.** Before archival, the preserved provenance
  marker makes a partial failure recoverable: retry the same explicit
  cancellation command. Ordinary reap sees a live
  `tree-base.cancelled-unmerged.json` marker as an in-progress cancellation
  lifecycle and refuses with the exact retry command; it never treats that
  marker as missing branch authority. Ambiguous or changed provenance still
  refuses. The preserved local ref intentionally blocks exact
  `spawn-git-tree <name>` reuse until an operator inspects and deliberately
  resolves it. Start a new lifecycle name for non-destructive continued work;
  the throne never force-deletes the retained recovery branch on the operator's
  behalf.

- **Idempotency is mode-specific.** Ordinary reap treats an already-gone
  branch, worktree, or data dir as a clean no-op success. Explicit cancellation
  instead requires live `tree-base.json` or preserved
  `tree-base.cancelled-unmerged.json` authority until archival succeeds; after
  successful ledger archival, rerunning the cancellation command is an
  authority failure, not the ordinary already-gone no-op path.
- **Exact branch ownership.** Branch cleanup is authorized only by a readable,
  structurally complete `~/.throne/data/<name>/tree-base.json` whose canonical `name`
  exactly equals `<name>` and whose `repo` identifies the target project. The
  candidate is that canonical name; reap never searches other repos or sweeps
  similarly named branches. A missing/unreadable record authorizes no deletion.
  A legacy exact record without `repo` preserves the branch, warns that the name
  may not yet be reusable, and keeps the old worktree/archive behavior. A
  readable corrupt or mismatched record refuses before teardown mutation.
- **Merged and not checked out.** Before closing a live tab, reap proves the exact
  local branch tip is reachable from the recorded merge-target branch
  (`tree-base.json` `branch`) in the recorded repo. When that target has been
  deleted, ordinary orphan cleanup instead requires the exact tip to be retained
  by the repository's durable default branch — resolved from
  `refs/remotes/origin/HEAD` and its matching local branch, never from a
  checkout's `HEAD` — refusing when that authority is unresolvable; `--force` explicitly
  authorizes cleanup without that retention proof. An unmerged tip while the
  recorded target still exists, a
  branch checked out in the retained target worktree, or duplicate registered
  checkouts is retained and refused. After worktree removal, deletion rechecks
  the tip, recorded-branch reachability, and that no checkout remains, then
  uses `git branch -D`: git's own `-d` proves merged-ness against `HEAD` — the
  wrong base for a Shadow that lands in its Alpha branch — so the recorded or
  default-branch retention proof replaces it. Remote deletion and cross-repo
  scans are never used.
- **Ancestry alone cannot prove "delivered" for a transplant, and the guard's
  message says so.** The guard's sole evidence for reachability is `git
merge-base --is-ancestor <branch tip> <merge-target tip>`
  (`src/git-lifecycle/branch-authority.ts`, `requireReachableFromMergeTarget`).
  That proves delivery for an ordinary campaign that lands by merging its
  branch into a live target branch, because the target's history then
  contains the campaign's commits by construction. Since the history-rewrite
  delivery mode ("MIG") was introduced, a campaign may instead deliver by
  **transplanting** its delta onto whatever main looks like at delivery time —
  a rebase/cherry-pick-style reapplication, not a merge — which lands the
  intended content on the target but produces new commits with new hashes;
  the original campaign branch's own commits are never literally reachable
  from the target, merged or not. A fully and correctly delivered
  transplant-mode campaign therefore still fails this ancestry check. The
  guard's refusal message names both possible causes (unlanded work vs.
  transplant delivery) and does **not** tell the operator to merge the branch
  to satisfy it — following that advice on a transplant-delivered campaign
  would merge the branch's original, pre-scrub commit history (which can
  carry a scrubbed operator username) into shared history the transplant was
  specifically used to avoid polluting. Instead the message points at the
  safe paths: confirm which delivery mode actually landed the campaign
  (content diff/manifest against the target, not branch ancestry), then rerun
  with `--force` to complete teardown while preserving the branch as a
  recovery ref if the content is already confirmed landed, or with
  `--archive-cancelled-unmerged` if the branch carries genuine unlanded unique
  work. The ancestry check itself is unchanged and still refuses a branch
  with real unlanded work; teaching the guard to detect content-equivalence
  directly (so the transplant shape above no longer needs the operator's
  manual confirmation step) was considered and declined as unneeded
  machinery — a correctly-transplanted campaign whose branch ends up an
  ancestor of the target (the common shape) already reaps cleanly with no
  guard change, and a general content-equivalence proof has no robust
  definition once renames, reformatting, or partial delivery are possible.
- **Transactional teardown.** Accepted order is tab close → git worktree removal
  → proven branch deletion → existing timing/notification hooks → ledger archive.
  A branch-delete failure keeps or recreates the preflighted ref, restores a
  clean dedicated worktree when practical, and leaves `~/.throne/data/<name>/` live for
  retry. An archive failure likewise leaves the ledger live; the deleted branch
  was already proven reachable from the recorded merge-target branch, so its
  commit is still recoverable and a retry treats the absent branch idempotently.
- **Ordinary archive rotation enables reuse.** Successful archive paths are
  `~/.throne/data/.reaped/<name>/`, then `<name>-2`, `<name>-3`, and so on without changing
  earlier contents. Ordinary successful git cleanup removes the dedicated local
  branch, so real `spawn-git-tree <name>` and fresh `identity.md` / `spawn.json`
  registration can reuse the exact canonical name independently of old archives.
  Cancelled-unmerged archival deliberately retains the local ref and therefore
  remains an exact-name reuse barrier.
- **Safe.** It normally **refuses to reap a LIVE agent** without `--force` and
  touches nothing when it refuses. The one plain-reap exception is
  **completion-proven but stuck**: `REPORT.md` landed and herdr reports any
  status except `working`, meaning the finished agent could not self-exit. That
  path prints a loud `completion-proven` note, closes the tab first, and reaps
  without force. A report-less LIVE agent, or a report-landed LIVE agent still
  marked `working`, remains refused and requires `reap-agent <name> --force`.
  A dead/complete agent (no live process) reaps freely. If the roster or needed
  completion probe cannot be read, plain reap refuses rather than guessing.
  When forcing a live agent, the tab is closed FIRST and the whole reap aborts
  if that fails — a live process never has its worktree pulled out from under it.
- **Child-aware.** Before any mutation, reap finds registered agents whose
  identity names the target as supervisor. Any LIVE child makes plain reap
  refuse with the child's status and exact remediation; this applies even when
  the parent itself is DEAD or COMPLETE. `--force` recursively force-reaps LIVE
  descendants depth-first before the parent and aborts the parent if any child
  fails. A cycle refuses loudly. Force may kill genuinely-working children, so
  inspect the listed agents before using it. Non-live children never block and
  are listed after a successful teardown with a completion-sweep suggestion.
- **The Regent is protected.** `reap-agent Regent` (any case) is refused
  unconditionally — the Regent is managed by the self-heal watchdog
  (summon/dismiss), and `~/.throne/data/regent/` holds the durable QUEUE.

## complete-agent

```bash
./bin/throne-cli complete-agent <name>   # reap one finished agent
./bin/throne-cli complete-agent --all     # sweep every finished agent
```

Reap-on-complete: the SAFE teardown of a **finished** agent. Its durable signal
is a `REPORT.md` landed in `~/.throne/data/<name>/`. A gone process has the roster's
**COMPLETE** lifecycle; a process that remains LIVE but no longer reports
`working` is completion-proven and stuck unable to self-exit. Both delegate a
plain teardown to `reap-agent` — never a blanket force. The roster supplies both
`lifecycle` and `reportLanded`; `reap-agent` owns teardown, so this command
re-implements neither.

- **Reaps a COMPLETE agent.** A completed agent is not live, so `reap-agent`'s
  liveness gate passes and no `--force` is needed.
- **Reaps a done-but-stuck LIVE agent** when `reportLanded` is true and herdr's
  status is anything except `working`. The success output calls out the
  completion-proven teardown; the delegated reap remains plain, with no force.
- **Preserves the child gate.** Its delegated plain reap still refuses when the
  completed parent has LIVE children and propagates that failure. Complete or
  reap the listed children first; `complete-agent` never upgrades itself to a
  forced cascade.
- **Refuses every other LIVE agent.** A report-less agent keeps the existing
  refusal. A report-landed agent still marked `working` is actively working:
  wait and retry, or explicitly run `reap-agent <name> --force` (exit 1,
  touches nothing).
- **Refuses a DEAD agent** — registered, process gone, but with **no** completion
  report: it died mid-work, not complete (exit 1). Resuming-or-reaping such an
  orphan is the Regent's call (objective D2), not this command's; a deliberate
  teardown is `reap-agent --force`.
- **Idempotent.** An unknown or already-reaped name is a clean no-op success —
  the same contract `reap-agent` gives an already-gone agent.
- **The Regent is protected** — refused early here (and `reap-agent` hard-refuses
  it too).
- **`--all` sweeps** every COMPLETE agent plus every completion-proven,
  non-working LIVE agent in one pass. It skips working-LIVE and DEAD agents and
  is failure-isolated: one bad reap never suppresses the rest, and the aggregate
  exit is non-zero if any reap failed. It is a manual sweep, not a background
  auto-reaper — nothing is torn down behind an operator's back.

## spawn-git-tree

```bash
./bin/throne-cli spawn-git-tree <name> [--repo <path>] [--base <ref>] [--alpha <name>] [--non-campaign]
```

Creates a git worktree for a coding slice of a **target project dir** (`--repo`,
default: the throne's own; resolved to its git root via `git rev-parse
--show-toplevel`; omitting `--repo` still works for throne self-work but warns
loudly and names the resolved throne repo, so cross-repo campaigns must pass
it), placed under the throne-owned `~/.throne/worktrees/<repo-basename>/<name>` —
**outside the target repo**, never a host for throne scaffolding (overridable
via `THRONE_WORKTREES_HOME`).

**The base depends on the tree kind.** A name shaped `shadow-<code>-…` is a
**campaign Shadow**: its base is its supervising **Alpha's branch** (the branch
whose name equals the Alpha agent name), so the whole campaign accumulates on
that one branch instead of braiding each slice into the target. The Alpha is
resolved either from an explicit `--alpha <name>` (which must name a registered
Alpha whose durable objective evidence admits this Shadow name) or, absent the
flag, by scanning registered Alphas for the one whose campaign code equals the
`<code>` in the Shadow name; **zero or multiple matches refuse**, with a message
naming both remedies (`--alpha <name>` and `--non-campaign`). The resolved
Alpha's branch must exist in the target repo, and when that Alpha recorded a
`repo` its root must equal this spawn's target repo — a mismatch refuses (it
catches a Shadow pointed at the wrong `--repo`). Every other name — Alpha trees,
infrastructure — bases on the target repo's current branch+commit, or `--base
<ref>`. `--non-campaign` is the one loud override: it forces current-branch
basing for a deliberate `shadow-*` infra tree and records the opt-out. `--base`
on a campaign name refuses unless `--non-campaign` is also passed (the mandate
owns the base). **ALL validation runs before any write**, so any refusal leaves
no worktree, no branch, and no `tree-base.json` behind.

After `git worktree add`, the tree hydrates only explicit, ignored dependency
directories from the target project: npm/pnpm/Yarn `node_modules`, Python
`.venv`, Rust/Maven `target`, Swift `.build`, Dart `.dart_tool`, Ruby
`vendor/bundle`, PHP `vendor`, CocoaPods `Pods`, and Gradle `.gradle`. Defaults
come from the selected ecosystems; a project may override them with
`data/gittree.dependency-hydration.json` containing `ecosystems` and/or `paths`.
Paths must be relative, contained, non-secret, non-runtime, and non-symlink
through every existing parent. Existing destinations are preserved. Copies are
independent, including dereferenced nested symlinks, and never shared mutable
symlinks. The legacy `data/gittree.reflink-dirs.json` array remains readable
only for compatibility. The command records the base AND the resolved target repo in `~/.throne/data/<name>/tree-base.json`
(`repo` field; a campaign Shadow additionally records `branch` = the Alpha
branch it merges back into and `commit` = that branch's tip, while
`--non-campaign` records a `nonCampaign: true` marker), and prints the tree's
project dir to work in. The reflink allowlist is overridable via that target
project's own `data/gittree.reflink-dirs.json` (JSON array of dir names). Merge
back with `merge-git-tree` (below), which stash → merge → unstashes over a dirty
target and resolves any unstash conflict rather than clobbering.

## merge-git-tree

```bash
./bin/throne-cli merge-git-tree <name> [<message>]
```

The other half of `spawn-git-tree`: delivers branch `<name>` to the repo and
branch recorded in `~/.throne/data/<name>/tree-base.json`. Missing/legacy target metadata
fails closed; the command never guesses from the current checkout.

Delivery creates exactly one commit, single-parented by the target branch's
latest tip, sharing `make-squash-commit`'s squash algorithm
(`buildSquashPreview`) rather than a two-parent merge. It reuses an existing,
non-stale `SquashPreviewRecord` for `<name>` when one was already built by
`make-squash-commit`; otherwise `<message>` is required and builds one fresh.
A preview is stale — and delivery refuses, naming which SHA moved — if either
branch's tip has moved since the preview was built. The candidate branch must
still exist (reap-before-squash precondition) or delivery refuses outright.
The target is fast-forwarded/CAS'd onto the delivery commit first, then the
candidate branch is force-moved onto the same commit (not a fast-forward: the
squash commit is parented by the target, not the candidate's own history).
Complete Git trees are preserved, including deletions, renames, modes,
symlinks, binary blobs, and submodules. An empty net diff succeeds as an
evidenced no-op without an empty commit. Repository `commit.gpgsign` policy is
honored; signing failure publishes nothing.

For a completed ordinary agent, a no-net-change result is accepted only when
one authoritative decision validates its live, non-symlink `REPORT.md` against
the same named identity, spawn objective, supervising Alpha, recorded tree, and
merge target. Missing, empty, malformed, foreign, stale, or contradictory
evidence still triggers the lost-commit refusal. This completion-time route is
also the supported recovery path for retained report-only agents: run the same
ordinary `merge-git-tree <name> "<verdict summary>"` command after this version
is installed; successful validation publishes the normal completion stamp, so
plain `complete-agent` can consume the agent afterward. Do not edit archived
records, force reap, manufacture content, or use raw Git.

Spawn-time `deliverable_shape: "verdict-only"` remains an independently working
compatibility route. It may be retired only after ten consecutive campaigns use
the completion-time route without fallback, both accepted and refused evidence
cases have occurred in operation, a caller audit finds no remaining dependency,
and the Regent deliberately approves removal.

When the target branch is checked out, dirty tracked/untracked work is stashed,
the one delivery commit is fast-forwarded, then the ambient work is restored
with user bytes winning any overlap. When it is checked out nowhere, the branch
ref advances by compare-and-swap without touching a checkout. Re-running
delivery after a crash between the target and candidate moves is idempotent:
it detects the target already carries the delivery commit and finishes only
the candidate move, never re-squashing. The command never rewrites
candidate/target history and never uses `git reset --hard` on the target. Its
success message reports either the delivery commit (with the pre-squash
candidate SHA, the only route back to it after the squash) or the explicit
no-op.

## keep-going

```bash
./bin/throne-cli keep-going [--name <name>]
```

Background heartbeat. Without `--name`, it first reads desired state, resolves
the uniquely named live Regent, and if running sends the Regent literal `read
~/.throne/data/regent/QUEUE.md, queue and dispatch more
work as necessary, check for stalled agents and poke them, and continue any
active work` through the common submit engine with explicit sender
`keep-going`, so the recipient-visible row begins `keep-going said: ...` and
never depends on current-agent inference. If the Regent is dismissed, it
no-ops. If no live Regent exists while desired state is running, it resurrects
one instead of sending, before reading any provider sensor. With `--name
<agent>`, it skips desired-state and resurrection entirely: a named Regent
gets the same queue-aware literal, and any other named agent gets the
preserved generic nudge, still with sender `keep-going`. It does not read,
evaluate, reconcile, or dispatch itself, and it exits non-zero only on genuine
ambiguity or resolution failure. Sends nothing on ambiguity or resolution
failure. Direct calls and the tracked systemd service both reach the common
submit engine, so they share the same per-pane kernel critical section with
every other producer.

On the default live-Regent path, `keep-going` passes the exact live
`HerdrAgent.agent` label into the throttle evaluator. `codex` selects only the
Codex/GPT usage getter, `claude` only the Claude getter, `opencode` only the
opencode-go getter, and opposite-provider telemetry cannot change cadence.
Matching-provider pressure
still obeys the existing hysteresis bands, progressive finite slowdown, and
never-full-stop law. A harness change or legacy driverless throttle state
starts a fresh pacing domain — persisted band and `lastNudgeAt` from one
provider never gate the other; only same-driver matching-sensor unavailability
may retain that driver's prior band. A live label outside `HARNESSES` reads no
provider getter, records explicit unsupported-driver evidence, and nudges once
at NORMAL/unthrottled cadence; the same unavailable-telemetry contract covers
an `opencode` Regent, whose unreadable opencode-go reading keeps the prior band
and never suppresses the heartbeat. A throttle-evaluation failure nudges
unthrottled (NORMAL); a state-read failure can still compute a matching
non-NORMAL band; a state-write failure can retain a computed non-NORMAL band —
no failure ever suppresses the heartbeat. Output is byte-identical to the plain
nudge only when
the evaluated band carries no advisory: the pinned literal, optionally
followed by a single space and that one band's advisory text, and nothing
else. A non-Regent `--name` target never receives a band advisory.

## add-to-queue

```bash
./bin/throne-cli add-to-queue [--objective-code <code>] <body words...>
```

Writes one new `open`-status item to the SQLite-backed Regent queue store
(`src/regent-queue/`). Every non-flag argument joins into the item's prose
body, space-separated; `--objective-code` (optional, may appear anywhere
among the arguments) keys the item by objective code instead of a generated
id. Prints the inserted item's id and status on success; a missing body is a
hard error (non-zero exit, store never opened).

**Admitted for the `Stager` role only (Lord, 2026-08-21).** An Alpha, a
Shadow, or the Regent invoking this command is refused and nothing is added;
see AGENTS.md, "The Stager" → "Only a Stager files queue objectives" for the
reasoning. The check reads the calling agent's own `identity.md` Role line via
`isQueueFilerRoleName` and fails CLOSED: an unresolvable caller or an
unreadable role is a refusal, not an admission. The refusal text names the
route that remains — report the finding to your supervisor and let the Lord
decide whether it becomes an objective.

## lint-queue-plan

```bash
./bin/throne-cli lint-queue-plan --objective-code <code> | --body-file <path>
```

The mechanical half of the Stager consolidation checklist (AGENTS.md, "The
Stager"): checks a consolidated plan body for the four canonical section
markers — `INTENT:`, `SCOPE:`, `RULINGS:`, `VERIFIED-NOUNS:` — before the
Stager files the objective and notifies the Regent as launch-ready.
`--objective-code` reads the item's body from the SQLite queue store;
`--body-file` lints a draft before filing. Read-only in both modes. Failure
text is deliberately teaching-grade (names the missing marker, what belongs
under it, an example) because downstream agents follow error text literally.
A pass proves structure only and says so — whether decisions were genuinely
closed with the Lord and nouns genuinely grep-verified stays the filing
Stager's judgment, and this lint is not evidence of it.

## mark-queue-launch-eligible

```bash
./bin/throne-cli mark-queue-launch-eligible --objective-code <code> \
  --alpha-name <name> --target-repo <path> --target-branch <branch> \
  --base-commit <commit>
```

Marks one existing open queue objective as launch-eligible and writes all four
launch facts atomically. The objective code uses the same canonical validation
as `add-to-queue`; missing metadata, an absent objective, or a non-open row
fails without changing the row. The command records launch intent only: the
existing auto-brief/floor path remains responsible for briefing and spawning.

The routine actor is the intentional filer, normally the Stager after it has
consolidated a launchable plan. The Regent may use the command for compatibility,
but is not the routine eligibility gate. Eligibility means the filer possesses
one canonical objective code and all four structured launch facts. Prose is
never interpreted as launch intent because queue prose also contains rulings,
corrections, and observations that must remain ineligible. Supplying the same
structured fields to `add-to-queue` remains the preferred one-step filing path;
this command supports existing rows and workflows where filing and launch
approval happen separately.

A successful mark commits the row to consideration by the alpha-autoscale
worker at its next five-minute floor tick; it is not an immediate launch request.
Operational proofs must therefore reserve and observe the whole tick window,
not infer safety from a momentarily free machine. This command has no revoke
mode. The separately tracked `eligrace` work owns atomic eligibility revocation
plus expiry of any derived launch brief; clearing only the eligibility bit would
leave stale launch authority behind.

## trim-queue

```bash
./bin/throne-cli trim-queue [--apply]
```

Operates on the SQLite-backed Regent queue store, not `QUEUE.md` prose.
Safe by default: with no flag it's a dry run that reports every terminal
(`complete`/`abandoned`) item a real trim would remove, without mutating the
store. `--apply --actor <actor>` performs the archive — preserving full bodies and audit metadata while removing exactly the terminal items,
through the store's attributed archive boundary. A non-terminal item (`open`/`in-flight`) is
never removable regardless of flags: "terminal" is decided once, by
`TERMINAL_QUEUE_ITEM_STATUSES` in `regent-queue-item-state.ts`, never
reimplemented here. An empty store or a store with no terminal items prints a
"nothing to trim" message and exits 0. A store the read layer reports as
`unknown` (could not read) is a hard error (non-zero exit) — never silently
treated as empty.

## ensure-heartbeat

```bash
./bin/throne-cli ensure-heartbeat
```

Idempotently arms the keep-going timer — renders
`systemd/throne-keep-going.{service,timer}` into the systemd user unit dir
(`$XDG_CONFIG_HOME/systemd/user`, falling back to `~/.config/systemd/user`) as
real files through the shared install core in `serviceunits.ts`,
`daemon-reload`s, and `enable --now`s
`throne-keep-going.timer` — so no operator ever runs `systemctl --user enable
--now` by hand. Fast-paths to a no-op when the timer is already active; degrades
gracefully (prints one line, exits 0) when `systemctl --user` is unreachable (no
systemd, no user bus). Only returns non-zero when systemd IS reachable but a
step genuinely fails. Also the reusable core `throne-startup` calls on every
harness launch.

## install-services

```bash
./bin/throne-cli install-services [--dry-run] [--throne-root <absolute path>]
```

Reads the strict JSON boolean `herdr-decouple` from
`$XDG_CONFIG_HOME/throne/features.json` (fallback
`~/.config/throne/features.json`), defaulting OFF when absent. In both states it
installs unrelated throne hooks and services for the current user. OFF does not
acquire or verify the pinned client, install the public `throne` seam, or
install/control the decoupled Herdr service; runtime calls retain legacy bare
PATH Herdr and its implicit/default session. ON adds the owned v0.7.5 client,
public attach seam, and isolated named-session service.

Linux installs and enables `throne-backend.service`, `ntfy.service` and the
three `sweep-tmp-scratch-*` timer pairs, and with the flag ON also installs
and enables `throne-herdr.service`; these are rendered into
`$XDG_CONFIG_HOME/systemd/user` (fallback `~/.config/systemd/user`). macOS
installs and bootstraps `com.throne.throne-backend` and `com.throne.ntfy`,
and with the flag ON also installs and bootstraps `com.throne.throne-herdr`,
in `~/Library/LaunchAgents`. The sweep timers have no mac counterpart: they
exist for a tmpfs inode cap macOS does not impose. The ntfy unit on both
platforms runs `systemd/ntfy-serve`, which starts the pinned
`binwiederhier/ntfy` image under docker or podman — `./install.sh` pulls it;
`install-services` itself never touches a container runtime.

Before rendering, each platform retires whatever pre-consolidation unit is
still on the box — `herdr-server`, `throne-keep-going`, `throne-no-idling`,
`throne-work` and `throne-build` on linux (`RETIRED_LINUX_UNITS`: stop,
disable, remove the file), `com.throne.{herdr-server,keep-going,no-idling}` on
mac (`RETIRED_DARWIN_AGENTS`: `launchctl bootout`, remove the plist; never
`launchctl disable`, which would persist and block a future bootstrap). Their
sources are deleted from the repo.

Sources under `systemd/` and `launchd/` carry `{{THRONE_ROOT}}`,
`{{HERDR_BIN}}` and/or `{{NODE_BIN}}`; the command substitutes whichever
tokens are present and refuses to install any rendered file that still
contains a token. Installed artifacts are real files, so a pre-existing
symlink is replaced and reported. Re-running writes no file and issues no
MUTATING service-manager command — it still probes each unit's state first
(`is-active`/`is-enabled` on linux, `launchctl print` on mac) to decide.

Changing the flag itself never touches or restarts a live server and never
performs a service-manager operation. The
installer never restarts, stops or kills anything on linux, and never boots out,
kickstarts or kills anything on mac. When an installed unit's content changes
while that unit is running, it reports that and leaves the running service
alone — applying the new content is left to an operator, and for herdr-server
that means an explicit handoff or a planned restart between agent runs, which
still drops every live agent pane.

On both platforms it also renders the Codex SessionStart hook registration:
the committed, token-bearing `.codex/hooks.json.template` becomes the
gitignored `.codex/hooks.json` inside the checkout whose code is running —
Codex reads that file in place (and trust-gates it by content hash), so it is
a checkout-local artifact rather than a service-manager unit. The same rules
apply: leftover tokens are refused, identical content writes nothing, and it
renders even where the platform's service manager is unreachable.

`--dry-run` prints the full plan (files and service-manager argv) and mutates
nothing. `--throne-root` sets only the absolute path substituted INTO the
rendered units and hook; sources are always read from the checkout whose code
is running, which is how a worktree installs units that point at the live
throne.

Linux is proven live on the court's own box. The mac branch was first run
against a real launchd on 2026-09-02 (macOS 26 / Darwin 25.6): the plists
parse, and `launchctl print` / `enable` / `bootstrap` / `bootout` behave as
`src/install-services/darwin.ts` expects; `src/install-services/darwin.spec.ts`
covers the retirement, bootstrap and idempotence branches with fakes. A mac
has no journal: both live agents append to `~/Library/Logs/throne/`.

The separate five-minute `alpha-autoscale` hosted tick also enforces the live
Stager floor before evaluating any Alpha queue signal. While desired state is
`running`, zero positively-known live Stagers is an immediate breach: there is
no grace tick, cooldown, capacity hold, or autoscale kill-switch exemption
(the env switch `THRONE_ALPHA_AUTOSCALE_ENABLED=1` is permanently armed in
both service templates since 2026-09-02; the operator pause is
`steering.autoscaleEnabled: false` in the live `config.user.ts`, flipped by
the `/autoscaler` skill and re-read by the worker every tick). The
tick uses ordinary `spawn-git-tree` and `create-agent --role Stager`, and a
uniquely live Stager makes the effect idempotent. Unknown role/roster evidence
or multiple live candidates fails closed. `dismissed` is the sole exemption and
logs `STAY DOWN` without creating anything.

```bash
./bin/throne-cli alpha-autoscale-tick
```

Runs one published autoscale watchdog tick through the hosted worker's same
`runOnce()` path. It exists for bounded operational checks where waiting for the
five-minute cron would obscure which generation acted; it does not call the
Stager decision helper or either spawn primitive directly.

## throne-startup

```bash
./bin/throne-cli throne-startup
```

The SessionStart-hook entry point — self-configures a freshly launched throne
harness with no manual steps. Resolves its own herdr pane; if the pane isn't in
the roster or its `cwd` isn't the throne root, it's a full no-op (so a
broadly-scoped hook fires harmlessly for every non-throne session). Otherwise
renames itself to `Regent`, but ONLY when it is unnamed AND no `Regent` already
exists (never re-renames a named agent, e.g. a `create-agent`-spawned Shadow),
**banners the Regent's desired-state** (`RUNNING`|`DISMISSED`, read via
`regentstate.ts`'s `readDesiredState` seam so the self-heal mode is never
hidden), **prints a compact QUEUE digest to stdout** from
`~/.throne/data/regent/QUEUE.md` (the in-flight 🟢 /
next-up ⚪ objective headings plus the file path — so a booting Regent's opening
context already holds the backlog with no manual `cat`), then always runs the
`ensure-heartbeat` core regardless of the rename outcome. The timer only
resolves and messages; the Regent reads the queue, reconciles live/current
campaign state, continues or merges active work, and only when there are no
current tasks dispatches the next dependency-eligible queued objective. Every
failure path is caught and logged; the command always exits 0 so it can never
disrupt harness launch.

The desired-state banner and the digest both print for ANY confirmed throne-root
pane (never in a no-op session), and both fail safe: an unreadable marker banners
`RUNNING`, an unreadable queue prints "no queue found" — neither aborts launch.
The digest reads `~/.throne/data/regent/QUEUE.md`, resolved from the
module dir (like `THRONE_ROOT`, never cwd), and lists only open
(🟢/⚪) objectives — landed ✅ items are omitted. The mechanism is just stdout:
the SessionStart hook's output is already injected into the harness's opening
context.

For a confirmed Regent only, startup reconciliation is followed by the same
shared Stager-floor effect used by the `alpha-autoscale` hosted tick. Thus a
running court with no live Stager heals immediately on startup through the
normal managed-worktree/create-agent path; a live Stager is a no-op, ambiguous
evidence refuses, and `dismissed` says `STAY DOWN`.

## plan-usage-remaining

```bash
./bin/throne-cli plan-usage-remaining [--json]
```

Reports how much Claude plan-usage headroom remains from authenticated `GET
https://api.anthropic.com/api/oauth/usage`, the same source the first-party
`claude` CLI renders as `/usage`. This endpoint is undocumented and has shown
schema drift, so throne normalizes only observed fields and never supplies a
missing value. Its `utilization`/`percent` values are already 0–100 percentages,
and every `resets_at` string is passed through byte-for-byte.

The normalized Fable/Opus rules are exact:

- `five_hour` becomes the general `5h` window and applies to both native Fable
  and native Opus when readable.
- `seven_day` becomes aggregate `weekly`. A structured
  `limits[].kind === "weekly_scoped"` row whose `scope.model.display_name`
  matches the requested model is that model's weekly authority; aggregate
  `weekly` is fallback only when no matching scoped signal exists.
- A non-null legacy `seven_day_opus` becomes exactly one `weekly:Opus` window
  only when no structured Opus-scoped row exists. Structured Opus data wins;
  the normalizer never emits both structured and legacy Opus windows.
- A scoped row whose model is readable but percentage is malformed is retained
  in `unreadable_windows` rather than silently discarded. This prevents an
  exact-model malformed row from accidentally making aggregate `weekly` look
  authoritative; malformed scoped rows for another model remain irrelevant.
- `src/create-agent/native-availability.ts` evaluates only canonical `claude/fable` and
  `claude/opus`. A readable `5h` plus the selected weekly signal are checked
  independently. Fresh, finite, in-range `remaining_pct <= 0` yields
  `exhausted` with the exact exhausted cap/reset evidence. Duplicate relevant
  windows, malformed/out-of-range relevant percentages, or no readable
  applicable allowance yield `unknown`, never manufactured exhaustion.

Default mode prints a short human-readable summary. `--json` prints the
machine-consumable `source`, `harness`, `as_of`, `windows[]`, and optional
`unreadable_windows[]` shape. Readable window entries carry `cap_window`,
`used_pct`, `remaining_pct`, `reset_time`, and `severity`; model entries also
carry `scope_model`. A window the endpoint reports as not applicable is omitted
rather than fabricated as zero.

It is a pure reader of `~/.claude/.credentials.json`: it never writes that
file. When the stored access token is at or near expiry it refreshes it via
the OAuth token endpoint, but only in memory for the one usage call — the live
Claude session owns that file's refresh lifecycle, and a second writer would
race and corrupt it.

A successful read is cached at `~/.throne/usage-cache/claude.json` (the same
shared last-good cache `codex-usage-remaining` below uses, one file per
harness). A repeat call within the cache's TTL (2 minutes) reuses that reading
without hitting the endpoint. On a live-fetch error, instead of failing, the
last-good cached reading is returned marked `stale: true`, retaining its
original `as_of` and carrying the live error. Human mode adds `(stale — last
good <as_of>)`; JSON exposes the fields directly; the command still exits 0.
Availability policy always returns `stale-unknown` for this payload, including
a cached zero — stale telemetry is never fresh proof of exhaustion. This same
cache-backed, at-most-one-read source is exported as `getUsagePayload`; the
availability adapter converts a rejected call or `source: "error"` payload to
`source-failure`. The live source persists a bounded JSONL history at
`data/stats/usages/usage-log.jsonl`; `boundUsageLogRows` keeps only valid
non-future rows no older than eight days and then applies one global newest-
4,096 cap after filtering, so the cached read is a reuse layer over a finite
sensor ledger rather than an unbounded log.

Every failure mode with no cached reading to fall back on —
missing/unreadable/malformed credentials, a failed token refresh, a failed
usage request, or a response that doesn't match the expected usage schema —
exits non-zero with a clear cause: a stderr line in the default mode, or a
`{"source":"error",...}` object in `--json` mode. It never prints a
fabricated percentage.

## codex-usage-remaining

```bash
./bin/throne-cli codex-usage-remaining [--json]
```

The Codex counterpart to `plan-usage-remaining` above: reports how much
Codex (ChatGPT) plan-usage headroom remains, read from `~/.codex/auth.json`,
in the same `source`/`harness`/`as_of`/`windows[]` shape (the codex response
may omit the `5h` session window entirely — an absent window means
unconstrained on that axis, never exhausted). Same read-only guarantee (never
writes `~/.codex/auth.json`), and the identical shared last-good cache
described above — its own file at `~/.throne/usage-cache/codex.json`, same
2-minute TTL, same `stale`-marked error-fallback and exit-0-on-stale
semantics, same `getUsagePayload` reuse seam. The command is owned by the Nest
`UsageAdaptersService`; the legacy pipeline root remains an internal
implementation boundary until its zero-reference proof is complete.

## resource-pressure

```bash
./bin/throne-cli resource-pressure [--json]
```

Reports current host capacity pressure. The verdict line is the
pressure-signal domain's own figure — `classifyPressure`'s
`max(cpu.avg10, cpu.avg60, memory.avg10, memory.avg60)` against the Lord's
standing 70 threshold — i.e. exactly the number the alpha-autoscale admission
gate and keep-going report already act on, so this command can never disagree
with the throne's own admission decisions. Around it: all three PSI windows
(avg10/avg60/avg300) for cpu, memory, and io (io is explicitly informational
and outside the verdict), load averages against the cpu count with a per-core
ratio, and `MemAvailable`/`MemTotal` from `/proc/meminfo`. On macOS (since
2026-09-02, the Lord's order that the autoscaler support mac) there is no PSI:
the verdict comes from `src/pressure-signal/darwin-pressure-reader.ts` through
the same classifier and thresholds — cpu is utilisation over a 500 ms
`os.cpus()` sample, memory is the kernel's memorystatus subsystem
(`100 - kern.memorystatus_level`, floored to 70 at WARN and 100 at CRITICAL by
`kern.memorystatus_vm_pressure_level`), io stall is not measurable and is
graded 0 with that stated in the report, and the memory line comes from
`hw.memsize`. The report prints `source: darwin` and no PSI window lines in
that case. Observe-and-report
only — nothing here can launch, nudge, or reap. Every input degrades
independently: a missing PSI file renders as `unavailable`, an unreadable
verdict input renders as a stated `unknown` (never defaulted into either
verdict), and partial input is stated in the output rather than converted
into a failing exit. `--json` emits the same snapshot as one JSON object with
no derived opinions.

## opencode-go-usage-remaining

```bash
./bin/throne-cli opencode-go-usage-remaining [--json]
```

Reports OpenCode Go usage as a provider distinct from Codex ChatGPT, even
though both may execute through `codexy-all-omni`. The evidenced quota source
is the authenticated workspace dashboard at
`https://opencode.ai/workspace/<workspace>/go`, configured with
`OPENCODE_GO_WORKSPACE_ID` and `OPENCODE_GO_AUTH_COOKIE` (the `OMNIROUTE_`
prefixed variants take precedence). The inference API key can authenticate
`/models` and model calls but cannot read quota; the tested `/zen/go/v1/quota`
path returns 404. Missing dashboard credentials therefore produce an honest
unavailable result, never a fabricated zero.

The parser normalizes only dashboard-declared rolling, weekly, and monthly
usage percentages and relative reset intervals. It deliberately omits dollar
credit totals/capacity because the observed dashboard payload does not declare
them. Human and `--json` modes share the cache, stale fallback, bounded
provider-specific history, burn-rate input, and reset-aware forecast behavior
used by the Claude and Codex sensors. Cache/history identity is `opencode-go`,
so it cannot collide with Codex. Provider-qualified
`opencode-go/<model>` spawn routing consumes this sensor; other Codex-family
models continue consuming Codex ChatGPT telemetry.

## list-harnesses-and-models

```bash
throne-cli list-harnesses-and-models [--json]
```

A read-only registry view of valid model vocabulary, launcher mapping, runtime
planning/non-coding/validation scores, the active preset, and its ordered role
pools. This is a live-court routing question, so the documented invocation is
bare. A checkout-local invocation from a linked worktree without
`config.user.ts` refuses before rendering plausible committed defaults and
names the resolved live throne root to query.
Every row is labeled `new-and-registered`,
`new-with-bypass-or-registered`, or `registered-resume-only`; shared GPT rows on
the non-selected harness carry the bypass label — a row's registration path, not
a `--bypass-harness` flag, since none exists. Human output also states that
the selected forward policy's fresh GPT path uses its shown launcher; a
`new-with-bypass-or-registered` alternate is selected by naming its model
directly with `--model`, not by any harness bypass flag.

`--json` emits `{source, active_plan, harnesses, forward_launch_policy,
scores_note}`. Disabled historical rows remain visible with
`launchPolicy: registered-resume-only`; they are excluded from fresh model
vocabulary and role pools. `forward_launch_policy` documents the selected GPT path, the
non-selected bypass-or-resume harness, and the legacy exact-resume
behavior. The command
never reads toggle state or live usage.

## Service install (keep-going timer and the rest)

The user timer runs `keep-going` every 30 minutes (`OnUnitActiveSec=30min`,
`OnBootSec=5min`). Most unit sources under `systemd/` are TEMPLATES holding
`{{THRONE_ROOT}}` or `{{HERDR_BIN}}`, so copying those into place by hand
installs a broken unit; the timer itself is the token-free exception and would
copy verbatim. Install and enable through the throne either way:

```bash
./bin/throne-cli install-services            # whole set; --dry-run to preview
./bin/throne-cli ensure-heartbeat            # or: keep-going pair only
systemctl --user list-timers throne-keep-going.timer
```

## Tests

```bash
npm test          # canonical — runs ONLY the throne's own tests
```

Runs the hermetic guard suite (name resolver, herdr-presence guard, keep-going
send guard, startup/roster guards) via Node's built-in runner, scoped to
`test/**/*.test.ts`.

**Prefer `npm test` over a bare `node --test` from the throne root.** With no
path argument Node discovers `**/*.test.ts` recursively from cwd. Now that
worktrees are placed under `~/.throne/worktrees/` — outside the throne repo
entirely — a bare run from the throne root no longer picks up sibling worktrees'
in-flight tests (as it once did when trees lived under the throne's own
`worktrees/<name>/throne/test`), but `npm test` still pins the glob to
`test/**/*.test.ts` and is the canonical scoped command regardless of what else
lives under cwd. (`node --test test/` does NOT work as a directory arg on this
box — Node treats it as a module entry point and fails with `Cannot find
module`; the quoted glob is what Node's runner expands itself.)

To verify a single file directly: `node --test test/startup-guards.test.ts`.

### Queue-store proof containment

Queue-store tests and campaign proofs use a scratch `THRONE_DATA_HOME` by default. A live-store proof is permitted only when installed scheduling is the behavior under test; it must create uniquely prefixed campaign-owned IDs, forbid bulk or predicate deletion, and clean each owned row by exact ID through the attributed archive boundary. `trim-queue --apply` requires an explicit invoking actor (`--actor <actor>`), archives terminal rows, and records the actor, predicate, operation ID, timestamp, and row count durably.
