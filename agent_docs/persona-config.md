# Persona / display config

The throne's DISPLAY layer — how agents address the human, what the three
agent tiers are called in prose, and the roleplay persona paragraph seeded
into new agents — is configurable through a small, layered, hand-validated
config. It does not touch machine identifiers (see below).

## Schema

Defined in `src/application-config.service.ts` as the `PersonaConfig` interface:

- `addressTitle: string` — how agents address the human.
- `tierTitles: { regent: string; alpha: string; shadow: string }` — what the
  three agent tiers are called in prose.
- `throneTitle: string` — what the organization itself is called in prose.
- `campaignTitle: string` — the noun for a unit of work.
- `queueDescription: string` — the descriptive phrase for the objective-backlog
  file's contents. The literal filename (`QUEUE.md`) is a ledger path and is
  never affected by this field.
- `roleplayPrompt: string` — a roleplay persona paragraph injected into every
  new agent's identity text.

The committed default (`DEFAULT_PERSONA_CONFIG`) is deliberately generic:

```
addressTitle: 'Lord'
tierTitles: { regent: 'Regent', alpha: 'Alpha', shadow: 'Shadow' }
throneTitle: 'Throne'
campaignTitle: 'campaign'
queueDescription: 'your objective backlog'
roleplayPrompt: 'You serve in a disciplined court. Speak plainly and candidly, never
  flatter, and prefer a blunt correction to a comfortable one. Carry out your charge
  with the seriousness the court expects, and report what actually happened rather
  than what was hoped for.'
```

## Named presets

`ROLEPLAY_PRESETS: Readonly<Record<RoleplayPresetName, PersonaConfig>>` holds
named, full `PersonaConfig` rows — `'Default'` (identical to
`DEFAULT_PERSONA_CONFIG`) and `'DRG'`. A `config.user.ts` override may set
`roleplayPreset` to pick the merge base; every other field then overrides that
preset per-field exactly as before. Presets are DATA: no consumer of
`PersonaConfig` branches on which preset is active, so a third preset is a new
`ROLEPLAY_PRESETS` row, never a new conditional.

An override supplies only the fields it wants to change: `PersonaConfigOverride`
makes every top-level field optional, and `tierTitles` is itself partial (a
`config.user.ts` overriding only `tierTitles.regent` leaves `alpha` and `shadow`
at their defaults).

## Layering

- The committed defaults in `src/application-config.service.ts` always exist. A fresh clone
  with no override file speaks the generic Lord/Regent/Alpha/Shadow court.
- An optional `config.user.ts` at the LIVE THRONE ROOT supplies a partial
  override, `export default`-ing an object matching `PersonaConfigOverride`.
  Copy `config.user.example.ts` (at the throne root) to `config.user.ts` and
  edit it to create one.
- `config.user.ts` is gitignored (`/config.user.ts` in `throne/.gitignore`), so
  local flavour never lands in git. It is resolved from the live throne root
  (the same `resolveLiveThroneRoot` git primitive `steering-user-config.ts`
  uses), not from the running checkout's own directory — a campaign worktree
  observes the same effective persona config as the live root.
- An absent `config.user.ts` is silent and produces the defaults unchanged. An
  invalid one — a non-object default export, an unknown top-level or
  `tierTitles` key, a non-string value, an empty/whitespace-only string, or an
  unrecognized `roleplayPreset` — throws loudly, naming the file and the
  offending field in the error message (e.g. `` Invalid persona config in
  "<path>": `tierTitles.regent` must be a non-empty string (got a number). ``).
  There is no fallback to defaults on an invalid file, and a failure to
  resolve the live throne root itself throws too: a typo'd override or an
  unresolvable root that silently did nothing would be worse than a loud
  failure.

## Where the config is read

`PERSONA_CONFIG`, the resolved effective config, is imported and read by:

- `src/agentdata/identity-data.service.ts` — the standing "never put a question to the ⟨address
  title⟩" instruction; `tierTitles` for the Alpha standing instruction
  (delivered in an Alpha's opening prompt, naming the Regent/Shadow tiers it
  spawns and reports to); and the roleplay persona paragraph appended to every
  new agent's identity text. Identity text itself reads `addressTitle` and
  appends `roleplayPrompt` — it contains no tier-title reads.
- `src/regentstate.ts` — the `RESURRECT_PROMPT` the keep-going watchdog feeds a
  freshly resurrected Regent.
- `src/throne-startup/throne-startup-reconciliation.service.ts` — `buildResumePrompt`'s escalation-target and
  address-title text.
- `src/notify-lord/notify-lord.command.ts` — the user-visible success/failure messages
  from the `notify-lord` command.
- `src/tools.ts` — the `notify-lord` command's one-line description in the
  `COMMANDS` table.

New agents' identity text carries the configured roleplay persona (via
the identity data service), so severing the global `~/.claude/CLAUDE.md` from throne
agents does not lose the persona — it already lives in throne-owned config by
the time that sever happens.

## The machine-identifier decision

The display layer above is configurable; the MACHINE layer is deliberately
**not**. Out of scope for this config, on purpose:

- The `alpha-`/`shadow-` agent-name prefixes and `campaignPrefix`
  (`` `shadow-${code}-` ``) in `src/config.ts`.
- `PLAN_ROLES` / `PlanRole` / `classifyPlanRole` in `src/config.ts`.
- Objective codes and the `derive-shadow-name-from-alpha` command.
- The herdr registry agent name `Regent` itself, and other herdr registry
  names.
- CLI command names (e.g. `notify-lord`, `summon-regent`, `dismiss-regent`).
- Ledger paths (`data/<agent-name>/…`).

These identifiers span many `src/` files, persisted `data/<name>/` ledgers, the
herdr registry, court-law prose (`AGENTS.md`), and the todo skills. Renaming
any of them is not a display change — it is a breaking change to existing
agent registrations, in-flight ledgers, and cross-references between them, and
is not bounded the way a prose-string swap is. A config field that must equal
its own default to keep the throne working would be a trap for an operator
editing `config.user.ts`, not a real customization surface, so no such field
ships.

Renaming the machine layer — agent-name prefixes, plan roles, ledger paths,
and the herdr registry names — remains an explicit follow-up for a future
campaign, not something this config takes on.
