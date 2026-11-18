# `config.user.ts` — every setting, in one place

`config.user.ts` is the throne's single machine-local override file. It lives in
`~/.throne/config/` (AGENTS.md "Where the throne keeps things"); a copy at the
**live throne root** (next to `AGENTS.md`, gitignored) wins when present, for
quick testing, and when both exist the throne prints one line naming the copy it
loaded. It is read fresh by the commands that consult it, so an edit takes effect
without a restart. A campaign worktree resolves the same file as the live root,
never a copy of its own.

Start from the template: `cp config.user.example.ts ~/.throne/config/config.user.ts`,
with a `package.json` of `{ "type": "module" }` beside it so node loads the file
as an ES module (`throne migrate-home` writes that file when it moves the
config). Every field in every section is optional; an absent file, section or field leaves the
committed default in force. **Unknown keys are refused at load time** with an
error naming the file and the field, top-level or nested — an override that
silently did nothing would be worse than a loud failure. A file naming only one
section (`{ steering: {...} }`) leaves every other section at its default, so
when you change one section, read the file, keep the rest, and write the whole
object back.

The file is TypeScript: it `export default`s one object. The types are
`PersonaConfigOverride` (`src/application-config.service.ts`),
`SteeringConfigOverride` (`src/steering-user-config.ts`) and the `identity`
shape shown below; the loader is `src/user-config-loader.ts`.

```ts
import type { PersonaConfigOverride } from './src/application-config.service.ts';
import type { SteeringConfigOverride } from './src/steering-user-config.ts';

interface UserConfigFileOverride extends PersonaConfigOverride {
  readonly steering?: SteeringConfigOverride;
  readonly identity?: {
    readonly name?: string;
    readonly email?: string;
    readonly signingKey?: string;
    readonly signingFormat?: 'openpgp' | 'ssh';
    readonly identities?: Record<string, { name: string; email: string; signingKey?: string; signingFormat?: 'openpgp' | 'ssh' }>;
    readonly remotes?: Record<string, string>;
  };
}

const userConfig: UserConfigFileOverride = { /* sections below */ };
export default userConfig;
```

## Sections at a glance

| Section | Keys | Read by |
| --- | --- | --- |
| Persona (top level) | `roleplayPreset`, `addressTitle`, `tierTitles`, `throneTitle`, `campaignTitle`, `queueDescription`, `roleplayPrompt` | every identity text, opening prompt, resurrection prompt and user-facing message (`agent_docs/persona-config.md`) |
| `ntfy` (top level) | `serverUrl`, `topic`, `enabled` | `notify-lord` phone pushes (`agent_docs/ntfy-phone-notifications.md`) |
| `steering` | `activePlanPresetName`, `activeTargetEffort`, `activeHarness`, `messageQueueTransport`, `customPlanPresets`, `stagerPool`, `roleEfforts`, `regentRoute`, `tokenBalanceEnabled`, `autoscaleEnabled`, `regentHeartbeatNudgeEnabled`, `macLoadPerCoreAtCapacity` | every fresh spawn's harness/model/effort, the Stager pool, the Regent's model and effort, the autoscaler, the token balancer (`agent_docs/MODEL_POLICY.md`) |
| `identity` | `name`, `email`, `signingKey`, `signingFormat`, `identities`, `remotes` | every git commit the court makes (`throne git-identity`, the `bin/git` shim, tab creation; `agent_docs/commands.md`) |
| `editor` (top level) | `editor` | `throne forge open` |
| `recall` | `verdictLineThreshold`, `serveThreshold`, `serveThresholdWhenCostIsHigh`, `siftKeepThreshold`, `maximumInjectedCharacters`, `repositoryMemoryNamesPerRepository`, `globalMemoryDirectories` | `throne recall`, `throne sift` and `throne rank` (`agent_docs/commands.md`) |
| `agentSettings` | `checkEnabled`, `colourByRole` | the `agent-settings` worker and `throne agent-settings-tick` (`agent_docs/commands.md`) |
| `previews` (top level) | a list of `path` or `port`, with `address` or `folder` | the `tailnet-publishing` worker, the web listener and `throne preview` (`agent_docs/commands.md`) |
| `harnessEnvironment` (top level) | one map per harness name of variable name to string value | every agent launch on that harness, and `throne check-config` |

## Persona — how the court speaks

Display only: none of these change a machine identifier, an agent name, a
branch or a ledger path. Presets are data; every field overrides the chosen
preset per field.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `roleplayPreset` | `'Default' \| 'DRG'` | `'Default'` | The base every other persona field is merged over. `DRG` is a Deep Rock Galactic register (`Karl`, Mission Control/Foreman/Greenbeard, The Space Rig, mission). Each preset also fixes `roleWords`, the substitute for the `alpha`/`shadow` tokens on herdr tab labels and ledger symlinks; `roleWords` is not overridable per field. |
| `addressTitle` | string | `'Lord'` | How agents address you. Also the word the standing "never put a question to the ⟨address title⟩" instruction uses. |
| `tierTitles` | `{ regent?, alpha?, shadow? }` | `Regent` / `Alpha` / `Shadow` | What the three tiers are called in prose. Partial: setting `regent` alone leaves the other two. |
| `throneTitle` | string | `'Throne'` | What the organisation is called in prose. |
| `campaignTitle` | string | `'campaign'` | The noun for a unit of work. |
| `queueDescription` | string | `'your objective backlog'` | The descriptive phrase for the queue's contents. The file name `QUEUE.md` is a ledger path and never changes. |
| `roleplayPrompt` | string | the disciplined-court paragraph | The persona paragraph appended to every new agent's identity text. |

Validation: a non-string, an empty or whitespace-only string, an unknown
`tierTitles` key or an unrecognised `roleplayPreset` refuses the whole file.

## `editor` — what `forge open` launches

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `editor` | string | unset | The editor command `throne forge open` launches, arguments allowed (`'code -n'`). The pull request's checkout path is appended as the last argument. `--editor` wins over it; unset, `$VISUAL` is used, then `code`. |

Validation: a non-string refuses the whole file.

## `ntfy` — phone pushes

Host-local secrets, which is why they live here and not in the tree. Omit the
whole section to keep the inert committed defaults (loopback server, topic
`throne-notifications`).

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `serverUrl` | string | `http://127.0.0.1:8410` | Base URL of the ntfy server (typically a private tailnet address). |
| `topic` | string | `throne-notifications` | The topic `notify-lord` publishes to. Anyone holding it can push to your phone: treat it as a secret. |
| `enabled` | boolean | `true` | `false` stops every phone push the throne sends (completion notices, `notify-lord`, alerts) without touching the ntfy server; `notify-lord` then says nothing was sent. |

`THRONE_NTFY_SERVER_URL` and `THRONE_NTFY_TOPIC` in the environment override
both, whatever the file says.

## `steering` — what a fresh spawn runs on

The committed defaults are deliberately conservative; every field here is a
deliberate operator choice. Values are validated against the registry at load:
a preset name that is neither built in nor one of your `customPlanPresets`, a
harness or model the registry does not know, a pool that is empty or names a
pair the harness cannot run, all refuse the whole file.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `activePlanPresetName` | `'GptOnly' \| 'AnthropicOnly' \| 'Optimized' \| 'Whichever' \| 'UnifiedRouting' \| 'OpusOnly' \| <a `customPlanPresets` key>` | `'OpusOnly'` | Which preset's role pools a fresh Alpha, Shadow and ShadowSlice99 spawn steers toward. `OpusOnly` runs every campaign role on claude/opus, the latest Opus the pinned Claude Code resolves; `UnifiedRouting` runs them all on claude/sonnet. The `/switch-campaign-model` skill rewrites this for you. |
| `activeTargetEffort` | number | `1` | The reasoning effort every fresh spawn is clamped toward, before the per-model clamp, for any role `roleEfforts` does not name. The scale is 1 to 6; for claude 1 is low, 2 medium, 3 high, 4 xhigh, 5 max. |
| `roleEfforts` | `{ alpha?, shadow?, shadowSlice99?, stager?, regent? }`, each 1 to 6 | `{ alpha: 3, shadow: 3, shadowSlice99: 3 }` | Per-role effort that overrides `activeTargetEffort` for that role on every fresh spawn (autoscaler, create-agent, the Stager floor, `--fork-of`, switch-agent-model) and on `/restart-harnesses`. An effort a queue row carries (`add-to-queue --effort`) still wins for its campaign. `regent` applies only when `regentRoute` is set. An unknown role or an effort outside 1 to 6 refuses the whole file. |
| `regentRoute` | `{ harness, model }` | absent | The Regent's model. When set, resurrection and `summon-regent` launch the Regent on this pair at `roleEfforts.regent` (else `activeTargetEffort`). Absent keeps the old launch: the recorded `data/regent` route at effort 1, or bare `bin/claudey`. |
| `activeHarness` | harness name | absent | Run every campaign role on THIS harness regardless of what the preset's pairs name. Absent means "each pair as written". Harness and model are independent choices, and this field exists so changing one never silently changes the other. The Stager is never moved by it. |
| `messageQueueTransport` | `'sqlite'` | absent | Explicit queue-transport marker. Only the SQLite delivery path exists; omitting it keeps the feature-flag behaviour. |
| `customPlanPresets` | `Record<name, { alpha, shadow, shadowSlice99 }>` | `{}` | Your own presets: each of the three campaign-role pools is a non-empty list of `{ harness, model }` pairs. Defining one changes nothing until `activePlanPresetName` names it. The Stager has no pool here by design. |
| `stagerPool` | `{ harness, model }[]` | absent | The Stager's own pair pool. Absent means the committed pin in `src/config.ts` (currently `claude/fable`, `claude/opus`). This is the ONE place the Stager can be moved; no preset and no `activeHarness` touches it, so a court-wide switch can never relocate your point of contact by accident. |
| `tokenBalanceEnabled` | boolean | `false` | Durable operator enable for the token-balance load balancer (`src/token-balance/`). Its ship-dark env kill switch `THRONE_TOKEN_BALANCE_ENABLED` must also be on; either being off fully de-gates it. |
| `regentHeartbeatNudgeEnabled` | boolean | `false` | Whether the heartbeat timer nudges the Regent. |
| `macLoadPerCoreAtCapacity` | number above 0 | `5` | On macOS only, the 1-minute load per core at which the host counts as at capacity: load ≥ this × the core count refuses new work. Graded beside the 70 cpu/memory figure, not inside it. Read when a process starts, so restart the backend after changing it. |
| `autoscaleEnabled` | boolean | `true` (absent means ON) | THE operator pause for the whole court's spawning. `false` makes every autoscale tick skip before it touches the queue; the worker re-reads the file each tick, no restart needed. The env switch `THRONE_ALPHA_AUTOSCALE_ENABLED` is permanently armed by the service templates, so this field is the deliberate off. Flip it with `/autoscaler off|on`. |

Harness and model names come from the registry: `throne list-harnesses-and-models`
prints every pair the throne can spawn on this machine (harnesses `claude`,
`codex`, `opencode`, `pi`; models such as `fable`, `opus`, `sonnet`, `haiku`,
`gpt-5.6-sol`, `gpt-5.6-terra`, and pi's DeepSeek `flash` and `pro`). A pool
entry `{ harness: 'pi', model: 'flash' }` is admitted wherever a claude entry is.

```ts
steering: {
  activePlanPresetName: 'PiTrial',
  activeTargetEffort: 1,
  customPlanPresets: {
    PiTrial: {
      alpha: [{ harness: 'pi', model: 'flash' }],
      shadow: [{ harness: 'pi', model: 'flash' }],
      shadowSlice99: [{ harness: 'pi', model: 'flash' }],
    },
  },
  stagerPool: [{ harness: 'pi', model: 'pro' }],
  regentRoute: { harness: 'claude', model: 'opus' },
  roleEfforts: { alpha: 3, shadow: 3, shadowSlice99: 3, stager: 3, regent: 3 },
  autoscaleEnabled: true,
},
```

## `identity` — who signs the court's commits

Every commit the court makes is signed with YOUR identity for the repository
at hand, and **signing is mandatory**: an identity without a signing key is
treated as unset. Nothing ever writes a global or per-repository git config —
the identity travels as environment on each tab (`GIT_AUTHOR_*`,
`GIT_COMMITTER_*`, and git's env-injected `user.signingkey`/`commit.gpgsign`)
and the `bin/git` shim re-resolves it per commit when the repository's origin
differs from the tab's. With the section unset, the shim refuses a
machine-local identity (`<user>@<hostname>`, `*.local`, `localhost`, no `@`)
with **STOP RIGHT THERE** and the agent asks you for these values — it never
guesses one.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `name` | string | — | The default author/committer name. |
| `email` | string | — | The default address. Must not look machine-local. |
| `signingKey` | string | — | **Required for any identity to count.** A GPG key id (`gpg --list-secret-keys --keyid-format long`), or with `signingFormat: 'ssh'` the path of an SSH public key. |
| `signingFormat` | `'openpgp' \| 'ssh'` | `'openpgp'` | How `signingKey` is interpreted; becomes `gpg.format`. |
| `identities` | `Record<alias, { name, email, signingKey?, signingFormat? }>` | `{}` | Named alternatives. An entry without its own `signingKey` inherits the top-level one. |
| `remotes` | `Record<pattern, alias \| 'default'>` | `{}` | Which identity a repository uses, by its `origin`. A pattern is `host` or `host:owner`, matched case-insensitively against ssh (`git@host:owner/repo`), `ssh://` and https URLs (credentials and ports ignored); `host:owner` beats `host`; an ssh-config host alias (`github.com-work`) is matched literally. `'default'` names the top-level pair. No match, or a repository without an origin, uses the default. |

```ts
identity: {
  name: 'Full Name', email: 'me@example.com',
  signingKey: '0123456789ABCDEF0123456789ABCDEF01234567',
  identities: {
    work: { name: 'Full Name', email: 'me@examplecorp.example' },   // inherits signingKey
  },
  remotes: {
    'github.com:example-owner': 'default',
    'github.example-corp.com': 'work',
    'github.com:ExampleCorp': 'work',
  },
},
```

Check the result for any repository or URL without committing:

```bash
throne git-identity --repo /path/to/checkout
throne git-identity --remote git@github.com:ExampleCorp/some-repo.git
```

Exit 3 means nothing applies (and says whether it is the identity or the
signing key that is missing).

## `recall` — which memories and log lines reach an agent

`throne recall --directory <repo> "<task>"` prints the bodies of the recorded
memories in that repository and the global memory directories that apply to a
task; `throne sift "<query>"` prints only the chunks of a long
command output that matter. Both decide with plain keyword rules
on this machine; nothing is sent over the network.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `verdictLineThreshold` | number 0..1 | `0.9` | Every recall ends with the rules' verdict, that a relevant memory likely exists or that there is no relevant memory in the scope it searched, and its confidence. The line is printed with any served memories; when nothing is served it is printed alone only when the rules are surer than this that no relevant memory exists. |
| `serveThreshold` | number 0..1 | `0.5` | A memory is served when the probability that it applies is at least this. |
| `serveThresholdWhenCostIsHigh` | number 0..1 | `0.3` | The lower bar for a memory whose frontmatter says `cost_if_missed: high`. |
| `siftKeepThreshold` | number 0..1 | `0.5` | A log chunk is kept when the probability that it matters is at least this. |
| `maximumInjectedCharacters` | integer >= 1 | `8000` | Total characters one recall may print. |
| `repositoryMemoryNamesPerRepository` | integer >= 1 | `40` | How many memory titles, most recently modified first, recall weighs for each other repository it asks about (the repositories recall has seen, in `~/.throne/data/recall/repositories.json`, outside the lookup's scope). Titles only, never bodies. |
| `globalMemoryDirectories` | string[] | `[]` | Memory directories shared by every project, read in addition to the project's own (`throne memory-dir .`). `~/` expands. |

`throne recall --status` (also `sift --status`, `rank --status`) prints that
the keyword rules answer. Any field in the `recall` section that is not in the
table above is dropped: the file loads anyway and prints one stderr line per
such field saying it is no longer read and can be deleted. The other sections
still refuse an unknown field.

Memory frontmatter keys, all optional: `ask` (a yes/no test of WHEN the lesson
applies), `scope` (`global` or the project memory directory's name), `kind`
(`trap`, `ruling`, `preference`, `procedure`, `fact`), `learned` (ISO date),
`status` (`active`, `superseded`), `superseded_by` (file name),
`cost_if_missed` (`low`, `high`). A superseded memory is never served.

## `agentSettings` — the colour and name each agent's pane carries

The backend's `agent-settings` worker checks every minute that each
Claude Code agent shows the colour of its kind and carries its herdr tab's name
as its session name, and corrects what differs (`agent_docs/commands.md`,
`agent-settings-tick`).

```ts
agentSettings: {
  checkEnabled: true,
  colourByRole: {
    Regent: 'red',
    Stager: 'green',
    Alpha: 'blue',
    Shadow: 'purple',
  },
},
```

- `checkEnabled` — `false` switches the check off. Default `true`.
- `colourByRole` — one colour name per role, each a single word the harness's
  `/color` command accepts. A role left out keeps its default; the keys are
  `Regent`, `Stager`, `Alpha` and `Shadow`.

## `previews` — what the tailnet shows

Each entry puts one local address or one folder on the tailnet, never through
funnel. The backend's `tailnet-publishing` worker reads this list fresh at start
and every minute, so an edit needs no restart.

```ts
previews: [
  { path: '/mock', address: 'http://127.0.0.1:4173' },
  { path: '/shots', folder: '~/tmp/shots' },
  { port: 8446, address: 'http://127.0.0.1:5173' },
  { port: 8447, folder: '~/tmp/site' },
],
```

- `path` — a tailnet path on port 443: one slash and a name of lowercase
  letters, digits and dashes. `/throne` and `/where-i-stand` are refused.
- `port` — a whole tailnet HTTPS port, any but 443.
- `address` — a local address `tailscale serve` proxies to. It must be on this
  machine: `127.0.0.1`, `localhost` or `[::1]`, with `http://`, `https://` or
  `https+insecure://` in front and its port named.
- `folder` — a folder the web listener serves, absolute or starting `~/`. A
  folder shows its `index.html`; there is no listing.

An entry gives exactly one of `path` or `port`, and exactly one of `address` or
`folder`. An invalid list is logged by name of the field and changes nothing on
the tailnet. A place that something else already holds, or a port with funnel
enabled, is refused and left alone. Taking an entry out of the list takes it off
the tailnet. `throne preview add|remove|list` edits this same list
(`agent_docs/commands.md`).

## `harnessEnvironment` — extra variables for each harness's agents

Each key is a harness name; each value maps a variable name to a string. Every
agent throne launches on that harness gets those variables in its process.

```ts
harnessEnvironment: {
  claude: { EXAMPLE_TRACE_LEVEL: 'quiet' },
  codex: { EXAMPLE_REGION: 'north' },
},
```

- Throne's own values win: a variable throne also sets for the launch keeps
  throne's value.
- Throne turns Claude Code's code mode on for every Claude agent with
  `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1`, laid beneath this section, so an
  entry here wins. To turn it off:

  ```ts
  harnessEnvironment: { claude: { CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: '0' } },
  ```
- Refused at load, naming the key: a harness name throne does not know, a
  value that is not a string, a name starting `THRONE_`, `GIT_` or `HERDR_`,
  `PATH`, `HOME`, and every variable throne uses to pin a harness binary.
- Each launch reads the file fresh, so the next agent launched sees an edit.
  A running agent keeps the environment it started with; `/restart-harnesses`
  relaunches it with the new one. If the file fails to load at launch, the
  agent launches without the extras and one line goes to stderr.
- `throne check-config` prints each harness's variable names, never the values.
- Not here: variables per role, unsetting a variable.

## How the file is loaded

- `src/user-config-loader.ts` parses the default export once per call, checks
  top-level and nested keys against the known lists, and hands each section to
  its owner for value validation. Persona: `src/application-config.service.ts`;
  steering: `src/steering-user-config.ts`; identity: `src/git-identity/`.
- Long-lived processes (the backend, the autoscale worker, tab creation, the
  git shim) re-read with a cache-bust token, so an edit is seen by the next
  tick, the next tab and the next commit — not by tabs already open, whose
  exported environment was computed at creation.
- A still-present legacy `src/config.user.ts` refuses loudly; the merged file
  (home copy, or the checkout copy when present) is the only source of truth.
- `test/config-doc-covers-every-user-config-field.test.ts` fails the suite when
  a key known to the loader is missing from this document.

## `accounts.json` — which Claude account folders agents run on

A separate JSON file beside `config.user.ts`: `~/.throne/config/accounts.json`.
With no file the throne behaves as it always has: one account, `~/.claude`, and
no account recorded for any agent. Malformed JSON, an unknown key or a bad value
is refused with an error naming the file; it never falls back to a default
silently. The reader is `src/account/accounts-config.ts`; the decision that
uses it is `src/harness-routing/policy/account-balance.ts`.

```json
{
  "accounts": [
    { "name": "primary", "harness": "claude", "folder": "/Users/theuser/.claude" },
    { "name": "secondary", "harness": "claude", "folder": "/Users/theuser/.throne/accounts/claude/secondary" }
  ],
  "longRunningAccount": "primary",
  "companyLogin": { "emailDomain": "example.com" },
  "mcpServersAllowedOnEveryAccount": [],
  "balancing": true
}
```

- `accounts` — the account folders, in fill order. Each entry has `name` (one
  plain lowercase word; `company` is reserved), `harness` (`claude`) and
  `folder` (an absolute path). The account whose folder is `~/.claude` is the
  primary. A new short-lived agent goes to the first account under 90% used on
  both the all-models 5-hour and weekly windows. The Fable window does not count.
  If no account is under 90%, the agent goes to the first account not yet at
  its limit. An account whose usage cannot be read (none read, or refused with
  HTTP 429) is not counted as full: when no readable account is below its
  limit, the agent goes to a logged-in account with no usage reading, the
  primary first, and the reason names the unreadable accounts. The spawn
  pauses only when every logged-in account has a usage reading at its limit.
- `longRunningAccount` — the account Stagers and the Regent run on, whatever
  the usage. Absent: the first account. `throne account switch-long-running <name>` sets it.
- `companyLogin` — how the company login is recognised from a folder's own
  login (`oauthAccount` in that folder's `.claude.json`): `emailDomain`,
  `organizationUuid`, or both. Company work runs only on the account logged
  in as the company, and waits while that account is at its limit.
- `mcpServersAllowedOnEveryAccount` — MCP server names every account may use.
  Every other server is company-only. Absent: none.
- `balancing` — `true` or `false`; absent means `true`. With `false`, a spawn
  reads no account usage and goes to the primary account, unless the agent
  names its account with `create-agent --account <name>`. Stagers and the
  Regent still run on `longRunningAccount`, and company work still runs on the
  company account. Every account's folder mapping stays in force: recorded
  accounts, relaunches and the transcript lookup keep using each agent's own
  folder.

Removing or renaming `accounts.json` is not a way to turn balancing off. It
also drops every account's folder mapping: on 2026-10-16 (message 20518),
with the file set aside, send-agent to an Alpha on the secondary account was
refused with "transcript contains no assistant runtime-model record", because
the transcript check looked in `~/.claude/projects` instead of the secondary
folder. Set `"balancing": false` instead.

The same file holds provider accounts, the keys of third-party providers,
under `providerAccounts`. Today only `deepseek` exists, used by the `pi` harness: its entry names a key
file that must exist, be non-empty and be readable only by its owner (mode
600), or every pi launch is refused naming the problem. The key never appears
in argv, `spawn.json`, pane text or the journal: the pane is given the key
file's path and `bin/piy` reads it into `DEEPSEEK_API_KEY`, in pi's environment only. A file holding only
provider accounts leaves every Claude launch exactly as with no file.

### pi settings

Each pi agent has its own pi configuration folder, `~/.throne/data/<agent>/pi-agent/`, and throne rewrites the `settings.json` in it at every launch. A pi agent started by throne never reads `~/.pi/agent/settings.json`.

Throne writes these defaults, which make pi quiet:

| Setting | Value | Effect |
| --- | --- | --- |
| `hideThinkingBlock` | `true` | hides the model's thinking blocks (`Ctrl+T` shows them in a session) |
| `quietStartup` | `true` | hides the start-up header and the list of loaded resources |
| `collapseChangelog` | `true` | shows a short changelog after an update |
| `defaultTools` | `['+codemode']` | turns on pi's `codemode` tool, which runs a JavaScript script calling pi's other tools and returns only the script's output, next to the default tools `read`, `bash`, `edit` and `write` (pi's `docs/cli.md` "Enable codemode") |

To change any of them, or to set any other pi setting, put one JSON object in `~/.throne/config/pi-settings.json`. Its entries are laid over the defaults:

```json
{
  "hideThinkingBlock": false,
  "defaultThinkingLevel": "low"
}
```

- The file is read at each pi launch, so a change reaches an agent the next time it starts.
- `defaultProvider` and `defaultModel` are throne's to set and are ignored in this file.
- A file that is not one JSON object refuses every pi launch, naming the file.
- No file means the defaults alone.
- Throne also writes `skills`, naming its own `.claude/skills` folder, so a pi agent has throne's skills whatever folder it works in. Folders you list under `skills` in this file are added after it. The global skills in `~/.agents/skills` are found by pi itself.
- Throne does not set `defaultProjectTrust`: a pi agent trusts no working folder's own pi resources unless you say so here.
- Throne keeps `lastChangelogVersion`, which pi records itself, from one launch to the next, so pi does not show its changelog again on every start.

The same settings can be written in `config.user.ts` as a top-level `piSettings` object. It is laid over the defaults after `pi-settings.json`, so for a key set in both, `config.user.ts` wins:

```ts
piSettings: {
  defaultTools: ['read', 'bash', 'edit', 'write'],
},
```

That entry replaces throne's `defaultTools` and so turns pi's `codemode` off. `codemode: { mode: 'only' }` instead hides the other tools from the model, which then reaches them through `codemode`; the default is `'on'` (pi's `docs/settings.md`).

- `piSettings` must be one object of JSON values. Pi's own setting names are not checked.
- `defaultProvider` and `defaultModel` in `piSettings` refuse the file at load, naming the key.
- Throne's `skills` folder and its `defaultProvider` and `defaultModel` are still written after it.
- It is read at each pi launch. A `config.user.ts` that fails to load there prints one line on stderr and the agent launches without the section.
- A running pi agent keeps the `settings.json` it was launched with; the change reaches it when it is next launched.
- `throne check-config` prints the key names it holds.
- No section leaves `settings.json` exactly as before.

Throne also places its own instruction file, `extensions/pi/AGENTS.md` in the throne checkout, in each agent's pi folder as `AGENTS.md`, linked back to the checkout at every launch so it never goes stale. It tells the agent to follow `~/.claude/CLAUDE.md`, to read both `AGENTS.md` and `CLAUDE.md` when the working folder has both, and to search the web only with the agent-browser skill and DuckDuckGo, from its own copy `~/.agent-browser/profiles/web-search-<agent>` of the persistent `~/.agent-browser/profiles/web-search` profile. Reaping the agent removes its copy; the base profile stays. A launch that cannot place it is refused with the reason. `~/.pi/agent/AGENTS.md` is not read by an agent throne starts.

## `features` — switches that are off until you turn them on

The `features` section of `config.user.ts` holds boolean switches, one object
of `<name>: true | false`. No section, or no name, leaves the switch off; a
value that is not a boolean, or a name throne does not know, refuses the file,
naming the key. Each switch is read fresh at every message, so a change takes
effect at the next one with no restart. A `config.user.ts` that fails to load
reads every switch as off and prints one line on stderr; the message is still
delivered. `throne check-config` shows each switch and its value, and says so
when a leftover `~/.throne/config/features.json` is no longer read.

| switch | default | effect when `true` |
| --- | --- | --- |
| `sendAgentFileBackedPayloads` | `false` | `send-agent` stages bodies of 768 bytes and over in a file and types a pointer (`agent_docs/commands.md` "File-backed bodies"). |

`send-agent` hands messages for Claude Code and pi agents to the agent's own
Unix socket, recorded in its `spawn.json` as `delivery_socket` and passed at
launch as `THRONE_DELIVERY_SOCKET`. pi listens inside its extension; for
Claude, throne's mod from `extensions/claude/`, which every Claude launch
loads (`--plugin-dir`), starts a helper through `bin/throne-runtime`
(`THRONE_DELIVERY_RUNTIME`, `THRONE_DELIVERY_HELPER`). No switch turns this
on or off. The agent reads the composer's real text, waits while a draft or a
turn is in it, submits the message, and answers on the same connection.
Delivery falls back to typed keys, once, with one line naming the agent and
the reason, in each of these cases:

- the agent's `spawn.json` records no `delivery_socket` (it was launched
  before the socket, or its Claude Code failed `claude plugin validate`;
  `throne restart-harnesses` relaunches it onto one);
- the socket cannot be connected to within 1000 ms, whatever file sits at
  the path (a dead agent, a killed helper);
- the agent answers `busy` after the sender's wait, or does not answer
  within that wait plus 2000 ms;
- the installed Claude Code fails `claude plugin validate extensions/claude`:
  agents launch without the mod and one line says it does not fit that
  version. `update-harnesses` runs the same validate on every Claude update
  and says so when the new version breaks the mod.

Codex and other harnesses are launched and messaged by typed keys as before.
Claude Code shows the model a mod-delivered message as
`The <mod name> plugin sent a message:` above the usual `<sender> said: <text>`
body (measured on Claude Code 2.1.322).
