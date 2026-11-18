import { homedir } from 'node:os';
import path from 'node:path';
import {
  describeValue,
  isPlainObject,
} from '../shared-policy/config-value-shape.ts';
import {
  RECALL_SECTION_FIELDS,
  loadUserConfigFile,
  resolveUserConfigPath,
} from '../user-config-loader.ts';

export const SERVE_ARM = 'serve';
export const SHADOW_ARM = 'shadow';
export type RecallArm = typeof SERVE_ARM | typeof SHADOW_ARM;

export interface RecallConfig {
  readonly verdictLineThreshold: number;
  readonly serveThreshold: number;
  readonly serveThresholdWhenCostIsHigh: number;
  readonly siftKeepThreshold: number;
  readonly maximumInjectedCharacters: number;
  readonly repositoryMemoryNamesPerRepository: number;
  readonly globalMemoryDirectories: readonly string[];
}

export const DEFAULT_RECALL_CONFIG: RecallConfig = {
  verdictLineThreshold: 0.9,
  serveThreshold: 0.5,
  serveThresholdWhenCostIsHigh: 0.3,
  siftKeepThreshold: 0.5,
  maximumInjectedCharacters: 8000,
  repositoryMemoryNamesPerRepository: 40,
  globalMemoryDirectories: [],
};

const PROBABILITY_FIELDS = [
  'serveThreshold',
  'serveThresholdWhenCostIsHigh',
  'siftKeepThreshold',
  'verdictLineThreshold',
] as const;
const DIRECTORY_LIST_FIELDS = [
  'globalMemoryDirectories',
] as const;
const POSITIVE_INTEGER_FIELDS = [
  'maximumInjectedCharacters',
  'repositoryMemoryNamesPerRepository',
] as const;
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
  return override;
}

export async function loadRecallConfig(
  configPath?: string,
): Promise<RecallConfig> {
  const resolvedPath =
    configPath ?? (await resolveUserConfigPath());
  const userConfigFile = await loadUserConfigFile(resolvedPath);
  if (userConfigFile === undefined) return DEFAULT_RECALL_CONFIG;
  return {
    ...DEFAULT_RECALL_CONFIG,
    ...validateRecallOverride(userConfigFile.recall, resolvedPath),
  };
}
