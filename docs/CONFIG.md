# `config.user.ts` — every setting, in one place

`config.user.ts` is the throne's single machine-local override file. It lives at
the **live throne root** (next to `AGENTS.md`), is gitignored, and is read fresh
by the commands that consult it, so an edit takes effect without a restart. A
campaign worktree resolves the live root's file, never a copy of its own.

Start from the template: `cp config.user.example.ts config.user.ts`. Every field
in every section is optional; an absent file, section or field leaves the
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
| `ntfy` (top level) | `serverUrl`, `topic` | `notify-lord` phone pushes (`agent_docs/ntfy-phone-notifications.md`) |
| `steering` | `activePlanPresetName`, `activeTargetEffort`, `activeHarness`, `messageQueueTransport`, `customPlanPresets`, `stagerPool`, `tokenBalanceEnabled`, `autoscaleEnabled` | every fresh spawn's harness/model/effort, the Stager pool, the autoscaler, the token balancer (`agent_docs/MODEL_POLICY.md`) |
| `identity` | `name`, `email`, `signingKey`, `signingFormat`, `identities`, `remotes` | every git commit the court makes (`throne git-identity`, the `bin/git` shim, tab creation; `agent_docs/commands.md`) |

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

## `ntfy` — phone pushes

Host-local secrets, which is why they live here and not in the tree. Omit the
whole section to keep the inert committed defaults (loopback server, topic
`throne-notifications`).

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `serverUrl` | string | `http://127.0.0.1:8410` | Base URL of the ntfy server (typically a private tailnet address). |
| `topic` | string | `throne-notifications` | The topic `notify-lord` publishes to. Anyone holding it can push to your phone: treat it as a secret. |

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
| `activePlanPresetName` | `'GptOnly' \| 'AnthropicOnly' \| 'Optimized' \| 'Whichever' \| 'UnifiedRouting' \| <a `customPlanPresets` key>` | `'UnifiedRouting'` | Which preset's role pools a fresh Alpha, Shadow and ShadowSlice99 spawn steers toward. `UnifiedRouting` is Sonnet end to end. The `/switch-campaign-model` skill rewrites this for you. |
| `activeTargetEffort` | number | `1` | The reasoning effort every fresh spawn is clamped toward, before the per-model clamp. `1` is "low". |
| `activeHarness` | harness name | absent | Run every campaign role on THIS harness regardless of what the preset's pairs name. Absent means "each pair as written". Harness and model are independent choices, and this field exists so changing one never silently changes the other. The Stager is never moved by it. |
| `messageQueueTransport` | `'sqlite'` | absent | Explicit queue-transport marker. Only the SQLite delivery path exists; omitting it keeps the feature-flag behaviour. |
| `customPlanPresets` | `Record<name, { alpha, shadow, shadowSlice99 }>` | `{}` | Your own presets: each of the three campaign-role pools is a non-empty list of `{ harness, model }` pairs. Defining one changes nothing until `activePlanPresetName` names it. The Stager has no pool here by design. |
| `stagerPool` | `{ harness, model }[]` | absent | The Stager's own pair pool. Absent means the committed pin in `src/config.ts` (currently `claude/fable`, `claude/opus`). This is the ONE place the Stager can be moved; no preset and no `activeHarness` touches it, so a court-wide switch can never relocate your point of contact by accident. |
| `tokenBalanceEnabled` | boolean | `false` | Durable operator enable for the token-balance load balancer (`src/token-balance/`). Its ship-dark env kill switch `THRONE_TOKEN_BALANCE_ENABLED` must also be on; either being off fully de-gates it. |
| `autoscaleEnabled` | boolean | `true` (absent means ON) | THE operator pause for the whole court's spawning. `false` makes every autoscale tick skip before it touches the queue; the worker re-reads the file each tick, no restart needed. The env switch `THRONE_ALPHA_AUTOSCALE_ENABLED` is permanently armed by the service templates, so this field is the deliberate off. Flip it with `/autoscaler off|on`. |

Harness and model names come from the registry: `throne list-harnesses-and-models`
prints every pair the throne can spawn on this machine (harnesses `claude`,
`codex`, `opencode`, `omp`; models such as `fable`, `opus`, `sonnet`, `haiku`,
`gpt-5.6-sol`, `gpt-5.6-terra`).

```ts
steering: {
  activePlanPresetName: 'OmpTrial',
  activeTargetEffort: 1,
  customPlanPresets: {
    OmpTrial: {
      alpha: [{ harness: 'omp', model: 'sonnet' }],
      shadow: [{ harness: 'omp', model: 'sonnet' }],
      shadowSlice99: [{ harness: 'omp', model: 'sonnet' }],
    },
  },
  stagerPool: [{ harness: 'omp', model: 'opus' }],
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
  signingKey: 'EF48D4AEA48740A906D185C249F04938B553113B',
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

## How the file is loaded

- `src/user-config-loader.ts` parses the default export once per call, checks
  top-level and nested keys against the known lists, and hands each section to
  its owner for value validation. Persona: `src/application-config.service.ts`;
  steering: `src/steering-user-config.ts`; identity: `src/git-identity/`.
- Long-lived processes (the backend, the autoscale worker, tab creation, the
  git shim) re-read with a cache-bust token, so an edit is seen by the next
  tick, the next tab and the next commit — not by tabs already open, whose
  exported environment was computed at creation.
- A still-present legacy `src/config.user.ts` refuses loudly; the merged file at
  the root is the only source of truth.
- `test/config-doc-covers-every-user-config-field.test.ts` fails the suite when
  a key known to the loader is missing from this document.
