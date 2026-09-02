import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export interface AtomicMkdirLockOptions {
  readonly lockPath: string;
  readonly holder: string;
  readonly staleAfterMs?: number;
  readonly retryMs?: number;
  readonly attempts?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly log?: (message: string) => void;
}

interface LockRecord {
  readonly holder: string;
  readonly acquiredAt: number;
  readonly token: string;
}

interface StaleClaimRecord {
  readonly acquiredAt: number;
  readonly token: string;
}

const RECORD_FILE = "holder.json";

function staleClaimPath(lockPath: string): string {
  return `${lockPath}.stale-claim`;
}

async function staleClaimOwner(lockPath: string): Promise<string | undefined> {
  try {
    const body = await readFile(staleClaimPath(lockPath), "utf8");
    return parseStaleClaimRecord(body)?.token ?? body;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function tryClaimStaleReclamation(
  lockPath: string,
  token: string,
  acquiredAt: number,
): Promise<boolean> {
  let claim;
  try {
    claim = await open(staleClaimPath(lockPath), "wx");
    await claim.writeFile(JSON.stringify({ acquiredAt, token }), "utf8");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await claim?.close();
  }
}

function parseStaleClaimRecord(body: string): StaleClaimRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as StaleClaimRecord).acquiredAt === "number" &&
      typeof (parsed as StaleClaimRecord).token === "string"
    ) {
      return parsed as StaleClaimRecord;
    }
  } catch {}
  return undefined;
}

async function reapExpiredStaleClaim(
  lockPath: string,
  claimToken: string,
  now: number,
  staleAfterMs: number,
): Promise<boolean> {
  const claimPath = staleClaimPath(lockPath);
  let acquiredAt: number;
  try {
    const body = await readFile(claimPath, "utf8");
    acquiredAt =
      parseStaleClaimRecord(body)?.acquiredAt ??
      (await stat(claimPath)).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  if (now - acquiredAt < staleAfterMs) return false;

  const ownedClaimPath = `${claimPath}.stale-${claimToken}`;
  try {
    await rename(claimPath, ownedClaimPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  await rm(ownedClaimPath, { force: true });
  return true;
}

async function releaseStaleReclamationClaim(
  lockPath: string,
  token: string,
): Promise<void> {
  if ((await staleClaimOwner(lockPath)) === token) {
    await rm(staleClaimPath(lockPath), { force: true });
  }
}

function parseRecord(body: string): LockRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as LockRecord).holder === "string" &&
      typeof (parsed as LockRecord).acquiredAt === "number" &&
      typeof (parsed as LockRecord).token === "string"
    ) {
      return parsed as LockRecord;
    }
  } catch {
    // A crashed writer can leave no usable record; directory mtime remains
    // the conservative age source.
  }
  return undefined;
}

async function readLockRecord(
  lockPath: string,
): Promise<LockRecord | undefined> {
  try {
    return parseRecord(
      await readFile(path.join(lockPath, RECORD_FILE), "utf8"),
    );
  } catch {
    return undefined;
  }
}

async function staleLockIdentity(
  lockPath: string,
  now: number,
  staleAfterMs: number,
): Promise<{ holder: string; ageMs: number } | undefined> {
  const record = await readLockRecord(lockPath);
  try {
    const acquiredAt = record?.acquiredAt ?? (await stat(lockPath)).mtimeMs;
    const ageMs = now - acquiredAt;
    return ageMs >= staleAfterMs
      ? { holder: record?.holder ?? "<unknown>", ageMs }
      : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function claimStaleLockInstance(
  lockPath: string,
  claimToken: string,
): Promise<string | undefined> {
  const claimedPath = `${lockPath}.stale-${claimToken}`;
  try {
    await rename(lockPath, claimedPath);
    return claimedPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * The court's single atomic-mkdir lock primitive. An optional TTL is an
 * unconditional age bound: there is deliberately no heartbeat, renewal, or
 * holder-liveness exception. The returned release only removes the lock when
 * its random token still owns it, so a stale holder cannot erase a successor.
 */
export async function acquireAtomicMkdirLock(
  options: AtomicMkdirLockOptions,
): Promise<() => Promise<void>> {
  const retryMs = options.retryMs ?? 10;
  const attempts = options.attempts ?? 500;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const token = randomUUID();
  let ownsStaleClaim = false;

  await mkdir(path.dirname(options.lockPath), { recursive: true });
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await mkdir(options.lockPath);
      const claimOwner = await staleClaimOwner(options.lockPath);
      if (claimOwner !== undefined && claimOwner !== token) {
        const reaped =
          options.staleAfterMs !== undefined &&
          (await reapExpiredStaleClaim(
            options.lockPath,
            token,
            now(),
            options.staleAfterMs,
          ));
        if (!reaped) {
          await rm(options.lockPath, { recursive: true, force: true });
          await sleep(retryMs);
          continue;
        }
      }
      const record: LockRecord = {
        holder: options.holder,
        acquiredAt: now(),
        token,
      };
      try {
        await writeFile(
          path.join(options.lockPath, RECORD_FILE),
          JSON.stringify(record),
          "utf8",
        );
      } catch (error) {
        await rm(options.lockPath, { recursive: true, force: true });
        throw error;
      }
      if (ownsStaleClaim) {
        await releaseStaleReclamationClaim(options.lockPath, token);
        ownsStaleClaim = false;
      }
      return async (): Promise<void> => {
        const current = await readLockRecord(options.lockPath);
        if (current?.token === token) {
          await rm(options.lockPath, { recursive: true, force: true });
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (options.staleAfterMs !== undefined) {
        const stale = await staleLockIdentity(
          options.lockPath,
          now(),
          options.staleAfterMs,
        );
        if (stale !== undefined) {
          ownsStaleClaim = await tryClaimStaleReclamation(
            options.lockPath,
            token,
            now(),
          );
          if (!ownsStaleClaim) {
            await sleep(retryMs);
            continue;
          }
          const claimedStale = await staleLockIdentity(
            options.lockPath,
            now(),
            options.staleAfterMs,
          );
          if (claimedStale === undefined) {
            await releaseStaleReclamationClaim(options.lockPath, token);
            ownsStaleClaim = false;
            continue;
          }
          const claimedPath = await claimStaleLockInstance(
            options.lockPath,
            token,
          );
          if (claimedPath === undefined) {
            await releaseStaleReclamationClaim(options.lockPath, token);
            ownsStaleClaim = false;
            continue;
          }
          options.log?.(
            `BREAKING STALE LOCK ${options.lockPath}: previous holder ` +
              `"${claimedStale.holder}", age ${claimedStale.ageMs}ms\n`,
          );
          await rm(claimedPath, { recursive: true, force: true });
          continue;
        }
      }
      await sleep(retryMs);
    }
  }
  if (ownsStaleClaim) {
    await releaseStaleReclamationClaim(options.lockPath, token);
  }
  throw new Error(`atomic mkdir lock timed out: ${options.lockPath}`);
}
