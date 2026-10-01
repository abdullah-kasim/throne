import { stat } from 'node:fs/promises';
import {
  JEV_LIMIT_FIELDS,
  pathWithHomeExpanded,
  type JevLimitField,
  type RecallConfig,
} from './recall-user-config.ts';
import { renderedJevSpending, type JevSpending } from './jev-spending.ts';

export const JEV_DISABLED_ENVIRONMENT_VARIABLE = 'THRONE_JEV_DISABLED';

export type KeyFileState = 'not-checked' | 'usable' | 'unavailable';

export interface JevSwitch {
  readonly on: boolean;
  readonly enabledInConfig: boolean;
  readonly disabledByEnvironment: boolean;
  readonly limitAtZero?: JevLimitField;
  readonly keyFile: KeyFileState;
  readonly keyFilePath: string;
}

export type JevSwitchConfig = Pick<
  RecallConfig,
  'jevEnabled' | 'jevKeyFile' | JevLimitField
>;

export interface KeyFileFacts {
  isFile(): boolean;
  readonly size: number;
}

export interface JevSwitchDependencies {
  readonly environment: NodeJS.ProcessEnv;
  statKeyFile(keyFilePath: string): Promise<KeyFileFacts>;
}

export const PRODUCTION_JEV_SWITCH_DEPENDENCIES: JevSwitchDependencies = {
  environment: process.env,
  statKeyFile: (keyFilePath) => stat(keyFilePath),
};

export function isJevDisabledByEnvironment(
  environment: NodeJS.ProcessEnv,
): boolean {
  const value = environment[JEV_DISABLED_ENVIRONMENT_VARIABLE];
  return value !== undefined && value !== '' && value !== '0';
}

export function jevLimitAtZero(
  limits: Pick<RecallConfig, JevLimitField>,
): JevLimitField | undefined {
  return JEV_LIMIT_FIELDS.find((field) => limits[field] === 0);
}

async function keyFileIsUsable(
  keyFilePath: string,
  dependencies: JevSwitchDependencies,
): Promise<boolean> {
  try {
    const keyFile = await dependencies.statKeyFile(keyFilePath);
    return keyFile.isFile() && keyFile.size > 0;
  } catch {
    return false;
  }
}

export async function readJevSwitch(
  config: JevSwitchConfig,
  dependencies: JevSwitchDependencies = PRODUCTION_JEV_SWITCH_DEPENDENCIES,
): Promise<JevSwitch> {
  const keyFilePath = pathWithHomeExpanded(config.jevKeyFile);
  const disabledByEnvironment = isJevDisabledByEnvironment(
    dependencies.environment,
  );
  const limitAtZero = jevLimitAtZero(config);
  if (!config.jevEnabled || disabledByEnvironment || limitAtZero !== undefined) {
    return {
      on: false,
      enabledInConfig: config.jevEnabled,
      disabledByEnvironment,
      limitAtZero,
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

export function reasonJevIsOff(jevSwitch: JevSwitch): string {
  if (jevSwitch.disabledByEnvironment) {
    return `${JEV_DISABLED_ENVIRONMENT_VARIABLE} is set, which always wins`;
  }
  if (!jevSwitch.enabledInConfig) return 'recall.jevEnabled is false';
  if (jevSwitch.limitAtZero !== undefined) {
    return `recall.${jevSwitch.limitAtZero} is 0, which switches Jev off`;
  }
  return 'the key file is missing, unreadable or empty';
}

export function renderedJevStatus(jevSwitch: JevSwitch, spending: JevSpending): string {
  return [
    `backend that would answer now: ${jevSwitch.on ? 'jev' : 'rules'}`,
    `why: ${jevSwitch.on ? 'recall.jevEnabled is true, no override is set, and the key file is usable' : reasonJevIsOff(jevSwitch)}`,
    `recall.jevEnabled: ${jevSwitch.enabledInConfig}`,
    `${JEV_DISABLED_ENVIRONMENT_VARIABLE}: ${jevSwitch.disabledByEnvironment ? 'set' : 'not set'}`,
    `key file ${jevSwitch.keyFilePath}: ${jevSwitch.keyFile === 'not-checked' ? 'not opened, because Jev is off' : jevSwitch.keyFile}`,
    ...renderedJevSpending(spending),
    '',
  ].join('\n');
}
