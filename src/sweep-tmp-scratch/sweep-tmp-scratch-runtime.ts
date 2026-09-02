import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildScratchHolderIndex } from "../tmp-scratch-lifecycle/scratch-dir-holders.ts";
import {
  checkScratchDirRemovalEligibility,
  removeScratchDir,
} from "../tmp-scratch-lifecycle/remove-scratch-dir.ts";
import { SCRATCH_DIR_REMOVAL_OUTCOMES } from "../tmp-scratch-lifecycle/tmp-scratch-lifecycle.types.ts";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";

const DEFAULT_MIN_AGE_MS = 2 * 60 * 60 * 1000;

const USAGE =
  "Usage: sweep-tmp-scratch [--min-age-ms N] [--apply] [--tmp-root PATH]\n" +
  "  --min-age-ms N   minimum directory age, in milliseconds, to be eligible " +
  `(default ${DEFAULT_MIN_AGE_MS})\n` +
  "  --apply          actually remove eligible directories; default is dry-run report only\n" +
  "  --tmp-root PATH  scratch root to scan (default ~/tmp)\n";

interface SweepOptions {
  minAgeMs: number;
  apply: boolean;
  tmpRoot: string;
}

function help(): string {
  return `sweep-tmp-scratch — deliberate backlog sweep for ~/tmp campaign scratch\n\n${USAGE}`;
}

function takeFlagValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseSweepArgs(args: string[], homedir: string): SweepOptions {
  let minAgeMs = DEFAULT_MIN_AGE_MS;
  let apply = false;
  let tmpRoot = path.join(homedir, "tmp");
  const singleFlags = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--apply") {
      if (apply) throw new Error("--apply may be specified only once");
      apply = true;
      continue;
    }
    if (arg !== "--min-age-ms" && arg !== "--tmp-root") {
      throw new Error(`unknown argument "${arg}"`);
    }
    if (singleFlags.has(arg)) {
      throw new Error(`${arg} may be specified only once`);
    }
    singleFlags.add(arg);
    const value = takeFlagValue(args, index, arg);
    if (arg === "--min-age-ms") {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(
          `--min-age-ms must be a non-negative integer, got "${value}"`,
        );
      }
      minAgeMs = parsed;
    }
    if (arg === "--tmp-root") tmpRoot = value;
    index += 1;
  }

  return { minAgeMs, apply, tmpRoot };
}

type SweepEntryOutcome =
  | typeof SCRATCH_DIR_REMOVAL_OUTCOMES.REMOVED
  | typeof SCRATCH_DIR_REMOVAL_OUTCOMES.SKIPPED_LIVE
  | typeof SCRATCH_DIR_REMOVAL_OUTCOMES.SKIPPED_TOO_YOUNG;

interface SweepEntry {
  dirPath: string;
  outcome: SweepEntryOutcome;
}

async function scratchDirsUnder(tmpRoot: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(tmpRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(tmpRoot, entry.name));
}

async function sweepScratchDirs(options: SweepOptions): Promise<SweepEntry[]> {
  const dirs = await scratchDirsUnder(options.tmpRoot);
  const holderIndex = await buildScratchHolderIndex();
  const entries: SweepEntry[] = [];
  for (const dirPath of dirs) {
    if (!options.apply) {
      const result = await checkScratchDirRemovalEligibility(
        dirPath,
        options.minAgeMs,
        holderIndex,
      );
      entries.push({ dirPath, outcome: result.outcome });
      continue;
    }
    const result = await removeScratchDir(dirPath, options.minAgeMs, holderIndex);
    entries.push({ dirPath, outcome: result.outcome });
  }
  return entries;
}

function outcomeLabel(outcome: SweepEntryOutcome, apply: boolean): string {
  if (outcome === SCRATCH_DIR_REMOVAL_OUTCOMES.REMOVED) {
    return apply ? "removed" : "would-remove";
  }
  return outcome;
}

function renderReport(entries: SweepEntry[], options: SweepOptions): string {
  if (entries.length === 0) {
    return `sweep-tmp-scratch: no directories found under ${options.tmpRoot}\n`;
  }
  const lines = entries.map(
    (entry) =>
      `${entry.dirPath}: ${outcomeLabel(entry.outcome, options.apply)}`,
  );
  const mode = options.apply ? "apply" : "dry-run";
  lines.push(
    `sweep-tmp-scratch (${mode}): ${entries.length} directory(ies) considered`,
  );
  return `${lines.join("\n")}\n`;
}

export async function runSweepTmpScratch(
  args: string[],
  homedir: string = os.homedir(),
): Promise<number> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    process.stdout.write(help());
    return 0;
  }

  let options: SweepOptions;
  try {
    options = parseSweepArgs(args, homedir);
  } catch (error) {
    process.stderr.write(
      `sweep-tmp-scratch: ${error instanceof Error ? error.message : String(error)}\n${renderEntranceRefusal(
        {
          reason:
            "sweep-tmp-scratch entrance validation refused this invocation.",
          bypass: undefined,
          supervisorRoute:
            "Ask your supervisor for an allowed alternative invocation.",
        },
      )}\n${USAGE}`,
    );
    return 2;
  }

  const entries = await sweepScratchDirs(options);
  process.stdout.write(renderReport(entries, options));
  return 0;
}
