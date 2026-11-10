import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { PageSection } from "./page-frame.ts";
import { readJournal } from "./page-journal.ts";
import { archivePathIn, showPage } from "./page-store.ts";
import { runWhereIStand, WhereIStandExitCode } from "./where-i-stand-runtime.ts";
import { entry, lockEditAndRelease, pageRoom, pageWith, readPageOrEmptyFrame, WRITER, WRITTEN_AT, type PageRoom } from "./where-i-stand.test-support.ts";

const BODY = "- Links: no pull request · cakeorders · Ticket no ticket\n- Kind: throne — Cake orders\n- Where it stands: merged to main.";
const OLDER_BODY = "- Links: no pull request · cakeorders · Ticket no ticket\n- Kind: throne — Cake orders\n- Where it stands: in flight.";

async function put(room: PageRoom, ...commandArguments: string[]): Promise<number> {
  return runWhereIStand(["put", ...commandArguments], room.dependencies);
}

function putUnder(room: PageRoom, section: string, body: string = BODY): Promise<number> {
  return put(room, "--code", "cakeorders", "--section", section, `--text=${body}`);
}

async function seededRoom(t: TestContext, sections: Partial<Record<string, string>>): Promise<PageRoom> {
  const room = await pageRoom(t);
  await lockEditAndRelease(room, () => pageWith(sections));
  room.printed.length = 0;
  return room;
}

test("an agent can put its entry under a section with one command", async (t) => {
  const room = await seededRoom(t, { "## In flight": entry("flourdeal", "The flour deal.") });
  assert.equal(await putUnder(room, PageSection.InFlight), WhereIStandExitCode.Done);
  assert.equal(
    await readPageOrEmptyFrame(room),
    pageWith({ "## In flight": `${entry("cakeorders", BODY)}${entry("flourdeal", "The flour deal.")}` }),
  );
});

test("putting an entry under another section moves it there", async (t) => {
  const room = await seededRoom(t, { "## In flight": entry("cakeorders", BODY) });
  assert.equal(await putUnder(room, PageSection.DeliveredNotOnGitHub), WhereIStandExitCode.Done);
  assert.equal(await readPageOrEmptyFrame(room), pageWith({ "## Delivered, not on GitHub": entry("cakeorders", BODY) }));
});

test("putting an entry replaces an older entry with the same code in any section", async (t) => {
  const room = await seededRoom(t, {
    "## Needs you": entry("cakeorders", OLDER_BODY),
    "## In flight": `${entry("cakeorders", OLDER_BODY)}${entry("flourdeal", "The flour deal.")}`,
  });
  assert.equal(await putUnder(room, PageSection.OnGitHub), WhereIStandExitCode.Done);
  assert.equal(
    await readPageOrEmptyFrame(room),
    pageWith({ "## In flight": entry("flourdeal", "The flour deal."), "## On GitHub": entry("cakeorders", BODY) }),
  );
});

test("an entry missing its where it stands line is refused naming that line", async (t) => {
  const room = await seededRoom(t, {});
  const before = await readPageOrEmptyFrame(room);
  assert.equal(await putUnder(room, PageSection.InFlight, BODY.replace("- Where it stands:", "Where:")), WhereIStandExitCode.Refused);
  assert.match(room.complaints.join(""), /its "- Where it stands:" line is missing/);
  assert.equal(await readPageOrEmptyFrame(room), before);
});

test("put is refused while another agent holds the lock and names the holder", async (t) => {
  const room = await seededRoom(t, {});
  let refused: number | undefined;
  await runWhereIStand(["lock", "--checksum", (await showPage(room.dataHome)).version], {
    ...room.dependencies,
    currentAgentName: async () => "alpha-florist-01",
    waitForRelease: async () => {
      refused = await putUnder(room, PageSection.InFlight);
    },
  });
  assert.equal(refused, WhereIStandExitCode.Refused);
  assert.match(room.complaints.join(""), /held by alpha-florist-01 until/);
  assert.doesNotMatch(await readPageOrEmptyFrame(room), /### cakeorders/);
});

test("put refuses the epics section", async (t) => {
  const room = await seededRoom(t, {});
  assert.equal(await putUnder(room, PageSection.Epics), WhereIStandExitCode.Refused);
  assert.match(room.complaints.join(""), /Only the Lord edits "## Epics"/);
});

test("put removes an entry with --remove", async (t) => {
  const room = await seededRoom(t, { "## In flight": `${entry("cakeorders", BODY)}${entry("flourdeal", "The flour deal.")}` });
  assert.equal(await put(room, "--code", "cakeorders", "--remove"), WhereIStandExitCode.Done);
  assert.equal(await readPageOrEmptyFrame(room), pageWith({ "## In flight": entry("flourdeal", "The flour deal.") }));
});

test("put journals the calling agent and prints the new checksum", async (t) => {
  const room = await seededRoom(t, {});
  await putUnder(room, PageSection.InFlight);
  const last = (await readJournal(room.dataHome)).at(-1);
  assert.deepEqual([last?.writer, last?.added], [WRITER, ["cakeorders"]]);
  assert.match(room.printed.join(""), new RegExp(`checksum: ${(await showPage(room.dataHome)).version}`));
});

test("put reads the entry from --text-file", async (t) => {
  const room = await seededRoom(t, {});
  const file = path.join(room.dataHome, "entry.md");
  await writeFile(file, `${BODY}\n`);
  assert.equal(await put(room, "--code", "cakeorders", "--section", PageSection.InFlight, "--text-file", file), WhereIStandExitCode.Done);
  assert.equal(await readPageOrEmptyFrame(room), pageWith({ "## In flight": entry("cakeorders", BODY) }));
});

test("an entry body passed after --text is accepted even though it starts with a dash", async (t) => {
  const room = await seededRoom(t, {});
  assert.equal(await put(room, "--code", "cakeorders", "--section", PageSection.InFlight, "--text", BODY), WhereIStandExitCode.Done);
  assert.equal(await readPageOrEmptyFrame(room), pageWith({ "## In flight": entry("cakeorders", BODY) }));
});

test("put trims the delivered section", async (t) => {
  const oldEntries = Array.from({ length: 20 }, (_, index) =>
    entry(`old${index}`, `- Links: no pull request · old${index} · Ticket no ticket\n- Kind: throne — Old\n- Where it stands: done. Written by ${WRITER} 2026-09-01.`),
  ).join("");
  const room = await seededRoom(t, { "## Delivered, not on GitHub": oldEntries });
  await putUnder(room, PageSection.DeliveredNotOnGitHub, `${BODY} Written by ${WRITER} ${WRITTEN_AT.toISOString().slice(0, 10)}.`);
  const page = await readPageOrEmptyFrame(room);
  assert.match(page, /### cakeorders/);
  assert.doesNotMatch(page, /### old19\n/);
  assert.match(await readFile(archivePathIn(room.dataHome), "utf8"), /### old19\n/);
  assert.equal((await readJournal(room.dataHome)).at(-1)?.archived?.length, 1);
});
