import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { connectToWhereIStand, type WhereIStandConnection } from "../where-i-stand-store/where-i-stand-client.ts";
import { whereIStandClock } from "../where-i-stand-store/where-i-stand.store.ts";
import { runWhereIStand, type WhereIStandDependencies } from "./where-i-stand-runtime.ts";

export const WRITER = "alpha-bakery-01";
export const STARTED_AT = new Date("2026-06-15T12:00:00.000Z");
export const TODAYS_TABS: readonly (readonly [string, readonly string[]])[] = [
  ["Now", ["Needs you", "Just happened", "In flight"]],
  ["Epics", ["Epics"]],
  ["Queue", ["Queued and deferred"]],
  ["Delivered", ["Delivered, not on GitHub"]],
  ["Pull requests", ["On GitHub"]],
];

export interface Ran {
  readonly exitCode: number;
  readonly printed: string;
  readonly complaints: string;
}

export interface CommandRoom {
  readonly home: string;
  readonly clock: { time: Date };
  run(commandArguments: readonly string[], writer?: string): Promise<Ran>;
  sectionId(name: string): Promise<string>;
  listingToken(): Promise<string>;
}

export function entryText(whereItStands = "building", links = "no pull request · branch oven · Ticket no ticket"): string {
  return `- Links: ${links}\n- Kind: bug fix — keep the oven warm\n- Where it stands: ${whereItStands}\n`;
}

export function dependenciesFor(connect: (local: boolean) => WhereIStandConnection, writer: string, printed: string[], complaints: string[]): WhereIStandDependencies {
  return {
    connect,
    currentAgentName: async () => writer,
    out: (message) => void printed.push(message),
    err: (message) => void complaints.push(message),
  };
}

export async function commandRoom(t: TestContext, connectOverride?: (local: boolean, home: string) => WhereIStandConnection): Promise<CommandRoom> {
  const home = await mkdtemp(path.join(os.tmpdir(), "where-i-stand-commands-"));
  const clock = { time: STARTED_AT };
  const realNow = whereIStandClock.now;
  whereIStandClock.now = () => new Date(clock.time);
  t.after(async () => {
    whereIStandClock.now = realNow;
    await rm(home, { recursive: true, force: true });
  });
  const connect = (local: boolean): WhereIStandConnection =>
    connectOverride === undefined ? connectToWhereIStand({ local, throneHome: home, address: "http://127.0.0.1:9" }) : connectOverride(local, home);
  const run = async (commandArguments: readonly string[], writer = WRITER): Promise<Ran> => {
    const printed: string[] = [];
    const complaints: string[] = [];
    const exitCode = await runWhereIStand(commandArguments, dependenciesFor(connect, writer, printed, complaints));
    return { exitCode, printed: printed.join(""), complaints: complaints.join("") };
  };
  const listing = async () => {
    const connection = connect(true);
    try {
      return await connection.operations.listing();
    } finally {
      await connection.close();
    }
  };
  const room: CommandRoom = {
    home,
    clock,
    run,
    sectionId: async (name) => (await listing()).sections.find((section) => section.name === name)!.id,
    listingToken: async () => (await listing()).listingToken,
  };
  for (const [tabName, sections] of TODAYS_TABS) {
    const created = await run(["add-tab", "--local", "--name", tabName, "--listing-token", await room.listingToken()]);
    assert.equal(created.exitCode, 0, created.complaints);
    const tabId = /Created tab (t\d+)/.exec(created.printed)![1];
    for (const name of sections) {
      const section = await run(["add-section", "--local", "--tab-id", tabId, "--name", name, "--listing-token", await room.listingToken()]);
      assert.equal(section.exitCode, 0, section.complaints);
    }
  }
  return room;
}
