// The shared "parse the union, not the active preset" resolver: every
// existing agent-name-prefix parsing site must accept a canonical role word
// (`alpha`/`shadow`) OR any preset's persona role word for that role,
// regardless of which preset is currently active. This module builds that
// union from the full preset registry and resolves an arbitrary
// name-or-label string against it. A pure query, never a validator — an
// unrecognized string returns `null` rather than throwing.

import {
  ROLEPLAY_PRESETS,
  type PersonaConfig,
} from '../application-config.service.ts';

export type CanonicalRole = 'alpha' | 'shadow';

/** For each canonical role, every word (canonical token plus every preset's
 *  role word for that role) that names it, lowercased for case-insensitive
 *  matching. */
export type RoleWordUnion = Readonly<Record<CanonicalRole, ReadonlySet<string>>>;

const CANONICAL_ROLE_WORDS: Readonly<Record<CanonicalRole, string>> = {
  alpha: 'alpha',
  shadow: 'shadow',
};

/**
 * Builds the role-word union from a preset registry: for each canonical
 * role, the canonical token itself plus every preset's role word for that
 * role, lowercased. Called with the full `ROLEPLAY_PRESETS` registry in
 * normal operation; also usable with an empty/partial registry, which
 * collapses the union to the canonical words alone — the degrade-safe
 * fallback shape when persona config is unreadable.
 */
export function buildRoleWordUnion(
  presets: Readonly<Record<string, PersonaConfig>>,
): RoleWordUnion {
  const alpha = new Set<string>([CANONICAL_ROLE_WORDS.alpha]);
  const shadow = new Set<string>([CANONICAL_ROLE_WORDS.shadow]);
  for (const config of Object.values(presets)) {
    alpha.add(config.roleWords.alpha.toLowerCase());
    shadow.add(config.roleWords.shadow.toLowerCase());
  }
  return { alpha, shadow };
}

/** The union built from every preset in the live registry — the union every
 *  existing parsing site should resolve against so a name or label produced
 *  under any preset resolves correctly regardless of which preset is active. */
export const LIVE_ROLE_WORD_UNION: RoleWordUnion = buildRoleWordUnion(ROLEPLAY_PRESETS);

/** The degrade-safe fallback union: canonical words only, used when persona
 *  config could not be read. Reuses `buildRoleWordUnion` over an empty
 *  registry rather than a second parallel code path. */
export const CANONICAL_ONLY_ROLE_WORD_UNION: RoleWordUnion = buildRoleWordUnion({});

/**
 * Resolves an arbitrary name-or-label string against a role-word union:
 * does it exhibit one of the role's accepted words as a prefix, using the
 * existing `alpha-`/`shadow-` grammar's `-` separator convention? Case-
 * insensitive, matching `sameAgentName`'s convention. Returns the matched
 * canonical role and the remainder string after the word and its separator,
 * or `null` if the string matches no role's word in the union — never
 * throws, this is a pure query, not a validator.
 */
export function resolveCanonicalRoleWord(
  nameOrLabel: string,
  union: RoleWordUnion,
): { role: CanonicalRole; rest: string } | null {
  const lowered = nameOrLabel.toLowerCase();
  for (const role of ['alpha', 'shadow'] as const) {
    for (const word of union[role]) {
      const prefix = `${word}-`;
      if (lowered.startsWith(prefix)) {
        return { role, rest: nameOrLabel.slice(prefix.length) };
      }
    }
  }
  return null;
}
