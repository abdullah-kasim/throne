import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test, type TestContext } from "node:test";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { saveResponse } from "../web-api-contract/where-i-stand.ts";
import { startWebListener } from "../web-listener/web-listener-app.ts";
import { EditLockOutcome, releaseEditLock, takeEditLock } from "./edit-lock.ts";
import { versionOf } from "./page-frame.ts";
import { readJournal, UNRECORDED_WRITER } from "./page-journal.ts";
import { pagePathIn } from "./page-store.ts";
import { SAVE_INPUT_REFUSED } from "./where-i-stand-messages.ts";
import { runWhereIStand, WhereIStandExitCode } from "./where-i-stand-runtime.ts";
import {
  editThePageDirectly,
  filesBesideThePage,
  lockEditAndRelease,
  pageRoom,
  pageWith,
  readPageOrEmptyFrame,
  type PageRoom,
} from "./where-i-stand.test-support.ts";

const AGENT = "alpha-bakery-01";
const FILE_TIME = new Date("2026-10-14T09:30:00.000Z");
const FLOUR_DEAL = "### flourdeal\n\nThe flour deal is signed.";
const NEEDS_YOU = "### ovenrepair\n\nThe oven needs a new door.";
const SECOND_BAKERY = "### Open the second bakery\n\nFind a site near the station.";
const JUST_HAPPENED_LINE = "- launched flourdeal";
const PAGE = pageWith({
  "## Just happened": `\n${JUST_HAPPENED_LINE}\n`,
  "## Needs you": `\n${NEEDS_YOU}\n`,
  "## In flight": `\n${FLOUR_DEAL}\n`,
  "## Epics": `\n${SECOND_BAKERY}\n`,
});
const SECOND_BAKERY_MOVED = SECOND_BAKERY.replace("station", "market");
const RECORDS = {
  read_at: "2026-11-05T01:32:54.886344+00:00",
  days: 14,
  problems: ["forge.example: unreachable"],
  changes: ["bakery #7 is new"],
  rows: [
    {
      group: "Blocked",
      repository: "bakery/ovens",
      title: "Fit the second oven",
      ticket: "BAKE-7",
      ticket_url: "https://example.com/BAKE-7",
      kind: "feature",
      summary: "A second oven.",
      forgejo: null,
      github: { url: "https://example.com/pull/7", number: 7, state: "ready" },
      head_commits: "",
    },
  ],
  waiting_for_review: [
    {
      host: "example.com",
      repository: "bakery/tills",
      number: 8,
      url: "https://example.com/pull/8",
      title: "Count the till",
      author: "a-teammate",
      waiting_on: "you",
      checks: { passing: 1, failing: 0, running: 0 },
      created_at: "2026-11-01T00:00:00Z",
    },
  ],
  teammates: [
    {
      host: "example.com",
      repository: "bakery/tills",
      number: 9,
      url: "https://example.com/pull/9",
      title: "Label the bread",
      author: "a-teammate",
      draft: false,
      review: "APPROVED",
      checks: { passing: 0, failing: 0, running: 1 },
      updated_at: "2026-11-02T00:00:00Z",
    },
  ],
};

let scratch: string;
let listener: NestExpressApplication;
let address: string;
let regentMessagesFile: string;

interface ApiAnswer {
  readonly status: number;
  readonly outcome: string;
  readonly message: string;
}

async function writeThroneCommandStub(): Promise<void> {
  const binFolder = path.join(scratch, "bin");
  await mkdir(binFolder);
  await writeFile(path.join(binFolder, "throne"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${regentMessagesFile}'\n`);
  await chmod(path.join(binFolder, "throne"), 0o755);
  process.env.PATH = `${binFolder}${path.delimiter}${process.env.PATH ?? ""}`;
}

function recordsFile(): string {
  return path.join(scratch, "cache", "where-i-stand", "where-i-stand-prs.json");
}

async function writeRecords(content: string): Promise<void> {
  await mkdir(path.dirname(recordsFile()), { recursive: true });
  await writeFile(recordsFile(), content);
  await utimes(recordsFile(), FILE_TIME, FILE_TIME);
}

async function roomHolding(t: TestContext, page: string): Promise<PageRoom> {
  const room = await pageRoom(t, { currentAgentName: async () => AGENT });
  await lockEditAndRelease(room, () => page);
  room.printed.length = 0;
  process.env.THRONE_DATA_HOME = room.dataHome;
  return room;
}

function get(urlPath: string): Promise<Response> {
  return fetch(`${address}/api/where-i-stand/${urlPath}`);
}

function sendBody(body: string, contentType = "application/json"): Promise<Response> {
  return fetch(`${address}/api/where-i-stand/save`, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
  });
}

async function postBody(body: string, contentType?: string): Promise<ApiAnswer> {
  const response = await sendBody(body, contentType);
  const { outcome, message } = (await response.json()) as { outcome: string; message: string };
  return { status: response.status, outcome, message };
}

function save(loaded: string, edited: string): Promise<ApiAnswer> {
  return postBody(JSON.stringify({ loaded, edited }));
}

async function saveThroughTheCommand(room: PageRoom, input: string): Promise<{ exitCode: number; answer: unknown }> {
  const exitCode = await runWhereIStand(["save"], { ...room.dependencies, readStandardInput: async () => input });
  return { exitCode, answer: JSON.parse(room.printed.join("")) };
}

before(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), "where-i-stand-api-"));
  regentMessagesFile = path.join(scratch, "regent-messages");
  await writeThroneCommandStub();
  process.env.XDG_CACHE_HOME = path.join(scratch, "cache");
  listener = await startWebListener({ port: 0, webRoot: path.join(scratch, "web") });
  address = `http://127.0.0.1:${(listener.getHttpServer().address() as AddressInfo).port}`;
});

after(async () => {
  await listener.close();
  await rm(scratch, { recursive: true, force: true });
});

test("the page and its time come back from the api", async (t) => {
  const room = await roomHolding(t, PAGE);
  await utimes(pagePathIn(room.dataHome), FILE_TIME, FILE_TIME);

  for (const url of [`${address}/api/where-i-stand/page`, `${address}/throne/api/where-i-stand/page`]) {
    const response = await fetch(url);

    assert.equal(response.status, 200, url);
    assert.deepEqual(await response.json(), { markdown: PAGE, lastModified: FILE_TIME.toISOString() }, url);
  }
});

test("every read returns the live page and is checked with the server", async (t) => {
  const room = await roomHolding(t, PAGE);
  await get("page");

  await editThePageDirectly(room, (content) => content.replace("signed", "torn up"));
  const response = await get("page");

  assert.equal(response.headers.get("cache-control"), "no-cache");
  assert.match(((await response.json()) as { markdown: string }).markdown, /torn up/);
});

test("a page that was never written answers 404 with a message", async (t) => {
  const room = await pageRoom(t);
  process.env.THRONE_DATA_HOME = room.dataHome;

  const response = await get("page");

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { outcome: "failed", message: "The page has not been written yet." });
});

test("the pull request records come back from the api", async () => {
  await writeRecords(JSON.stringify(RECORDS));

  const response = await get("records");

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-cache");
  assert.deepEqual(await response.json(), { records: RECORDS, lastModified: FILE_TIME.toISOString() });
});

test("missing pull request records answer 404 with a message", async () => {
  await rm(recordsFile(), { force: true });

  const response = await get("records");

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    outcome: "failed",
    message: "The pull request records have not been read yet.",
  });
});

test("a records file of the wrong shape fails naming the field", async () => {
  const [row] = RECORDS.rows;
  await writeRecords(JSON.stringify({ ...RECORDS, rows: [{ ...row, title: 7 }] }));

  const response = await get("records");

  assert.equal(response.status, 500);
  assert.match(((await response.json()) as { message: string }).message, /records\.rows\.0\.title/);
});

test("a save through the api is journaled with the writer Lord", async (t) => {
  const room = await roomHolding(t, PAGE);

  const answer = await save(SECOND_BAKERY, SECOND_BAKERY_MOVED);

  assert.deepEqual([answer.status, answer.outcome], [200, "saved"]);
  assert.equal(await readPageOrEmptyFrame(room), PAGE.replace(SECOND_BAKERY, SECOND_BAKERY_MOVED));
  const newest = (await readJournal(room.dataHome)).at(-1);
  assert.deepEqual([newest?.writer, newest?.changed], ["Lord", ["Epics: Open the second bakery"]]);
});

test("a save through the api and the save command change the page the same way", async (t) => {
  const commandRoom = await roomHolding(t, PAGE);
  const apiRoom = await roomHolding(t, PAGE);
  const change = JSON.stringify({ loaded: SECOND_BAKERY, edited: SECOND_BAKERY_MOVED });

  const throughTheCommand = await saveThroughTheCommand(commandRoom, change);
  const { status, ...throughTheApi } = await postBody(change);

  assert.deepEqual([throughTheCommand.exitCode, status], [WhereIStandExitCode.Done, 200]);
  assert.deepEqual(throughTheApi, throughTheCommand.answer);
  assert.equal(await readPageOrEmptyFrame(apiRoom), await readPageOrEmptyFrame(commandRoom));
  const withoutTheTime = async (room: PageRoom): Promise<unknown> => {
    const { at: _at, ...record } = (await readJournal(room.dataHome)).at(-1) ?? { at: "" };
    return record;
  };
  assert.deepEqual(await withoutTheTime(apiRoom), await withoutTheTime(commandRoom));
});

test("saving an entry someone else changed answers 409 and leaves the page alone", async (t) => {
  const room = await roomHolding(t, PAGE);
  await lockEditAndRelease(room, (content) => content.replace("station", "harbour"));
  const before = await filesBesideThePage(room);

  const answer = await save(SECOND_BAKERY, SECOND_BAKERY_MOVED);

  assert.deepEqual([answer.status, answer.outcome], [409, "entry-changed"]);
  assert.deepEqual(await filesBesideThePage(room), before);
});

test("saving an entry the page holds twice answers 409 and leaves the page alone", async (t) => {
  const room = await roomHolding(t, PAGE);
  await lockEditAndRelease(room, (content) => content.replace(SECOND_BAKERY, `${SECOND_BAKERY}\n\n${SECOND_BAKERY}`));
  const before = await filesBesideThePage(room);

  const answer = await save(SECOND_BAKERY, SECOND_BAKERY_MOVED);

  assert.deepEqual([answer.status, answer.outcome], [409, "entry-repeated"]);
  assert.deepEqual(await filesBesideThePage(room), before);
});

test("a save naming an entry of the heading other than the one holding the text answers 409", async (t) => {
  const room = await roomHolding(t, PAGE);
  const before = await filesBesideThePage(room);

  const answer = await postBody(JSON.stringify({ loaded: SECOND_BAKERY, edited: SECOND_BAKERY_MOVED, headingOccurrence: 2 }));

  assert.deepEqual([answer.status, answer.outcome], [409, "entry-changed"]);
  assert.deepEqual(await filesBesideThePage(room), before);
});

test("a save naming no place among the entries answers 400", async (t) => {
  await roomHolding(t, PAGE);

  const answer = await postBody(JSON.stringify({ loaded: SECOND_BAKERY, edited: SECOND_BAKERY_MOVED, headingOccurrence: 0 }));

  assert.deepEqual([answer.status, answer.outcome], [400, "failed"]);
});

test("a save while an agent holds the lock answers 409 naming the holder", async (t) => {
  const room = await roomHolding(t, PAGE);
  const holder = { ...room.dependencies, name: "alpha-florist-01" };
  const held = await takeEditLock(holder, versionOf(PAGE), new Date(Date.now() + 60_000));
  assert.equal(held.outcome, EditLockOutcome.Taken);
  const before = await filesBesideThePage(room);

  const answer = await save(SECOND_BAKERY, SECOND_BAKERY_MOVED);

  assert.deepEqual([answer.status, answer.outcome], [409, "lock-held"]);
  assert.match(answer.message, /alpha-florist-01/);
  assert.deepEqual(await filesBesideThePage(room), before);
  if (held.outcome === EditLockOutcome.Taken) await releaseEditLock(holder, held);
});

test("a save that breaks the page frame answers 409", async (t) => {
  const room = await roomHolding(t, PAGE);
  const before = await filesBesideThePage(room);

  const answer = await save(SECOND_BAKERY, `${SECOND_BAKERY}\n\n## Needs you`);

  assert.deepEqual([answer.status, answer.outcome], [409, "frame-broken"]);
  assert.match(answer.message, /## Needs you/);
  assert.deepEqual(await filesBesideThePage(room), before);
});

test("a save body missing a field answers 400 naming that field", async (t) => {
  const room = await roomHolding(t, PAGE);
  const before = await filesBesideThePage(room);

  const noEdited = await postBody('{"loaded":"x"}');
  const noLoaded = await postBody('{"edited":"x"}');

  assert.deepEqual([noEdited.status, noEdited.outcome], [400, "failed"]);
  assert.match(noEdited.message, /request does not match its contract: edited:/);
  assert.deepEqual([noLoaded.status, noLoaded.outcome], [400, "failed"]);
  assert.match(noLoaded.message, /request does not match its contract: loaded:/);
  assert.deepEqual(await filesBesideThePage(room), before);
});

test("a save body with a field of the wrong type answers 400 naming that field", async (t) => {
  const room = await roomHolding(t, PAGE);
  const before = await filesBesideThePage(room);

  const numberForLoaded = await postBody('{"loaded":5,"edited":"x"}');
  const numberForEdited = await postBody('{"loaded":"x","edited":7}');

  assert.deepEqual([numberForLoaded.status, numberForLoaded.outcome], [400, "failed"]);
  assert.match(numberForLoaded.message, /request does not match its contract: loaded:/);
  assert.deepEqual([numberForEdited.status, numberForEdited.outcome], [400, "failed"]);
  assert.match(numberForEdited.message, /request does not match its contract: edited:/);
  assert.deepEqual(await filesBesideThePage(room), before);
});

test("a save body that is not JSON answers 400 and leaves the page alone", async (t) => {
  const room = await roomHolding(t, PAGE);
  const before = await filesBesideThePage(room);

  const answer = await postBody("not json");

  assert.deepEqual([answer.status, answer.outcome], [400, "failed"]);
  assert.match(answer.message, /not JSON/);
  assert.deepEqual(await filesBesideThePage(room), before);
});

test("a refused save body answers with only the outcome and message the web client reads", async (t) => {
  await roomHolding(t, PAGE);

  for (const body of ["not json", '{"loaded":"x"}']) {
    const answer: unknown = await (await sendBody(body)).json();

    assert.deepEqual(Object.keys(answer as object).sort(), ["message", "outcome"], body);
    assert.equal(saveResponse.parse(answer).outcome, "failed", body);
  }
});

test("the save command keeps its answer for a bad body while the api refuses it too", async (t) => {
  const room = await roomHolding(t, PAGE);
  const before = await filesBesideThePage(room);
  const badBodies = ["not json", "[]", "null", "{}", '{"loaded":"","edited":"x"}', '{"loaded":"x"}', '{"loaded":1,"edited":"x"}'];

  for (const body of badBodies) {
    room.printed.length = 0;
    const throughTheCommand = await saveThroughTheCommand(room, body);
    const throughTheApi = await postBody(body);

    assert.deepEqual([throughTheApi.status, throughTheCommand.exitCode], [400, WhereIStandExitCode.InvalidInvocation], body);
    assert.deepEqual(throughTheCommand.answer, { outcome: "failed", message: SAVE_INPUT_REFUSED }, body);
    assert.equal(throughTheApi.outcome, "failed", body);
  }
  assert.deepEqual(await filesBesideThePage(room), before);
});

test("a save body that is not labelled as JSON still saves", async (t) => {
  await roomHolding(t, PAGE);

  const answer = await postBody(JSON.stringify({ loaded: SECOND_BAKERY, edited: SECOND_BAKERY_MOVED }), "text/plain");

  assert.deepEqual([answer.status, answer.outcome], [200, "saved"]);
});

test("an edit to an entry outside Epics is refused and leaves the page alone", async (t) => {
  const room = await roomHolding(t, PAGE);
  const before = await filesBesideThePage(room);

  for (const entry of [FLOUR_DEAL, NEEDS_YOU, JUST_HAPPENED_LINE]) {
    const answer = await save(entry, `${entry} Changed.`);

    assert.deepEqual([answer.status, answer.outcome], [403, "outside-epics"], entry);
  }
  assert.deepEqual(await filesBesideThePage(room), before);
});

test("a removal of an entry outside Epics is refused and leaves the page alone", async (t) => {
  const room = await roomHolding(t, PAGE);
  const before = await filesBesideThePage(room);

  for (const entry of [FLOUR_DEAL, NEEDS_YOU, JUST_HAPPENED_LINE]) {
    const answer = await save(entry, "");

    assert.deepEqual([answer.status, answer.outcome], [403, "outside-epics"], entry);
  }
  assert.deepEqual(await filesBesideThePage(room), before);
});

test("a save reaching across the Epics heading is refused and leaves the page alone", async (t) => {
  const room = await roomHolding(t, PAGE);
  const before = await filesBesideThePage(room);

  const answer = await save(`## On GitHub\n\n## Epics`, "## On GitHub\n\n### tillreport\n\n## Epics");

  assert.deepEqual([answer.status, answer.outcome], [403, "outside-epics"]);
  assert.deepEqual(await filesBesideThePage(room), before);
});

test("a save that adds, edits or removes an epic still works", async (t) => {
  const room = await roomHolding(t, PAGE);
  const firstEpic = "### Buy flour in bulk";

  const added = await save("## Epics", `## Epics\n\n${firstEpic}`);
  const edited = await save(SECOND_BAKERY, SECOND_BAKERY_MOVED);
  const removed = await save(firstEpic, "");

  assert.deepEqual([added, edited, removed].map((answer) => [answer.status, answer.outcome]), [
    [200, "saved"],
    [200, "saved"],
    [200, "saved"],
  ]);
  assert.equal(await readPageOrEmptyFrame(room), PAGE.replace(SECOND_BAKERY, SECOND_BAKERY_MOVED));
  const journal = await readJournal(room.dataHome);
  assert.deepEqual(journal.slice(-3).map((record) => record.writer), ["Lord", "Lord", "Lord"]);
});

test("a long epic saves through the api as it does through the save command", async (t) => {
  const room = await roomHolding(t, PAGE);
  const longEpic = `### Open the second bakery\n\n${"Find a site near the station. ".repeat(10_000)}`;

  const answer = await save(SECOND_BAKERY, longEpic);

  assert.deepEqual([answer.status, answer.outcome], [200, "saved"]);
  assert.equal(await readPageOrEmptyFrame(room), PAGE.replace(SECOND_BAKERY, longEpic));
});

test("an agent can still edit any entry under the lock", async (t) => {
  const room = await roomHolding(t, PAGE);
  const changed = PAGE.replace("signed", "torn up").replace(JUST_HAPPENED_LINE, "- filed flourdeal").replace("station", "market");

  const exitCode = await lockEditAndRelease(room, () => changed);

  assert.equal(exitCode, WhereIStandExitCode.Done);
  assert.equal(await readPageOrEmptyFrame(room), changed);
  assert.equal((await readJournal(room.dataHome)).at(-1)?.writer, AGENT);
});

test("a save through the api reports an unrecorded edit to the Regent", async (t) => {
  const room = await roomHolding(t, PAGE);
  await editThePageDirectly(room, (content) => content.replace("signed", "torn up"));
  await rm(regentMessagesFile, { force: true });

  const answer = await save(SECOND_BAKERY, SECOND_BAKERY_MOVED);

  assert.equal(answer.outcome, "saved");
  assert.match(await readFile(regentMessagesFile, "utf8"), /^send-agent Regent .*was changed with no lock held/);
  const writers = (await readJournal(room.dataHome)).slice(-2).map((record) => record.writer);
  assert.deepEqual(writers, [UNRECORDED_WRITER, "Lord"]);
});
