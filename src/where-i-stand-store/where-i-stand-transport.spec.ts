import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { THRONE_HOME_ENV } from "../shared-policy/throne-home.ts";
import { startScratchListener } from "../web-listener/web-listener.test-support.ts";
import { BackendUnreachableError, connectToWhereIStand, whereIStandOverRest } from "./where-i-stand-client.ts";
import { readTable, workEntry, WRITER } from "./where-i-stand-store.test-support.ts";
import { whereIStandClock } from "./where-i-stand.store.ts";

const PINNED_TIME = new Date("2026-03-01T09:30:00.000Z");

let scratch: string;
let home: string;
let listener: NestExpressApplication;
let address: string;
let previousHome: string | undefined;
const realNow = whereIStandClock.now;

before(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), "where-i-stand-transport-"));
  home = path.join(scratch, "home");
  previousHome = process.env[THRONE_HOME_ENV];
  process.env[THRONE_HOME_ENV] = home;
  whereIStandClock.now = () => new Date(PINNED_TIME);
  ({ listener, address } = await startScratchListener(scratch));
});

after(async () => {
  await listener.close();
  whereIStandClock.now = realNow;
  if (previousHome === undefined) delete process.env[THRONE_HOME_ENV];
  else process.env[THRONE_HOME_ENV] = previousHome;
  await rm(scratch, { recursive: true, force: true });
});

async function sectionOverRest(): Promise<{ sectionId: string; listingToken: string }> {
  const backend = whereIStandOverRest(address);
  const listing = await backend.listing();
  const existing = listing.sections[0];
  if (existing !== undefined) return { sectionId: existing.id, listingToken: listing.listingToken };
  const tab = await backend.createTab({ name: "Now", listingToken: listing.listingToken, writer: WRITER });
  const section = await backend.createSection({ tabId: tab.tab!.id, name: "In flight", listingToken: (await backend.listing()).listingToken, writer: WRITER });
  return { sectionId: section.section!.id, listingToken: (await backend.listing()).listingToken };
}

test("two writes sent to the backend at the same moment both succeed and both are in the journal", async () => {
  const backend = whereIStandOverRest(address);
  const { sectionId, listingToken } = await sectionOverRest();
  const answers = await Promise.all(
    ["alpha-first", "alpha-second"].map((code) => backend.addRow({ sectionId, listingToken, writer: WRITER, row: workEntry(code) })),
  );
  assert.deepEqual(answers.map((answer) => answer.outcome), ["done", "done"]);
  const journaled = readTable(home, "journal").filter((entry) => entry.action === "add").map((entry) => String(entry.after));
  assert.ok(journaled.some((after) => after.includes("alpha-first")));
  assert.ok(journaled.some((after) => after.includes("alpha-second")));
});

test("a write records the store's own time and ignores a date sent by the caller", async () => {
  const { sectionId, listingToken } = await sectionOverRest();
  const response = await fetch(`${address}/api/where-i-stand/store/rows`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sectionId, listingToken, writer: WRITER, writtenAt: "2020-01-01T00:00:00.000Z", row: { ...workEntry("alpha-dated"), writtenAt: "2020-01-01T00:00:00.000Z" } }),
  });
  assert.equal(response.status, 200);
  const stored = readTable(home, "content").find((row) => row.code === "alpha-dated")!;
  assert.equal(stored.written_at, PINNED_TIME.getTime());
});

test("a refused write answers with the reason over the backend route", async () => {
  const { listingToken } = await sectionOverRest();
  const answer = await whereIStandOverRest(address).addRow({ sectionId: "In flight", listingToken, writer: WRITER, row: workEntry("alpha-named") });
  assert.equal(answer.outcome, "refused");
  assert.match(answer.message, /not a section id/);
});

test("with the backend running and with --local against the same database the listing and page are the same", async () => {
  await sectionOverRest();
  const local = connectToWhereIStand({ local: true, throneHome: home });
  try {
    const backend = whereIStandOverRest(address);
    assert.deepEqual(await local.operations.listing(), await backend.listing());
    assert.deepEqual(await local.operations.page(), await backend.page());
  } finally {
    await local.close();
  }
});

test("with the backend stopped a command without --local fails naming the backend and the flag and writes nothing", async () => {
  const before = readTable(home, "content");
  const { listener: stopped, address: stoppedAddress } = await startScratchListener(scratch);
  await stopped.close();
  const { operations } = connectToWhereIStand({ local: false, address: stoppedAddress });
  await assert.rejects(
    operations.addRow({ sectionId: "s1", listingToken: "any", writer: WRITER, row: workEntry("alpha-unwritten") }),
    (error: unknown) => error instanceof BackendUnreachableError && /throne-backend/.test(error.message) && /--local/.test(error.message),
  );
  assert.deepEqual(readTable(home, "content"), before);
});
