// Shared parse+validate for the merged `config.user.ts` override file at the
// live throne root. Persona (`application-config.service.ts`) and steering
// (`steering-user-config.ts`) both resolve their section through this one
// module instead of independently dynamic-`import()`-ing the file, so an
// unknown top-level key is rejected across the FULL known key set no matter
// which section a caller is after — the structural guarantee behind the
// CRITICAL HAZARD requirement that a file naming only one section (e.g.
// `{ steering: {...} }`) leaves every other section at its defaults.
//
// This module owns exactly two things: the single dynamic import, and
// whole-file/section-shape validation (known top-level keys, known nested
// keys within `steering`/`identity`). It deliberately does NOT re-validate
// persona's own nested shapes (`tierTitles`, `ntfy`) — those stay owned by
// `application-config.service.ts`, unchanged by this module, and are handed
// the raw `persona` section to validate exactly as they do today.
//
// A still-present legacy `src/config.user.ts` (the pre-merge steering
// override file) is refused loudly at load time, naming the legacy file, the
// fields it used to carry, and the merged file's `steering` key as their new
// home — never silently read, never auto-merged.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspect } from 'node:util';
import {
  describeValue,
  isPlainObject,
} from './shared-policy/config-value-shape.ts';
import { resolveLiveThroneRoot } from './throne-root-resolution.ts';

const PERSONA_SECTION_FIELDS = [
  'roleplayPreset',
  'addressTitle',
  'tierTitles',
  'throneTitle',
  'campaignTitle',
  'queueDescription',
  'roleplayPrompt',
  'ntfy',
] as const;

// THE steering key list, exported so `steering-user-config.ts` validates
// against this exact array instead of a copy. It was a copy until
// 2026-08-26, and the copy is what a new steering field forgets: `stagerPool`
// validated fine in its own module while this outer gate refused the whole
// config as an unknown key, so every command died at load. The dependency
// runs this way round because `steering-user-config.ts` already imports this
// module and carries a top-level await — the reverse edge would be a cycle.
export const STEERING_SECTION_FIELDS = [
  'activePlanPresetName',
  'activeHarness',
  'activeTargetEffort',
  'messageQueueTransport',
  'customPlanPresets',
  'stagerPool',
  'tokenBalanceEnabled',
] as const;
const IDENTITY_SECTION_FIELDS = ['name', 'email'] as const;

const TOP_LEVEL_FIELDS = [
  ...PERSONA_SECTION_FIELDS,
  'steering',
  'identity',
] as const;

/** The merged file's default export, split into its three independently
 *  optional sections. An absent section is `{}` — never `undefined` — so a
 *  section-owning consumer can merge it over its own defaults without a null
 *  check. Field VALUES are not deep-validated here; each section's owner
 *  (persona, steering, identity) validates its own field types. */
export interface UserConfigFile {
  readonly persona: Readonly<Record<string, unknown>>;
  readonly steering: Readonly<Record<string, unknown>>;
  readonly identity: Readonly<Record<string, unknown>>;
}

/** Where the merged override lives: `<live-throne-root>/config.user.ts`. */
export function userConfigPath(liveThroneRoot: string): string {
  return path.join(liveThroneRoot, 'config.user.ts');
}

/** Where the retired, pre-merge steering-only override used to live:
 *  `<live-throne-root>/src/config.user.ts`. Its continued presence is the
 *  loud-refusal trigger, never a silently-honoured second source of truth. */
export function legacySteeringConfigPath(liveThroneRoot: string): string {
  return path.join(liveThroneRoot, 'src', 'config.user.ts');
}

function invalidUserConfig(
  sourcePath: string,
  field: string,
  expectation: string,
): Error {
  return new Error(
    `Invalid config in "${sourcePath}": \`${field}\` ${expectation}.`,
  );
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
      throw invalidUserConfig(
        sourcePath,
        `${fieldPrefix}${key}`,
        `is not a known field (expected one of: ${knownFields.join(', ')})`,
      );
    }
  }
}

/** Pulls one nested section (`steering`/`identity`) out of the validated
 *  top-level object, rejecting an unknown nested key and a non-object section
 *  value. An absent section yields `{}`. */
function extractSection(
  value: Record<string, unknown>,
  field: string,
  knownFields: readonly string[],
  sourcePath: string,
): Record<string, unknown> {
  if (!(field in value)) return {};
  const section = value[field];
  if (!isPlainObject(section)) {
    throw invalidUserConfig(
      sourcePath,
      field,
      `must be a plain object (got ${describeValue(section)})`,
    );
  }
  requireKnownKeys(section, knownFields, sourcePath, `${field}.`);
  return section;
}

function legacySteeringMigrationError(
  legacyPath: string,
  mergedPath: string,
): Error {
  return new Error(
    `Legacy steering override found at "${legacyPath}". The two ` +
      'machine-local override files were merged into one: move its ' +
      '`activePlanPresetName`/`activeTargetEffort` fields into the ' +
      `\`steering\` key of "${mergedPath}", then delete "${legacyPath}".`,
  );
}

/**
 * Imports and validates the merged `config.user.ts` override, or returns
 * `undefined` when it is absent. `configPath`, when passed, is used verbatim
 * (the test/fixture contract, mirroring `loadSteeringConfig`); otherwise it
 * resolves against the live throne root. Throws loudly — naming the file and
 * the offending field — on an unimportable file, an unknown top-level key, an
 * unknown nested key within `steering`/`identity`, or a still-present legacy
 * `src/config.user.ts` alongside it.
 */
export async function loadUserConfigFile(
  configPath?: string,
  // Node's ESM loader caches by resolved URL and never observes a file
  // changed on disk after its first import in this process. A caller that
  // re-reads the SAME path after writing it in the same process (e.g.
  // `switch-persona` verifying its own write) must pass a fresh value here
  // to force re-parsing instead of silently serving the stale cached module.
  cacheBustToken?: string,
): Promise<UserConfigFile | undefined> {
  const resolvedPath =
    configPath ?? userConfigPath(await resolveLiveThroneRoot());
  const liveThroneRoot = path.dirname(resolvedPath);
  const legacyPath = legacySteeringConfigPath(liveThroneRoot);
  if (existsSync(legacyPath)) {
    throw legacySteeringMigrationError(legacyPath, resolvedPath);
  }

  if (!existsSync(resolvedPath)) return undefined;

  let userModule: { default?: unknown };
  try {
    const url = pathToFileURL(resolvedPath).href;
    userModule = (await import(
      cacheBustToken ? `${url}?cacheBust=${encodeURIComponent(cacheBustToken)}` : url
    )) as {
      default?: unknown;
    };
  } catch (cause) {
    // `import()` can reject with a plain diagnostics object (e.g. ts-node's
    // ESM loader on a syntax error), not an `Error` — such objects have no
    // usable `toString`/`valueOf`, so `String(cause)` itself throws. Fall
    // back to `util.inspect` for anything that isn't a real `Error`.
    const detail = cause instanceof Error ? cause.message : inspect(cause);
    throw new Error(
      `Invalid config in "${resolvedPath}": the file could not be imported ` +
        `— ${detail}`,
      { cause },
    );
  }

  const value = userModule.default;
  if (value === undefined) {
    throw invalidUserConfig(
      resolvedPath,
      'default',
      'export is missing — the file must `export default { … }`',
    );
  }
  if (!isPlainObject(value)) {
    throw invalidUserConfig(
      resolvedPath,
      'default',
      `export must be a plain object (got ${describeValue(value)})`,
    );
  }
  requireKnownKeys(value, TOP_LEVEL_FIELDS, resolvedPath, '');

  const steering = extractSection(
    value,
    'steering',
    STEERING_SECTION_FIELDS,
    resolvedPath,
  );
  const identity = extractSection(
    value,
    'identity',
    IDENTITY_SECTION_FIELDS,
    resolvedPath,
  );
  const persona: Record<string, unknown> = {};
  for (const field of PERSONA_SECTION_FIELDS) {
    if (field in value) persona[field] = value[field];
  }

  return { persona, steering, identity };
}
