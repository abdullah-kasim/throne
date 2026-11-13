import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { expect, test } from "@playwright/test";

const PINNED_NOW = new Date("2026-11-12T15:00:00.000Z");
const throneHome = path.join(process.env.WHERE_I_STAND_E2E_HOME!, "throne-home");

test("the running backend answers the where-i-stand listing for the fixture", async ({ request }) => {
  const listing = await (await request.get("/api/where-i-stand/store/listing")).json();
  expect(listing.tabs.map((tab: { name: string }) => tab.name)).toEqual(["Now", "Epics", "Queue", "Delivered", "Pull requests"]);
  expect(listing.listingToken).toMatch(/^[0-9a-f]{12}$/);
});

test("the page loads on the fixture with no console or page errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.clock.setFixedTime(PINNED_NOW);
  await page.goto("/throne/where-i-stand/#now", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "Where I stand", level: 1 })).toBeVisible();
  expect(errors).toEqual([]);
});

test("opening the database with --local gives the same listing and page as the running backend", async ({ request }) => {
  const script = [
    'const { connectToWhereIStand } = await import("./src/where-i-stand-store/where-i-stand-client.ts");',
    `const connection = connectToWhereIStand({ local: true, throneHome: ${JSON.stringify(throneHome)} });`,
    "const answer = { listing: await connection.operations.listing(), page: await connection.operations.page() };",
    "await connection.close();",
    "process.stdout.write(JSON.stringify(answer));",
  ].join("\n");
  const { stdout } = await promisify(execFile)("bun", ["-e", script], { encoding: "utf8" });
  const local = JSON.parse(stdout);
  expect(local.listing).toEqual(await (await request.get("/api/where-i-stand/store/listing")).json());
  const { now: _localNow, ...localPage } = local.page;
  const { now: _backendNow, ...backendPage } = await (await request.get("/api/where-i-stand/store/page")).json();
  expect(localPage).toEqual(backendPage);
});
