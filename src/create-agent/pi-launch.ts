import { randomUUID } from "node:crypto";
import { providerKeyReadiness } from "../account/provider-accounts.ts";
import type { SpawnSpec } from "../agentdata/spawn-data-contracts.ts";
import { piAgentDirectory } from "../herdr/pi-delivery-client.ts";
import {
  installPiDeliveryExtension,
  installPiInstructionFile,
  piDeliveryExtensionSource,
  piInstructionFileSource,
} from "../herdr/pi-extension-install.ts";
import { installPiStateExtensions } from "../herdr/pi-state-install.ts";
import type { PiSessionPlacement } from "../harness-routing/harness.ts";
import {
  PI_SETTINGS_OVERRIDES_FILE_NAME,
  piModelToResume,
  readPiSettingsOverrides,
  resolvePiModel,
  writePiAgentDirectory,
  type PiModelFamily,
  type PiSettings,
} from "../pi-models/pi-models.ts";
import { RUNTIME_THRONE_ROOT } from "../shared-policy/runtime-throne-root.ts";
import { throneCacheDirectory, throneConfigDirectory } from "../shared-policy/throne-home.ts";
import { THRONE_DATA_DIR } from "../shared-policy/throne-home.ts";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { accountsConfigPath } from "../account/accounts-config.ts";
import { loadFreshUserConfigForLaunch } from "../herdr/herdr-tab.service.ts";

export const PI_KEY_FILE_VARIABLE = "THRONE_PI_KEY_FILE";
export const PI_PROVIDER_BASE_URL_VARIABLE = "THRONE_PI_PROVIDER_BASE_URL";

export interface PiLaunch {
  readonly piSession: PiSessionPlacement;
  readonly piModelId: string;
  readonly displayName: string | null;
  readonly account: string;
  readonly note: string | null;
  readonly env: Record<string, string>;
}

export type PiLaunchPreparation =
  | { readonly ready: true; readonly launch: PiLaunch }
  | { readonly ready: false; readonly refusal: string };

export interface PiLaunchPlaces {
  readonly dataDirectory: string;
  readonly accountsConfigPath: string;
  readonly cacheDirectory: string;
  readonly providerBaseUrl: string | undefined;
  readonly settingsOverridesPath: string;
  readonly readOperatorPiSettings: () => Promise<PiSettings>;
  readonly installStateExtensions: (agentDirectory: string) => Promise<unknown>;
}

export function realPiLaunchPlaces(environment: NodeJS.ProcessEnv = process.env): PiLaunchPlaces {
  return {
    dataDirectory: THRONE_DATA_DIR,
    accountsConfigPath: accountsConfigPath(environment),
    cacheDirectory: throneCacheDirectory(environment),
    providerBaseUrl: environment[PI_PROVIDER_BASE_URL_VARIABLE] || undefined,
    settingsOverridesPath: path.join(throneConfigDirectory(environment), PI_SETTINGS_OVERRIDES_FILE_NAME),
    readOperatorPiSettings: () => readOperatorPiSettings(),
    installStateExtensions: installPiStateExtensions,
  };
}

export function piSessionDirectory(name: string, dataDirectory: string = THRONE_DATA_DIR): string {
  return path.join(dataDirectory, name, "pi-sessions");
}

export async function readOperatorPiSettings(configPath?: string): Promise<PiSettings> {
  return (await loadFreshUserConfigForLaunch(configPath, "pi launch: piSettings not applied"))?.piSettings ?? {};
}

export const PI_CODE_MODE_SETTINGS: PiSettings = { defaultTools: ["+codemode"] };

export async function piSettingsOverrides(places: PiLaunchPlaces): Promise<PiSettings> {
  return { ...PI_CODE_MODE_SETTINGS, ...(await readPiSettingsOverrides(places.settingsOverridesPath)), ...(await places.readOperatorPiSettings()) };
}

async function installIntoAgentDirectory(agentDirectory: string, modelId: string, places: PiLaunchPlaces): Promise<string | null> {
  let settingsOverrides: PiSettings;
  try {
    settingsOverrides = await piSettingsOverrides(places);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  await writePiAgentDirectory({
    agentDirectory,
    modelId,
    settingsOverrides,
    throneSkillsDirectory: path.join(RUNTIME_THRONE_ROOT, ".claude", "skills"),
    ...(places.providerBaseUrl === undefined ? {} : { baseUrl: places.providerBaseUrl }),
  });
  const delivery = await installPiDeliveryExtension(agentDirectory, piDeliveryExtensionSource(RUNTIME_THRONE_ROOT));
  if (delivery.kind === "blocked") return `throne's pi delivery extension did not install at ${delivery.link}: ${delivery.reason}`;
  const instructions = await installPiInstructionFile(agentDirectory, piInstructionFileSource(RUNTIME_THRONE_ROOT));
  if (instructions.kind === "blocked") return `throne's pi instruction file was not placed at ${instructions.link}: ${instructions.reason}`;
  try {
    await places.installStateExtensions(agentDirectory);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return null;
}

async function modelToLaunch(family: string, recorded: SpawnSpec | null, keyFile: string, places: PiLaunchPlaces) {
  if (recorded?.pi_model_id !== undefined) {
    return { id: piModelToResume(recorded), displayName: recorded.pi_model_display_name ?? null, note: null };
  }
  return resolvePiModel({
    family: family as PiModelFamily,
    key: (await readFile(keyFile, "utf8")).trim(),
    cacheDirectory: places.cacheDirectory,
    ...(places.providerBaseUrl === undefined ? {} : { baseUrl: places.providerBaseUrl }),
  });
}

export async function preparePiLaunch(
  name: string,
  family: string,
  recorded: SpawnSpec | null,
  places: PiLaunchPlaces = realPiLaunchPlaces(),
): Promise<PiLaunchPreparation> {
  const readiness = await providerKeyReadiness("deepseek", places.accountsConfigPath);
  if (!readiness.ready) return { ready: false, refusal: readiness.refusal };
  const model = await modelToLaunch(family, recorded, readiness.keyFile, places);
  const failure = await installIntoAgentDirectory(piAgentDirectory(name, places.dataDirectory), model.id, places);
  if (failure !== null) return { ready: false, refusal: failure };
  return {
    ready: true,
    launch: {
      piSession: {
        sessionId: recorded?.session_id ?? randomUUID(),
        sessionDirectory: piSessionDirectory(name, places.dataDirectory),
      },
      piModelId: model.id,
      displayName: model.displayName,
      account: readiness.account.name,
      note: model.note,
      env: { [PI_KEY_FILE_VARIABLE]: readiness.keyFile },
    },
  };
}
