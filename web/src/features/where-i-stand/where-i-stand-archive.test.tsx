import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { EMPTY_ARCHIVE_WORDS } from "@/features/where-i-stand/archive-tab";
import { FakeBackend, openPage } from "@/features/where-i-stand/where-i-stand.test-support";

const ARCHIVED_ENTRY_NAME = "alpha-old-oven";
const ARCHIVE_MARKDOWN = `## Delivered, not on GitHub\n\n### ${ARCHIVED_ENTRY_NAME}\n- Links: no pull request\n- Kind: feature — The old oven\n- Where it stands: delivered\n`;

function backendWithArchive(): FakeBackend {
  const backend = new FakeBackend();
  backend.archiveMarkdown = ARCHIVE_MARKDOWN;
  return backend;
}

test("the Lord can open the archive from the where-i-stand page", async () => {
  const page = await openPage(backendWithArchive());

  await page.chooseTab("Archive");

  expect(await within(page.panel()).findByRole("heading", { level: 3, name: ARCHIVED_ENTRY_NAME })).toBeTruthy();
  expect(window.location.hash).toBe("#archive");
});

test("the archive shows archived entries read-only", async () => {
  const page = await openPage(backendWithArchive(), "#archive");

  await within(page.panel()).findByRole("heading", { level: 3, name: ARCHIVED_ENTRY_NAME });

  expect(within(page.panel()).queryAllByRole("button")).toEqual([]);
  expect(within(page.panel()).queryAllByRole("textbox")).toEqual([]);
  expect(page.panel().querySelector("[contenteditable]")).toBeNull();
});

test("an empty archive says so instead of failing", async () => {
  const page = await openPage(new FakeBackend(), "#archive");

  expect(await within(page.panel()).findByText(EMPTY_ARCHIVE_WORDS)).toBeTruthy();
  expect(screen.queryByText(/Could not fetch/)).toBeNull();
});
