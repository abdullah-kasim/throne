import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RUNTIME_DATA_HOME } from "../shared-policy/runtime-data-home.ts";

export const ALPHA_AUTOSCALE_SWEEP_LOCK_PATH = path.join(
  RUNTIME_DATA_HOME,
  "locks",
  "alpha-autoscale.lock",
);
export const SWEEP_LOCK_TIME_TO_LIVE_MS = 60_000;
export const SWEEP_LOCK_RENEWAL_INTERVAL_MS = 20_000;
export const SWEEP_LOCK_RENEWAL_CUTOFF_MS = 10 * 60_000;
export const SWEEP_LOCK_LATEST_EXPIRY_MS =
  SWEEP_LOCK_RENEWAL_CUTOFF_MS + SWEEP_LOCK_TIME_TO_LIVE_MS;

export interface SweepLockHolder {
  readonly pid: number;
  readonly host: string;
  readonly token: string;
  readonly acquiredAt: number;
  readonly renewedAt: number;
}

export interface SweepLockSighting {
  readonly holder: SweepLockHolder | undefined;
  readonly renewedAgoMs: number;
}

export interface SweepLockLease {
  readonly lockPath: string;
  readonly holder: SweepLockHolder;
  isStillHeld(): Promise<boolean>;
  renew(): Promise<boolean>;
  release(): Promise<void>;
}

export type SweepLockAcquisition =
  | {
      readonly outcome: "acquired";
      readonly lease: SweepLockLease;
      readonly replaced: SweepLockSighting | undefined;
    }
  | {
      readonly outcome: "held";
      readonly lockPath: string;
      readonly sighting: SweepLockSighting | undefined;
    };

export type ScheduleSweepLockRenewal = (
  renew: () => void,
  intervalMs: number,
) => () => void;

export interface SweepLockOptions {
  readonly lockPath: string;
  readonly now?: () => number;
  readonly host?: string;
  readonly pid?: number;
  readonly isProcessRunning?: (pid: number) => boolean;
  readonly scheduleRenewal?: ScheduleSweepLockRenewal;
}

interface SweepLockSettings {
  readonly lockPath: string;
  readonly now: () => number;
  readonly host: string;
  readonly pid: number;
  readonly isProcessRunning: (pid: number) => boolean;
  readonly scheduleRenewal: ScheduleSweepLockRenewal;
}

interface LockFileReading {
  readonly bytes: string;
  readonly holder: SweepLockHolder | undefined;
  readonly modifiedAt: number;
}

export interface SweepLockInspection {
  readonly reading: LockFileReading | undefined;
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isAlreadyPresent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function renewOnAnInterval(renew: () => void, intervalMs: number): () => void {
  const timer = setInterval(renew, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

function resolveSettings(options: SweepLockOptions): SweepLockSettings {
  return {
    lockPath: options.lockPath,
    now: options.now ?? Date.now,
    host: options.host ?? os.hostname(),
    pid: options.pid ?? process.pid,
    isProcessRunning: options.isProcessRunning ?? isProcessRunning,
    scheduleRenewal: options.scheduleRenewal ?? renewOnAnInterval,
  };
}

function serializeHolder(holder: SweepLockHolder): string {
  return `${JSON.stringify(holder)}\n`;
}

function parseHolder(bytes: string): SweepLockHolder | undefined {
  try {
    const parsed = JSON.parse(bytes) as Partial<SweepLockHolder> | null;
    if (
      typeof parsed?.pid === "number" &&
      typeof parsed.host === "string" &&
      typeof parsed.token === "string" &&
      typeof parsed.acquiredAt === "number" &&
      typeof parsed.renewedAt === "number"
    ) {
      return parsed as SweepLockHolder;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function privateSiblingPath(lockPath: string, token: string, purpose: string): string {
  return `${lockPath}.${token}.${purpose}`;
}

async function readLockFile(lockPath: string): Promise<LockFileReading | undefined> {
  try {
    const [bytes, stats] = await Promise.all([readFile(lockPath, "utf8"), stat(lockPath)]);
    return { bytes, holder: parseHolder(bytes), modifiedAt: stats.mtimeMs };
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

function lastRenewedAt(reading: LockFileReading): number {
  return reading.holder?.renewedAt ?? reading.modifiedAt;
}

function isExpired(reading: LockFileReading, now: number): boolean {
  return now - lastRenewedAt(reading) >= SWEEP_LOCK_TIME_TO_LIVE_MS;
}

function isHolderGoneFromThisHost(reading: LockFileReading, settings: SweepLockSettings): boolean {
  const holder = reading.holder;
  return holder !== undefined && holder.host === settings.host && !settings.isProcessRunning(holder.pid);
}

function isFreeToTakeOver(reading: LockFileReading, settings: SweepLockSettings): boolean {
  return isExpired(reading, settings.now()) || isHolderGoneFromThisHost(reading, settings);
}

function sightingOf(reading: LockFileReading | undefined, now: number): SweepLockSighting | undefined {
  if (reading === undefined) return undefined;
  return { holder: reading.holder, renewedAgoMs: Math.max(0, now - lastRenewedAt(reading)) };
}

async function linkIfAbsent(sourcePath: string, targetPath: string): Promise<boolean> {
  try {
    await link(sourcePath, targetPath);
    return true;
  } catch (error) {
    if (isAlreadyPresent(error)) return false;
    throw error;
  }
}

async function moveIfPresent(sourcePath: string, targetPath: string): Promise<boolean> {
  try {
    await rename(sourcePath, targetPath);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

async function removeLockIfItStillMatches(
  lockPath: string,
  token: string,
  matches: (bytes: string) => boolean,
): Promise<boolean> {
  const asidePath = privateSiblingPath(lockPath, token, "aside");
  if (!(await moveIfPresent(lockPath, asidePath))) return false;
  try {
    if (matches(await readFile(asidePath, "utf8"))) return true;
    await linkIfAbsent(asidePath, lockPath);
    return false;
  } finally {
    await rm(asidePath, { force: true });
  }
}

function createLease(settings: SweepLockSettings, holder: SweepLockHolder): SweepLockLease {
  let stopRenewal = (): void => {};
  const lease: SweepLockLease = {
    lockPath: settings.lockPath,
    holder,
    async isStillHeld() {
      const current = await readLockFile(settings.lockPath);
      return (
        current?.holder?.token === holder.token && !isExpired(current, settings.now())
      );
    },
    async renew() {
      const now = settings.now();
      if (now - holder.acquiredAt >= SWEEP_LOCK_RENEWAL_CUTOFF_MS) {
        stopRenewal();
        return false;
      }
      let handle;
      try {
        handle = await open(settings.lockPath, "r+");
      } catch (error) {
        if (!isMissingFile(error)) throw error;
        stopRenewal();
        return false;
      }
      try {
        const current = parseHolder(await handle.readFile("utf8"));
        if (current?.token !== holder.token || now - current.renewedAt >= SWEEP_LOCK_TIME_TO_LIVE_MS) {
          stopRenewal();
          return false;
        }
        await handle.truncate(0);
        await handle.write(serializeHolder({ ...current, renewedAt: now }), 0);
        return true;
      } finally {
        await handle.close();
      }
    },
    async release() {
      stopRenewal();
      await removeLockIfItStillMatches(
        settings.lockPath,
        holder.token,
        (bytes) => parseHolder(bytes)?.token === holder.token,
      );
    },
  };
  const renewOrStopRenewing = async (): Promise<void> => {
    try {
      await lease.renew();
    } catch {
      stopRenewal();
    }
  };
  stopRenewal = settings.scheduleRenewal(() => {
    void renewOrStopRenewing();
  }, SWEEP_LOCK_RENEWAL_INTERVAL_MS);
  return lease;
}

async function claimLock(
  settings: SweepLockSettings,
  holder: SweepLockHolder,
  pendingPath: string,
  inspection: SweepLockInspection,
): Promise<SweepLockAcquisition> {
  const acquired = (replaced?: SweepLockSighting): SweepLockAcquisition => ({
    outcome: "acquired",
    lease: createLease(settings, holder),
    replaced,
  });
  const heldBy = (reading: LockFileReading | undefined): SweepLockAcquisition => ({
    outcome: "held",
    lockPath: settings.lockPath,
    sighting: sightingOf(reading, settings.now()),
  });

  const current = inspection.reading;
  if (current === undefined) {
    return (await linkIfAbsent(pendingPath, settings.lockPath))
      ? acquired()
      : heldBy(await readLockFile(settings.lockPath));
  }
  if (!isFreeToTakeOver(current, settings)) return heldBy(current);
  const removedTheStaleLock = await removeLockIfItStillMatches(
    settings.lockPath,
    holder.token,
    (bytes) => bytes === current.bytes,
  );
  if (removedTheStaleLock && (await linkIfAbsent(pendingPath, settings.lockPath))) {
    return acquired(sightingOf(current, settings.now()));
  }
  return heldBy(await readLockFile(settings.lockPath));
}

export async function inspectSweepLock(lockPath: string): Promise<SweepLockInspection> {
  return { reading: await readLockFile(lockPath) };
}

export async function claimSweepLock(
  options: SweepLockOptions,
  inspection: SweepLockInspection,
): Promise<SweepLockAcquisition> {
  const settings = resolveSettings(options);
  const acquiredAt = settings.now();
  const holder: SweepLockHolder = {
    pid: settings.pid,
    host: settings.host,
    token: randomUUID(),
    acquiredAt,
    renewedAt: acquiredAt,
  };
  const pendingPath = privateSiblingPath(settings.lockPath, holder.token, "pending");
  await mkdir(path.dirname(settings.lockPath), { recursive: true, mode: 0o700 });
  await writeFile(pendingPath, serializeHolder(holder), { flag: "wx", mode: 0o600 });
  try {
    return await claimLock(settings, holder, pendingPath, inspection);
  } finally {
    await rm(pendingPath, { force: true });
  }
}

export async function acquireSweepLock(options: SweepLockOptions): Promise<SweepLockAcquisition> {
  return claimSweepLock(options, await inspectSweepLock(options.lockPath));
}

function describeSecondsAgo(milliseconds: number): string {
  return `${(milliseconds / 1_000).toFixed(1)}s ago`;
}

function describeHolder(sighting: SweepLockSighting): string {
  const holder = sighting.holder;
  if (holder === undefined) {
    return `an unreadable holder record, last written ${describeSecondsAgo(sighting.renewedAgoMs)}`;
  }
  return `pid ${holder.pid} on ${holder.host}, renewed ${describeSecondsAgo(sighting.renewedAgoMs)}`;
}

export function describeHeldSweepLock(
  acquisition: Extract<SweepLockAcquisition, { outcome: "held" }>,
): string {
  const holder =
    acquisition.sighting === undefined
      ? "a holder that released it while this sweep was taking it over"
      : describeHolder(acquisition.sighting);
  return `skip: another alpha-autoscale sweep holds ${acquisition.lockPath} (${holder}); not waiting, no page sent`;
}

export function describeReplacedSweepLock(lockPath: string, replaced: SweepLockSighting): string {
  return `took over the stale alpha-autoscale lock ${lockPath} from ${describeHolder(replaced)}`;
}

export function describeLostSweepLock(lockPath: string): string {
  return `stop: this sweep no longer holds ${lockPath} (it expired or another sweep took it over); launching nothing more`;
}
