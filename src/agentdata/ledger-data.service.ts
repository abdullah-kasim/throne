import { Injectable } from "@nestjs/common";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  symlink,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { RUNTIME_DATA_DIR } from "../shared-policy/runtime-data-home.ts";
import type { CanonicalRole } from "../shared-policy/role-word-union.ts";
import type { PersonaConfig } from "../application-config.service.ts";
import { type SpawnSpec } from "./spawn-data-contracts.ts";
import { SpawnDataService } from "./spawn-data.service.ts";
import { DELIVERY_EVIDENCE_DATA } from "./delivery-evidence-data.service.ts";

const TASK_FILE_RE = /^\d+[_-].*\.md$/i;
const BUNDLE_DIR_RE = /^todo[-_]/i;
export const DEFAULT_DATA_DIR = RUNTIME_DATA_DIR;
const TOOLS_RELATIVE_PATH = path.join("src", "tools.ts");
const REAPED_DIR_NAME = ".reaped";
const CANONICAL_LEDGER_DIR_RE = /^(alpha|shadow)-(.+)$/;

export interface LiveLedgerAgent {
  name?: string;
  cwd?: string;
}

export type LiveLedgerResolution =
  { ok: true; root: string; dataDir: string } | { ok: false; reason: string };

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listRegisteredAgents(
  baseDir: string = DEFAULT_DATA_DIR,
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(baseDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const registered: string[] = [];
  for (const entry of entries) {
    if (
      entry.isDirectory() &&
      (await fileExists(path.join(baseDir, entry.name, "identity.md")))
    ) {
      registered.push(entry.name);
    }
  }
  return registered.sort();
}

async function listReapedAgentNames(
  baseDir: string = DEFAULT_DATA_DIR,
): Promise<string[]> {
  const reapedDir = path.join(baseDir, REAPED_DIR_NAME);
  let entries;
  try {
    entries = await readdir(reapedDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const reaped: string[] = [];
  for (const entry of entries) {
    if (
      entry.isDirectory() &&
      (await fileExists(path.join(reapedDir, entry.name, "identity.md")))
    ) {
      reaped.push(entry.name);
    }
  }
  return reaped.sort();
}

async function hasCompletionReport(agentDirPath: string): Promise<boolean> {
  if (await fileExists(path.join(agentDirPath, "REPORT.md"))) return true;
  let subEntries;
  try {
    subEntries = await readdir(agentDirPath, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const subEntry of subEntries) {
    if (
      subEntry.isDirectory() &&
      (await fileExists(path.join(agentDirPath, subEntry.name, "REPORT.md")))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Whether `name`'s own ledger directory carries a landed `REPORT.md` (its
 * own directory or a terminal-gate subdirectory beneath it) — the durable,
 * agent-authored completion evidence a verdict-only agent (which never
 * produces a delivery commit) CAN actually produce.
 */
export async function hasCompletionReportForAgent(
  name: string,
  baseDir: string = DEFAULT_DATA_DIR,
): Promise<boolean> {
  return hasCompletionReport(path.join(baseDir, name));
}

async function listCompletedAgents(
  baseDir: string = DEFAULT_DATA_DIR,
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(baseDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const completed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(baseDir, entry.name);
    if (
      (await fileExists(path.join(dir, "identity.md"))) &&
      (await hasCompletionReport(dir))
    ) {
      completed.push(entry.name);
    }
  }
  return completed.sort();
}

/**
 * Whether durable ledger evidence already accounts for `name` as finished or
 * torn down: a landed `REPORT.md` (its own directory or a terminal-gate
 * subdirectory), a `delivery-evidence.json` landing record, or archival under
 * `.reaped/`. This is the one durable-completion predicate every checker that
 * decides whether to page an agent as untasked/orphaned should call, instead
 * of re-deriving REPORT.md/delivery-evidence/archival presence per caller.
 */
export async function isDurablyAccountedFor(
  name: string,
  baseDir: string = DEFAULT_DATA_DIR,
): Promise<boolean> {
  if (await hasCompletionReport(path.join(baseDir, name))) return true;
  if ((await DELIVERY_EVIDENCE_DATA.read(name, baseDir)) !== null) return true;
  return fileExists(path.join(baseDir, REAPED_DIR_NAME, name, "identity.md"));
}

async function archiveAgentData(
  name: string,
  baseDir: string = DEFAULT_DATA_DIR,
): Promise<"archived" | "absent"> {
  const source = path.join(baseDir, name);
  if (!(await fileExists(source))) return "absent";
  const reapedRoot = path.join(baseDir, ".reaped");
  await mkdir(reapedRoot, { recursive: true });
  let destination = path.join(reapedRoot, name);
  for (let suffix = 2; await fileExists(destination); suffix++) {
    destination = path.join(reapedRoot, `${name}-${suffix}`);
  }
  await rename(source, destination);
  return "archived";
}

export interface PersonaLedgerSymlinkSyncResult {
  readonly created: readonly string[];
  readonly removed: readonly string[];
  readonly skipped: readonly string[];
}

interface LiveCanonicalLedgerDir {
  readonly role: CanonicalRole;
  readonly rest: string;
  readonly dirName: string;
}

async function listLiveCanonicalLedgerDirs(
  dataDir: string,
): Promise<LiveCanonicalLedgerDir[]> {
  const entries = await readdir(dataDir, { withFileTypes: true }).catch(
    (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    },
  );
  const live: LiveCanonicalLedgerDir[] = [];
  for (const entry of entries) {
    if (entry.name === REAPED_DIR_NAME || !entry.isDirectory()) continue;
    const match = CANONICAL_LEDGER_DIR_RE.exec(entry.name);
    if (!match) continue;
    live.push({
      role: match[1] as CanonicalRole,
      rest: match[2]!,
      dirName: entry.name,
    });
  }
  return live;
}

function expectedPersonaSymlinkNames(
  activePersona: PersonaConfig,
  liveCanonicalDirs: readonly LiveCanonicalLedgerDir[],
): Map<string, string> {
  const expected = new Map<string, string>();
  for (const { role, rest, dirName } of liveCanonicalDirs) {
    const presetRoleWord = activePersona.roleWords[role];
    if (presetRoleWord.toLowerCase() === role) continue;
    expected.set(`${presetRoleWord}-${rest}`, dirName);
  }
  return expected;
}

async function resolveSymlinkTargetDirName(
  dataDir: string,
  linkName: string,
): Promise<string | undefined> {
  try {
    return path.basename(await readlink(path.join(dataDir, linkName)));
  } catch {
    return undefined;
  }
}

/**
 * Syncs `~/.throne/data/`'s persona addressing symlinks to the active preset:
 * for every LIVE (non-`.reaped/`) canonical `alpha-*`/`shadow-*` directory,
 * ensures a `<presetRoleWord>-<rest>` symlink exists pointing at it — except
 * when the preset's role word for that role is the canonical token itself
 * (`Default`), which needs no symlink. Every existing top-level symlink not
 * exactly matching that expected set (stale from a prior preset, or dangling
 * because its target was reaped or removed) is removed first, so persona
 * symlinks from personas activated in the past never accumulate. Pure and
 * idempotent: a second call against the same `dataDir`/`activePersona`
 * reports everything as `skipped`. Never enumerates, targets, or creates
 * anything under `data/.reaped/`.
 */
export async function syncPersonaLedgerSymlinks(
  dataDir: string,
  activePersona: PersonaConfig,
): Promise<PersonaLedgerSymlinkSyncResult> {
  const entries = await readdir(dataDir, { withFileTypes: true }).catch(
    (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    },
  );
  const liveCanonicalDirs = await listLiveCanonicalLedgerDirs(dataDir);
  const expected = expectedPersonaSymlinkNames(activePersona, liveCanonicalDirs);

  const created: string[] = [];
  const removed: string[] = [];
  const skipped: string[] = [];

  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue;
    const expectedTarget = expected.get(entry.name);
    const actualTarget = await resolveSymlinkTargetDirName(dataDir, entry.name);
    if (expectedTarget !== undefined && actualTarget === expectedTarget) {
      skipped.push(entry.name);
      expected.delete(entry.name);
      continue;
    }
    await unlink(path.join(dataDir, entry.name));
    removed.push(entry.name);
  }

  for (const [linkName, dirName] of expected) {
    await symlink(path.join(dataDir, dirName), path.join(dataDir, linkName), "dir");
    created.push(linkName);
  }

  return {
    created: created.sort(),
    removed: removed.sort(),
    skipped: skipped.sort(),
  };
}

async function liveRootFromWorktree(
  candidate: string,
  gitFile: string,
): Promise<string | undefined> {
  const contents = await readFile(gitFile, "utf8");
  const match = /^gitdir:\s*(.+)\s*$/m.exec(contents);
  if (!match) return undefined;
  const gitdir = path.resolve(path.dirname(gitFile), match[1]!);
  const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
  const markerIndex = gitdir.indexOf(marker);
  if (markerIndex < 0) return undefined;
  const repositoryRoot = gitdir.slice(0, markerIndex);
  const worktreeRoot = path.dirname(gitFile);
  return path.join(repositoryRoot, path.relative(worktreeRoot, candidate));
}

async function nearestGitRoot(candidate: string): Promise<string | undefined> {
  let gitCandidate = candidate;
  while (true) {
    try {
      await lstat(path.join(gitCandidate, ".git"));
      return path.join(gitCandidate, ".git");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(gitCandidate);
    if (parent === gitCandidate) return undefined;
    gitCandidate = parent;
  }
}

async function nearestLiveThroneRoot(
  start: string,
): Promise<string | undefined> {
  let candidate = path.resolve(start);
  if (!(await fileExists(path.join(candidate, TOOLS_RELATIVE_PATH))))
    return undefined;
  const gitFile = await nearestGitRoot(candidate);
  if (gitFile === undefined) return undefined;
  const gitStat = await lstat(gitFile);
  if (gitStat.isDirectory()) return candidate;
  if (gitStat.isFile()) return liveRootFromWorktree(candidate, gitFile);
  return undefined;
}

async function resolveLiveLedger(options: {
  invocationCwd: string;
  liveAgents: readonly LiveLedgerAgent[];
  sameAgentName: (left: string, right: string) => boolean;
}): Promise<LiveLedgerResolution> {
  const invocationRoot = await nearestLiveThroneRoot(options.invocationCwd);
  if (invocationRoot !== undefined) {
    return { ok: true, root: invocationRoot, dataDir: DEFAULT_DATA_DIR };
  }

  const regents = options.liveAgents.filter(
    (agent) =>
      typeof agent.name === "string" &&
      typeof agent.cwd === "string" &&
      options.sameAgentName(agent.name, "Regent"),
  );
  if (regents.length !== 1) {
    return {
      ok: false,
      reason: `cannot resolve the authoritative live throne ledger: expected one live Regent, found ${regents.length}`,
    };
  }
  const regentRoot = await nearestLiveThroneRoot(regents[0]!.cwd!);
  if (regentRoot === undefined) {
    return {
      ok: false,
      reason:
        `cannot resolve the authoritative live throne ledger: the live Regent cwd ` +
        `(${regents[0]!.cwd}) is not within a validated throne root`,
    };
  }
  return { ok: true, root: regentRoot, dataDir: DEFAULT_DATA_DIR };
}

@Injectable()
export class LedgerDataService {
  private readonly spawnData: SpawnDataService;

  constructor(spawnData = new SpawnDataService()) {
    this.spawnData = spawnData;
  }
  readonly agentDir = (name: string): string =>
    path.join(DEFAULT_DATA_DIR, name);
  readonly todoDir = (name: string, todo: string): string =>
    path.join(this.agentDir(name), todo);
  readonly fileExists = fileExists;
  readonly resolveLiveLedger = (options: {
    invocationCwd: string;
    liveAgents: readonly LiveLedgerAgent[];
    sameAgentName: (left: string, right: string) => boolean;
  }): Promise<LiveLedgerResolution> => resolveLiveLedger(options);
  readonly listRegisteredAgents = (baseDir?: string): Promise<string[]> =>
    listRegisteredAgents(baseDir);
  readonly listReapedAgentNames = (baseDir?: string): Promise<string[]> =>
    listReapedAgentNames(baseDir);
  readonly listCompletedAgents = (baseDir?: string): Promise<string[]> =>
    listCompletedAgents(baseDir);
  readonly isDurablyAccountedFor = (name: string, baseDir?: string): Promise<boolean> =>
    isDurablyAccountedFor(name, baseDir);
  readonly hasCompletionReport = (name: string, baseDir?: string): Promise<boolean> =>
    hasCompletionReportForAgent(name, baseDir);
  readonly archiveAgentData = (name: string, baseDir?: string) =>
    archiveAgentData(name, baseDir);
  readonly syncPersonaLedgerSymlinks = (
    activePersona: PersonaConfig,
    dataDir: string = DEFAULT_DATA_DIR,
  ): Promise<PersonaLedgerSymlinkSyncResult> =>
    syncPersonaLedgerSymlinks(dataDir, activePersona);
  readonly agentRegistrationExists = (name: string, baseDir?: string) =>
    this.spawnData.agentRegistrationExists(name, baseDir);
  readonly readSpawnSpec = (
    name: string,
    baseDir?: string,
  ): Promise<SpawnSpec | null> => this.spawnData.readSpawnSpec(name, baseDir);
  readonly writeSpawnSpec = (name: string, spec: SpawnSpec, baseDir?: string) =>
    this.spawnData.writeSpawnSpec(name, spec, baseDir);
  readonly spawnCapabilityEvidenceIsValid = (spec: SpawnSpec) =>
    this.spawnData.spawnCapabilityEvidenceIsValid(spec);
  readonly hasResumableWork = async (
    name: string,
    baseDir = DEFAULT_DATA_DIR,
  ): Promise<boolean> => {
    const dir = path.join(baseDir, name);
    if (await fileExists(path.join(dir, "ASSIGNMENT.md"))) return true;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (BUNDLE_DIR_RE.test(entry.name)) return true;
      let bundleFiles;
      try {
        bundleFiles = await readdir(path.join(dir, entry.name));
      } catch {
        continue;
      }
      if (bundleFiles.some((fileName) => TASK_FILE_RE.test(fileName)))
        return true;
    }
    return false;
  };
}
