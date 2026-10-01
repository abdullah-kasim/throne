import { homedir } from 'node:os';
import path from 'node:path';
import {
  describeValue,
  isPlainObject,
} from '../shared-policy/config-value-shape.ts';
import { resolveLiveThroneRoot } from '../throne-root-resolution.ts';
import type { JevLimits } from './jev-budget.ts';
import {
  RECALL_SECTION_FIELDS,
  loadUserConfigFile,
  userConfigPath,
} from '../user-config-loader.ts';

export const SERVE_ARM = 'serve';
export const SHADOW_ARM = 'shadow';
export const SPLIT_HOOK_MODE = 'split';
export const HOOK_MODES = [SERVE_ARM, SHADOW_ARM, SPLIT_HOOK_MODE] as const;
export type HookMode = (typeof HOOK_MODES)[number];
export type RecallArm = typeof SERVE_ARM | typeof SHADOW_ARM;

export interface RecallConfig {
  readonly jevEnabled: boolean;
  readonly hookEnabled: boolean;
  readonly hookMode: HookMode;
  readonly verdictLineThreshold: number;
  readonly serveThreshold: number;
  readonly serveThresholdWhenCostIsHigh: number;
  readonly siftKeepThreshold: number;
  readonly maximumInjectedCharacters: number;
  readonly repositoryMemoryNamesPerRepository: number;
  readonly hookTimeoutMilliseconds: number;
  readonly globalMemoryDirectories: readonly string[];
  readonly rankAllowedRoots: readonly string[];
  readonly jevKeyFile: string;
  readonly jevTokensPerDay: number;
  readonly jevTokensPerHour: number;
}

export const DEFAULT_RECALL_CONFIG: RecallConfig = {
  jevEnabled: false,
  hookEnabled: false,
  hookMode: SERVE_ARM,
  verdictLineThreshold: 0.9,
  serveThreshold: 0.5,
  serveThresholdWhenCostIsHigh: 0.3,
  siftKeepThreshold: 0.5,
  maximumInjectedCharacters: 8000,
  repositoryMemoryNamesPerRepository: 40,
  hookTimeoutMilliseconds: 2500,
  globalMemoryDirectories: [],
  rankAllowedRoots: [],
  jevKeyFile: '~/.jev-key',
  jevTokensPerDay: 15_000_000,
  jevTokensPerHour: 1_250_000,
};

const BOOLEAN_FIELDS = ['jevEnabled', 'hookEnabled'] as const;
const PROBABILITY_FIELDS = [
  'serveThreshold',
  'serveThresholdWhenCostIsHigh',
  'siftKeepThreshold',
  'verdictLineThreshold',
] as const;
const DIRECTORY_LIST_FIELDS = [
  'globalMemoryDirectories',
  'rankAllowedRoots',
] as const;
const POSITIVE_INTEGER_FIELDS = [
  'maximumInjectedCharacters',
  'repositoryMemoryNamesPerRepository',
  'hookTimeoutMilliseconds',
] as const;
export const JEV_LIMIT_FIELDS = ['jevTokensPerDay', 'jevTokensPerHour'] as const;
export type JevLimitField = (typeof JEV_LIMIT_FIELDS)[number];

export function jevLimitsOf(config: Pick<RecallConfig, JevLimitField>): JevLimits {
  return { tokensPerDay: config.jevTokensPerDay, tokensPerHour: config.jevTokensPerHour };
}

function invalidRecallConfig(
  sourcePath: string,
  field: string,
  expectation: string,
): Error {
  return new Error(
    `Invalid recall config in "${sourcePath}": \`${field}\` ${expectation}.`,
  );
}

export function pathWithHomeExpanded(
  configuredPath: string,
  homeDirectory: string = homedir(),
): string {
  if (configuredPath === '~') return homeDirectory;
  return configuredPath.startsWith('~/')
    ? path.join(homeDirectory, configuredPath.slice(2))
    : configuredPath;
}

function isHookMode(value: unknown): value is HookMode {
  return (HOOK_MODES as readonly unknown[]).includes(value);
}

export function validateRecallOverride(
  value: unknown,
  sourcePath: string,
): Partial<RecallConfig> {
  if (!isPlainObject(value)) {
    throw invalidRecallConfig(
      sourcePath,
      'recall',
      `must be a plain object (got ${describeValue(value)})`,
    );
  }
  for (const key of Object.keys(value)) {
    if (!(RECALL_SECTION_FIELDS as readonly string[]).includes(key)) {
      throw invalidRecallConfig(
        sourcePath,
        key,
        `is not a known field (expected one of: ${RECALL_SECTION_FIELDS.join(', ')})`,
      );
    }
  }
  const override: { -readonly [K in keyof RecallConfig]?: RecallConfig[K] } = {};
  for (const field of BOOLEAN_FIELDS) {
    if (!(field in value)) continue;
    const fieldValue = value[field];
    if (typeof fieldValue !== 'boolean') {
      throw invalidRecallConfig(
        sourcePath,
        field,
        `must be a boolean (got ${describeValue(fieldValue)})`,
      );
    }
    override[field] = fieldValue;
  }
  for (const field of PROBABILITY_FIELDS) {
    if (!(field in value)) continue;
    const fieldValue = value[field];
    if (typeof fieldValue !== 'number' || !(fieldValue >= 0 && fieldValue <= 1)) {
      throw invalidRecallConfig(
        sourcePath,
        field,
        `must be a number from 0 to 1 (got ${describeValue(fieldValue)})`,
      );
    }
    override[field] = fieldValue;
  }
  for (const field of POSITIVE_INTEGER_FIELDS) {
    if (!(field in value)) continue;
    const fieldValue = value[field];
    if (typeof fieldValue !== 'number' || !Number.isInteger(fieldValue) || fieldValue < 1) {
      throw invalidRecallConfig(
        sourcePath,
        field,
        `must be an integer >= 1 (got ${describeValue(fieldValue)})`,
      );
    }
    override[field] = fieldValue;
  }
  for (const field of JEV_LIMIT_FIELDS) {
    if (!(field in value)) continue;
    const fieldValue = value[field];
    if (typeof fieldValue !== 'number' || !Number.isInteger(fieldValue) || fieldValue < 0) {
      throw invalidRecallConfig(
        sourcePath,
        field,
        `must be an integer >= 0 (got ${describeValue(fieldValue)})`,
      );
    }
    override[field] = fieldValue;
  }
  for (const field of DIRECTORY_LIST_FIELDS) {
    if (!(field in value)) continue;
    const directories = value[field];
    if (
      !Array.isArray(directories) ||
      !directories.every(
        (directory): directory is string =>
          typeof directory === 'string' && directory.trim().length > 0,
      )
    ) {
      throw invalidRecallConfig(
        sourcePath,
        field,
        `must be an array of non-empty directory paths (got ${describeValue(directories)})`,
      );
    }
    override[field] = directories;
  }
  if ('hookMode' in value) {
    const hookMode = value.hookMode;
    if (!isHookMode(hookMode)) {
      throw invalidRecallConfig(
        sourcePath,
        'hookMode',
        `must be one of ${HOOK_MODES.map((mode) => `'${mode}'`).join(', ')} (got ${describeValue(hookMode)})`,
      );
    }
    override.hookMode = hookMode;
  }
  if ('jevKeyFile' in value) {
    const jevKeyFile = value.jevKeyFile;
    if (typeof jevKeyFile !== 'string' || jevKeyFile.trim().length === 0) {
      throw invalidRecallConfig(
        sourcePath,
        'jevKeyFile',
        `must be a non-empty file path (got ${describeValue(jevKeyFile)})`,
      );
    }
    override.jevKeyFile = jevKeyFile;
  }
  return override;
}

export async function loadRecallConfig(
  configPath?: string,
): Promise<RecallConfig> {
  const resolvedPath =
    configPath ?? userConfigPath(await resolveLiveThroneRoot());
  const userConfigFile = await loadUserConfigFile(resolvedPath);
  if (userConfigFile === undefined) return DEFAULT_RECALL_CONFIG;
  return {
    ...DEFAULT_RECALL_CONFIG,
    ...validateRecallOverride(userConfigFile.recall, resolvedPath),
  };
}
