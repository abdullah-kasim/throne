import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { THRONE_HOME_ENV } from "../shared-policy/throne-home.ts";
import { startWebListener } from "../web-listener/web-listener-app.ts";
import { connectToWhereIStand } from "../where-i-stand-store/where-i-stand-client.ts";
import { readTable } from "../where-i-stand-store/where-i-stand-store.test-support.ts";
import { commandRoom, entryText, type CommandRoom } from "./where-i-stand.test-support.ts";

function withoutIds(text: string): string {
  return text.replace(/\b[trs]\d+\b/g, "<id>");
}

async function checkpoint(room: CommandRoom, mode: readonly string[]): Promise<string[]> {
  const code = mode.length === 0 ? "alpha-rest" : "alpha-local";
  const outputs: string[] = [];
  const record = async (command: readonly string[]) => {
    const ran = await room.run([...command, ...mode]);
    assert.equal(ran.exitCode, 0, `${command.join(" ")}: ${ran.complaints}`);
    outputs.push(withoutIds(ran.printed.replaceAll(code, "<code>")));
    return ran;
  };
  const put = await record(["put", "--code", code, "--section-id", await room.sectionId("Needs you"), "--listing-token", await room.listingToken(), "--text", entryText()]);
  const rowId = /(r\d+)/.exec(put.printed)![1];
  await record(["note", `noted ${code}`]);
  await record(["archive", rowId]);
  await record(["restore", rowId]);
  await record(["put", "--code", code, "--remove"]);
  await record(["list"]);
  return outputs;
}

interface Backend {
  readonly room: CommandRoom;
  stop(): Promise<void>;
}

async function roomWithBackend(t: TestContext): Promise<Backend> {
  const previousHome = process.env[THRONE_HOME_ENV];
  let address = "";
  const room = await commandRoom(t, (local, home) => connectToWhereIStand({ local, throneHome: home, address }));
  process.env[THRONE_HOME_ENV] = room.home;
  const listener = await startWebListener({ port: 0, webRoot: path.join(room.home, "web") });
  address = `http://127.0.0.1:${(listener.getHttpServer().address() as AddressInfo).port}`;
  let running = true;
  const stop = async () => {
    if (running) await listener.close();
    running = false;
  };
  t.after(async () => {
    await stop();
    if (previousHome === undefined) delete process.env[THRONE_HOME_ENV];
    else process.env[THRONE_HOME_ENV] = previousHome;
  });
  return { room, stop };
}

test("B6.1 put, note, list, archive, restore and show reach the running backend, and two puts at once are both journaled", async (t) => {
  const { room } = await roomWithBackend(t);
  const inFlight = ["--section-id", await room.sectionId("In flight"), "--listing-token", await room.listingToken()];
  const [first, second] = await Promise.all(
    ["alpha-first", "alpha-second"].map((code) => room.run(["put", "--code", code, ...inFlight, "--text", entryText()])),
  );
  assert.deepEqual([first.exitCode, second.exitCode], [0, 0], first.complaints + second.complaints);
  const rowId = /(r\d+)/.exec(first.printed)![1];
  for (const command of [["note", "the oven is warm"], ["list"], ["archive", rowId], ["restore", rowId], ["show"]]) {
    const ran = await room.run(command);
    assert.equal(ran.exitCode, 0, `${command.join(" ")}: ${ran.complaints}`);
  }
  const added = readTable(room.home, "journal").filter((entry) => entry.action === "add").map((entry) => String(entry.after));
  for (const code of ["alpha-first", "alpha-second", "the oven is warm"]) assert.ok(added.some((after) => after.includes(code)), code);
});

test("B6.2 with the backend stopped, each command run with --local gives the same result against the same database", async (t) => {
  const { room, stop } = await roomWithBackend(t);
  const overRest = await checkpoint(room, []);
  await stop();
  const local = await checkpoint(room, ["--local"]);
  assert.deepEqual(local, overRest);
});

test("B6.3 with the backend stopped and no --local, each command fails naming the backend and the flag and writes nothing", async (t) => {
  const { room, stop } = await roomWithBackend(t);
  await stop();
  const before = readTable(room.home, "journal").length;
  const sectionId = await room.sectionId("In flight");
  for (const command of [["list"], ["show"], ["note", "hello"], ["put", "--code", "alpha-oven", "--section-id", await room.sectionId("In flight"), "--listing-token", await room.listingToken(), "--text", entryText()], ["archive", sectionId], ["restore", sectionId]]) {
    const ran = await room.run(command);
    assert.equal(ran.exitCode, 1, command.join(" "));
    assert.match(ran.complaints, /could not reach throne-backend at http:\/\/127\.0\.0\.1:\d+/);
    assert.match(ran.complaints, /run the command again with --local/);
  }
  assert.equal(readTable(room.home, "journal").length, before);
});
