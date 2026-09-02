// Template for `config.user.ts` — the throne's SINGLE local machine override
// file, at the live throne root.
//
// Copy this file to `config.user.ts` next to it and edit. `config.user.ts` is
// gitignored, so whatever you set here stays on this machine; the committed
// tree keeps the generic defaults. With no `config.user.ts` present the
// throne silently uses those defaults. Every campaign worktree resolves this
// same live-root file, not a copy of its own.
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

import type { PersonaConfigOverride } from './src/application-config.service.ts';
import type { SteeringConfigOverride } from './src/steering-user-config.ts';

interface UserConfigFileOverride extends PersonaConfigOverride {
  readonly steering?: SteeringConfigOverride;
  readonly identity?: {
    readonly name?: string;
    readonly email?: string;
  };
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
    activePlanPresetName: 'UnifiedRouting',
    activeTargetEffort: 1,

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
    // stagerPool: [{ harness: 'omp', model: 'opus' }],

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
    // flip `activePlanPresetName` to its name by hand. `omp` (oh-my-pi) is
    // registered as a fourth runtime harness but ships inactive; switching
    // to it is a deliberate operator choice, never a side effect of copying
    // this file.
    //
    // customPlanPresets: {
    //   OmpTrial: {
    //     alpha: [{ harness: 'omp', model: 'sonnet' }],
    //     shadow: [{ harness: 'omp', model: 'sonnet' }],
    //     shadowSlice99: [{ harness: 'omp', model: 'sonnet' }],
    //   },
    // },
  },

  // --- Git identity (see create-agent's --empty-worktree) ---

  // The LOCAL git identity `create-agent --empty-worktree` sets in a freshly
  // created scratch workspace (`git -C <workspace> config user.name/
  // user.email`). Never written globally, never written into any target
  // repo. Omit the whole section (or run without a `config.user.ts` at all)
  // to have `--empty-worktree` refuse loudly instead of guessing an identity.
  identity: {
    name: 'Your Name',
    email: 'you@example.com',
  },
};

export default userConfig;
