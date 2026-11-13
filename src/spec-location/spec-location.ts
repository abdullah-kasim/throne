import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { FEATURE_MAP_FILE_NAME, looksLikeThroneFeatureMap } from "../feature-map/spec-form.ts";
import { pathExists, readSpecFolder } from "../feature-map/feature-map.ts";
import { memorySlug, resolveRepoRoot } from "../memory-dir/memory-dir-resolver.ts";
import { PRODUCTION_MEMORY_RESOLVER_DEPS } from "../memory-dir/memory-dir-runtime.ts";

const execFileAsync = promisify(execFile);

export const NONE_YET = "none yet";
export const IN_THE_DATA_HOME = "in the throne data home";
export const MADE_WITH_THRONE = "in the project, made with throne's tooling";
export const MADE_ANOTHER_WAY = "in the project, made another way";
export type SpecArtefactState = typeof NONE_YET | typeof IN_THE_DATA_HOME | typeof MADE_WITH_THRONE | typeof MADE_ANOTHER_WAY;

export const SPEC_FOLDER_CANDIDATES: readonly string[] = ["specs", "spec", "docs/specs"];
export const FEATURE_MAP_CANDIDATES: readonly string[] = [
  `specs/${FEATURE_MAP_FILE_NAME}`,
  FEATURE_MAP_FILE_NAME,
  `docs/${FEATURE_MAP_FILE_NAME}`,
];

const OURS_SPEC_FOLDER = "specs";
const OURS_FEATURE_MAP = `specs/${FEATURE_MAP_FILE_NAME}`;
const SPECS_FOLDER_IN_DATA_HOME = "specs";
const SETTINGS_FILE_NAME = "settings.json";

export type Artefact = "spec" | "map";
export type Ownership = "yes" | "no" | "unknown";
export type Place = "repository" | "data-home";

export interface ArtefactLocation {
  readonly state: SpecArtefactState;
  readonly path: string | null;
  readonly candidates?: { readonly ours: string; readonly notOurs: string };
}

export interface SpecLocation {
  readonly repository: string;
  readonly mainCheckout: string;
  readonly settingsFile: string;
  readonly owned: Ownership;
  readonly spec: ArtefactLocation;
  readonly map: ArtefactLocation;
}

interface RecordedArtefact {
  readonly state: SpecArtefactState;
  readonly path: string;
}

interface SpecSettings {
  readonly owned?: boolean;
  readonly place?: Place;
  readonly spec?: RecordedArtefact;
  readonly map?: RecordedArtefact;
}

interface Project {
  readonly checkout: string;
  readonly mainCheckout: string;
  readonly folderInDataHome: string;
}

async function checkoutOf(directory: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: directory, encoding: "utf8" });
    return await realpath(stdout.trim());
  } catch {
    return realpath(directory);
  }
}

async function projectOf(repository: string, dataHome: string): Promise<Project> {
  const { root } = await resolveRepoRoot(repository, PRODUCTION_MEMORY_RESOLVER_DEPS);
  const slug = memorySlug(await realpath(os.homedir()), root);
  return {
    checkout: await checkoutOf(repository),
    mainCheckout: root,
    folderInDataHome: path.join(dataHome, SPECS_FOLDER_IN_DATA_HOME, slug),
  };
}

async function readSettings(settingsFile: string): Promise<SpecSettings> {
  const text = await readFile(settingsFile, "utf8").catch(() => undefined);
  return text === undefined ? {} : (JSON.parse(text) as SpecSettings);
}

async function detectSpecFolder(checkout: string): Promise<RecordedArtefact | undefined> {
  for (const candidate of SPEC_FOLDER_CANDIDATES) {
    const folder = path.join(checkout, candidate);
    if (!(await pathExists(folder))) continue;
    const specs = await readSpecFolder(folder).catch(() => []);
    if (specs.length === 0) continue;
    return { path: candidate, state: specs.every((spec) => spec.hasHeader) ? MADE_WITH_THRONE : MADE_ANOTHER_WAY };
  }
  return undefined;
}

async function detectFeatureMap(checkout: string): Promise<RecordedArtefact | undefined> {
  for (const candidate of FEATURE_MAP_CANDIDATES) {
    const text = await readFile(path.join(checkout, candidate), "utf8").catch(() => undefined);
    if (text === undefined) continue;
    return { path: candidate, state: looksLikeThroneFeatureMap(text) ? MADE_WITH_THRONE : MADE_ANOTHER_WAY };
  }
  return undefined;
}

function placeOf(owned: Ownership, passed: Place | undefined, settings: SpecSettings): Place | undefined {
  if (owned === "no") {
    if (passed === "repository") throw new Error("a repository that is not ours is never written into; its place is the data home");
    return "data-home";
  }
  if (owned === "unknown") return undefined;
  return passed ?? settings.place ?? "repository";
}

function notYetMade(place: Place | undefined, ours: string, notOurs: string): ArtefactLocation {
  if (place === "repository") return { state: NONE_YET, path: ours };
  if (place === "data-home") return { state: NONE_YET, path: notOurs };
  return { state: NONE_YET, path: null, candidates: { ours, notOurs } };
}

function ownershipOf(passed: boolean | undefined, settings: SpecSettings): Ownership {
  const owned = passed ?? settings.owned;
  if (owned === undefined) return "unknown";
  return owned ? "yes" : "no";
}

export async function resolveSpecLocation(
  repository: string,
  dataHome: string,
  owned?: boolean,
  place?: Place,
): Promise<SpecLocation> {
  const project = await projectOf(repository, dataHome);
  const settingsFile = path.join(project.folderInDataHome, SETTINGS_FILE_NAME);
  const settings = await readSettings(settingsFile);
  const ownership = ownershipOf(owned, settings);
  const chosenPlace = placeOf(ownership, place, settings);
  const externalFolder = path.join(project.folderInDataHome, SPECS_FOLDER_IN_DATA_HOME);
  const spec = (await detectSpecFolder(project.checkout)) ?? settings.spec ?? notYetMade(chosenPlace, OURS_SPEC_FOLDER, externalFolder);
  const map =
    (await detectFeatureMap(project.checkout)) ??
    settings.map ??
    notYetMade(chosenPlace, OURS_FEATURE_MAP, path.join(externalFolder, FEATURE_MAP_FILE_NAME));
  return {
    repository: project.checkout,
    mainCheckout: project.mainCheckout,
    settingsFile,
    owned: ownership,
    spec,
    map,
  };
}

export async function recordSpecArtefact(
  repository: string,
  dataHome: string,
  artefact: Artefact,
  owned?: boolean,
  place?: Place,
): Promise<SpecLocation> {
  const location = await resolveSpecLocation(repository, dataHome, owned, place);
  const current = location[artefact];
  if (current.path === null) {
    throw new Error("ownership is unknown, so there is no place to record; pass --owned yes or --owned no");
  }
  const inDataHome = path.isAbsolute(current.path);
  const onDisk = inDataHome ? current.path : path.join(location.repository, current.path);
  if (!(await pathExists(onDisk))) throw new Error(`${onDisk} does not exist yet; create it before recording it`);
  const state = inDataHome ? IN_THE_DATA_HOME : current.state === NONE_YET ? MADE_WITH_THRONE : current.state;
  const settings = await readSettings(location.settingsFile);
  const updated: SpecSettings = {
    ...settings,
    ...(location.owned === "unknown" ? {} : { owned: location.owned === "yes", place: inDataHome ? "data-home" : "repository" }),
    [artefact]: { state, path: current.path },
  };
  await mkdir(path.dirname(location.settingsFile), { recursive: true });
  await writeFile(location.settingsFile, `${JSON.stringify(updated, null, 2)}\n`);
  return resolveSpecLocation(repository, dataHome, owned, place);
}

function placeLine(location: ArtefactLocation): string {
  if (location.path !== null) return location.path;
  return `undecided, ownership unknown (ours: ${location.candidates?.ours}; not ours: ${location.candidates?.notOurs})`;
}

export function plainLinesOf(location: SpecLocation): string[] {
  return [
    `repository: ${location.repository}`,
    `main checkout: ${location.mainCheckout}`,
    `settings file: ${location.settingsFile}`,
    `owned: ${location.owned}`,
    `spec folder: ${placeLine(location.spec)}`,
    `spec state: ${location.spec.state}`,
    `map file: ${placeLine(location.map)}`,
    `map state: ${location.map.state}`,
  ];
}
