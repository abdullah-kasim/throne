// Layered display/persona configuration: the title agents use to address the
// human, the display titles of the three agent tiers, the organization and
// campaign/queue nouns, and the roleplay persona paragraph seeded into every
// new agent's identity text.
//
// Two layers. The generic defaults below are committed, so a fresh clone speaks
// a neutral court persona. An OPTIONAL, gitignored `config.user.ts` at the
// LIVE THRONE ROOT supplies a partial override merged over them, so local
// flavour never lands in git. The user file is resolved via the live throne
// root (`resolveLiveThroneRoot`, owned by `throne-root-resolution.ts`, shared
// with `steering-user-config.ts`), never from the running checkout's own
// directory or the cwd — a worktree executing this module must observe the
// same effective config as the live root.
//
// The override may also select a named preset (`roleplayPreset`) from
// `ROLEPLAY_PRESETS` as its base before any per-field override applies.
// Presets are DATA: no consumer of `PersonaConfig` branches on which preset
// is active, so adding a preset is a new table row, never a new conditional.
// Schema invariants and the preset/override semantics are documented in
// throne/agent_docs/ROLEPLAY_POLICY.md.
//
// DISPLAY ONLY, with exactly one deliberate exception: the `ntfy` section,
// which carries this host's phone-push identity. It rides in the same user
// file because that file is gitignored and its two values are host-local
// secrets — see `shared-policy/ntfy-user-config.ts`.
//
// Machine identifiers — agent-name prefixes, plan roles, herdr
// registry names, CLI command names, ledger paths — are deliberately absent
// from this schema. They are baked into persisted `data/<name>/` ledgers and
// the herdr registry, so renaming them is not a display change and a config
// field that must equal its default would be a trap.
//
// Validation is hand-rolled because the throne ships zero runtime dependencies
// and this schema is one flat object of non-empty strings plus one nested
// record. An INVALID user file throws with the file, the field, and the
// expectation named: a typo'd override that silently does nothing is worse
// than a loud failure, so there is no fallback-to-defaults path. An ABSENT
// user file is silent and fine. A failure to resolve the live throne root
// itself also throws — it is never mistaken for an absent file.

import {
  describeValue,
  isPlainObject,
} from './shared-policy/config-value-shape.ts';
import {
  type NtfyUserConfig,
  validateNtfy,
} from './shared-policy/ntfy-user-config.ts';
import { resolveLiveThroneRoot } from './throne-root-resolution.ts';
import { loadUserConfigFile, userConfigPath } from './user-config-loader.ts';

/** Display titles for the three agent tiers. */
export interface PersonaTierTitles {
  readonly regent: string;
  readonly alpha: string;
  readonly shadow: string;
}

/** The word substituted for the canonical `alpha`/`shadow` tokens on the two
 *  surfaces `ROLEPLAY_POLICY.md` names as persona-governed: herdr tab labels
 *  and ledger addressing symlinks. Never the real/registered identifier —
 *  `ledger path`, herdr registration name, `PLAN_ROLES`, `classifyPlanRole`,
 *  and CLI command/flag names stay canonical under every preset. */
export interface PersonaRoleWords {
  readonly alpha: string;
  readonly shadow: string;
}

export interface PersonaConfig {
  /** How agents address the human. */
  readonly addressTitle: string;
  /** What the three agent tiers are CALLED in prose. Display only. */
  readonly tierTitles: PersonaTierTitles;
  /** What the organization/institution itself is CALLED in prose. */
  readonly throneTitle: string;
  /** The noun for a unit of work (e.g. "campaign"). */
  readonly campaignTitle: string;
  /** The descriptive phrase for the objective-backlog file's contents — never
   *  the literal filename, which is a ledger path and unaffected by this. */
  readonly queueDescription: string;
  /** Roleplay persona paragraph injected into new agents' identity text. */
  readonly roleplayPrompt: string;
  /** The role word used for display/addressing in place of the canonical
   *  `alpha`/`shadow` tokens. `Default`'s words are the canonical tokens
   *  themselves. See `PersonaRoleWords`. */
  readonly roleWords: PersonaRoleWords;
}

/** Named, reusable `PersonaConfig` rows. Data only — no consumer branches on
 *  which name is active, so a third preset is one new row here. */
export type RoleplayPresetName = 'Default' | 'DRG';

/** The shape a `config.user.ts` default export may take: every field optional,
 *  `tierTitles` overridable per key, plus the preset selector. */
export interface PersonaConfigOverride {
  readonly roleplayPreset?: RoleplayPresetName;
  readonly addressTitle?: string;
  readonly tierTitles?: Partial<PersonaTierTitles>;
  readonly throneTitle?: string;
  readonly campaignTitle?: string;
  readonly queueDescription?: string;
  readonly roleplayPrompt?: string;
  /** Host-local push identity — the one non-display section. See
   *  `shared-policy/ntfy-user-config.ts`. */
  readonly ntfy?: NtfyUserConfig;
}

/** The committed, deliberately generic default. Carries no local flavour: the
 *  whole point of the user-file layer is that the tracked tree stays neutral. */
export const DEFAULT_PERSONA_CONFIG: PersonaConfig = {
  addressTitle: 'Lord',
  tierTitles: { regent: 'Regent', alpha: 'Alpha', shadow: 'Shadow' },
  throneTitle: 'Throne',
  campaignTitle: 'campaign',
  queueDescription: 'your objective backlog',
  roleplayPrompt:
    'You serve in a disciplined court. Speak plainly and candidly, never ' +
    'flatter, and prefer a blunt correction to a comfortable one. Carry out ' +
    'your charge with the seriousness the court expects, and report what ' +
    'actually happened rather than what was hoped for.',
  roleWords: { alpha: 'alpha', shadow: 'shadow' },
};

/** Deep Rock Galactic: a mining-crew register over the same schema. See
 *  `agent_docs/ROLEPLAY_POLICY.md` for the field contract this preset fills. */
const DRG_PERSONA_CONFIG: PersonaConfig = {
  addressTitle: 'Karl',
  tierTitles: { regent: 'Mission Control', alpha: 'Foreman', shadow: 'Greenbeard' },
  throneTitle: 'The Space Rig',
  campaignTitle: 'mission',
  queueDescription: 'your Mission Board',
  roleplayPrompt:
    "You've got Karl's back down in the dark, and Karl's got yours — that's " +
    'the whole deal. Call it straight, dwarf: no polishing a bad reading just ' +
    "to keep spirits up, no burying a cave-in behind good news. Watch your " +
    "crewmates' drills, pull your own weight on the dive, and when the mission's " +
    'done report what actually happened topside, not what you wish had. Rock ' +
    'and Stone!',
  roleWords: { alpha: 'Foreman', shadow: 'Greenbeard' },
};

/** The named preset registry. `Default` reproduces today's exact behaviour;
 *  `DRG` is the Deep Rock Galactic register — Lord becomes Karl. See
 *  `agent_docs/ROLEPLAY_POLICY.md` for the schema and field contract. */
export const ROLEPLAY_PRESETS: Readonly<Record<RoleplayPresetName, PersonaConfig>> = {
  Default: DEFAULT_PERSONA_CONFIG,
  DRG: DRG_PERSONA_CONFIG,
};

/** The full preset name registry, derived from `ROLEPLAY_PRESETS` itself —
 *  the sole source of truth `switch-persona` lists and validates against, so
 *  a third preset row is automatically listed and accepted with no second
 *  edit anywhere. */
export const ROLEPLAY_PRESET_NAMES = Object.keys(
  ROLEPLAY_PRESETS,
) as readonly RoleplayPresetName[];

/** Thrown by `assertRoleWordRegistryIsInjective` — named so callers and tests
 *  can distinguish a role-word collision from any other config error. */
export class RoleWordRegistryConflictError extends Error {}

const CANONICAL_ROLE_WORDS = { alpha: 'alpha', shadow: 'shadow' } as const;

/**
 * Validates, across the ENTIRE preset registry, that no two (preset, role)
 * pairs produce the same role word (case-insensitively, matching the
 * lowercase tab-label convention), and that no preset's role word reuses a
 * reserved canonical token (`alpha`/`shadow`) for the OTHER role — a preset's
 * own role word may equal its own canonical token (that is what makes
 * `Default` legitimate), but never the other role's token. Throws
 * `RoleWordRegistryConflictError` naming both colliding entries; never
 * silently drops or renames a colliding preset. Run at module load so a
 * future ambiguous preset is rejected before any agent ever spawns under it.
 */
export function assertRoleWordRegistryIsInjective(
  presets: Readonly<Record<string, PersonaConfig>>,
): void {
  const producedBy = new Map<string, string>();
  for (const [presetName, config] of Object.entries(presets)) {
    for (const role of ['alpha', 'shadow'] as const) {
      const word = config.roleWords[role];
      const normalizedWord = word.toLowerCase();
      const label = `${presetName}.${role} ("${word}")`;

      const otherRole = role === 'alpha' ? 'shadow' : 'alpha';
      if (normalizedWord === CANONICAL_ROLE_WORDS[otherRole]) {
        throw new RoleWordRegistryConflictError(
          `Role-word registry conflict: ${label} reuses the reserved ` +
            `canonical token "${CANONICAL_ROLE_WORDS[otherRole]}", which is ` +
            `reserved for the ${otherRole} role.`,
        );
      }

      const existingLabel = producedBy.get(normalizedWord);
      if (existingLabel !== undefined) {
        throw new RoleWordRegistryConflictError(
          `Role-word registry conflict: ${label} collides with ${existingLabel} ` +
            `— role words must be injective (case-insensitive) across the ` +
            `entire preset registry.`,
        );
      }
      producedBy.set(normalizedWord, label);
    }
  }
}

assertRoleWordRegistryIsInjective(ROLEPLAY_PRESETS);

/** Where the optional user override lives: `<live-throne-root>/config.user.ts`.
 *  Delegates to the shared loader's path function — persona and steering
 *  resolve the same merged file, so there is exactly one place that spells
 *  its location. */
export function personaUserConfigPath(liveThroneRoot: string): string {
  return userConfigPath(liveThroneRoot);
}

const TOP_LEVEL_FIELDS = [
  'roleplayPreset',
  'addressTitle',
  'tierTitles',
  'throneTitle',
  'campaignTitle',
  'queueDescription',
  'roleplayPrompt',
  'ntfy',
] as const;

const TIER_TITLE_FIELDS = ['regent', 'alpha', 'shadow'] as const;

/** Every rejection names the file, the dot-path of the field, and what was
 *  expected — an operator must be able to fix the file from the message alone. */
function invalidPersonaConfig(
  sourcePath: string,
  field: string,
  expectation: string,
): Error {
  return new Error(
    `Invalid persona config in "${sourcePath}": \`${field}\` ${expectation}.`,
  );
}

function requireNonEmptyString(
  value: unknown,
  sourcePath: string,
  field: string,
): string {
  if (typeof value !== 'string') {
    throw invalidPersonaConfig(
      sourcePath,
      field,
      `must be a non-empty string (got ${describeValue(value)})`,
    );
  }
  if (value.trim() === '') {
    throw invalidPersonaConfig(
      sourcePath,
      field,
      'must be a non-empty string (got an empty or whitespace-only string)',
    );
  }
  return value;
}

/** Unknown keys are errors, not ignored extras — silently dropping a typo'd
 *  key is exactly how an override appears to do nothing. */
function requireKnownKeys(
  record: Record<string, unknown>,
  knownFields: readonly string[],
  sourcePath: string,
  fieldPrefix: string,
): void {
  for (const key of Object.keys(record)) {
    if (!knownFields.includes(key)) {
      throw invalidPersonaConfig(
        sourcePath,
        `${fieldPrefix}${key}`,
        `is not a known field (expected one of: ${knownFields.join(', ')})`,
      );
    }
  }
}

function validateTierTitles(
  value: unknown,
  sourcePath: string,
): Partial<PersonaTierTitles> {
  if (!isPlainObject(value)) {
    throw invalidPersonaConfig(
      sourcePath,
      'tierTitles',
      `must be a plain object of tier titles (got ${describeValue(value)})`,
    );
  }
  requireKnownKeys(value, TIER_TITLE_FIELDS, sourcePath, 'tierTitles.');
  const titles: { -readonly [K in keyof PersonaTierTitles]?: string } = {};
  for (const field of TIER_TITLE_FIELDS) {
    if (field in value) {
      titles[field] = requireNonEmptyString(
        value[field],
        sourcePath,
        `tierTitles.${field}`,
      );
    }
  }
  return titles;
}

/**
 * Validates the `default` export of a user config file and returns it as a
 * partial override. Throws on anything it cannot accept; `sourcePath` is the
 * file named in every error message.
 */
export function validatePersonaOverride(
  value: unknown,
  sourcePath: string,
): PersonaConfigOverride {
  if (value === undefined) {
    throw invalidPersonaConfig(
      sourcePath,
      'default',
      'export is missing — the file must `export default { … }`',
    );
  }
  if (!isPlainObject(value)) {
    throw invalidPersonaConfig(
      sourcePath,
      'default',
      `export must be a plain object (got ${describeValue(value)})`,
    );
  }
  requireKnownKeys(value, TOP_LEVEL_FIELDS, sourcePath, '');
  const override: { -readonly [K in keyof PersonaConfigOverride]: PersonaConfigOverride[K] } =
    {};
  if ('roleplayPreset' in value) {
    const presetName = value.roleplayPreset;
    if (
      typeof presetName !== 'string' ||
      !(ROLEPLAY_PRESET_NAMES as readonly string[]).includes(presetName)
    ) {
      throw invalidPersonaConfig(
        sourcePath,
        'roleplayPreset',
        `must be one of: ${ROLEPLAY_PRESET_NAMES.join(', ')} (got ${describeValue(presetName)})`,
      );
    }
    override.roleplayPreset = presetName as RoleplayPresetName;
  }
  if ('addressTitle' in value) {
    override.addressTitle = requireNonEmptyString(
      value.addressTitle,
      sourcePath,
      'addressTitle',
    );
  }
  if ('throneTitle' in value) {
    override.throneTitle = requireNonEmptyString(
      value.throneTitle,
      sourcePath,
      'throneTitle',
    );
  }
  if ('campaignTitle' in value) {
    override.campaignTitle = requireNonEmptyString(
      value.campaignTitle,
      sourcePath,
      'campaignTitle',
    );
  }
  if ('queueDescription' in value) {
    override.queueDescription = requireNonEmptyString(
      value.queueDescription,
      sourcePath,
      'queueDescription',
    );
  }
  if ('roleplayPrompt' in value) {
    override.roleplayPrompt = requireNonEmptyString(
      value.roleplayPrompt,
      sourcePath,
      'roleplayPrompt',
    );
  }
  if ('tierTitles' in value) {
    override.tierTitles = validateTierTitles(value.tierTitles, sourcePath);
  }
  if ('ntfy' in value) {
    override.ntfy = validateNtfy(
      value.ntfy,
      (field, expectation) =>
        invalidPersonaConfig(sourcePath, field, expectation),
      (fieldValue, field) =>
        requireNonEmptyString(fieldValue, sourcePath, field),
    );
  }
  return override;
}

/** Exported so `switch-persona` can render the config it JUST wrote (e.g. for
 *  a live-court broadcast message) without a second merge implementation. */
export function mergePersonaConfig(
  base: PersonaConfig,
  override: PersonaConfigOverride,
): PersonaConfig {
  return {
    addressTitle: override.addressTitle ?? base.addressTitle,
    tierTitles: { ...base.tierTitles, ...override.tierTitles },
    throneTitle: override.throneTitle ?? base.throneTitle,
    campaignTitle: override.campaignTitle ?? base.campaignTitle,
    queueDescription: override.queueDescription ?? base.queueDescription,
    roleplayPrompt: override.roleplayPrompt ?? base.roleplayPrompt,
    roleWords: base.roleWords,
  };
}

/**
 * Validates `sourcePath`'s persona section of the merged `config.user.ts`
 * override, or returns `undefined` when the file is absent. This is the ONE
 * validate path — `loadPersonaConfig` and `switch-persona` (which needs the
 * raw override, not the merged config, to know which preset is currently
 * selected) both go through it, so there is exactly one error vocabulary for
 * an invalid file. The import itself is owned by the shared
 * `loadUserConfigFile`, which also guarantees a file naming only `steering`
 * or `identity` yields an empty persona section here rather than throwing —
 * the persona-consumer half of the CRITICAL HAZARD partial-override safety.
 * `cacheBustToken` is forwarded verbatim; see `loadUserConfigFile` for why a
 * same-process re-read after a write needs one.
 */
export async function loadValidatedPersonaOverride(
  sourcePath: string,
  cacheBustToken?: string,
): Promise<PersonaConfigOverride | undefined> {
  const userConfig = await loadUserConfigFile(sourcePath, cacheBustToken);
  if (userConfig === undefined) return undefined;
  return validatePersonaOverride(userConfig.persona, sourcePath);
}

/**
 * Resolves the effective persona config: the named preset the override
 * selects (or `Default`) with the user file's partial per-field override
 * merged over it. An absent file yields `Default`; an unreadable or invalid
 * file, or a failure to resolve the live throne root, throws. `userConfigPath`
 * exists so tests and future validators can point at a fixture instead of the
 * live throne root.
 */
export async function loadPersonaConfig(
  userConfigPath?: string,
): Promise<PersonaConfig> {
  const resolvedPath =
    userConfigPath ?? personaUserConfigPath(await resolveLiveThroneRoot());
  const override = await loadValidatedPersonaOverride(resolvedPath);
  if (override === undefined) return DEFAULT_PERSONA_CONFIG;
  return mergePersonaConfig(
    ROLEPLAY_PRESETS[override.roleplayPreset ?? 'Default'],
    override,
  );
}

/**
 * Resolves the host-local ntfy identity from the same user file. An absent
 * file, or a file with no `ntfy` section, yields `{}` — every field then falls
 * back to the committed neutral default at the notification call site.
 */
export async function loadNtfyUserConfig(
  userConfigPath?: string,
): Promise<NtfyUserConfig> {
  const resolvedPath =
    userConfigPath ?? personaUserConfigPath(await resolveLiveThroneRoot());
  return (await loadValidatedPersonaOverride(resolvedPath))?.ntfy ?? {};
}

/** The effective config, resolved once per process. */
export const PERSONA_CONFIG: PersonaConfig = await loadPersonaConfig();

/** The host-local ntfy identity, resolved once per process alongside it. */
export const NTFY_USER_CONFIG: NtfyUserConfig = await loadNtfyUserConfig();


export class ApplicationConfigService {
  get personaConfig(): PersonaConfig { return PERSONA_CONFIG; }
}
