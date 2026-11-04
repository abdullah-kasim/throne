import { lstat, readdir, realpath, statfs, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildScratchHolderIndex } from "../tmp-scratch-lifecycle/scratch-dir-holders.ts";
import {
  checkScratchDirRemovalEligibility,
  removeScratchDir,
} from "../tmp-scratch-lifecycle/remove-scratch-dir.ts";
import {
  SCRATCH_DIR_REMOVAL_OUTCOMES,
  type ScratchHolderIndex,
} from "../tmp-scratch-lifecycle/tmp-scratch-lifecycle.types.ts";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";
import { throneCacheDirectory } from "../shared-policy/throne-home.ts";

const DEFAULT_MIN_AGE_MS = 2 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const GIGABYTE_BYTES = 1_000_000_000;
const CACHE_NOTICE_FILE_NAME = "AGENTS.md";
const DIGITS_ONLY = /^\d+$/;

const USAGE =
  "Usage: sweep-tmp-scratch [--min-age-ms N] [--apply] [--tmp-root PATH] [--min-free-bytes N]\n" +
  "  --min-age-ms N      minimum entry age, in milliseconds, to be eligible " +
  `(default ${DEFAULT_MIN_AGE_MS})\n` +
  "  --apply             actually remove eligible entries; default is dry-run report only\n" +
  "  --tmp-root PATH     scratch root to scan (default /tmp; ~/tmp only with --min-free-bytes)\n" +
  "  --min-free-bytes N  cache mode: remove old files and folders, oldest first, only while\n" +
  "                      the root's disk has fewer than N bytes free, and keep an AGENTS.md\n" +
  "                      notice in the root\n";

interface SweepOptions {
  minAgeMs: number;
  apply: boolean;
  tmpRoot: string;
  minFreeBytes: number | null;
}

interface CacheSweepOptions extends SweepOptions {
  minFreeBytes: number;
}

export type FreeBytesReader = (root: string) => Promise<number>;

function help(): string {
  return `sweep-tmp-scratch — deliberate backlog sweep for /tmp campaign scratch\n\n${USAGE}`;
}

function takeFlagValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseNonNegativeInteger(flag: string, value: string): number {
  if (!DIGITS_ONLY.test(value)) {
    throw new Error(`${flag} must be a non-negative integer, got "${value}"`);
  }
  return Number(value);
}

function parseSweepArgs(args: string[]): SweepOptions {
  let minAgeMs = DEFAULT_MIN_AGE_MS;
  let apply = false;
  let tmpRoot = "/tmp";
  let minFreeBytes: number | null = null;
  const singleFlags = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--apply") {
      if (apply) throw new Error("--apply may be specified only once");
      apply = true;
      continue;
    }
    if (arg !== "--min-age-ms" && arg !== "--tmp-root" && arg !== "--min-free-bytes") {
      throw new Error(`unknown argument "${arg}"`);
    }
    if (singleFlags.has(arg)) {
      throw new Error(`${arg} may be specified only once`);
    }
    singleFlags.add(arg);
    const value = takeFlagValue(args, index, arg);
    if (arg === "--min-age-ms") minAgeMs = parseNonNegativeInteger(arg, value);
    if (arg === "--min-free-bytes") minFreeBytes = parseNonNegativeInteger(arg, value);
    if (arg === "--tmp-root") tmpRoot = value;
    index += 1;
  }

  return { minAgeMs, apply, tmpRoot, minFreeBytes };
}

type SweepEntryOutcome =
  | typeof SCRATCH_DIR_REMOVAL_OUTCOMES.REMOVED
  | typeof SCRATCH_DIR_REMOVAL_OUTCOMES.SKIPPED_LIVE
  | typeof SCRATCH_DIR_REMOVAL_OUTCOMES.SKIPPED_TOO_YOUNG;

interface SweepEntry {
  entryPath: string;
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

async function sweepEntry(
  entryPath: string,
  options: SweepOptions,
  holderIndex: ScratchHolderIndex,
): Promise<SweepEntry> {
  const result = options.apply
    ? await removeScratchDir(entryPath, options.minAgeMs, holderIndex)
    : await checkScratchDirRemovalEligibility(entryPath, options.minAgeMs, holderIndex);
  return { entryPath, outcome: result.outcome };
}

async function sweepScratchDirs(options: SweepOptions): Promise<SweepEntry[]> {
  const dirs = await scratchDirsUnder(options.tmpRoot);
  const holderIndex = await buildScratchHolderIndex();
  const entries: SweepEntry[] = [];
  for (const dirPath of dirs) {
    entries.push(await sweepEntry(dirPath, options, holderIndex));
  }
  return entries;
}

function outcomeLabel(outcome: SweepEntryOutcome, apply: boolean): string {
  if (outcome === SCRATCH_DIR_REMOVAL_OUTCOMES.REMOVED) {
    return apply ? "removed" : "would-remove";
  }
  return outcome;
}

function modeName(options: SweepOptions): string {
  return options.apply ? "apply" : "dry-run";
}

function renderEntryLines(entries: SweepEntry[], options: SweepOptions): string[] {
  return entries.map(
    (entry) => `${entry.entryPath}: ${outcomeLabel(entry.outcome, options.apply)}`,
  );
}

function renderReport(entries: SweepEntry[], options: SweepOptions): string {
  if (entries.length === 0) {
    return `sweep-tmp-scratch: no directories found under ${options.tmpRoot}\n`;
  }
  const lines = renderEntryLines(entries, options);
  lines.push(
    `sweep-tmp-scratch (${modeName(options)}): ${entries.length} directory(ies) considered`,
  );
  return `${lines.join("\n")}\n`;
}

export async function readFilesystemFreeBytes(root: string): Promise<number> {
  const filesystem = await statfs(root);
  return filesystem.bavail * filesystem.bsize;
}

function hasEnoughFreeSpace(freeBytes: number, minFreeBytes: number): boolean {
  return freeBytes >= minFreeBytes;
}

function cacheNoticeText(options: CacheSweepOptions): string {
  const days = Math.floor(options.minAgeMs / DAY_MS);
  const gigabytes = Math.floor(options.minFreeBytes / GIGABYTE_BYTES);
  return [
    "# This folder is a cache",
    "",
    "Everything in this folder is a cache and may be deleted.",
    "",
    `When the disk holding this folder has less than ${gigabytes} GB free, entries older than ${days} days are deleted,`,
    `files and folders alike, oldest first, until ${gigabytes} GB is free again. An entry's age is its own`,
    "modified time; the dates of the files inside a folder do not count. The `sweep-tmp-scratch-home`",
    "timer does the deleting by running the `sweep-tmp-scratch` command with `--min-free-bytes`.",
    "",
    `Put anything that must last under \`${path.join(throneCacheDirectory(), "<tool>")}/\`, never here.`,
    "",
    `Never delete this file (${CACHE_NOTICE_FILE_NAME}).`,
    "",
  ].join("\n");
}

function isFileAlreadyThere(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

async function ensureCacheNotice(options: CacheSweepOptions): Promise<void> {
  try {
    await writeFile(
      path.join(options.tmpRoot, CACHE_NOTICE_FILE_NAME),
      cacheNoticeText(options),
      { flag: "wx" },
    );
  } catch (error) {
    if (!isFileAlreadyThere(error)) throw error;
  }
}

async function modifiedTimeOrNull(entryPath: string): Promise<number | null> {
  try {
    return (await lstat(entryPath)).mtimeMs;
  } catch {
    return null;
  }
}

async function cacheEntriesOldestFirst(root: string): Promise<string[]> {
  const names = (await readdir(root)).filter((name) => name !== CACHE_NOTICE_FILE_NAME);
  const entries: { entryPath: string; modifiedMs: number }[] = [];
  for (const name of names) {
    const entryPath = path.join(root, name);
    const modifiedMs = await modifiedTimeOrNull(entryPath);
    if (modifiedMs !== null) entries.push({ entryPath, modifiedMs });
  }
  return entries
    .sort((left, right) => left.modifiedMs - right.modifiedMs)
    .map((entry) => entry.entryPath);
}

async function sweepCacheEntries(
  options: CacheSweepOptions,
  readFreeBytes: FreeBytesReader,
): Promise<SweepEntry[]> {
  const candidates = await cacheEntriesOldestFirst(options.tmpRoot);
  const holderIndex = await buildScratchHolderIndex();
  const entries: SweepEntry[] = [];
  for (const entryPath of candidates) {
    const entry = await sweepEntry(entryPath, options, holderIndex);
    entries.push(entry);
    if (!options.apply || entry.outcome !== SCRATCH_DIR_REMOVAL_OUTCOMES.REMOVED) continue;
    if (hasEnoughFreeSpace(await readFreeBytes(options.tmpRoot), options.minFreeBytes)) break;
  }
  return entries;
}

function renderCacheReport(
  entries: SweepEntry[],
  freeBytesAtStart: number,
  options: CacheSweepOptions,
): string {
  const header = `sweep-tmp-scratch (cache, ${modeName(options)}): ${freeBytesAtStart} bytes free under ${options.tmpRoot}, threshold ${options.minFreeBytes} bytes`;
  if (hasEnoughFreeSpace(freeBytesAtStart, options.minFreeBytes)) {
    return `${header}; nothing to do\n`;
  }
  const stopNote = options.apply
    ? "removal stopped once free space reached the threshold or the eligible entries ran out"
    : "an apply removes these oldest first and stops as soon as free space reaches the threshold, so it may remove fewer";
  const lines = renderEntryLines(entries, options);
  lines.push(`${header}; ${entries.length} entry(ies) considered; ${stopNote}`);
  return `${lines.join("\n")}\n`;
}

async function runCacheSweep(
  options: CacheSweepOptions,
  readFreeBytes: FreeBytesReader,
): Promise<string> {
  await ensureCacheNotice(options);
  const freeBytesAtStart = await readFreeBytes(options.tmpRoot);
  const entries = hasEnoughFreeSpace(freeBytesAtStart, options.minFreeBytes)
    ? []
    : await sweepCacheEntries(options, readFreeBytes);
  return renderCacheReport(entries, freeBytesAtStart, options);
}

async function resolvesToHomeScratch(tmpRoot: string, homedir: string): Promise<boolean> {
  const homeScratch = await realpath(path.join(homedir, "tmp")).catch(() => null);
  const sweptRoot = await realpath(tmpRoot).catch(() => null);
  return homeScratch !== null && sweptRoot === homeScratch;
}

export async function runSweepTmpScratch(
  args: string[],
  homedir: string = os.homedir(),
  readFreeBytes: FreeBytesReader = readFilesystemFreeBytes,
): Promise<number> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    process.stdout.write(help());
    return 0;
  }

  let options: SweepOptions;
  try {
    options = parseSweepArgs(args);
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

  const { minFreeBytes } = options;
  if (minFreeBytes !== null) {
    process.stdout.write(await runCacheSweep({ ...options, minFreeBytes }, readFreeBytes));
    return 0;
  }
  if (await resolvesToHomeScratch(options.tmpRoot, homedir)) {
    process.stderr.write(
      `sweep-tmp-scratch: --tmp-root ${options.tmpRoot} resolves to ${path.join(homedir, "tmp")}, the Lord's kept scratch, which is swept only in cache mode (--min-free-bytes)\n`,
    );
    return 2;
  }
  const entries = await sweepScratchDirs(options);
  process.stdout.write(renderReport(entries, options));
  return 0;
}
