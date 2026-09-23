import { readFile } from 'node:fs/promises';
import {
  pathWithHomeExpanded,
  type RecallConfig,
} from './recall-user-config.ts';

export const JEV_DISABLED_ENVIRONMENT_VARIABLE = 'THRONE_JEV_DISABLED';

export type KeyFileState = 'not-checked' | 'usable' | 'unavailable';

export interface JevSwitch {
  readonly on: boolean;
  readonly enabledInConfig: boolean;
  readonly disabledByEnvironment: boolean;
  readonly keyFile: KeyFileState;
  readonly keyFilePath: string;
}

export interface JevSwitchDependencies {
  readonly environment: NodeJS.ProcessEnv;
  readKeyFile(keyFilePath: string): Promise<string>;
}

export const PRODUCTION_JEV_SWITCH_DEPENDENCIES: JevSwitchDependencies = {
  environment: process.env,
  readKeyFile: (keyFilePath) => readFile(keyFilePath, 'utf8'),
};

export function isJevDisabledByEnvironment(
  environment: NodeJS.ProcessEnv,
): boolean {
  const value = environment[JEV_DISABLED_ENVIRONMENT_VARIABLE];
  return value !== undefined && value !== '' && value !== '0';
}

async function keyFileIsUsable(
  keyFilePath: string,
  dependencies: JevSwitchDependencies,
): Promise<boolean> {
  try {
    return (await dependencies.readKeyFile(keyFilePath)).trim().length > 0;
  } catch {
    return false;
  }
}

export async function readJevSwitch(
  config: Pick<RecallConfig, 'jevEnabled' | 'jevKeyFile'>,
  dependencies: JevSwitchDependencies = PRODUCTION_JEV_SWITCH_DEPENDENCIES,
): Promise<JevSwitch> {
  const keyFilePath = pathWithHomeExpanded(config.jevKeyFile);
  const disabledByEnvironment = isJevDisabledByEnvironment(
    dependencies.environment,
  );
  if (!config.jevEnabled || disabledByEnvironment) {
    return {
      on: false,
      enabledInConfig: config.jevEnabled,
      disabledByEnvironment,
      keyFile: 'not-checked',
      keyFilePath,
    };
  }
  const usable = await keyFileIsUsable(keyFilePath, dependencies);
  return {
    on: usable,
    enabledInConfig: true,
    disabledByEnvironment: false,
    keyFile: usable ? 'usable' : 'unavailable',
    keyFilePath,
  };
}

function reasonJevIsOff(jevSwitch: JevSwitch): string {
  if (jevSwitch.disabledByEnvironment) {
    return `${JEV_DISABLED_ENVIRONMENT_VARIABLE} is set, which always wins`;
  }
  if (!jevSwitch.enabledInConfig) return 'recall.jevEnabled is false';
  return 'the key file is missing, unreadable or empty';
}

export function renderedJevStatus(jevSwitch: JevSwitch): string {
  return [
    `backend that would answer now: ${jevSwitch.on ? 'jev' : 'rules'}`,
    `why: ${jevSwitch.on ? 'recall.jevEnabled is true, no override is set, and the key file is usable' : reasonJevIsOff(jevSwitch)}`,
    `recall.jevEnabled: ${jevSwitch.enabledInConfig}`,
    `${JEV_DISABLED_ENVIRONMENT_VARIABLE}: ${jevSwitch.disabledByEnvironment ? 'set' : 'not set'}`,
    `key file ${jevSwitch.keyFilePath}: ${jevSwitch.keyFile === 'not-checked' ? 'not opened, because Jev is off' : jevSwitch.keyFile}`,
    '',
  ].join('\n');
}
