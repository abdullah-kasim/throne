import { expect, test, type Page } from "@playwright/test";

const PINNED_NOW = new Date("2026-11-12T15:00:00.000Z");

async function openThePage(page: Page, hash: string, requests: string[] = []) {
  page.on("request", (request) => requests.push(request.url()));
  await page.clock.install({ time: PINNED_NOW });
  await page.goto(`/throne/where-i-stand/${hash}`, { waitUntil: "networkidle" });
}

test("B3.1 B3.6 the fixture's tabs come from the store and Now carries its Needs you count", async ({ page }) => {
  await openThePage(page, "#now");
  await expect(page.getByRole("tab")).toHaveText([/^Now/, /^Epics/, /^Queue/, /^Delivered/, /^Pull requests/, /^Archive$/]);
  await expect(page.getByRole("tab", { name: /^Now, \d+ items, 2 needs you$/ })).toBeVisible();
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByRole("tab", { selected: true })).toHaveText(/^Now/);
});

test("B3.3 the Oven work subsection sits inside In flight", async ({ page }) => {
  await openThePage(page, "#now");
  await expect(page.locator("section", { has: page.getByRole("heading", { level: 2, name: "In flight" }) }).getByRole("heading", { level: 3, name: "Oven work" })).toBeVisible();
});

test("B2.5 archived rows are fetched only when a spoiler opens and the journal never is", async ({ page }) => {
  const requests: string[] = [];
  await openThePage(page, "#now", requests);
  expect(requests.filter((url) => /archived-rows|journal/.test(url))).toEqual([]);
  await page.getByRole("button", { name: /^Archived \(/ }).first().click();
  await expect(page.getByText(/^archived .*, deleted in /).first()).toBeVisible();
  expect(requests.filter((url) => /archived-rows/.test(url))).toHaveLength(1);
  expect(requests.filter((url) => /journal/.test(url))).toEqual([]);
});

test("B5.1 B5.3 rows show their ages from the pinned clock", async ({ page }) => {
  await openThePage(page, "#now");
  await expect(page.getByRole("button", { name: /^written 5 days ago, changed 2 hours ago/ })).toBeVisible();
});

test("B5.7 ages advance with the clock while the page stays open", async ({ page }) => {
  await openThePage(page, "#now");
  await expect(page.getByRole("button", { name: /^written 30 minutes ago/ })).toBeVisible();
  await page.clock.runFor(5 * 60_000);
  await expect(page.getByRole("button", { name: /^written 35 minutes ago/ })).toBeVisible();
});

test("B1.4 B1.3 archiving a row moves it to the spoiler and restoring brings it back across a reload", async ({ page }) => {
  await openThePage(page, "#queue");
  await page.getByRole("button", { name: "Archive alpha-flour" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Archive" }).click();
  await expect(page.getByRole("heading", { name: "alpha-flour" })).toHaveCount(0);
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "alpha-flour" })).toHaveCount(0);
  await page.locator("section", { has: page.getByRole("heading", { level: 2, name: "Queued and deferred" }) }).getByRole("button", { name: /^Archived \(/ }).click();
  await page.getByRole("button", { name: "Restore alpha-flour" }).click();
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 3, name: "alpha-flour" })).toBeVisible();
});

test("B7.3 an event line's Archive button is reached by Tab, shows when focused, and Escape returns focus to it", async ({ page }) => {
  await openThePage(page, "#now");
  const firstEvent = page.locator(".events li").first();
  const archiveButton = firstEvent.getByRole("button", { name: /^Archive / });
  await firstEvent.locator(".row-age button").focus();
  await page.keyboard.press("Tab");
  await expect(archiveButton).toBeFocused();
  await expect(archiveButton).toHaveCSS("opacity", "1");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(archiveButton).toBeFocused();
});

test("B7.4 the work table lists In flight rows after Needs you and names a subsection's rows by their top section", async ({ page }) => {
  await openThePage(page, "#pull-requests");
  const whereItStands = await page.locator(".work tbody tr td[data-label='Where it stands'] > :first-child").allTextContents();
  const firstInFlight = whereItStands.indexOf("In flight");
  expect(firstInFlight).toBeGreaterThan(-1);
  expect(firstInFlight).toBeLessThan(whereItStands.indexOf("On GitHub"));
  expect(whereItStands).not.toContain("Oven work");
});

test("#archive opens a read-only whole-archive view grouped by section, fetching archived rows only when it opens", async ({ page }) => {
  const requests: string[] = [];
  await openThePage(page, "#now", requests);
  expect(requests.filter((url) => /archived-rows/.test(url))).toEqual([]);
  await page.getByRole("tab", { name: "Archive" }).click();
  await expect(page).toHaveURL(/#archive$/);
  const panel = page.getByRole("tabpanel");
  await expect(panel.getByRole("heading", { level: 2 }).first()).toBeVisible();
  await expect(panel.getByText(/^archived .*, deleted in /).first()).toBeVisible();
  await expect(panel.getByRole("button", { name: /^Restore / }).first()).toBeVisible();
  expect(requests.filter((url) => /archived-rows/.test(url)).length).toBeGreaterThan(0);
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByRole("tab", { selected: true })).toHaveText("Archive");
});

test("on a phone a row's age and Archive button stay inside its card", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openThePage(page, "#now");
  const overflowing = await page.locator(".where-i-stand .unit-controls").evaluateAll((controls) =>
    controls.filter((control) => {
      const card = control.closest("section")!.getBoundingClientRect();
      return Array.from(control.children).some((child) => child.getBoundingClientRect().right > card.right + 0.5);
    }).length,
  );
  expect(overflowing).toBe(0);
});

test("restoring a row by keyboard on the Archive tab leaves focus on the Archive tab, not on the page body", async ({ page, request }) => {
  await page.goto("/throne/where-i-stand/#archive", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Restore alpha-delivered-22" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Restore alpha-delivered-22" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Archive" })).toBeFocused();
  const restored = (await (await request.get("/api/where-i-stand/store/page")).json()).rows.find((row: { code: string }) => row.code === "alpha-delivered-22");
  expect((await (await request.post(`/api/where-i-stand/store/rows/${restored.id}/archive`, { data: { writer: "Lord" } })).json()).outcome).toBe("done");
});
