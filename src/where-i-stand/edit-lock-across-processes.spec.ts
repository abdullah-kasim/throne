import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { versionOf } from "./page-frame.ts";
import { JournalAction, readJournal, UNRECORDED_WRITER } from "./page-journal.ts";
import { runWhereIStand, WhereIStandExitCode } from "./where-i-stand-runtime.ts";
import {
  editThePageDirectly,
  entry,
  lockEditAndRelease,
  pageRoom,
  pageWith,
  type PageRoom,
} from "./where-i-stand.test-support.ts";

const HOLDER_IN_ANOTHER_PROCESS = "shadow-bakery-01-oven";
const holderFixturePath = fileURLToPath(new URL("./edit-lock-holder-fixture.ts", import.meta.url));
const typescriptRegisterPath = fileURLToPath(new URL("../../test/register-typescript.mjs", import.meta.url));
const BEFORE = pageWith({ "## In flight": entry("ovenqueue", "Baking.") + entry("tillreport", "Counting.") });

async function lockHeldByAnotherProcess(t: TestContext, room: PageRoom): Promise<ChildProcess> {
  const holder = spawn(
    process.execPath,
    ["--import", typescriptRegisterPath, holderFixturePath, room.dataHome, HOLDER_IN_ANOTHER_PROCESS, versionOf(BEFORE)],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  t.after(() => void holder.kill("SIGKILL"));
  holder.stdout.setEncoding("utf8");
  let printed = "";
  await new Promise<void>((resolve, reject) => {
    holder.stdout.on("data", (chunk: string) => {
      printed += chunk;
      if (printed.includes("locked by")) resolve();
    });
    holder.once("exit", () => reject(new Error(`the lock process ended without taking the lock: ${printed}`)));
  });
  return holder;
}

async function secondLockAfterTheHolderEditsAndEnds(
  t: TestContext,
  signal: NodeJS.Signals,
): Promise<{ room: PageRoom; holder: ChildProcess; secondLock: number }> {
  const room = await pageRoom(t);
  await lockEditAndRelease(room, () => BEFORE);
  const holder = await lockHeldByAnotherProcess(t, room);
  await editThePageDirectly(room, (content) => content.replace("Baking.", "Baked."));
  const exited = once(holder, "exit");
  holder.kill(signal);
  await exited;
  return { room, holder, secondLock: await lockEditAndRelease(room, (content) => content) };
}

test("stopping the lock process with TERM journals its edit and lets a second lock succeed at once", async (t) => {
  const { room, holder, secondLock } = await secondLockAfterTheHolderEditsAndEnds(t, "SIGTERM");

  assert.equal(holder.exitCode, WhereIStandExitCode.Done);
  assert.equal(secondLock, WhereIStandExitCode.Done);
  const release = (await readJournal(room.dataHome)).at(-1);
  assert.deepEqual(
    [release?.writer, release?.action, release?.changed],
    [HOLDER_IN_ANOTHER_PROCESS, JournalAction.Edit, ["ovenqueue"]],
  );
  assert.deepEqual(room.regentNotices, []);
});

test("killing the lock process with KILL lets a second lock succeed at once and that lock journals the edit as unknown", async (t) => {
  const { room, holder, secondLock } = await secondLockAfterTheHolderEditsAndEnds(t, "SIGKILL");

  assert.equal(holder.signalCode, "SIGKILL");
  assert.equal(secondLock, WhereIStandExitCode.Done);
  const caught = (await readJournal(room.dataHome)).at(-1);
  assert.deepEqual(
    [caught?.writer, caught?.action, caught?.changed],
    [UNRECORDED_WRITER, JournalAction.UnrecordedEdit, ["ovenqueue"]],
  );
  assert.equal(room.regentNotices.length, 1);
});
