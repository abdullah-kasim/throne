import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const VIEWPORTS = {
  desktop: { width: 1920, height: 1080 },
  phone: { width: 393, height: 852 },
};

const CHANGED_ELSEWHERE = " (changed elsewhere)";
const EDITED_WORDS = " (edited on the page)";
const EPIC_NOTE = "Find a street with morning foot traffic.";
const EPIC_TITLE = "Open a second bakery";

async function clickFirst(page, names) {
  for (const name of names) {
    const control = page.getByRole("button", { name }).first();
    if ((await control.count()) > 0 && (await control.isVisible())) {
      await control.click();
      return `clicked the button named ${name}`;
    }
  }
  return `no visible button named ${names.join(" or ")}`;
}

async function startEditingAnEpic(page) {
  const opened = await clickFirst(page, [new RegExp(`^Edit ${EPIC_TITLE}`), /^Edit /]);
  const editor = page.getByRole("textbox", { name: new RegExp(EPIC_TITLE) }).first();
  if ((await editor.count()) === 0) return `${opened}; no editor opened`;
  await editor.click();
  await editor.press("End");
  await editor.pressSequentially(EDITED_WORDS);
  return `${opened}; typed into the editor`;
}

async function changeTheEpicElsewhere(side) {
  const pagePath = path.join(side.dataHome, "where-i-stand.md");
  const markdown = await readFile(pagePath, "utf8");
  await writeFile(pagePath, markdown.replace(EPIC_NOTE, `${EPIC_NOTE}${CHANGED_ELSEWHERE}`));
  if (!side.hasStore) return;
  const base = `${side.address}/api/where-i-stand/store`;
  const page = await (await fetch(`${base}/page`)).json();
  const epic = page.rows.find((row) => row.kind === "epic" && row.text === EPIC_TITLE);
  if (epic === undefined) return;
  await fetch(`${base}/rows/${epic.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ writer: "evidence tool", row: { freeLines: [...epic.freeLines, CHANGED_ELSEWHERE.trim()] }, loadedChangedAt: epic.changedAt }),
  });
}

export const PRESETS = {
  now: { tab: "now" },
  epics: { tab: "epics" },
  queue: { tab: "queue" },
  delivered: { tab: "delivered" },
  "pull-requests": { tab: "pull-requests" },
  archive: { tab: "archive" },
  "spoiler-open": {
    tab: "now",
    act: async (page) => {
      const opened = await clickFirst(page, [/^Archived/]);
      await page.evaluate(() => window.scrollTo(0, 0));
      return opened;
    },
  },
  "archive-question": { tab: "now", referenceTab: "epics", act: (page) => clickFirst(page, [/^Archive /, /^Remove .* epic$/]) },
  "epic-editing": { tab: "epics", act: (page) => startEditingAnEpic(page) },
  "refused-save": {
    tab: "epics",
    act: async (page, side) => {
      const editing = await startEditingAnEpic(page);
      await changeTheEpicElsewhere(side);
      const saved = await clickFirst(page, [/^Save /]);
      await page.waitForTimeout(800);
      return `${editing}; changed the epic elsewhere; ${saved}`;
    },
  },
  "empty-section": { tab: "queue" },
};

export const PRESET_NAMES = Object.keys(PRESETS);
