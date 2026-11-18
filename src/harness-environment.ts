import { HARNESS_NAMES, HARNESSES } from './harness-routing/harness-identity.ts';
import { describeValue, isPlainObject } from './shared-policy/config-value-shape.ts';
import type { SupportedComposerHarness } from './codex-screen/composer/composer.types.ts';

export type HarnessEnvironment = Readonly<Record<string, Readonly<Record<string, string>>>>;

export const PINNED_BINARY_OVERRIDE_VARIABLES: Readonly<
  Partial<Record<SupportedComposerHarness, 'CLAUDE_BIN' | 'CODEX_BIN'>>
> = {
  [HARNESS_NAMES.CLAUDE]: 'CLAUDE_BIN',
  [HARNESS_NAMES.CODEX]: 'CODEX_BIN',
};

const RESERVED_PREFIXES = ['THRONE_', 'GIT_', 'HERDR_'];

const RESERVED_NAMES = ['PATH', 'HOME', ...Object.values(PINNED_BINARY_OVERRIDE_VARIABLES)];

export function isReservedForThrone(variable: string): boolean {
  return RESERVED_NAMES.includes(variable) || RESERVED_PREFIXES.some((prefix) => variable.startsWith(prefix));
}

function refusal(sourcePath: string, key: string, expectation: string): Error {
  return new Error(`Invalid config in "${sourcePath}": \`${key}\` ${expectation}.`);
}

export function validateHarnessEnvironment(section: unknown, sourcePath: string): HarnessEnvironment {
  if (section === undefined) return {};
  if (!isPlainObject(section)) {
    throw refusal(sourcePath, 'harnessEnvironment', `must be a plain object (got ${describeValue(section)})`);
  }
  const knownHarnesses: readonly string[] = HARNESSES;
  for (const [harness, variables] of Object.entries(section)) {
    const harnessKey = `harnessEnvironment.${harness}`;
    if (!knownHarnesses.includes(harness)) {
      throw refusal(sourcePath, harnessKey, `is not a known harness (expected one of: ${knownHarnesses.join(', ')})`);
    }
    if (!isPlainObject(variables)) {
      throw refusal(sourcePath, harnessKey, `must be a plain object (got ${describeValue(variables)})`);
    }
    for (const [variable, value] of Object.entries(variables)) {
      const variableKey = `${harnessKey}.${variable}`;
      if (isReservedForThrone(variable)) {
        throw refusal(sourcePath, variableKey, 'is reserved for throne and cannot be set');
      }
      if (typeof value !== 'string') {
        throw refusal(sourcePath, variableKey, `must be a string (got ${describeValue(value)})`);
      }
    }
  }
  return section as HarnessEnvironment;
}
