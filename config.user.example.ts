// Template for `config.user.ts` — the throne's SINGLE local machine override
// file, kept in the throne home's config folder:
// `~/.throne/config/config.user.ts` (`$THRONE_DATA_HOME/config/config.user.ts`
// when that override is set).
//
// Copy this file there and edit. A `config.user.ts` in the live throne
// checkout, next to this template, is loaded instead when present (one stderr
// line says so when it hides a home copy); it is gitignored and meant for
// quick tests. With neither present the throne silently uses the committed
// defaults. Every campaign worktree resolves the same file, not a copy of its
// own.
//
// THREE INDEPENDENTLY OPTIONAL TOP-LEVEL SECTIONS: the persona/display fields
// and `ntfy` below, plus `steering` and `identity`. Every field, in every
// section, is optional — a file naming only ONE section (e.g.
// `{ steering: {...} }`) leaves every other section, and every other field,
// at its committed default. This is deliberate: a Regent routinely
// whole-file-rewrites this file to flip `steering.activePlanPresetName` for
// one spawn, and that write must never blank out your persona or `ntfy`
// identity. Unknown keys — top-level or nested within a section — are
// REJECTED at load time with an error naming this file and the offending
// field; there is no silent fallback, because an override that quietly does
// nothing is the worst outcome.
//
// The safe procedure for changing ONLY `steering`: read this file, keep every
// key you're not changing exactly as it stands, edit only the
// `steering.activePlanPresetName`/`steering.activeTargetEffort` values you
// mean to change, and write the whole object back. Never write a bare
// `{ steering: {...} }` object over an existing file that also carries
// `addressTitle`/`ntfy`/`identity` — that IS a valid partial file (every
// other section falls back to its default), but it silently discards
// whatever you'd already customized in the other sections. Preserve, don't
// replace.

import type { AgentSettingsConfigOverride } from './src/agent-settings/agent-settings-user-config.ts';
import type { PersonaConfigOverride } from './src/application-config.service.ts';
import type { PreviewEntry } from './src/previews/preview-entries.ts';
import type { RecallConfig } from './src/relevance-classifier/recall-user-config.ts';
import type { SteeringConfigOverride } from './src/steering-user-config.ts';
import type { FeatureSwitches } from './src/user-config-loader.ts';

interface UserConfigFileOverride extends PersonaConfigOverride {
  readonly steering?: SteeringConfigOverride;
  readonly identity?: {
    readonly name?: string;
    readonly email?: string;
    readonly signingKey?: string;
    readonly signingFormat?: 'openpgp' | 'ssh';
    readonly identities?: Record<
      string,
      { name: string; email: string; signingKey?: string; signingFormat?: 'openpgp' | 'ssh' }
    >;
    readonly remotes?: Record<string, string>;
  };
  readonly recall?: Partial<RecallConfig>;
  readonly agentSettings?: AgentSettingsConfigOverride;
  readonly editor?: string;
  readonly previews?: readonly PreviewEntry[];
  readonly harnessEnvironment?: Record<string, Record<string, string>>;
  readonly features?: Partial<FeatureSwitches>;
}

const userConfig: UserConfigFileOverride = {
  // --- Persona / display (see application-config.service.ts) ---

  // Start from a named preset. Omit to start from 'Default'. Each preset also
  // carries its own `roleWords` — the word substituted for the canonical
  // `alpha`/`shadow` tokens on herdr tab labels and ledger addressing
  // symlinks only (never the real/registered identifier). `roleWords` is
  // fixed per preset and is not one of the per-field overrides below.
  roleplayPreset: 'Default',

  // How agents address you.
  addressTitle: 'Lord',

  // What the three agent tiers are called in prose.
  tierTitles: {
    regent: 'Regent',
    alpha: 'Alpha',
    shadow: 'Shadow',
  },

  // What the organization itself is called in prose.
  throneTitle: 'Throne',

  // The noun for a unit of work.
  campaignTitle: 'campaign',

  // The descriptive phrase for the objective-backlog file's contents. The
  // literal filename (QUEUE.md) is a ledger path and is never affected by
  // this field.
  queueDescription: 'your objective backlog',

  // The roleplay persona paragraph seeded into every new agent's identity.
  roleplayPrompt:
    'You serve in a disciplined court. Speak plainly and candidly, never ' +
    'flatter, and prefer a blunt correction to a comfortable one. Carry out ' +
    'your charge with the seriousness the court expects, and report what ' +
    'actually happened rather than what was hoped for.',

  // Host-local phone-push identity. Omit the whole section to leave the
  // committed inert defaults (loopback server, topic `throne-notifications`)
  // in place. The `THRONE_NTFY_SERVER_URL` / `THRONE_NTFY_TOPIC` env vars
  // still override whatever is set here.
  ntfy: {
    serverUrl: 'http://127.0.0.1:8410',
    topic: 'throne-notifications',
  },

  // --- Steering (see steering-user-config.ts) ---

  // Which registered plan preset (`PLAN_PRESET_NAMES`) a fresh spawn steers
  // toward, and the target effort every fresh spawn is clamped toward before
  // the per-model clamp applies.
  steering: {
    activePlanPresetName: 'OpusOnly',
    activeTargetEffort: 3,

    // Choose the message-delivery queue explicitly. Omit this field to retain
    // the existing `send-agent-bullmq-queue-transport` feature-flag behavior.
    // messageQueueTransport: 'sqlite',

    // WHICH PAIR THE STAGER RUNS ON. Absent = the committed claude/opus pin
    // in src/config.ts. The Stager is not a campaign role: no preset and no
    // `activeHarness` moves it, precisely so that a court-wide harness or
    // model switch cannot silently relocate the Lord's point of contact.
    // This field is the one deliberate place it CAN be moved. Validated
    // against the configured pair table at load — a typo refuses the whole
    // config rather than spawning a different Stager than you asked for.
    //
    // stagerPool: [{ harness: 'pi', model: 'pro' }],

    // Per-role effort, 1 to 6 (claude: 1 low, 2 medium, 3 high, 4 xhigh,
    // 5 max). A role left out uses activeTargetEffort. A queue row's own
    // --effort still wins for its campaign.
    //
    roleEfforts: { alpha: 3, shadow: 3, shadowSlice99: 3, stager: 3, regent: 3 },

    // WHICH PAIR THE REGENT RUNS ON. Absent = the old launch (the recorded
    // data/regent route at effort 1, or bare bin/claudey). When set, the
    // Regent launches on this pair at roleEfforts.regent.
    //
    regentRoute: { harness: 'claude', model: 'opus' },

    // Durable operator disable for the token-balance load balancer
    // (src/token-balance/), independent of that feature's own ship-dark
    // THRONE_TOKEN_BALANCE_ENABLED env-var kill switch — either being
    // off/absent fully de-gates it (create-agent stops refusing off-lane
    // spawns, autodispatch falls back to ACTIVE_PLAN_PRESET.rolePools.Alpha[0]
    // exactly as today). Absent or false = disabled, matching the fresh-clone
    // default. Set true only once the balancer feature is meant to run.
    tokenBalanceEnabled: false,

    // THE OPERATOR PAUSE. The alpha-autoscale worker's env switch
    // (THRONE_ALPHA_AUTOSCALE_ENABLED) is permanently armed in both service
    // templates (the Lord's order of 2026-09-02), so this field is the one
    // deliberate place the court's spawning is turned off. `false` makes
    // every autoscale tick skip before it touches the queue -- no Alpha is
    // born until it is `true` again. The worker re-reads this file on every
    // tick, so flipping it needs no backend restart in either direction.
    // Absent means ON. Flip it with the `/autoscaler off` / `/autoscaler on`
    // skill (Stager only) rather than by hand.
    autoscaleEnabled: true,

    // A custom preset pool routes fresh spawns through a `{harness, model}`
    // pair that isn't one of the committed built-in presets above. EXAMPLE
    // ONLY — commented out, and not referenced by `activePlanPresetName`
    // above, so it changes nothing until you uncomment BOTH this block AND
    // flip `activePlanPresetName` to its name by hand. Switching harness is a
    // deliberate operator choice, never a side effect of copying this file.
    //
    // customPlanPresets: {
    //   PiTrial: {
    //     alpha: [{ harness: 'pi', model: 'flash' }],
    //     shadow: [{ harness: 'pi', model: 'flash' }],
    //     shadowSlice99: [{ harness: 'pi', model: 'flash' }],
    //   },
    // },
  },

  // --- Git identity (docs/CONFIG.md, "identity") ---
  // Who signs every commit the court makes. Exported onto every tab as
  // GIT_AUTHOR_*/GIT_COMMITTER_* plus git's env-injected signing config, and
  // re-resolved per commit by bin/git for a repository whose origin differs
  // from the tab's. Never written globally, never written into any repo.
  // SIGNING IS MANDATORY: without `signingKey` the identity does not count,
  // and the shim STOPs and has the agent ask you — it never guesses.
  identity: {
    name: 'Your Name',
    email: 'you@example.com',
    signingKey: '<gpg key id from `gpg --list-secret-keys --keyid-format long`>',
    // signingFormat: 'openpgp',           // or 'ssh' with a public-key path above
    // Named alternatives, chosen by the repository origin (`host` or
    // `host:owner`; `host:owner` wins; 'default' names the pair above).
    // identities: { work: { name: 'Your Name', email: 'you@work.example' } },
    // remotes: { 'github.com:your-org': 'work', 'git.work.example': 'work' },
  },

  // --- Memory recall and log sift (docs/CONFIG.md, "recall") ---
  // `throne recall` picks which recorded memories apply to a task and prints
  // their bodies; `throne sift` prints only the chunks of a long command
  // output that matter. Both decide with plain keyword rules.
  recall: {
    // A memory is served when the probability that it applies is at least
    // this. These are knobs, not facts.
    serveThreshold: 0.5,
    // The lower bar for a memory marked `cost_if_missed: high`.
    serveThresholdWhenCostIsHigh: 0.3,
    // A log chunk is kept when the probability that it matters is at least this.
    siftKeepThreshold: 0.5,

    // Total characters of memory text one recall may print.
    maximumInjectedCharacters: 8000,
    repositoryMemoryNamesPerRepository: 40,

    // Memory directories shared by every project, read in addition to the
    // project's own memory directory (`throne memory-dir .`). Empty by default.
    globalMemoryDirectories: [],
  },

  agentSettings: {
    checkEnabled: true,
    colourByRole: {
      Regent: 'red',
      Stager: 'green',
      Alpha: 'blue',
      Shadow: 'purple',
    },
  },

  previews: [],

  // pi settings laid over every pi agent's pi-agent/settings.json at its next
  // launch, after ~/.throne/config/pi-settings.json, so a key here wins.
  // defaultProvider and defaultModel are throne's and are refused.
  // Throne turns pi's codemode tool on with defaultTools ['+codemode'].
  // Turn it off by naming the tools without it:
  // piSettings: {
  //   defaultTools: ['read', 'bash', 'edit', 'write'],
  // },

  features: {
    sendAgentFileBackedPayloads: false,
  },

  // --- Extra environment per harness (docs/CONFIG.md, "harnessEnvironment") ---
  // Variables added to every agent throne launches on that harness, keyed by
  // harness name. Throne's own values win over these. Names starting THRONE_,
  // GIT_ or HERDR_, PATH, HOME and the pinned harness binary variables are
  // refused. Read fresh at each launch; restart a running agent with
  // /restart-harnesses to pick up a change. `throne check-config` prints the
  // names, never the values.
  //
  // Throne sets CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 for Claude beneath this
  // section; turn Claude Code's code mode off with:
  // harnessEnvironment: {
  //   claude: { CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: '0' },
  // },
};

export default userConfig;
