import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PI_PINNED_MODEL_IDS } from "../harness-routing/model-registry.ts";

export type PiModelFamily = "flash" | "pro";

export type ListedModel = { id: string; displayName: string | null };

export type ResolvedPiModel = {
  id: string;
  displayName: string | null;
  source: "listed" | "cached" | "pinned";
  note: string;
};

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const MODEL_LIST_LIFETIME_MILLISECONDS = 24 * 60 * 60 * 1000;
const PROVIDER = "deepseek";
const PI_BUILT_IN_MODEL_IDS = new Set(Object.values(PI_PINNED_MODEL_IDS));
const LIST_TIMEOUT_MILLISECONDS = 10_000;

type CachedList = { fetched_at: string; models: ListedModel[] };

function versionParts(id: string, family: PiModelFamily): number[] {
  return (id.replace(family, "").match(/\d+/g) ?? []).map(Number);
}

function compareVersions(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function newestOfFamily(models: readonly ListedModel[], family: PiModelFamily): ListedModel | undefined {
  const movingName = models.find((model) => model.id === `${PROVIDER}-${family}`);
  if (movingName !== undefined) return movingName;
  return models
    .filter((model) => model.id.split("-").includes(family))
    .sort((left, right) => compareVersions(versionParts(right.id, family), versionParts(left.id, family)))[0];
}

function cacheFilePath(cacheDirectory: string): string {
  return path.join(cacheDirectory, "pi-models", `${PROVIDER}.json`);
}

async function readCachedList(cacheDirectory: string): Promise<CachedList | undefined> {
  try {
    const cached = JSON.parse(await readFile(cacheFilePath(cacheDirectory), "utf8")) as CachedList;
    return Array.isArray(cached.models) && typeof cached.fetched_at === "string" ? cached : undefined;
  } catch {
    return undefined;
  }
}

async function writeCachedList(cacheDirectory: string, list: CachedList): Promise<void> {
  await mkdir(path.dirname(cacheFilePath(cacheDirectory)), { recursive: true });
  await writeFile(cacheFilePath(cacheDirectory), `${JSON.stringify(list, null, 2)}\n`);
}

async function fetchModelList(baseUrl: string, key: string): Promise<ListedModel[]> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(LIST_TIMEOUT_MILLISECONDS),
  });
  if (!response.ok) throw new Error(`the model list answered ${response.status}`);
  const body = (await response.json()) as { data?: Array<{ id?: unknown; display_name?: unknown; name?: unknown }> };
  return (body.data ?? [])
    .filter((model) => typeof model.id === "string")
    .map((model) => {
      const displayName = model.display_name ?? model.name;
      return { id: model.id as string, displayName: typeof displayName === "string" ? displayName : null };
    });
}

function describe(model: ListedModel): string {
  return model.displayName === null ? model.id : `${model.id} (${model.displayName})`;
}

export async function resolvePiModel(request: {
  family: PiModelFamily;
  key: string;
  cacheDirectory: string;
  baseUrl?: string;
  now?: Date;
}): Promise<ResolvedPiModel> {
  const now = request.now ?? new Date();
  const cached = await readCachedList(request.cacheDirectory);
  const cacheIsFresh = cached !== undefined && now.getTime() - Date.parse(cached.fetched_at) < MODEL_LIST_LIFETIME_MILLISECONDS;
  if (cacheIsFresh) {
    const chosen = newestOfFamily(cached.models, request.family);
    if (chosen !== undefined) {
      return { ...chosen, source: "cached", note: `pi/${request.family} is ${describe(chosen)}, from the model list fetched at ${cached.fetched_at}` };
    }
  }
  let unreachableReason: string;
  try {
    const models = await fetchModelList(request.baseUrl ?? DEEPSEEK_BASE_URL, request.key);
    await writeCachedList(request.cacheDirectory, { fetched_at: now.toISOString(), models });
    const chosen = newestOfFamily(models, request.family);
    if (chosen !== undefined) {
      return { ...chosen, source: "listed", note: `pi/${request.family} is ${describe(chosen)}, the newest the provider lists` };
    }
    unreachableReason = `the provider's model list holds no ${request.family} model`;
  } catch (error) {
    unreachableReason = `the provider's model list could not be reached (${error instanceof Error ? error.message : String(error)})`;
  }
  const cachedChoice = cached === undefined ? undefined : newestOfFamily(cached.models, request.family);
  if (cachedChoice !== undefined) {
    return {
      ...cachedChoice,
      source: "cached",
      note: `${unreachableReason}; using the cached ${describe(cachedChoice)} from ${cached?.fetched_at}`,
    };
  }
  const pinned = PI_PINNED_MODEL_IDS[request.family];
  return {
    id: pinned,
    displayName: null,
    source: "pinned",
    note: `${unreachableReason} and nothing is cached; using the registry's pinned ${pinned}`,
  };
}

export function piModelToResume(spawnRecord: { pi_model_id?: unknown }): string {
  if (typeof spawnRecord.pi_model_id !== "string" || spawnRecord.pi_model_id === "") {
    throw new Error("spawn.json records no pi_model_id to resume on");
  }
  return spawnRecord.pi_model_id;
}

export const PI_SETTINGS_OVERRIDES_FILE_NAME = "pi-settings.json";

export const PI_DEFAULT_SETTINGS: Readonly<Record<string, unknown>> = {
  hideThinkingBlock: true,
  quietStartup: true,
  collapseChangelog: true,
};

const SETTINGS_PI_WRITES_ITSELF = ["lastChangelogVersion"];

export type PiSettings = Record<string, unknown>;

function isFileMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function readPiSettingsOverrides(overridesPath: string): Promise<PiSettings> {
  let text: string;
  try {
    text = await readFile(overridesPath, "utf8");
  } catch (error) {
    if (isFileMissing(error)) return {};
    throw new Error(`cannot read the pi settings file ${overridesPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`the pi settings file ${overridesPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`the pi settings file ${overridesPath} must hold one JSON object of pi settings`);
  }
  return parsed as PiSettings;
}

async function settingsPiWroteItself(settingsPath: string): Promise<PiSettings> {
  let existing: unknown;
  try {
    existing = JSON.parse(await readFile(settingsPath, "utf8"));
  } catch {
    return {};
  }
  if (typeof existing !== "object" || existing === null) return {};
  const kept: PiSettings = {};
  for (const key of SETTINGS_PI_WRITES_ITSELF) {
    const value = (existing as PiSettings)[key];
    if (value !== undefined) kept[key] = value;
  }
  return kept;
}

function skillFolders(throneSkillsDirectory: string | undefined, overrides: PiSettings | undefined): PiSettings {
  const fromTheUser = Array.isArray(overrides?.skills) ? overrides.skills : [];
  const folders = throneSkillsDirectory === undefined ? fromTheUser : [throneSkillsDirectory, ...fromTheUser];
  return folders.length === 0 ? {} : { skills: folders };
}

export async function writePiAgentDirectory(request: {
  agentDirectory: string;
  modelId: string;
  baseUrl?: string;
  settingsOverrides?: PiSettings;
  throneSkillsDirectory?: string;
}): Promise<{ modelsPath: string; settingsPath: string }> {
  await mkdir(request.agentDirectory, { recursive: true });
  const modelsPath = path.join(request.agentDirectory, "models.json");
  const settingsPath = path.join(request.agentDirectory, "settings.json");
  const provider = {
    ...(request.baseUrl === undefined ? {} : { baseUrl: request.baseUrl }),
    ...(PI_BUILT_IN_MODEL_IDS.has(request.modelId) ? {} : { models: [{ id: request.modelId }] }),
  };
  const settings = {
    ...(await settingsPiWroteItself(settingsPath)),
    ...PI_DEFAULT_SETTINGS,
    ...request.settingsOverrides,
    ...skillFolders(request.throneSkillsDirectory, request.settingsOverrides),
    defaultProvider: PROVIDER,
    defaultModel: request.modelId,
  };
  await writeFile(modelsPath, `${JSON.stringify({ providers: Object.keys(provider).length === 0 ? {} : { [PROVIDER]: provider } }, null, 2)}\n`);
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return { modelsPath, settingsPath };
}
