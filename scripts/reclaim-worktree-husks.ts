import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { runGit } from "../src/git-lifecycle/git-command.service.ts";
import {
  parseWorktreeList,
  realIdentity,
  worktreesHome,
  THRONE_PROJECT_DIR,
  type Worktree,
} from "../src/git-lifecycle/git-worktree.service.ts";
import {
  findTreeOccupants,
  findUnregisteredTreeOccupants,
} from "../src/reap-agent/occupancy.ts";
import { findScratchDirHolders } from "../src/tmp-scratch-lifecycle/scratch-dir-holders.ts";
import type { HerdrAgent } from "../src/herdr/herdr-inventory.service.ts";
import { HerdrInventoryService } from "../src/herdr/herdr-inventory.service.ts";
import { HerdrClientService } from "../src/herdr/herdr-client.ts";

const USAGE =
  "Usage: reclaim-worktree-husks [--apply] [--throne-root PATH] [--worktrees-root PATH]\n" +
  "  --apply             actually prune stale registrations and remove dead " +
  "directories; default is a dry-run report only\n" +
  "  --throne-root PATH  the repo `git worktree list` is read against " +
  "(default: this repo's own root)\n" +
  "  --worktrees-root PATH  directory holding worktree directories to audit " +
  "(default: ~/.throne/worktrees)\n";

/**
 * No live agent is ever named this — passing it to `findTreeOccupants`
 * turns that "every named occupant except the one being reaped" predicate
 * into "every named occupant, full stop", which is exactly the ownership
 * test this tool needs: does ANY live agent's roster-recorded `cwd` resolve
 * inside this tree, regardless of what the tree is named or who it was
 * created for. `findUnregisteredTreeOccupants` covers the unnamed case the
 * same call already leaves out.
 */
const NO_AGENT_IS_EVER_NAMED_THIS = "\0no-agent-has-this-name\0";

export type HuskCategory =
  | "registered-live"
  | "registered-stale"
  | "unregistered-held"
  | "unregistered-dead"
  | "unknown";

export interface HuskClassification {
  path: string;
  registered: boolean;
  directoryExists: boolean;
  category: HuskCategory;
  reason: string;
  removalAction?: "git-worktree-remove" | "git-worktree-prune" | "rm";
}

export interface OccupancyReader {
  /** Live agents from `herdr agent list`/`agent-statuses`'s own source, or
   *  `undefined` when the roster itself could not be read. */
  agents(): Promise<HerdrAgent[] | undefined>;
  /** OS-process holder evidence for one directory, from the same `/proc`
   *  primitive the scratch-directory sweeper uses, or `undefined` when unreadable. */
  procHolders(dirPath: string): Promise<{ pid: number }[] | undefined>;
}

interface OccupancyResult {
  /** `true` only when BOTH checks resolved and found nothing — the only
   *  state that ever authorizes removal. */
  confirmedUnheld: boolean;
  /** `true` when either check found evidence of a live occupant. */
  held: boolean;
  /** `true` when either check could not resolve at all — tristate law:
   *  this always wins over `held`/`confirmedUnheld`, dry-run output must
   *  say so distinctly, and this directory is never a removal candidate. */
  unresolvable: boolean;
  detail: string[];
}

async function checkOccupancy(
  treePath: string,
  reader: OccupancyReader,
): Promise<OccupancyResult> {
  const detail: string[] = [];
  let unresolvable = false;
  let held = false;

  const agents = await reader.agents();
  if (agents === undefined) {
    unresolvable = true;
    detail.push("live agent roster was unreadable");
  } else {
    const occupants = [
      ...findTreeOccupants(NO_AGENT_IS_EVER_NAMED_THIS, treePath, agents),
      ...findUnregisteredTreeOccupants(treePath, agents),
    ];
    if (occupants.length > 0) {
      held = true;
      detail.push(`${occupants.length} live agent(s) recorded cwd inside this tree`);
    }
  }

  const procHolders = await reader.procHolders(treePath);
  if (procHolders === undefined) {
    unresolvable = true;
    detail.push("process holder scan was unreadable");
  } else if (procHolders.length > 0) {
    held = true;
    detail.push(`${procHolders.length} OS process(es) hold this tree (cwd or open fd)`);
  }

  return { confirmedUnheld: !unresolvable && !held, held, unresolvable, detail };
}

/**
 * Classifies every directory this tool needs to report on: every registered
 * worktree entry (present or not) plus every on-disk directory under
 * `worktreesRoot` that git does not register. A registered entry whose
 * directory is present is only ever `registered-stale` when both occupancy
 * checks positively clear it — an unresolvable read leaves it `unknown`,
 * never a removal candidate, per the tristate law this bundle applies
 * everywhere occupancy is judged.
 */
export async function classifyWorktreeHusks(
  registered: Worktree[],
  onDiskDirNames: string[],
  worktreesRoot: string,
  reader: OccupancyReader,
): Promise<HuskClassification[]> {
  const onDiskPaths = new Set(
    onDiskDirNames.map((name) => realIdentity(path.join(worktreesRoot, name))),
  );
  const results: HuskClassification[] = [];

  for (const worktree of registered) {
    const resolved = realIdentity(worktree.path);
    const directoryExists = onDiskPaths.has(resolved);
    if (!directoryExists) {
      results.push({
        path: worktree.path,
        registered: true,
        directoryExists: false,
        category: "registered-stale",
        reason: "registered with git but its directory no longer exists",
        removalAction: "git-worktree-prune",
      });
      continue;
    }
    const occupancy = await checkOccupancy(worktree.path, reader);
    if (occupancy.unresolvable) {
      results.push({
        path: worktree.path,
        registered: true,
        directoryExists: true,
        category: "unknown",
        reason: `occupancy could not be resolved (${occupancy.detail.join("; ")})`,
      });
    } else if (occupancy.held) {
      results.push({
        path: worktree.path,
        registered: true,
        directoryExists: true,
        category: "registered-live",
        reason: occupancy.detail.join("; "),
      });
    } else {
      results.push({
        path: worktree.path,
        registered: true,
        directoryExists: true,
        category: "registered-stale",
        reason: "registered with git, directory present, but no live occupant found",
        removalAction: "git-worktree-remove",
      });
    }
  }

  const registeredPaths = new Set(registered.map((worktree) => realIdentity(worktree.path)));
  for (const name of onDiskDirNames) {
    const dirPath = path.join(worktreesRoot, name);
    if (registeredPaths.has(realIdentity(dirPath))) continue;
    const occupancy = await checkOccupancy(dirPath, reader);
    if (occupancy.unresolvable) {
      results.push({
        path: dirPath,
        registered: false,
        directoryExists: true,
        category: "unknown",
        reason: `occupancy could not be resolved (${occupancy.detail.join("; ")})`,
      });
    } else if (occupancy.held) {
      results.push({
        path: dirPath,
        registered: false,
        directoryExists: true,
        category: "unregistered-held",
        reason: occupancy.detail.join("; "),
      });
    } else {
      results.push({
        path: dirPath,
        registered: false,
        directoryExists: true,
        category: "unregistered-dead",
        reason: "not registered with git and no live occupant found",
        removalAction: "rm",
      });
    }
  }

  return results;
}

function renderReport(
  classifications: HuskClassification[],
  registeredCount: number,
  onDiskCount: number,
  apply: boolean,
): string {
  const counts = new Map<HuskCategory, number>();
  for (const entry of classifications) {
    counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
  }
  const lines = [
    `git worktree list: ${registeredCount} registration(s)`,
    `on-disk directories: ${onDiskCount}`,
    ...(
      ["registered-live", "registered-stale", "unregistered-held", "unregistered-dead", "unknown"] as HuskCategory[]
    ).map((category) => `  ${category}: ${counts.get(category) ?? 0}`),
    "",
    ...classifications.map(
      (entry) => `[${entry.category}] ${entry.path} — ${entry.reason}`,
    ),
    "",
    apply ? "apply mode: removing reclaim candidates now." : "dry-run: nothing removed. Pass --apply to remove registered-stale and unregistered-dead entries.",
  ];
  return lines.join("\n");
}

async function applyRemovals(
  classifications: HuskClassification[],
  throneRoot: string,
  worktreesRoot: string,
): Promise<string[]> {
  const applied: string[] = [];
  const staleWithMissingDirectory = classifications.some(
    (entry) => entry.removalAction === "git-worktree-prune",
  );
  if (staleWithMissingDirectory) {
    await runGit(["worktree", "prune"], throneRoot);
    applied.push("git worktree prune (registered-stale entries with no directory)");
  }
  for (const entry of classifications) {
    if (entry.removalAction === "git-worktree-remove") {
      await runGit(["worktree", "remove", "--force", entry.path], throneRoot);
      applied.push(`git worktree remove --force ${entry.path}`);
    } else if (entry.removalAction === "rm") {
      const resolved = realIdentity(entry.path);
      const rootResolved = realIdentity(worktreesRoot);
      if (resolved !== rootResolved && !resolved.startsWith(`${rootResolved}${path.sep}`)) {
        throw new Error(
          `refusing to remove "${entry.path}" — it does not resolve under the audited worktrees root "${worktreesRoot}"`,
        );
      }
      await rm(entry.path, { recursive: true, force: true });
      applied.push(`rm -rf ${entry.path}`);
    }
  }
  return applied;
}

interface ReclaimOptions {
  apply: boolean;
  throneRoot: string;
  worktreesRoot: string;
}

function parseArgs(args: string[], defaults: ReclaimOptions): ReclaimOptions {
  let apply = defaults.apply;
  let throneRoot = defaults.throneRoot;
  let worktreesRoot = defaults.worktreesRoot;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (arg === "--throne-root" || arg === "--worktrees-root") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      if (arg === "--throne-root") throneRoot = value;
      else worktreesRoot = value;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    throw new Error(`unknown argument "${arg}"`);
  }
  return { apply, throneRoot, worktreesRoot };
}

function liveHerdrOccupancyReader(): OccupancyReader {
  const inventory = new HerdrInventoryService(new HerdrClientService());
  return {
    async agents() {
      try {
        return await inventory.listAgents();
      } catch {
        return undefined;
      }
    },
    async procHolders(dirPath: string) {
      try {
        return await findScratchDirHolders(dirPath);
      } catch {
        return undefined;
      }
    },
  };
}

export async function runReclaim(options: ReclaimOptions, reader: OccupancyReader): Promise<string> {
  const porcelain = await runGit(["worktree", "list", "--porcelain"], options.throneRoot);
  const registered = parseWorktreeList(porcelain);
  let onDiskDirNames: string[];
  try {
    onDiskDirNames = (await readdir(options.worktreesRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") onDiskDirNames = [];
    else throw error;
  }

  const classifications = await classifyWorktreeHusks(
    registered,
    onDiskDirNames,
    options.worktreesRoot,
    reader,
  );

  let report = renderReport(classifications, registered.length, onDiskDirNames.length, options.apply);
  if (options.apply) {
    const applied = await applyRemovals(classifications, options.throneRoot, options.worktreesRoot);
    report += `\n\napplied:\n${applied.map((line) => `  - ${line}`).join("\n")}`;
  }
  return report;
}

async function main(): Promise<void> {
  let options: ReclaimOptions;
  try {
    options = parseArgs(process.argv.slice(2), {
      apply: false,
      throneRoot: THRONE_PROJECT_DIR,
      worktreesRoot: worktreesHome(),
    });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n${USAGE}`);
    process.exit(1);
    return;
  }
  const report = await runReclaim(options, liveHerdrOccupancyReader());
  process.stdout.write(`${report}\n`);
}

const isMainModule = process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMainModule) {
  main().catch((error) => {
    process.stderr.write(`reclaim-worktree-husks: ${(error as Error).message}\n`);
    process.exit(1);
  });
}
