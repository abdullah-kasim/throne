import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  RegentQueueItemStatus,
  type RegentQueueStore,
} from "./regent-queue.store.ts";

// One-way import of the Regent's historical `QUEUE.md` (and its archive)
// into the SQLite store. This module never edits, deletes, or truncates
// either source file — it only reads them and writes rows.
//
// ITEM BOUNDARY — reused, not reinvented, from two existing precedents:
//   - `queue-automark.ts` treats a top-level `- ` line carrying a leading
//     emoji status marker (🟢/🔴/⚪/🟡/✅/…) as the start of one real
//     objective bullet — narrative bullets with no such marker are prose,
//     not items (verified against the real file: 25 of 83 top-level bullets
//     carry a marker; the rest are plain narrative).
//   - `trim-queue-runtime.ts` treats a top-level `# ` heading (never `## `)
//     as the start of one archival block.
// Both shapes coexist in the real file (a short bulleted "open objectives"
// list, plus thousands of lines of `# `-headed historical findings), so this
// migration recognizes EITHER as a block start and lets the other one — an
// emoji bullet, a `## ` subsection, plain prose — ride along as part of the
// enclosing block's body. This guarantees every line of the source lands in
// exactly one block: nothing is dropped, silently or otherwise.
//
// CORRECTIONS-WIN: `QUEUE.md` is written append-only, so a correction is
// always textually AFTER what it corrects. Within one block (the common
// case — see the `⚠️ REGENT CORRECTION` example inline under `DISTPUB`),
// the full body — original text and its correction — is preserved verbatim
// in the same row, so nothing is discarded and a reader sees both. Where a
// block's own resolution marker conflicts with a later marker appearing
// deeper in the same block's text (e.g. an item opened `🔴` whose body later
// states `✅` once resolved), the LAST resolution marker found in the block
// decides the stored status — the append-only convention makes "last"
// exactly "most recent", with no need to classify prose as "the correction"
// versus "the original". A correction that supersedes a DIFFERENT, earlier
// block (e.g. `THEMEFLOOR` superseding an earlier tailwind ruling) is left as
// two separate rows, each carrying its own full text — inventing a
// cross-block link is a guess this migration does not make; the text itself
// names what it supersedes.
//
// A migrated item's `agentName`/`targetRepo`/`baseCommit`/`deliveryCommit`
// are always left null — those fields are populated only by a real future
// lifecycle write-back (create-agent/reap-agent), never guessed from prose.

const TOP_LEVEL_HEADING_PREFIX = "# ";
const SUBHEADING_PREFIX = "## ";
/** The one fixed structural divider `trim-queue-runtime.ts` also excludes from block-hood. */
const TITLE_DIVIDER = "# Regent's objective queue";

/** Matches a single emoji/pictographic token — queue-automark's own leading
 *  status-marker convention — immediately after `- `. */
const EMOJI_TOKEN_PATTERN = /^[\p{Extended_Pictographic}️]+$/u;
const LANDED_MARKER = "✅";
const ABANDONED_MARKERS = ["ABANDONED", "CANCELLED", "SUPERSEDED — DROPPED"];

/** A short caps-and-hyphens identifier immediately after the optional emoji
 *  marker and optional bold-open, e.g. `GBM-10`, `THEMEFLOOR`, `BLK`. Used
 *  only to populate `objectiveCode`; never used to guess agent identity. */
const LEADING_CODE_PATTERN =
  /^(?:[\p{Extended_Pictographic}️]+\s+)?\*{0,2}([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*)\b/u;

function isTopLevelHeading(line: string): boolean {
  return (
    line.startsWith(TOP_LEVEL_HEADING_PREFIX) &&
    !line.startsWith(SUBHEADING_PREFIX) &&
    line.trimEnd() !== TITLE_DIVIDER
  );
}

function isEmojiMarkedBullet(line: string): boolean {
  if (!line.startsWith("- ")) return false;
  const token = /^\S+/.exec(line.slice(2))?.[0];
  return token !== undefined && EMOJI_TOKEN_PATTERN.test(token);
}

function isBlockStart(line: string): boolean {
  return isTopLevelHeading(line) || isEmojiMarkedBullet(line);
}

export interface ParsedBlock {
  readonly lines: string[];
  readonly isPreamble: boolean;
}

/** Splits `text` into blocks at every block-start line, per the boundary
 *  rule documented above. Any leading content before the first block-start
 *  becomes one "preamble" block, so a source file with no recognizable
 *  block-start line still round-trips instead of vanishing silently. */
export function splitIntoBlocks(text: string): ParsedBlock[] {
  const lines = text.split("\n");
  const blocks: ParsedBlock[] = [];
  let current: string[] = [];
  let sawBlockStart = false;

  const flush = () => {
    if (current.length === 0) return;
    blocks.push({ lines: current, isPreamble: !sawBlockStart });
    current = [];
  };

  for (const line of lines) {
    if (isBlockStart(line)) {
      flush();
      sawBlockStart = true;
    }
    current.push(line);
  }
  flush();
  return blocks;
}

function extractObjectiveCode(headLine: string): string | undefined {
  const withoutBulletPrefix = headLine.startsWith("- ")
    ? headLine.slice(2)
    : headLine.replace(/^#+\s*/, "");
  const match = LEADING_CODE_PATTERN.exec(withoutBulletPrefix);
  const code = match?.[1];
  // A bare word like "THE" or "A" is not a real objective identifier; require
  // either a hyphen (GBM-10) or length >= 3 (BLK, DUP is 3, THEMEFLOOR).
  if (code === undefined) return undefined;
  if (!code.includes("-") && code.length < 3) return undefined;
  return code.toLowerCase();
}

function deriveStatus(blockText: string): RegentQueueItemStatus {
  let status: RegentQueueItemStatus = RegentQueueItemStatus.Open;
  for (const line of blockText.split("\n")) {
    if (ABANDONED_MARKERS.some((marker) => line.includes(marker))) {
      status = RegentQueueItemStatus.Abandoned;
    } else if (line.includes(LANDED_MARKER)) {
      status = RegentQueueItemStatus.Complete;
    }
  }
  return status;
}

/** True when the block carries no resolution marker anywhere — its status
 *  could not be determined and was defaulted to open rather than guessed. */
function statusIsUndetermined(blockText: string): boolean {
  return (
    !blockText.includes(LANDED_MARKER) &&
    !ABANDONED_MARKERS.some((marker) => blockText.includes(marker))
  );
}

const MIGRATION_NOTE_PREAMBLE =
  "[migration note: preamble content preceding the first recognizable objective/heading — imported verbatim, status not applicable, defaulted to open]";
const MIGRATION_NOTE_UNDETERMINED =
  "[migration note: no ✅/abandoned resolution marker found in this block — status could not be determined and was defaulted to open rather than guessed]";

/** Appends the appropriate migration note (if any) to a block's trimmed text,
 *  matching the exact `\n\n`-joined shape both the one-shot and incremental
 *  importers write to the store. */
function buildImportedBody(
  blockText: string,
  isPreamble: boolean,
  undetermined: boolean,
): string {
  const note = isPreamble
    ? MIGRATION_NOTE_PREAMBLE
    : undetermined
      ? MIGRATION_NOTE_UNDETERMINED
      : undefined;
  return note === undefined ? blockText : `${blockText}\n\n${note}`;
}

/** Reverses `buildImportedBody`: recovers the original trimmed block text
 *  from a stored row's body, so a previously-imported row (however it was
 *  imported) can be re-hashed and compared against freshly parsed blocks. */
function stripImportedNote(body: string): string {
  for (const note of [MIGRATION_NOTE_PREAMBLE, MIGRATION_NOTE_UNDETERMINED]) {
    const suffix = `\n\n${note}`;
    if (body.endsWith(suffix)) return body.slice(0, -suffix.length);
  }
  return body;
}

export interface MigrationReport {
  readonly imported: number;
  readonly skipped: number;
  readonly skippedReasons: string[];
  readonly sourceFiles: string[];
}

/** Fixed id of the marker row this migration writes as its very last insert,
 *  once every block from every source file imported cleanly. Its presence is
 *  the refusal gate on a second run — see `migrateQueueMarkdownToStore`. */
export const MIGRATION_MARKER_ID = "__regent_queue_migration_marker__";

export class QueueMigrationAlreadyRanError extends Error {
  readonly name = "QueueMigrationAlreadyRanError";
  constructor() {
    super(
      "the Regent queue markdown migration already ran once (marker row " +
        `"${MIGRATION_MARKER_ID}" is present) — it is one-way and refuses to ` +
        "import a second time rather than risk duplicate or conflicting rows",
    );
  }
}

interface SourceFile {
  readonly path: string;
  readonly tag: string;
}

function importSource(
  source: SourceFile,
  store: RegentQueueStore,
  usedObjectiveCodes: Set<string>,
  report: { imported: number; skipped: number; skippedReasons: string[] },
): void {
  let text: string;
  try {
    text = readFileSync(source.path, "utf8");
  } catch (error) {
    report.skipped += 1;
    report.skippedReasons.push(
      `${source.path}: could not read source file (${error instanceof Error ? error.message : String(error)})`,
    );
    return;
  }

  const blocks = splitIntoBlocks(text);
  blocks.forEach((block, index) => {
    const blockText = block.lines.join("\n").trim();
    if (blockText.length === 0) {
      report.skipped += 1;
      report.skippedReasons.push(`${source.tag}#${index}: empty block, nothing to import`);
      return;
    }

    const headLine = block.lines[0] ?? "";
    let objectiveCode = block.isPreamble ? undefined : extractObjectiveCode(headLine);
    if (objectiveCode !== undefined) {
      if (usedObjectiveCodes.has(objectiveCode)) {
        // A code already claimed by an earlier block this run — never silently
        // collide with the store's unique index; import this block without one.
        objectiveCode = undefined;
      } else {
        usedObjectiveCodes.add(objectiveCode);
      }
    }

    const status = block.isPreamble ? RegentQueueItemStatus.Open : deriveStatus(blockText);
    const undetermined = !block.isPreamble && statusIsUndetermined(blockText);
    const body = buildImportedBody(blockText, block.isPreamble, undetermined);

    store.insertItem({
      id: `migrate-${source.tag}-${String(index).padStart(4, "0")}`,
      objectiveCode: objectiveCode ?? null,
      status,
      body,
    });
    report.imported += 1;
  });
}

/**
 * One-way import of `queueMarkdownPath` (required) and `archiveMarkdownPath`
 * (optional — a missing archive is reported as skipped, not fatal) into
 * `store`. Refuses on a second run once the marker row is present (see
 * `QueueMigrationAlreadyRanError`); never mutates either source file.
 */
export function migrateQueueMarkdownToStore(
  queueMarkdownPath: string,
  archiveMarkdownPath: string | undefined,
  store: RegentQueueStore,
): MigrationReport {
  if (store.readItem(MIGRATION_MARKER_ID) !== undefined) {
    throw new QueueMigrationAlreadyRanError();
  }

  const sources: SourceFile[] = [{ path: queueMarkdownPath, tag: "queue" }];
  if (archiveMarkdownPath !== undefined) {
    sources.push({ path: archiveMarkdownPath, tag: "archive" });
  }

  const report = { imported: 0, skipped: 0, skippedReasons: [] as string[] };
  const usedObjectiveCodes = new Set<string>();
  for (const source of sources) {
    importSource(source, store, usedObjectiveCodes, report);
  }

  store.insertItem({
    id: MIGRATION_MARKER_ID,
    objectiveCode: null,
    status: RegentQueueItemStatus.Complete,
    body:
      `Regent queue markdown migration completed. Imported ${report.imported} item(s) ` +
      `from ${sources.map((s) => s.path).join(", ")}. This row exists only to refuse a ` +
      "second run; it is not a real queue objective.",
  });

  return { ...report, sourceFiles: sources.map((s) => s.path) };
}

/** Stable content identity for one parsed block, independent of which run or
 *  which id scheme first imported it — the sole predicate `incrementallyImportQueueMarkdown`
 *  uses to decide "is this block already in the store?", applied identically
 *  on the first run and every re-run. */
export function blockContentHash(blockText: string): string {
  return createHash("sha256").update(blockText).digest("hex");
}

/** Exact block accounting for one source file: every parsed, non-empty block
 *  is either a heading block, an emoji-marked bullet block, or a preamble
 *  block, and is either already present in the store or newly imported —
 *  nothing is dropped or double-counted. */
export interface IncrementalImportSourceReport {
  readonly path: string;
  readonly tag: string;
  readonly headingBlocks: number;
  readonly emojiBulletBlocks: number;
  readonly preambleBlocks: number;
  readonly alreadyPresent: number;
  readonly imported: number;
}

export interface IncrementalImportReport {
  readonly imported: number;
  readonly alreadyPresent: number;
  readonly sources: IncrementalImportSourceReport[];
  /** `SELECT COUNT(*)`-equivalent total row count in the store after this run. */
  readonly totalStoreRowCount: number;
}

function collectExistingObjectiveCodes(store: RegentQueueStore): Set<string> {
  const all = store.readAll();
  if (all.state !== "items") return new Set();
  return new Set(
    all.items
      .map((item) => item.objectiveCode)
      .filter((code): code is string => code !== null),
  );
}

/** Content hashes of every row already in the store (any prior import path),
 *  recovered by stripping the known migration-note suffix back off each
 *  row's body — this is what lets a re-run recognize a block regardless of
 *  whether it was originally imported by the one-shot or incremental path. */
function collectImportedContentHashes(store: RegentQueueStore): Set<string> {
  const all = store.readAll();
  if (all.state !== "items") return new Set();
  const hashes = new Set<string>();
  for (const item of all.items) {
    if (item.id === MIGRATION_MARKER_ID) continue;
    hashes.add(blockContentHash(stripImportedNote(item.body)));
  }
  return hashes;
}

function importSourceIncrementally(
  source: SourceFile,
  store: RegentQueueStore,
  usedObjectiveCodes: Set<string>,
  importedContentHashes: Set<string>,
): IncrementalImportSourceReport {
  const text = readFileSync(source.path, "utf8");
  const blocks = splitIntoBlocks(text);

  const counts = {
    headingBlocks: 0,
    emojiBulletBlocks: 0,
    preambleBlocks: 0,
    alreadyPresent: 0,
    imported: 0,
  };

  for (const block of blocks) {
    const blockText = block.lines.join("\n").trim();
    if (blockText.length === 0) continue;

    const headLine = block.lines[0] ?? "";
    if (block.isPreamble) {
      counts.preambleBlocks += 1;
    } else if (isEmojiMarkedBullet(headLine)) {
      counts.emojiBulletBlocks += 1;
    } else {
      counts.headingBlocks += 1;
    }

    const hash = blockContentHash(blockText);
    if (importedContentHashes.has(hash)) {
      counts.alreadyPresent += 1;
      continue;
    }

    let objectiveCode = block.isPreamble ? undefined : extractObjectiveCode(headLine);
    if (objectiveCode !== undefined) {
      if (usedObjectiveCodes.has(objectiveCode)) {
        objectiveCode = undefined;
      } else {
        usedObjectiveCodes.add(objectiveCode);
      }
    }

    const status = block.isPreamble ? RegentQueueItemStatus.Open : deriveStatus(blockText);
    const undetermined = !block.isPreamble && statusIsUndetermined(blockText);
    const body = buildImportedBody(blockText, block.isPreamble, undetermined);

    store.insertItem({
      id: `queue-content-${hash}`,
      objectiveCode: objectiveCode ?? null,
      status,
      body,
    });
    importedContentHashes.add(hash);
    counts.imported += 1;
  }

  return { path: source.path, tag: source.tag, ...counts };
}

/**
 * Re-runnable, idempotent sibling of `migrateQueueMarkdownToStore`: imports
 * every block from `queueMarkdownPath` (and `archiveMarkdownPath`, if given)
 * that is not already present in `store` by content hash, and leaves
 * everything already imported untouched — by either this function or the
 * one-shot migration. Never throws on a prior migration marker; safe to call
 * repeatedly, including immediately before a final cutover to absorb
 * whatever was written since the last run.
 */
export function incrementallyImportQueueMarkdown(
  queueMarkdownPath: string,
  archiveMarkdownPath: string | undefined,
  store: RegentQueueStore,
): IncrementalImportReport {
  const sources: SourceFile[] = [{ path: queueMarkdownPath, tag: "queue" }];
  if (archiveMarkdownPath !== undefined) {
    sources.push({ path: archiveMarkdownPath, tag: "archive" });
  }

  const usedObjectiveCodes = collectExistingObjectiveCodes(store);
  const importedContentHashes = collectImportedContentHashes(store);
  const sourceReports = sources.map((source) =>
    importSourceIncrementally(source, store, usedObjectiveCodes, importedContentHashes),
  );

  const totalStoreRows = store.readAll();
  const totalStoreRowCount = totalStoreRows.state === "items" ? totalStoreRows.items.length : 0;

  return {
    imported: sourceReports.reduce((n, r) => n + r.imported, 0),
    alreadyPresent: sourceReports.reduce((n, r) => n + r.alreadyPresent, 0),
    sources: sourceReports,
    totalStoreRowCount,
  };
}
