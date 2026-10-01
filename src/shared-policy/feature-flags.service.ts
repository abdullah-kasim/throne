import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const FEATURE_FLAG_NAMES = {
  SEND_AGENT_FILE_BACKED_PAYLOADS: 'send-agent-file-backed-payloads',
} as const;
export type FeatureFlagName =
  (typeof FEATURE_FLAG_NAMES)[keyof typeof FEATURE_FLAG_NAMES];
export type ThroneFeatureFlags = Readonly<Record<FeatureFlagName, boolean>>;

export const RETIRED_FEATURE_FLAG_NAMES: readonly string[] = [
  'herdr-decouple',
  'harness-decouple',
];

export const DEFAULT_FEATURE_FLAGS: ThroneFeatureFlags = {
  [FEATURE_FLAG_NAMES.SEND_AGENT_FILE_BACKED_PAYLOADS]: false,
};

export function featureFlagsPath(
  xdgConfigHome: string | undefined = process.env.XDG_CONFIG_HOME,
  homeDirectory: string = os.homedir(),
): string {
  return path.join(xdgConfigHome ?? path.join(homeDirectory, '.config'), 'throne', 'features.json');
}

function isAcceptedFeatureFlagName(name: string): boolean {
  return (
    (Object.values(FEATURE_FLAG_NAMES) as string[]).includes(name) ||
    RETIRED_FEATURE_FLAG_NAMES.includes(name)
  );
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
  const unknown = Object.keys(record).filter((key) => !isAcceptedFeatureFlagName(key));
  if (unknown.length > 0) {
    throw new Error(
      `Invalid throne feature flags in "${sourcePath}": unknown flag "${unknown[0]}"`,
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
