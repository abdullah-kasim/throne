import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { versionOf } from "./page-frame.ts";
import { JournalAction, readJournal } from "./page-journal.ts";
import { runWhereIStand, saveChangeFromThePage, WhereIStandExitCode, type WhereIStandDependencies } from "./where-i-stand-runtime.ts";
import {
  entry,
  filesBesideThePage,
  lockEditAndRelease,
  pageRoom,
  pageWith,
  readPageOrEmptyFrame,
  WRITTEN_AT,
  type PageRoom,
} from "./where-i-stand.test-support.ts";

const OVEN_QUEUE = "### ovenqueue\n\n- Links: no pull request · ovenqueue · Ticket no ticket\n\nThe oven queue is **baking** with `bake-time` on [the board](https://example.com/board).";
const TILL_REPORT = "### tillreport\n\nThe till report is in flight.";
const FLOUR_DEAL = "### flourdeal\n\nThe flour deal is signed.";
const HEADING_ONLY_EPIC = "### ryeflour";
const SEEDED_PAGE = pageWith({
  "## Just happened": "\n- filed ovenqueue\n- launched tillreport\n- merged breadlabels\n",
  "## In flight": `\n${FLOUR_DEAL}\n`,
  "## Epics": `\n${OVEN_QUEUE}\n\n${TILL_REPORT}\n`,
});

interface SaveAnswer {
  readonly exitCode: number;
  readonly outcome: string;
  readonly message: string;
}

async function seededRoom(t: TestContext): Promise<PageRoom> {
  const room = await pageRoom(t, {
    currentAgentName: async () => {
      throw new Error("the page's save never asks who the caller is");
    },
  });
  await lockEditAndRelease(room, () => SEEDED_PAGE, { currentAgentName: async () => "alpha-bakery-01" });
  room.printed.length = 0;
  return room;
}

async function saveFromThePage(
  room: PageRoom,
  loaded: string,
  edited: string,
  extra: Partial<WhereIStandDependencies> = {},
): Promise<SaveAnswer> {
  const printedBefore = room.printed.length;
  const exitCode = await runWhereIStand(["save"], {
    ...room.dependencies,
    readStandardInput: async () => JSON.stringify({ loaded, edited }),
    ...extra,
  });
  const lines = room.printed.slice(printedBefore).join("").split("\n").filter((line) => line !== "");
  assert.equal(lines.length, 1);
  const answer = JSON.parse(lines[0] ?? "{}") as { outcome: string; message: string };
  return { exitCode, outcome: answer.outcome, message: answer.message };
}

test("the Lord's save from the page replaces one epic and is journaled with the writer Lord", async (t) => {
  const room = await seededRoom(t);
  const edited = OVEN_QUEUE.replace("is **baking**", "is **out of the oven**");

  const answer = await saveFromThePage(room, OVEN_QUEUE, edited);

  assert.deepEqual([answer.exitCode, answer.outcome], [WhereIStandExitCode.Done, "saved"]);
  const page = await readPageOrEmptyFrame(room);
  assert.equal(page, SEEDED_PAGE.replace(OVEN_QUEUE, edited));
  assert.deepEqual((await readJournal(room.dataHome)).at(-1), {
    at: WRITTEN_AT.toISOString(),
    writer: "Lord",
    action: JournalAction.Edit,
    version: versionOf(page),
    added: [],
    changed: ["Epics: ovenqueue"],
    removed: [],
  });
});

test("the Lord can remove a whole epic from the page", async (t) => {
  const room = await seededRoom(t);

  const removedEpic = await saveFromThePage(room, OVEN_QUEUE, "");

  assert.equal(removedEpic.outcome, "saved");
  assert.equal(await readPageOrEmptyFrame(room), SEEDED_PAGE.replace(`${OVEN_QUEUE}\n\n`, ""));
  const newest = (await readJournal(room.dataHome)).at(-1);
  assert.deepEqual([newest?.writer, newest?.removed], ["Lord", ["Epics: ovenqueue"]]);
});

test("the last epic on the page can be removed", async (t) => {
  const room = await seededRoom(t);

  const answer = await saveFromThePage(room, TILL_REPORT, "");

  assert.equal(answer.outcome, "saved");
  assert.doesNotMatch(await readPageOrEmptyFrame(room), /### tillreport/);
});

test("removing an epic that gained lines since it was read refuses and leaves them where they are", async (t) => {
  for (const [epic, gained] of [
    [OVEN_QUEUE, `${OVEN_QUEUE}\n\nThe mill sent word.`],
    [TILL_REPORT, `${TILL_REPORT}\n- Counted twice.`],
    [HEADING_ONLY_EPIC, `${HEADING_ONLY_EPIC}\n\nThe mill sent word.`],
  ] as const) {
    const room = await seededRoom(t);
    await lockEditAndRelease(room, (content) => `${content.trimEnd()}\n\n${HEADING_ONLY_EPIC}\n`.replace(epic, gained), {
      currentAgentName: async () => "alpha-bakery-01",
    });
    const before = await filesBesideThePage(room);

    const answer = await saveFromThePage(room, epic, "");

    assert.deepEqual([answer.exitCode, answer.outcome], [WhereIStandExitCode.Refused, "entry-changed"]);
    assert.match(answer.message, /changed since/);
    assert.deepEqual(await filesBesideThePage(room), before);
  }
});

test("a removal stops at a heading the page reads as the next epic, however it is indented", async (t) => {
  const room = await seededRoom(t);
  await lockEditAndRelease(room, (content) => `${content.trimEnd()}\n\n  ### indentedepic\n`, {
    currentAgentName: async () => "alpha-bakery-01",
  });

  const answer = await saveFromThePage(room, TILL_REPORT, "");

  assert.equal(answer.outcome, "saved");
  assert.match(await readPageOrEmptyFrame(room), /### indentedepic/);
});

test("adding an epic and saving notes still work when the page holds lines below the matched text", async (t) => {
  const room = await seededRoom(t);
  const gained = `${TILL_REPORT}\n\nThe mill sent word.`;
  await lockEditAndRelease(room, (content) => content.replace(TILL_REPORT, gained), {
    currentAgentName: async () => "alpha-bakery-01",
  });

  const added = await saveFromThePage(room, "## Epics", `## Epics\n\n${HEADING_ONLY_EPIC}`);
  const notesSaved = await saveFromThePage(room, TILL_REPORT, TILL_REPORT.replace("in flight", "counted"));

  assert.deepEqual([added.outcome, notesSaved.outcome], ["saved", "saved"]);
  const page = await readPageOrEmptyFrame(room);
  assert.match(page, /## Epics\n\n### ryeflour\n\n### ovenqueue/);
  assert.match(page, /The till report is counted\.\n\nThe mill sent word\./);
});

const CHANGES_OUTSIDE_THE_EPICS: Record<string, { loaded: string; edited: string }> = {
  "an edit to an entry": { loaded: FLOUR_DEAL, edited: FLOUR_DEAL.replace("signed", "torn up") },
  "a removal of an entry": { loaded: FLOUR_DEAL, edited: "" },
  "an edit to a Just happened line": { loaded: "- launched tillreport", edited: "- launched tillreport twice" },
  "a removal of a Just happened line": { loaded: "- launched tillreport", edited: "" },
};

for (const [change, { loaded, edited }] of Object.entries(CHANGES_OUTSIDE_THE_EPICS)) {
  test(`${change} outside Epics is refused by the save command, written nowhere and journaled nowhere`, async (t) => {
    const room = await seededRoom(t);
    const before = await filesBesideThePage(room);

    const answer = await saveFromThePage(room, loaded, edited);

    assert.deepEqual([answer.exitCode, answer.outcome], [WhereIStandExitCode.Refused, "outside-epics"]);
    assert.match(answer.message, /epics only/);
    assert.deepEqual(await filesBesideThePage(room), before);
  });
}

test("a save whose entry an agent changed since the page loaded is refused and leaves the page unchanged", async (t) => {
  const room = await seededRoom(t);
  await lockEditAndRelease(room, (content) => content.replace("is **baking**", "is **cooling**"), {
    currentAgentName: async () => "alpha-bakery-01",
  });
  const before = await filesBesideThePage(room);

  const answer = await saveFromThePage(room, OVEN_QUEUE, OVEN_QUEUE.replace("is **baking**", "is **sold**"));

  assert.deepEqual([answer.exitCode, answer.outcome], [WhereIStandExitCode.Refused, "entry-changed"]);
  assert.match(answer.message, /changed since/);
  assert.deepEqual(await filesBesideThePage(room), before);
});

test("a save of an entry the page holds twice is refused in words that say so and leaves the page unchanged", async (t) => {
  for (const edited of [`${TILL_REPORT}\n\nMore.`, ""]) {
    const room = await seededRoom(t);
    await lockEditAndRelease(room, (content) => content.replace(TILL_REPORT, `${TILL_REPORT}\n\n${TILL_REPORT}`), {
      currentAgentName: async () => "alpha-bakery-01",
    });
    const before = await filesBesideThePage(room);

    const answer = await saveFromThePage(room, TILL_REPORT, edited);

    assert.deepEqual([answer.exitCode, answer.outcome], [WhereIStandExitCode.Refused, "entry-repeated"]);
    assert.match(answer.message, /more than once/);
    assert.deepEqual(await filesBesideThePage(room), before);
  }
});

test("an entry named by its place saves and goes on its own beside a longer namesake", async (t) => {
  const namesake = `${HEADING_ONLY_EPIC}\n\nThe mill sent word.`;
  for (const [order, headingOccurrence, edited, expected] of [
    [`${HEADING_ONLY_EPIC}\n\n${namesake}`, 1, `${HEADING_ONLY_EPIC}\n\nNew.`, `${HEADING_ONLY_EPIC}\n\nNew.\n\n${namesake}`],
    [`${namesake}\n\n${HEADING_ONLY_EPIC}`, 2, `${HEADING_ONLY_EPIC}\n\nNew.`, `${namesake}\n\n${HEADING_ONLY_EPIC}\n\nNew.`],
    [`${HEADING_ONLY_EPIC}\n\n${namesake}`, 1, "", namesake],
    [`${namesake}\n\n${HEADING_ONLY_EPIC}`, 2, "", namesake],
  ] as const) {
    const room = await seededRoom(t);
    await lockEditAndRelease(room, (content) => content.replace(TILL_REPORT, order), {
      currentAgentName: async () => "alpha-bakery-01",
    });

    const answer = await saveChangeFromThePage({ loaded: HEADING_ONLY_EPIC, edited, headingOccurrence }, room.dependencies);

    assert.equal(answer.outcome, "saved");
    assert.ok((await readPageOrEmptyFrame(room)).includes(`${OVEN_QUEUE}\n\n${expected}\n`));
  }
});

const RYE_LINE = `${HEADING_ONLY_EPIC}\n\nline`;
const LONGER_RYE = `${RYE_LINE}\nmore`;
const CHANGED_RYE = `${HEADING_ONLY_EPIC}\n\nchanged by an agent`;
const TWO_PLACES_BEGINNING_WITH_THE_TEXT = [
  [`${LONGER_RYE}\n\n${RYE_LINE}`, RYE_LINE],
  [`${RYE_LINE}\n\n${LONGER_RYE}`, RYE_LINE],
  [`${CHANGED_RYE}\n\n${HEADING_ONLY_EPIC}`, HEADING_ONLY_EPIC],
  [`${HEADING_ONLY_EPIC}\n\n${CHANGED_RYE}`, HEADING_ONLY_EPIC],
] as const;

async function roomWithEpics(t: TestContext, epics: string): Promise<PageRoom> {
  const room = await seededRoom(t);
  await lockEditAndRelease(room, (content) => content.replace(TILL_REPORT, epics), {
    currentAgentName: async () => "alpha-bakery-01",
  });
  return room;
}

test("a save meant for one epic of a heading refuses when the text it matches belongs to the other", async (t) => {
  for (const [epics, loaded, headingOccurrence] of [
    [`${CHANGED_RYE}\n\n${LONGER_RYE}`, RYE_LINE, 1],
    [`${CHANGED_RYE}\n\n${RYE_LINE}`, RYE_LINE, 1],
    [`${RYE_LINE}\n\n${CHANGED_RYE}`, RYE_LINE, 2],
    [LONGER_RYE, RYE_LINE, 1],
    [`${CHANGED_RYE}\n\n${RYE_LINE}\n\n${RYE_LINE}`, RYE_LINE, 1],
  ] as const) {
    const room = await roomWithEpics(t, epics);
    const before = await filesBesideThePage(room);

    const answer = await saveChangeFromThePage({ loaded, edited: `${loaded}\n\nNew.`, headingOccurrence }, room.dependencies);

    assert.equal(answer.outcome, "entry-changed", epics);
    assert.deepEqual(await filesBesideThePage(room), before);
  }
});

test("a removal meant for one epic of a heading refuses when the text it matches belongs to the other", async (t) => {
  for (const [epics, loaded, headingOccurrence] of [
    [`${CHANGED_RYE}\n\n${RYE_LINE}`, RYE_LINE, 1],
    [`${RYE_LINE}\n\n${CHANGED_RYE}`, RYE_LINE, 2],
    [RYE_LINE, RYE_LINE, 2],
  ] as const) {
    const room = await roomWithEpics(t, epics);
    const before = await filesBesideThePage(room);

    const answer = await saveChangeFromThePage({ loaded, edited: "", headingOccurrence }, room.dependencies);

    assert.equal(answer.outcome, "entry-changed", epics);
    assert.deepEqual(await filesBesideThePage(room), before);
  }
});

test("a save naming the entry that holds the text lands on it", async (t) => {
  for (const [epics, loaded, headingOccurrence, expected] of [
    [`${RYE_LINE}\n\n${LONGER_RYE}`, RYE_LINE, 1, `${CHANGED_RYE}\n\n${LONGER_RYE}`],
    [`${LONGER_RYE}\n\n${RYE_LINE}`, RYE_LINE, 2, `${LONGER_RYE}\n\n${CHANGED_RYE}`],
  ] as const) {
    const room = await roomWithEpics(t, epics);

    const answer = await saveChangeFromThePage({ loaded, edited: CHANGED_RYE, headingOccurrence }, room.dependencies);

    assert.equal(answer.outcome, "saved");
    assert.ok((await readPageOrEmptyFrame(room)).includes(`${OVEN_QUEUE}\n\n${expected}\n`));
  }
});

test("a save naming one of two identical epics is still refused as repeated", async (t) => {
  const room = await roomWithEpics(t, `${RYE_LINE}\n\n${RYE_LINE}`);
  const before = await filesBesideThePage(room);

  const answer = await saveChangeFromThePage({ loaded: RYE_LINE, edited: CHANGED_RYE, headingOccurrence: 2 }, room.dependencies);

  assert.equal(answer.outcome, "entry-repeated");
  assert.deepEqual(await filesBesideThePage(room), before);
});

test("an entry of the same heading in another section does not move an epic's place", async (t) => {
  const room = await roomWithEpics(t, RYE_LINE);
  await lockEditAndRelease(room, (content) => content.replace(FLOUR_DEAL, `${FLOUR_DEAL}\n\n${LONGER_RYE}`), {
    currentAgentName: async () => "alpha-bakery-01",
  });

  const answer = await saveChangeFromThePage({ loaded: RYE_LINE, edited: CHANGED_RYE, headingOccurrence: 1 }, room.dependencies);

  assert.equal(answer.outcome, "saved");
  assert.ok((await readPageOrEmptyFrame(room)).includes(`${OVEN_QUEUE}\n\n${CHANGED_RYE}\n`));
});

test("a change outside the epics that names an entry is still refused as outside them", async (t) => {
  const room = await seededRoom(t);

  const answer = await saveChangeFromThePage({ loaded: FLOUR_DEAL, edited: `${FLOUR_DEAL}\n\nNew.`, headingOccurrence: 1 }, room.dependencies);

  assert.equal(answer.outcome, "outside-epics");
});

test("a save with no entry named behaves as before", async (t) => {
  const room = await roomWithEpics(t, `${CHANGED_RYE}\n\n${LONGER_RYE}`);

  const answer = await saveChangeFromThePage({ loaded: RYE_LINE, edited: `${HEADING_ONLY_EPIC}\n\nNew.` }, room.dependencies);

  assert.equal(answer.outcome, "saved");
  assert.ok((await readPageOrEmptyFrame(room)).includes(`${CHANGED_RYE}\n\n${HEADING_ONLY_EPIC}\n\nNew.\nmore\n`));
});

test("a save naming no entry refuses when two places begin with its text", async (t) => {
  for (const [epics, loaded] of TWO_PLACES_BEGINNING_WITH_THE_TEXT) {
    const room = await roomWithEpics(t, epics);
    const before = await filesBesideThePage(room);

    const answer = await saveChangeFromThePage({ loaded, edited: `${loaded}\n\nNew.` }, room.dependencies);

    assert.equal(answer.outcome, "entry-repeated", epics);
    assert.deepEqual(await filesBesideThePage(room), before);
  }
});

test("a removal naming no entry refuses when two places begin with its text", async (t) => {
  for (const [epics, loaded] of TWO_PLACES_BEGINNING_WITH_THE_TEXT) {
    const room = await roomWithEpics(t, epics);
    const before = await filesBesideThePage(room);

    const answer = await saveChangeFromThePage({ loaded, edited: "" }, room.dependencies);

    assert.equal(answer.outcome, "entry-repeated", epics);
    assert.deepEqual(await filesBesideThePage(room), before);
  }
});

test("a save is refused and leaves the page unchanged while another holder has the edit lock", async (t) => {
  const room = await seededRoom(t);
  let answer: SaveAnswer | undefined;
  let filesWhileHeld: Record<string, string> = {};
  let filesAfterTheSave: Record<string, string> = {};
  await runWhereIStand(["lock", "--checksum", versionOf(SEEDED_PAGE)], {
    ...room.dependencies,
    currentAgentName: async () => "alpha-florist-01",
    waitForRelease: async () => {
      filesWhileHeld = await filesBesideThePage(room);
      answer = await saveFromThePage(room, OVEN_QUEUE, "");
      filesAfterTheSave = await filesBesideThePage(room);
    },
  });

  assert.deepEqual([answer?.exitCode, answer?.outcome], [WhereIStandExitCode.Refused, "lock-held"]);
  assert.match(answer?.message ?? "", /alpha-florist-01/);
  assert.deepEqual(filesAfterTheSave, filesWhileHeld);
  assert.equal(await readPageOrEmptyFrame(room), SEEDED_PAGE);
});

test("a save that would break the page's frame is refused and leaves the page unchanged", async (t) => {
  const room = await seededRoom(t);
  const before = await filesBesideThePage(room);

  const answer = await saveFromThePage(room, TILL_REPORT, `${TILL_REPORT}\n\n## Needs you`);

  assert.deepEqual([answer.exitCode, answer.outcome], [WhereIStandExitCode.Refused, "frame-broken"]);
  assert.match(answer.message, /## Needs you/);
  assert.deepEqual(await filesBesideThePage(room), before);
});

test("saving an entry the Lord did not touch changes nothing and journals nothing", async (t) => {
  const room = await seededRoom(t);
  const before = await filesBesideThePage(room);

  const answer = await saveFromThePage(room, OVEN_QUEUE, OVEN_QUEUE);

  assert.deepEqual([answer.exitCode, answer.outcome], [WhereIStandExitCode.Done, "unchanged"]);
  assert.deepEqual(await filesBesideThePage(room), before);
});

test("an agent cannot lock or note the page under the name Lord", async (t) => {
  for (const name of ["Lord", "lord", "LORD"]) {
    const room = await seededRoom(t);
    const before = await filesBesideThePage(room);
    const callingAs = { ...room.dependencies, currentAgentName: async () => name };

    const exitCodes = [
      await runWhereIStand(["lock", "--checksum", versionOf(SEEDED_PAGE)], callingAs),
      await runWhereIStand(["note", "launched ovenqueue"], callingAs),
    ];

    assert.deepEqual(exitCodes, [WhereIStandExitCode.Refused, WhereIStandExitCode.Refused]);
    assert.match(room.complaints.join(""), /belongs to the Lord's own saves from the page/);
    assert.deepEqual(await filesBesideThePage(room), before);
  }
});

test("the Lord's save on a page holding a duplicate is kept and its answer names the duplicate", async (t) => {
  const room = await seededRoom(t);
  const sameLinks = "- Links: no pull request · flourdeal · Ticket BAKE-12";
  const duplicates = `### flourdeal\n\n${sameLinks}\n\n### flourorder\n\n${sameLinks}`;
  await lockEditAndRelease(room, (content) => content.replace(FLOUR_DEAL, duplicates), {
    currentAgentName: async () => "alpha-bakery-01",
  });
  room.printed.length = 0;

  const answer = await saveFromThePage(room, TILL_REPORT, TILL_REPORT.replace("in flight", "counted"));

  assert.deepEqual([answer.exitCode, answer.outcome], [WhereIStandExitCode.Done, "saved"]);
  assert.match(await readPageOrEmptyFrame(room), /The till report is counted\./);
  assert.match(answer.message, /^Saved; the page now holds your change\. These entries are about the same work: "### flourdeal" still says .* and "### flourorder" still says "- Links: no pull request · flourdeal · Ticket BAKE-12"/);
});
