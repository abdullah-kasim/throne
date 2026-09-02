import { readdir, rm, access, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildScratchHolderIndex,
  findScratchDirHolders,
} from "../tmp-scratch-lifecycle/scratch-dir-holders.ts";
import { HerdrInventoryService } from "../herdr/herdr-inventory.service.ts";
import { HerdrClientService } from "../herdr/herdr-client.ts";
import { RUNTIME_DATA_DIR } from "../shared-policy/runtime-data-home.ts";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";
import { readKnownRepoNames } from "./scratchpad-attribution.ts";
import {
  checkAttributionConsistency,
  classifyScratchpadEntry,
  RECLAIM_VERDICTS,
  type AttributionReader,
  type ReclaimEntry,
} from "./reclaim-agent-scratchpads-classifier.ts";

const DEFAULT_TMP_ROOT = "/tmp/claude-1000";

const USAGE =
  "Usage: reclaim-agent-scratchpads [--apply] [--tmp-root PATH] " +
  "[--worktrees-root PATH] [--data-dir PATH]\n" +
  "  --apply             actually remove RECLAIMABLE directories; default is " +
  "a dry-run report only\n" +
  `  --tmp-root PATH     scratch root to audit (default ${DEFAULT_TMP_ROOT})\n` +
  "  --worktrees-root PATH  directory holding <repo>/<agent> worktrees, used " +
  "to attribute entry names (default ~/.throne/worktrees)\n" +
  "  --data-dir PATH     throne data directory holding live/.reaped agent " +
  "records (default ~/.throne/data)\n";

interface ReclaimOptions {
  apply: boolean;
  tmpRoot: string;
  worktreesRoot: string;
  dataDir: string;
}

function help(): string {
  return `reclaim-agent-scratchpads — positive-attribution reclaim for dead ` +
    `agents' /tmp session scratchpads; deny by default\n\n${USAGE}`;
}

function takeFlagValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseArgs(args: string[], defaults: ReclaimOptions): ReclaimOptions {
  let { apply, tmpRoot, worktreesRoot, dataDir } = defaults;
  const singleFlags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--apply") {
      if (apply) throw new Error("--apply may be specified only once");
      apply = true;
      continue;
    }
    if (
      arg !== "--tmp-root" &&
      arg !== "--worktrees-root" &&
      arg !== "--data-dir"
    ) {
      throw new Error(`unknown argument "${arg}"`);
    }
    if (singleFlags.has(arg)) throw new Error(`${arg} may be specified only once`);
    singleFlags.add(arg);
    const value = takeFlagValue(args, index, arg);
    if (arg === "--tmp-root") tmpRoot = value;
    if (arg === "--worktrees-root") worktreesRoot = value;
    if (arg === "--data-dir") dataDir = value;
    index += 1;
  }
  return { apply, tmpRoot, worktreesRoot, dataDir };
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function liveReader(dataDir: string): AttributionReader {
  const inventory = new HerdrInventoryService(new HerdrClientService());
  return {
    async agents() {
      try {
        return await inventory.listAgents();
      } catch {
        return undefined;
      }
    },
    async reapedRecordExists(agentName: string) {
      try {
        return await fileExists(path.join(dataDir, ".reaped", agentName));
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
    async holderIndex() {
      return buildScratchHolderIndex();
    },
  };
}

async function directoryNamesUnder(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

export async function classifyScratchpads(
  tmpRoot: string,
  worktreesRoot: string,
  reader: AttributionReader,
): Promise<ReclaimEntry[]> {
  const entryNames = await directoryNamesUnder(tmpRoot);
  const repoNames = await readKnownRepoNames(worktreesRoot, (dirPath) =>
    readdir(dirPath, { withFileTypes: true }),
  );
  // Both fetched exactly once per run, then passed as plain values — the
  // live-roster read and the /proc holder walk are each a single
  // once-per-sweep query, never repeated per candidate directory.
  const [liveAgents, holderIndex] = await Promise.all([
    reader.agents(),
    reader.holderIndex(),
  ]);
  const entries: ReclaimEntry[] = [];
  for (const entryName of entryNames) {
    const dirPath = path.join(tmpRoot, entryName);
    entries.push(
      await classifyScratchpadEntry(
        dirPath,
        entryName,
        worktreesRoot,
        repoNames,
        liveAgents,
        holderIndex,
        reader,
      ),
    );
  }
  return entries;
}

async function applyReclaim(
  entries: ReclaimEntry[],
  tmpRoot: string,
  reader: AttributionReader,
): Promise<string[]> {
  const applied: string[] = [];
  const resolvedRoot = path.resolve(tmpRoot);
  for (const entry of entries) {
    if (entry.verdict !== RECLAIM_VERDICTS.RECLAIMABLE) continue;
    const resolvedEntry = path.resolve(entry.dirPath);
    if (resolvedEntry !== resolvedRoot && !resolvedEntry.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw new Error(
        `refusing to remove "${entry.dirPath}" — it does not resolve under the audited root "${tmpRoot}"`,
      );
    }
    // Unconditional fresh check immediately before delete — the classify
    // pass above already ran this, but time may have passed since; a
    // second race window closes only by checking again right here.
    const holders = await reader.procHolders(entry.dirPath);
    if (holders === undefined || holders.length > 0) {
      applied.push(`SKIPPED (race check before delete): ${entry.dirPath}`);
      continue;
    }
    await rm(entry.dirPath, { recursive: true, force: true });
    applied.push(`rm -rf ${entry.dirPath}`);
  }
  return applied;
}

function renderReport(entries: ReclaimEntry[], options: ReclaimOptions): string {
  if (entries.length === 0) {
    return `reclaim-agent-scratchpads: no directories found under ${options.tmpRoot}\n`;
  }
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.verdict, (counts.get(entry.verdict) ?? 0) + 1);
  const lines = [
    `reclaim-agent-scratchpads (${options.apply ? "apply" : "dry-run"}): ` +
      `${entries.length} director(y/ies) considered under ${options.tmpRoot}`,
    `  ${RECLAIM_VERDICTS.RECLAIMABLE}: ${counts.get(RECLAIM_VERDICTS.RECLAIMABLE) ?? 0}`,
    `  ${RECLAIM_VERDICTS.UNKNOWN}: ${counts.get(RECLAIM_VERDICTS.UNKNOWN) ?? 0}`,
    "",
    ...entries.map((entry) => `[${entry.verdict}] ${entry.dirPath} — ${entry.reason}`),
  ];
  if (!options.apply) {
    lines.push("", "dry-run: nothing removed. Pass --apply to remove RECLAIMABLE entries.");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The real filesystem path behind `homedir`, resolving through any symlink
 * (e.g. this box's `/home` -> `/var/home`) before it becomes part of the
 * default `--worktrees-root`. Only the DEFAULT needs this: an entry name
 * under `/tmp/claude-1000` is slugified from an agent's REALPATH-resolved
 * cwd, so an unresolved default would never match. An explicit
 * `--worktrees-root` argument is the caller's own responsibility and is
 * never passed through this resolution. A homedir that cannot be resolved
 * (e.g. it does not exist) falls back to the unresolved value — the
 * default is best-effort, not a hard requirement.
 */
async function resolveDefaultWorktreesHome(homedir: string): Promise<string> {
  try {
    return await realpath(homedir);
  } catch {
    return homedir;
  }
}

export async function runReclaimAgentScratchpads(
  args: string[],
  homedir: string = os.homedir(),
): Promise<number> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    process.stdout.write(help());
    return 0;
  }

  const resolvedHomedir = await resolveDefaultWorktreesHome(homedir);

  let options: ReclaimOptions;
  try {
    options = parseArgs(args, {
      apply: false,
      tmpRoot: DEFAULT_TMP_ROOT,
      worktreesRoot: path.join(resolvedHomedir, ".throne", "worktrees"),
      dataDir: RUNTIME_DATA_DIR,
    });
  } catch (error) {
    process.stderr.write(
      `reclaim-agent-scratchpads: ${error instanceof Error ? error.message : String(error)}\n` +
        `${renderEntranceRefusal({
          reason: "reclaim-agent-scratchpads entrance validation refused this invocation.",
          bypass: undefined,
          supervisorRoute: "Ask your supervisor for an allowed alternative invocation.",
        })}\n${USAGE}`,
    );
    return 2;
  }

  const reader = liveReader(options.dataDir);
  const entries = await classifyScratchpads(options.tmpRoot, options.worktreesRoot, reader);

  const consistency = checkAttributionConsistency(entries, options.worktreesRoot);
  if (!consistency.consistent) {
    process.stderr.write(
      `reclaim-agent-scratchpads: attribution inconsistency — ` +
        `${consistency.worktreeShapedCount} worktree-shaped director(y/ies) found under ` +
        `${options.tmpRoot} (worktrees-root: ${options.worktreesRoot}), 0 resolved to any ` +
        "agent name. This is a broken attribution pass, not a clean empty result — refusing " +
        "to report. Check --worktrees-root against the real (symlink-resolved) path agent " +
        "cwds are slugified from.\n",
    );
    return 1;
  }

  let report = renderReport(entries, options);
  if (options.apply) {
    const applied = await applyReclaim(entries, options.tmpRoot, reader);
    report += `\napplied:\n${applied.map((line) => `  - ${line}`).join("\n")}\n`;
  }
  process.stdout.write(report);
  return 0;
}
