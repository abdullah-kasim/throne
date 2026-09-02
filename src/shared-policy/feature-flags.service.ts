import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const FEATURE_FLAG_NAMES = {
  HARNESS_DECOUPLE: 'harness-decouple',
  HERDR_DECOUPLE: 'herdr-decouple',
  SEND_AGENT_FILE_BACKED_PAYLOADS: 'send-agent-file-backed-payloads',
} as const;
export type FeatureFlagName =
  (typeof FEATURE_FLAG_NAMES)[keyof typeof FEATURE_FLAG_NAMES];
export type ThroneFeatureFlags = Readonly<Record<FeatureFlagName, boolean>>;

export const DEFAULT_FEATURE_FLAGS: ThroneFeatureFlags = {
  [FEATURE_FLAG_NAMES.HARNESS_DECOUPLE]: false,
  [FEATURE_FLAG_NAMES.HERDR_DECOUPLE]: false,
  [FEATURE_FLAG_NAMES.SEND_AGENT_FILE_BACKED_PAYLOADS]: false,
};

export function featureFlagsPath(
  xdgConfigHome: string | undefined = process.env.XDG_CONFIG_HOME,
  homeDirectory: string = os.homedir(),
): string {
  return path.join(xdgConfigHome ?? path.join(homeDirectory, '.config'), 'throne', 'features.json');
}

export function parseFeatureFlags(
  source: string,
  sourcePath: string,
): ThroneFeatureFlags {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (cause) {
    throw new Error(`Invalid throne feature flags in "${sourcePath}": expected JSON`, { cause });
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid throne feature flags in "${sourcePath}": expected an object`);
  }
  const record = value as Record<string, unknown>;
  const knownFlags = new Set<FeatureFlagName>(
    Object.values(FEATURE_FLAG_NAMES),
  );
  const unknown = Object.keys(record).filter(
    (key) => !knownFlags.has(key as keyof ThroneFeatureFlags),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Invalid throne feature flags in "${sourcePath}": unknown flag "${unknown[0]}"`,
    );
  }
  if (
    FEATURE_FLAG_NAMES.HARNESS_DECOUPLE in record &&
    typeof record[FEATURE_FLAG_NAMES.HARNESS_DECOUPLE] !== 'boolean'
  ) {
    throw new Error(
      `Invalid throne feature flags in "${sourcePath}": "harness-decouple" must be boolean`,
    );
  }
  if (
    FEATURE_FLAG_NAMES.HERDR_DECOUPLE in record &&
    typeof record[FEATURE_FLAG_NAMES.HERDR_DECOUPLE] !== 'boolean'
  ) {
    throw new Error(
      `Invalid throne feature flags in "${sourcePath}": "herdr-decouple" must be boolean`,
    );
  }
  if (
    FEATURE_FLAG_NAMES.SEND_AGENT_FILE_BACKED_PAYLOADS in record &&
    typeof record[FEATURE_FLAG_NAMES.SEND_AGENT_FILE_BACKED_PAYLOADS] !== 'boolean'
  ) {
    throw new Error(
      `Invalid throne feature flags in "${sourcePath}": "send-agent-file-backed-payloads" must be boolean`,
    );
  }
  return {
    [FEATURE_FLAG_NAMES.HARNESS_DECOUPLE]:
      (record[FEATURE_FLAG_NAMES.HARNESS_DECOUPLE] as boolean | undefined) ??
      DEFAULT_FEATURE_FLAGS[FEATURE_FLAG_NAMES.HARNESS_DECOUPLE],
    [FEATURE_FLAG_NAMES.HERDR_DECOUPLE]:
      (record[FEATURE_FLAG_NAMES.HERDR_DECOUPLE] as boolean | undefined) ??
      DEFAULT_FEATURE_FLAGS[FEATURE_FLAG_NAMES.HERDR_DECOUPLE],
    [FEATURE_FLAG_NAMES.SEND_AGENT_FILE_BACKED_PAYLOADS]:
      (record[FEATURE_FLAG_NAMES.SEND_AGENT_FILE_BACKED_PAYLOADS] as boolean | undefined) ??
      DEFAULT_FEATURE_FLAGS[FEATURE_FLAG_NAMES.SEND_AGENT_FILE_BACKED_PAYLOADS],
  };
}

export function loadFeatureFlags(
  sourcePath: string = featureFlagsPath(),
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): ThroneFeatureFlags {
  try {
    return parseFeatureFlags(readFile(sourcePath), sourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return DEFAULT_FEATURE_FLAGS;
    }
    throw error;
  }
}

export const FEATURE_FLAGS = loadFeatureFlags();

export function shouldOwnHarnessUpdates(
  featureFlags: ThroneFeatureFlags = FEATURE_FLAGS,
): boolean {
  return featureFlags[FEATURE_FLAG_NAMES.HARNESS_DECOUPLE];
}

export function shouldUpdateHerdrInHarnessUpdate(
  featureFlags: ThroneFeatureFlags = FEATURE_FLAGS,
): boolean {
  return featureFlags[FEATURE_FLAG_NAMES.HERDR_DECOUPLE];
}

export function shouldUseFileBackedAgentPayloads(
  featureFlags: ThroneFeatureFlags = FEATURE_FLAGS,
): boolean {
  return featureFlags[FEATURE_FLAG_NAMES.SEND_AGENT_FILE_BACKED_PAYLOADS];
}



export class FeatureFlagsService {
  private readonly read: () => ThroneFeatureFlags;

  constructor(read: () => ThroneFeatureFlags = () => FEATURE_FLAGS) {
    this.read = read;
  }
  get all(): ThroneFeatureFlags { return this.read(); }
  enabled(name: FeatureFlagName): boolean { return this.all[name]; }
}

export const REAL_FEATURE_FLAGS_SERVICE = new FeatureFlagsService(() => loadFeatureFlags());
