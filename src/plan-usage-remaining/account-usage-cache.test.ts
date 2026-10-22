import assert from "node:assert/strict";
import { mkdir, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { before, test } from "node:test";
import { readAccountReading } from "../account/account-adapters.ts";
import type { Account, AccountsConfig } from "../account/accounts-config.ts";
import { makeScratchDirectory } from "../scratch-directory.test-support.ts";
import { accountUsageCacheFile, writeCacheEntry } from "./account-usage-cache.ts";
import { PlanUsagePlatformService } from "./plan-usage-platform.service.ts";
import { realPlanUsageRemainingService } from "./plan-usage-remaining.service.ts";
import { cachedUsage, type CacheablePayload } from "./telemetry-core/cache.ts";
import type { HttpJsonRequest, HttpJsonResponse } from "./pipeline.types.ts";

const START = new Date("2026-10-16T12:00:00Z");
const MINUTE_MS = 60_000;
const ACCESS_TOKEN = "access-token-of-the-account-under-test";

let scratchRoot: string;

before(async () => {
  scratchRoot = await makeScratchDirectory("account-usage-cache-");
  process.env.THRONE_DATA_HOME = path.join(scratchRoot, "throne-home");
});

function credentialsText(expiresAt: number = START.getTime() + 24 * 60 * MINUTE_MS): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: ACCESS_TOKEN,
      refreshToken: "refresh-token-that-stays-in-the-store",
      expiresAt,
      scopes: ["user:inference"],
    },
  });
}

function usageBody(fiveHourUsedPct: number, weeklyUsedPct: number) {
  return {
    five_hour: { utilization: fiveHourUsedPct, resets_at: "2026-10-16T15:00:00Z" },
    seven_day: { utilization: weeklyUsedPct, resets_at: "2026-10-20T00:00:00Z" },
  };
}

function usageEndpoint(answers: { status: number; weeklyUsedPct?: number }[] = [{ status: 200 }]) {
  const requests: HttpJsonRequest[] = [];
  const httpJson = async (request: HttpJsonRequest): Promise<HttpJsonResponse> => {
    const answer = answers[Math.min(requests.length, answers.length - 1)]!;
    requests.push(request);
    await new Promise((resolve) => setImmediate(resolve));
    return { status: answer.status, json: answer.status === 200 ? usageBody(10, answer.weeklyUsedPct ?? 40) : null };
  };
  return { requests, httpJson };
}

function clockAt(start: Date = START) {
  let nowMs = start.getTime();
  return {
    now: () => new Date(nowMs),
    advanceMinutes: (minutes: number) => {
      nowMs += minutes * MINUTE_MS;
    },
  };
}

async function accountFolder(name: string): Promise<string> {
  const folder = path.join(scratchRoot, "accounts", `${name}-${Math.random().toString(36).slice(2)}`);
  await mkdir(folder, { recursive: true });
  return folder;
}

function usageServiceFor(folder: string, now: () => Date, httpJson: (request: HttpJsonRequest) => Promise<HttpJsonResponse>) {
  return realPlanUsageRemainingService(
    new PlanUsagePlatformService({
      readCredentialsFile: async () => credentialsText(),
      httpJson,
      now,
      out: () => undefined,
      errOut: () => undefined,
      usageCacheFile: accountUsageCacheFile(folder),
    }),
  );
}

test("a usage reading younger than two minutes is reused without asking the endpoint again", async () => {
  const folder = await accountFolder("fresh");
  const endpoint = usageEndpoint();
  const clock = clockAt();
  const service = usageServiceFor(folder, clock.now, endpoint.httpJson);
  const first = await service.getUsagePayload();
  clock.advanceMinutes(1.9);
  const second = await service.getUsagePayload();
  assert.equal(endpoint.requests.length, 1);
  assert.equal(first.reading_source, "fresh");
  assert.equal(second.reading_source, "cached");
  assert.equal(second.as_of, START.toISOString());
  assert.deepEqual(second.windows?.map((window) => window.used_pct), [10, 40]);
});

test("a usage reading older than two minutes is read again from the endpoint", async () => {
  const folder = await accountFolder("old");
  const endpoint = usageEndpoint();
  const clock = clockAt();
  const service = usageServiceFor(folder, clock.now, endpoint.httpJson);
  await service.getUsagePayload();
  clock.advanceMinutes(2);
  const second = await service.getUsagePayload();
  assert.equal(endpoint.requests.length, 2);
  assert.equal(second.reading_source, "fresh");
});

test("each account keeps its own usage reading in its own file under the throne data home", async () => {
  const firstFolder = await accountFolder("first");
  const secondFolder = await accountFolder("second");
  const clock = clockAt();
  await usageServiceFor(firstFolder, clock.now, usageEndpoint([{ status: 200, weeklyUsedPct: 20 }]).httpJson).getUsagePayload();
  await usageServiceFor(secondFolder, clock.now, usageEndpoint([{ status: 200, weeklyUsedPct: 70 }]).httpJson).getUsagePayload();
  const firstFile = accountUsageCacheFile(firstFolder);
  const secondFile = accountUsageCacheFile(secondFolder);
  assert.notEqual(firstFile, secondFile);
  assert.ok(firstFile.startsWith(path.join(scratchRoot, "throne-home", "usage-cache") + path.sep));
  assert.match(await readFile(firstFile, "utf8"), /"used_pct":20/);
  assert.match(await readFile(secondFile, "utf8"), /"used_pct":70/);
  assert.doesNotMatch(await readFile(firstFile, "utf8"), new RegExp(ACCESS_TOKEN));
});

test("after a 429 the account asks the endpoint again only after five minutes, then ten, twenty and at most thirty", async () => {
  const folder = await accountFolder("backoff");
  const endpoint = usageEndpoint([{ status: 429 }]);
  const clock = clockAt();
  const service = usageServiceFor(folder, clock.now, endpoint.httpJson);
  const requestsAfter = async (minutes: number) => {
    clock.advanceMinutes(minutes);
    await service.getUsagePayload();
    return endpoint.requests.length;
  };
  assert.equal(await requestsAfter(0), 1);
  assert.equal(await requestsAfter(4.9), 1);
  assert.equal(await requestsAfter(0.1), 2);
  assert.equal(await requestsAfter(9.9), 2);
  assert.equal(await requestsAfter(0.1), 3);
  assert.equal(await requestsAfter(19.9), 3);
  assert.equal(await requestsAfter(0.1), 4);
  assert.equal(await requestsAfter(29.9), 4);
  assert.equal(await requestsAfter(0.1), 5);
  assert.equal(await requestsAfter(29.9), 5);
  assert.equal(await requestsAfter(0.1), 6);
});

test("after a 429 the last good reading is returned and marked as the last good reading after a 429", async () => {
  const folder = await accountFolder("last-good");
  const endpoint = usageEndpoint([{ status: 200, weeklyUsedPct: 33 }, { status: 429 }]);
  const clock = clockAt();
  const service = usageServiceFor(folder, clock.now, endpoint.httpJson);
  await service.getUsagePayload();
  clock.advanceMinutes(3);
  const refused = await service.getUsagePayload();
  clock.advanceMinutes(1);
  const heldBack = await service.getUsagePayload();
  assert.equal(endpoint.requests.length, 2);
  for (const payload of [refused, heldBack]) {
    assert.equal(payload.source, "api");
    assert.equal(payload.reading_source, "last good after a 429");
    assert.equal(payload.as_of, START.toISOString());
    assert.equal(payload.windows?.find((window) => window.cap_window === "weekly")?.used_pct, 33);
  }
});

test("a successful reading after a 429 ends the back-off", async () => {
  const folder = await accountFolder("recovers");
  const endpoint = usageEndpoint([{ status: 429 }, { status: 429 }, { status: 200 }, { status: 429 }]);
  const clock = clockAt();
  const service = usageServiceFor(folder, clock.now, endpoint.httpJson);
  await service.getUsagePayload();
  clock.advanceMinutes(5);
  await service.getUsagePayload();
  clock.advanceMinutes(10);
  assert.equal((await service.getUsagePayload()).reading_source, "fresh");
  clock.advanceMinutes(2);
  await service.getUsagePayload();
  clock.advanceMinutes(5);
  await service.getUsagePayload();
  assert.equal(endpoint.requests.length, 5);
});

test("an account that never had a good reading stays unreadable after a 429", async () => {
  const folder = await accountFolder("never-read");
  const endpoint = usageEndpoint([{ status: 429 }]);
  const clock = clockAt();
  const service = usageServiceFor(folder, clock.now, endpoint.httpJson);
  const refused = await service.getUsagePayload();
  clock.advanceMinutes(1);
  const heldBack = await service.getUsagePayload();
  assert.equal(refused.source, "error");
  assert.match(refused.error ?? "", /HTTP 429/);
  assert.equal(heldBack.source, "error");
  assert.match(heldBack.error ?? "", /held back after HTTP 429 until 2026-10-16T12:05:00\.000Z/);
});

test("a usage reading is read again from the endpoint after the clock moves backwards", async () => {
  const folder = await accountFolder("clock-back-reading");
  const endpoint = usageEndpoint();
  const clock = clockAt();
  const service = usageServiceFor(folder, clock.now, endpoint.httpJson);
  await service.getUsagePayload();
  clock.advanceMinutes(-10);
  const second = await service.getUsagePayload();
  assert.equal(endpoint.requests.length, 2);
  assert.equal(second.reading_source, "fresh");
});

test("after the clock moves backwards a 429 back-off still holds the account for at most its own length", async () => {
  const folder = await accountFolder("clock-back-backoff");
  const endpoint = usageEndpoint([{ status: 429 }]);
  const clock = clockAt();
  const service = usageServiceFor(folder, clock.now, endpoint.httpJson);
  await service.getUsagePayload();
  clock.advanceMinutes(-60);
  await service.getUsagePayload();
  assert.equal(endpoint.requests.length, 2);
});

test("a refresh claim left by a crashed process is taken over after the clock moves backwards", async () => {
  const folder = await accountFolder("clock-back-claim");
  const clock = clockAt();
  await usageServiceFor(folder, clock.now, usageEndpoint().httpJson).getUsagePayload();
  clock.advanceMinutes(3);
  const claimFile = `${accountUsageCacheFile(folder)}.refreshing`;
  await writeFile(claimFile, "12345");
  const claimTimeAheadOfTheClock = new Date(Date.now() + 10 * MINUTE_MS);
  await utimes(claimFile, claimTimeAheadOfTheClock, claimTimeAheadOfTheClock);
  const endpoint = usageEndpoint();
  const payload = await usageServiceFor(folder, clock.now, endpoint.httpJson).getUsagePayload();
  assert.equal(endpoint.requests.length, 1);
  assert.equal(payload.reading_source, "fresh");
});

test("when a stale reading is read by several processes at once only one of them asks the endpoint", async () => {
  const folder = await accountFolder("stampede");
  const clock = clockAt();
  await usageServiceFor(folder, clock.now, usageEndpoint().httpJson).getUsagePayload();
  clock.advanceMinutes(3);
  const endpoint = usageEndpoint();
  const readers = Array.from({ length: 8 }, () => usageServiceFor(folder, clock.now, endpoint.httpJson));
  const payloads = await Promise.all(readers.map((reader) => reader.getUsagePayload()));
  assert.equal(endpoint.requests.length, 1);
  assert.equal(payloads.filter((payload) => payload.reading_source === "fresh").length, 1);
  assert.equal(payloads.filter((payload) => payload.reading_source === "cached").length, 7);
  assert.deepEqual(await readdir(path.dirname(accountUsageCacheFile(folder))).then((names) => names.filter((name) => name.endsWith(".refreshing"))), []);
});

test("the usage cache file stays readable when several processes write it at once", async () => {
  const folder = await accountFolder("writers");
  const cacheFile = accountUsageCacheFile(folder);
  const service = usageServiceFor(folder, clockAt().now, usageEndpoint().httpJson);
  const lastGood = await service.getUsagePayload();
  await Promise.all(
    Array.from({ length: 40 }, (_, index) =>
      writeCacheEntry(cacheFile, { lastGood: { ...lastGood, as_of: new Date(START.getTime() + index).toISOString() } }),
    ),
  );
  const written = JSON.parse(await readFile(cacheFile, "utf8"));
  assert.equal(written.lastGood.source, "api");
  assert.deepEqual((await readdir(path.dirname(cacheFile))).filter((name) => name.endsWith(".tmp")), []);
});

test("the account balancer counts a cached or last good reading as a usable reading", async () => {
  const userHome = await makeScratchDirectory("account-usage-cache-home-");
  const folder = await accountFolder("balancer");
  await writeFile(path.join(folder, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "someone@personal.example" } }));
  await writeFile(path.join(folder, ".credentials.json"), credentialsText(Date.now() + 3_600_000));
  const account: Account = { name: "secondary", harness: "claude", folder };
  const config: AccountsConfig = { accounts: [account], mcpServersAllowedOnEveryAccount: [] };
  const refusingEndpoint = usageEndpoint([{ status: 429 }]);
  const readingNow = () => readAccountReading(account, config, { userHome, httpJson: refusingEndpoint.httpJson });

  await usageServiceFor(folder, () => new Date(Date.now() - MINUTE_MS), usageEndpoint().httpJson).getUsagePayload();
  const cached = await readingNow();
  await writeCacheEntry(accountUsageCacheFile(folder), {
    lastGood: { source: "api", harness: "claude", as_of: new Date(Date.now() - 3 * MINUTE_MS).toISOString(), windows: [
      { cap_window: "5h", used_pct: 10, remaining_pct: 90 },
      { cap_window: "weekly", used_pct: 40, remaining_pct: 60 },
    ] },
  });
  const lastGood = await readingNow();

  assert.equal(refusingEndpoint.requests.length, 1);
  assert.deepEqual(cached.usage, { ok: true, weeklyPct: 60, sessionPct: 90 });
  assert.deepEqual(lastGood.usage, { ok: true, weeklyPct: 60, sessionPct: 90 });
});

test("codex usage caching keeps its thirty-minute reuse", async () => {
  let nowMs = START.getTime();
  let stored = "";
  let liveReads = 0;
  const io = {
    now: () => nowMs,
    readCache: async () => stored,
    writeCache: async (data: string) => {
      stored = data;
    },
  };
  const readCodex = () =>
    cachedUsage<CacheablePayload>(async () => {
      liveReads += 1;
      return liveReads === 1
        ? { source: "api", harness: "codex", as_of: new Date(nowMs).toISOString(), windows: [] }
        : { source: "error", harness: "codex", as_of: new Date(nowMs).toISOString(), error: "Codex usage request failed (HTTP 429)" };
    }, io);
  await readCodex();
  nowMs += 29 * MINUTE_MS;
  const reused = await readCodex();
  nowMs += MINUTE_MS;
  const stale = await readCodex();
  assert.equal(liveReads, 2);
  assert.equal(reused.stale, undefined);
  assert.equal(stale.stale, true);
  assert.equal(stale.as_of, START.toISOString());
});
