import { link, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

/** Cross-process resurrection mutex marker — same `REGENT_DIR` marker-file
 * pattern as `desired-state`/`harness`, guarding `resurrectRegent`'s
 * check-then-spawn window against a second, independent process. */
export const RESURRECT_LOCK_BASENAME = "resurrect.lock";
/**
 * A held lock older than this is treated as abandoned (holder crashed
 * mid-resurrection) and may be reclaimed by the next caller. A full
 * resurrection (herdr tab create + shell-ready wait + agent start + opening
 * prompt) normally completes in well under a minute; keep-going's own sweep
 * cadence is ~30 minutes. Five minutes is generous headroom above a normal
 * resurrection's runtime while still being a small fraction of one keep-going
 * cycle, so a genuinely wedged lock clears well before the next sweep — a
 * single crash cannot itself wedge future resurrections.
 */
export const RESURRECT_LOCK_STALE_MS = 5 * 60 * 1000;

/**
 * A unique per-claim identity token (`pid:timestamp:random`), written into
 * the lock file at claim time and checked back on release — this is what
 * lets acquire/release reason about a SPECIFIC claimed instance rather than
 * just the lock file's path (see `releaseResurrectLock`).
 */
function makeLockToken(): string {
  return `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

/**
 * Acquire the durable, cross-process resurrection lock via exclusive file
 * creation (`open(..., "wx")` — atomic at the filesystem level, unlike a
 * read-then-write check, so two processes racing to create the same lock
 * file can never both succeed). Returns the winning claim's unique token, or
 * `null` on failure to acquire — the caller passes this token back to
 * `releaseResurrectLock` so release only ever removes ITS OWN claim.
 *
 * A held-but-stale lock (see `RESURRECT_LOCK_STALE_MS`) is reclaimed via
 * `rename(lockPath, <lockPath>.stale.<token>)`, not `unlink` — rename is
 * atomic against a concurrent renamer of the SAME source path (POSIX
 * guarantees exactly one of two racing `rename` calls on the same source
 * succeeds; the loser gets `ENOENT`). But `rename` alone is still
 * PATH-keyed, not identity-keyed: it renames whatever currently sits at
 * `lockPath`, with no way to ask "is this still the same stale instance I
 * read?" — so if a first reclaimer's ENTIRE cycle (rename → claim) finishes
 * between this caller's staleness read and its own rename call, this call's
 * rename would still succeed, silently stealing the FIRST reclaimer's brand
 * new, genuinely-live lock (confirmed empirically against real concurrent OS
 * processes: a bare rename reproduces the exact double-claim, not just the
 * old unconditional `unlink`). The identity check that closes this gap:
 * read the stale file's mtime AND content through ONE open file descriptor
 * (a single `open`, `fstat`, then `readFile` on that handle — pinned to one
 * inode, so the two reads can never straddle a mutation the way two
 * separate `stat`/`readFile` calls against the path could), then — AFTER
 * renaming it aside — compare the aside file's content against what was
 * read. A match proves this rename really did carry off the SAME stale
 * instance this caller observed; a mismatch means the path had already been
 * reclaimed by someone else in the interim, so this caller restores the
 * (someone else's live) file via `link` — NOT `rename`, which would
 * silently REPLACE a legitimate claim that has since taken the path; `link`
 * fails with `EEXIST` instead, so restoration correctly backs off rather
 * than clobbering — and reports failure, exactly like losing the initial
 * `wx` race, instead of finishing the claim and destroying it.
 */
export async function acquireResurrectLock(dir: string): Promise<string | null> {
  await mkdir(dir, { recursive: true });
  const lockPath = path.join(dir, RESURRECT_LOCK_BASENAME);
  const claim = async (): Promise<string> => {
    const token = makeLockToken();
    const handle = await open(lockPath, "wx");
    try {
      await handle.writeFile(`${token}\n`);
    } finally {
      await handle.close();
    }
    return token;
  };
  try {
    return await claim();
  } catch (err) {
    if (!(err instanceof Error) || (err as NodeJS.ErrnoException).code !== "EEXIST") {
      throw err;
    }
    const readHandle = await open(lockPath, "r").catch(() => null);
    if (readHandle === null) {
      // Vanished between our failed create and this read (already reclaimed
      // or released by someone else) — nothing to reclaim right now.
      return null;
    }
    let isStale: boolean;
    let observedContent: string;
    try {
      const info = await readHandle.stat();
      isStale = Date.now() - info.mtimeMs > RESURRECT_LOCK_STALE_MS;
      observedContent = await readHandle.readFile("utf8");
    } finally {
      await readHandle.close();
    }
    if (!isStale) {
      return null;
    }
    const staleAsidePath = `${lockPath}.stale.${makeLockToken()}`;
    try {
      // Atomic: of two concurrent renames of the same `lockPath`, exactly one
      // succeeds. Only the winner may proceed past this point.
      await rename(lockPath, staleAsidePath);
    } catch (renameErr) {
      if (
        renameErr instanceof Error &&
        (renameErr as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        // Lost the rename race (or someone else already reclaimed/released
        // it) — treat exactly like a failed acquire, do not claim.
        return null;
      }
      throw renameErr;
    }
    // Winning the rename is necessary but not sufficient: confirm the file
    // we actually carried off is the SAME stale instance we read above, not
    // a fresh claim that replaced it in the gap between the read and the
    // rename. `open(..., "wx")` and `rename` are exclusivity primitives, not
    // identity primitives — this content comparison is what supplies the
    // missing identity check.
    const asideContent = await readFile(staleAsidePath, "utf8").catch(() => null);
    if (asideContent !== observedContent) {
      // Renamed away someone else's live claim by mistake — restore it, but
      // NOT via `rename`: POSIX `rename(2)` atomically REPLACES an existing
      // destination with no error, so if a third caller has since claimed
      // fresh at `lockPath` a rename-based restore would silently clobber
      // that legitimate claim. `link(2)` gives the no-clobber semantics we
      // actually need — it FAILS with `EEXIST` when the destination already
      // exists, so on `EEXIST` we correctly back off and leave the fresh
      // claim alone; only clean up our stale-aside copy either way.
      await link(staleAsidePath, lockPath).catch(() => undefined);
      await unlink(staleAsidePath).catch(() => undefined);
      return null;
    }
    await unlink(staleAsidePath).catch(() => undefined);
    return await claim().catch((retryErr) => {
      if (
        retryErr instanceof Error &&
        (retryErr as NodeJS.ErrnoException).code === "EEXIST"
      ) {
        return null;
      }
      throw retryErr;
    });
  }
}

/**
 * Release the resurrection lock — but ONLY if it still holds the exact
 * token this caller claimed with. Reads the lock file back and unlinks it
 * solely on a content match; if the content differs (someone else's claim
 * now occupies the path, including via the rename-reclaim path above), this
 * is a no-op — never an unconditional delete, so a holder whose lock was
 * reclaimed out from under it can never delete the new rightful holder's
 * live claim. Missing/unreadable is also a no-op (already reclaimed as
 * stale, or never acquired by this caller's branch).
 */
export async function releaseResurrectLock(dir: string, token: string): Promise<void> {
  const lockPath = path.join(dir, RESURRECT_LOCK_BASENAME);
  const current = await readFile(lockPath, "utf8").catch(() => null);
  if (current !== `${token}\n`) {
    return;
  }
  await unlink(lockPath).catch(() => undefined);
}
