import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, readFile, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import { test } from "node:test";
import {
  SWEEP_LOCK_LATEST_EXPIRY_MS,
  SWEEP_LOCK_RENEWAL_CUTOFF_MS,
  SWEEP_LOCK_RENEWAL_INTERVAL_MS,
  SWEEP_LOCK_TIME_TO_LIVE_MS,
  acquireSweepLock,
  claimSweepLock,
  describeHeldSweepLock,
  inspectSweepLock,
  type SweepLockAcquisition,
  type SweepLockHolder,
  type SweepLockLease,
  type SweepLockOptions,
} from "./alpha-autoscale-sweep-lock.ts";
import { uniqueTestSweepLockPath } from "./alpha-autoscale-sweep-lock-test-fixtures.ts";

interface FakeClock {
  now: number;
}

interface ScheduledRenewal {
  renew: (() => void) | undefined;
  intervalMs: number | undefined;
  stopped: boolean;
}

function withFakeClock(lockPath: string, clock: FakeClock, renewal?: ScheduledRenewal): SweepLockOptions {
  return {
    lockPath,
    now: () => clock.now,
    scheduleRenewal: (renew, intervalMs) => {
      if (renewal !== undefined) {
        renewal.renew = renew;
        renewal.intervalMs = intervalMs;
      }
      return () => {
        if (renewal !== undefined) renewal.stopped = true;
      };
    },
  };
}

function leaseOf(acquisition: SweepLockAcquisition): SweepLockLease {
  assert.equal(acquisition.outcome, "acquired", "expected the lock to be acquired");
  return (acquisition as Extract<SweepLockAcquisition, { outcome: "acquired" }>).lease;
}

function heldOf(acquisition: SweepLockAcquisition): Extract<SweepLockAcquisition, { outcome: "held" }> {
  assert.equal(acquisition.outcome, "held", "expected the lock to be held by someone else");
  return acquisition as Extract<SweepLockAcquisition, { outcome: "held" }>;
}

async function recordedHolder(lockPath: string): Promise<SweepLockHolder> {
  return JSON.parse(await readFile(lockPath, "utf8")) as SweepLockHolder;
}

async function writeHolder(lockPath: string, holder: SweepLockHolder): Promise<void> {
  await writeFile(lockPath, `${JSON.stringify(holder)}\n`);
}

async function lockFileExists(lockPath: string): Promise<boolean> {
  try {
    await access(lockPath);
    return true;
  } catch {
    return false;
  }
}

async function pidThatHasExited(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""]);
  const exitCode = await new Promise((resolve) => child.once("close", resolve));
  assert.equal(exitCode, 0);
  return child.pid!;
}

test("a free sweep lock is acquired and records the holder's pid, host, acquired-at and renewed-at", async () => {
  const lockPath = uniqueTestSweepLockPath();
  const clock = { now: 1_000_000 };

  const lease = leaseOf(await acquireSweepLock(withFakeClock(lockPath, clock)));

  const holder = await recordedHolder(lockPath);
  assert.equal(holder.pid, process.pid);
  assert.equal(holder.host, os.hostname());
  assert.equal(holder.acquiredAt, 1_000_000);
  assert.equal(holder.renewedAt, 1_000_000);
  assert.equal(holder.token, lease.holder.token);
  assert.equal(await lease.isStillHeld(), true);
  await lease.release();
  assert.equal(await lockFileExists(lockPath), false);
});

test("a held sweep lock is skipped at once, naming the holder's pid and how long ago it renewed", async () => {
  const lockPath = uniqueTestSweepLockPath();
  const clock = { now: 1_000_000 };
  const holderLease = leaseOf(await acquireSweepLock(withFakeClock(lockPath, clock)));
  clock.now += 7_000;

  const contender = heldOf(await acquireSweepLock(withFakeClock(lockPath, clock)));

  assert.equal(contender.sighting?.holder?.pid, process.pid);
  assert.equal(contender.sighting?.renewedAgoMs, 7_000);
  assert.match(
    describeHeldSweepLock(contender),
    new RegExp(`^skip: another alpha-autoscale sweep holds .* \\(pid ${process.pid} on .*, renewed 7\\.0s ago\\); not waiting, no page sent$`),
  );
  assert.equal((await recordedHolder(lockPath)).token, holderLease.holder.token);
  await holderLease.release();
});

test("the holder renews every 20 seconds, so a contender still finds the lock held past its first 60 seconds", async () => {
  const lockPath = uniqueTestSweepLockPath();
  const clock = { now: 1_000_000 };
  const renewal: ScheduledRenewal = { renew: undefined, intervalMs: undefined, stopped: false };
  const lease = leaseOf(await acquireSweepLock(withFakeClock(lockPath, clock, renewal)));
  assert.equal(renewal.intervalMs, SWEEP_LOCK_RENEWAL_INTERVAL_MS);
  assert.equal(SWEEP_LOCK_RENEWAL_INTERVAL_MS, 20_000);

  for (let renewals = 1; renewals <= 3; renewals += 1) {
    clock.now += SWEEP_LOCK_RENEWAL_INTERVAL_MS;
    assert.equal(await lease.renew(), true);
  }
  assert.equal((await recordedHolder(lockPath)).renewedAt, 1_060_000);
  clock.now = 1_000_000 + SWEEP_LOCK_TIME_TO_LIVE_MS + 30_000;

  const contender = heldOf(await acquireSweepLock(withFakeClock(lockPath, clock)));
  assert.equal(contender.sighting?.renewedAgoMs, 30_000);
  assert.equal(await lease.isStillHeld(), true);
  await lease.release();
  assert.equal(renewal.stopped, true);
});

test("a sweep lock not renewed for 60 seconds expires and a contender takes it over", async () => {
  const lockPath = uniqueTestSweepLockPath();
  const clock = { now: 1_000_000 };
  const firstLease = leaseOf(await acquireSweepLock(withFakeClock(lockPath, clock)));
  assert.equal(SWEEP_LOCK_TIME_TO_LIVE_MS, 60_000);

  clock.now = 1_000_000 + SWEEP_LOCK_TIME_TO_LIVE_MS - 1;
  heldOf(await acquireSweepLock(withFakeClock(lockPath, clock)));
  assert.equal(await firstLease.isStillHeld(), true);

  clock.now = 1_000_000 + SWEEP_LOCK_TIME_TO_LIVE_MS;
  assert.equal(await firstLease.isStillHeld(), false);
  const takeover = await acquireSweepLock(withFakeClock(lockPath, clock));
  const secondLease = leaseOf(takeover);
  assert.equal(takeover.outcome === "acquired" && takeover.replaced?.holder?.token, firstLease.holder.token);
  assert.equal((await recordedHolder(lockPath)).token, secondLease.holder.token);
  assert.equal(await firstLease.renew(), false, "an expired lock is never revived by its old holder");
  assert.equal((await recordedHolder(lockPath)).token, secondLease.holder.token);
  await secondLease.release();
});

test("renewal stops for good 10 minutes after acquisition, so a live but stuck holder loses the lock by 11 minutes", async () => {
  const lockPath = uniqueTestSweepLockPath();
  const acquiredAt = 1_000_000;
  const clock = { now: acquiredAt };
  const renewal: ScheduledRenewal = { renew: undefined, intervalMs: undefined, stopped: false };
  const lease = leaseOf(await acquireSweepLock(withFakeClock(lockPath, clock, renewal)));
  assert.equal(SWEEP_LOCK_RENEWAL_CUTOFF_MS, 600_000);

  let lastSuccessfulRenewalAt = acquiredAt;
  while (clock.now - acquiredAt < SWEEP_LOCK_RENEWAL_CUTOFF_MS + SWEEP_LOCK_RENEWAL_INTERVAL_MS) {
    clock.now += SWEEP_LOCK_RENEWAL_INTERVAL_MS;
    const renewed = await lease.renew();
    assert.equal(renewed, clock.now - acquiredAt < SWEEP_LOCK_RENEWAL_CUTOFF_MS, `renewal at +${clock.now - acquiredAt}ms`);
    if (renewed) lastSuccessfulRenewalAt = clock.now;
  }
  assert.equal(renewal.stopped, true);
  assert.equal(lastSuccessfulRenewalAt - acquiredAt, SWEEP_LOCK_RENEWAL_CUTOFF_MS - SWEEP_LOCK_RENEWAL_INTERVAL_MS);

  clock.now = lastSuccessfulRenewalAt + SWEEP_LOCK_TIME_TO_LIVE_MS - 1;
  heldOf(await acquireSweepLock(withFakeClock(lockPath, clock)));

  clock.now = lastSuccessfulRenewalAt + SWEEP_LOCK_TIME_TO_LIVE_MS;
  assert.ok(clock.now - acquiredAt <= SWEEP_LOCK_LATEST_EXPIRY_MS);
  assert.equal(SWEEP_LOCK_LATEST_EXPIRY_MS, 11 * 60_000);
  const successor = leaseOf(await acquireSweepLock(withFakeClock(lockPath, clock)));
  assert.equal(await lease.isStillHeld(), false);
  await successor.release();
});

test("a sweep lock whose pid is not running on this host is taken over at once, while a pid on another host is left alone", async () => {
  const lockPath = uniqueTestSweepLockPath();
  const clock = { now: 1_000_000 };
  const exitedPid = await pidThatHasExited();
  const freshRecord = { token: "exited-holder", acquiredAt: clock.now, renewedAt: clock.now };

  await writeHolder(lockPath, { ...freshRecord, pid: exitedPid, host: "some-other-host" });
  heldOf(await acquireSweepLock(withFakeClock(lockPath, clock)));

  await writeHolder(lockPath, { ...freshRecord, pid: exitedPid, host: os.hostname() });
  const takeover = await acquireSweepLock(withFakeClock(lockPath, clock));
  const lease = leaseOf(takeover);
  assert.equal(takeover.outcome === "acquired" && takeover.replaced?.holder?.pid, exitedPid);
  assert.equal((await recordedHolder(lockPath)).pid, process.pid);
  await lease.release();
});

test("an unreadable lock record counts from its last write: fresh is held, older than 60 seconds is taken over", async () => {
  const lockPath = uniqueTestSweepLockPath();
  await writeFile(lockPath, "{\"pid\":");
  const fresh = heldOf(await acquireSweepLock({ lockPath }));
  assert.equal(fresh.sighting?.holder, undefined);
  assert.match(describeHeldSweepLock(fresh), /an unreadable holder record, last written \d+\.\ds ago/);

  const longAgo = new Date(Date.now() - SWEEP_LOCK_TIME_TO_LIVE_MS - 5_000);
  await utimes(lockPath, longAgo, longAgo);
  const lease = leaseOf(await acquireSweepLock({ lockPath }));
  await lease.release();
});

test("two contenders taking over the same stale sweep lock: exactly one wins, every round", async () => {
  const rounds = 200;
  for (let round = 0; round < rounds; round += 1) {
    const lockPath = uniqueTestSweepLockPath();
    const staleAt = Date.now() - SWEEP_LOCK_TIME_TO_LIVE_MS - 1_000;
    await writeHolder(lockPath, {
      pid: process.pid,
      host: os.hostname(),
      token: `stale-${round}`,
      acquiredAt: staleAt,
      renewedAt: staleAt,
    });

    const outcomes = await Promise.all([acquireSweepLock({ lockPath }), acquireSweepLock({ lockPath })]);

    const winners = outcomes.filter((outcome) => outcome.outcome === "acquired");
    assert.equal(winners.length, 1, `round ${round}: ${outcomes.map((outcome) => outcome.outcome).join(", ")}`);
    const winningLease = leaseOf(winners[0]!);
    assert.equal((await recordedHolder(lockPath)).token, winningLease.holder.token);
    await winningLease.release();
  }
});

test("two contenders that both saw the same stale sweep lock: the one that claims second loses to the first", async () => {
  const lockPath = uniqueTestSweepLockPath();
  const staleAt = Date.now() - SWEEP_LOCK_TIME_TO_LIVE_MS - 1_000;
  await writeHolder(lockPath, {
    pid: process.pid,
    host: os.hostname(),
    token: "stale",
    acquiredAt: staleAt,
    renewedAt: staleAt,
  });
  const firstLook = await inspectSweepLock(lockPath);
  const secondLook = await inspectSweepLock(lockPath);

  const firstClaim = await claimSweepLock({ lockPath }, firstLook);
  const secondClaim = await claimSweepLock({ lockPath }, secondLook);

  const winningLease = leaseOf(firstClaim);
  const loser = heldOf(secondClaim);
  assert.equal(loser.sighting?.holder?.token, winningLease.holder.token);
  assert.equal((await recordedHolder(lockPath)).token, winningLease.holder.token);
  assert.equal(await winningLease.isStillHeld(), true);
  await winningLease.release();
});

test("release removes the sweep lock only while it still names this holder", async () => {
  const lockPath = uniqueTestSweepLockPath();
  const clock = { now: 1_000_000 };
  const overrunLease = leaseOf(await acquireSweepLock(withFakeClock(lockPath, clock)));
  clock.now += SWEEP_LOCK_TIME_TO_LIVE_MS;
  const successorLease = leaseOf(await acquireSweepLock(withFakeClock(lockPath, clock)));

  await overrunLease.release();

  assert.equal(await lockFileExists(lockPath), true);
  assert.equal((await recordedHolder(lockPath)).token, successorLease.holder.token);
  assert.equal(await successorLease.isStillHeld(), true);

  await successorLease.release();
  assert.equal(await lockFileExists(lockPath), false);
});
