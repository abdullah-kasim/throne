# Roleplay policy for throne persona/display config

Executable data is authoritative. Inspect the committed defaults and the
named preset registry in `src/application-config.service.ts`
(`DEFAULT_PERSONA_CONFIG`, `ROLEPLAY_PRESETS`). Documentation must not copy
their current field values.

## Presentation-layer contract

`PersonaConfig` is a DISPLAY layer over stable internal identifiers. It
governs how agents speak — the title used to address the human, the tier
titles agents use for each other in prose, the organization/campaign/queue
nouns, and the roleplay paragraph seeded into new agents' identity text.

It never governs machine identifiers: agent-name grammar (`alpha-*`,
`shadow-*`), `PLAN_ROLES`/`classifyPlanRole`, objective codes,
`derive-shadow-name-from-alpha`, herdr registry names, CLI command/flag
names, or ledger paths (`data/<agent-name>/…`). No `PersonaConfig` field
governs any of these, and no consumer of `PersonaConfig` may start reading
one of them from this schema — a display rename must never become a breaking
rename of a persisted identifier.

**Carve-out — `roleWords` governs exactly two overlay surfaces.** Each
preset's `roleWords` (`PersonaConfig.roleWords`) names the word substituted
for the canonical `alpha`/`shadow` tokens on (a) a newly-spawned agent's
herdr tab LABEL and (b) a ledger addressing SYMLINK created at persona
switch. `roleWords` governs only these two, always-derived, always-recomputable
overlay surfaces — it still never governs the real/canonical identifier
grammar named above (ledger path, herdr registration name, `PLAN_ROLES`,
`classifyPlanRole`, CLI command/flag names), which stays fixed under every
preset. `roleWords` is validated injective across the entire
`ROLEPLAY_PRESETS` registry at module load — no two (preset, role) pairs may
produce the same word, and no preset's word may reuse the canonical token
reserved for the other role — so an ambiguous preset is rejected at load,
never at runtime.

## Preset selection is data, not a code branch

`ROLEPLAY_PRESETS` is `Readonly<Record<RoleplayPresetName, PersonaConfig>>` —
a flat table of named, complete `PersonaConfig` rows. `config.user.ts` may
set `roleplayPreset` to choose the merge base; every other override field
then applies per-field over that preset exactly as it would over `Default`.

No consumer of `PERSONA_CONFIG` — nor `loadPersonaConfig` itself — branches
on which preset name is active. Adding a preset is exactly one new
`ROLEPLAY_PRESETS` row; it requires no new conditional anywhere in
production code. A preset that needed a call-site `if` to render correctly
would be a design defect, not a valid addition.

## The `Default` preset is the regression bar

`ROLEPLAY_PRESETS.Default` is defined as `DEFAULT_PERSONA_CONFIG`, the
committed generic values a fresh clone speaks with no override file present.
Every other preset is free to diverge in register and vocabulary, but
`Default` itself must never drift from today's committed literals — it is
the byte-identical baseline every persona-config regression test is pinned
against.

## Adding or editing a preset

A preset's `PersonaConfig` must populate every field the interface declares
— there is no partial preset row, only a partial per-field *override* on top
of one. Field values may take any register (formal, casual, faction-themed)
but must stay internally coherent: `tierTitles`, `throneTitle`,
`campaignTitle`, and `queueDescription` are read as plain nouns by every
consumer and interpolated into short, functional sentences, so they should
read naturally in that position without additional punctuation or trailing
context baked in. `roleplayPrompt` is the one field meant to carry a fuller
register and any signature phrasing for the preset — it is seeded whole into
new agents' identity text, never fragmented across other fields.

## Where the config is read

See `agent_docs/persona-config.md`'s "Where the config is read" section for
the current consumer list; this policy doc does not duplicate it, since a
duplicated list is exactly the kind of value that drifts.
