import { expect, test, type APIRequestContext } from "@playwright/test";

const PINNED_NOW = new Date("2026-11-12T15:00:00.000Z");
const EPIC_CHANGED_WORDS = "Not saved: this epic changed since it was loaded, and nothing was overwritten. Here is the current one.";

interface EpicRow {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
  readonly changedAt: string;
  readonly archivedAt: string | null;
}

async function liveEpics(request: APIRequestContext): Promise<EpicRow[]> {
  const page = await (await request.get("/api/where-i-stand/store/page")).json();
  return page.rows.filter((row: EpicRow) => row.kind === "epic" && row.archivedAt === null);
}

async function agentChangesNotes(request: APIRequestContext, epic: EpicRow, notes: string) {
  const current = (await liveEpics(request)).find((row) => row.id === epic.id)!;
  const answer = await request.put(`/api/where-i-stand/store/rows/${epic.id}`, {
    data: { writer: "alpha-e2e-agent", row: { freeLines: [notes] }, loadedChangedAt: current.changedAt },
  });
  expect((await answer.json()).outcome).toBe("done");
}

test("B7.1 F7 the Lord's epic save is refused only when that epic changed since he loaded it, and his words are kept", async ({ page, request }) => {
  const [mine, other] = await liveEpics(request);
  await page.clock.install({ time: PINNED_NOW });
  await page.goto("/throne/where-i-stand/#epics", { waitUntil: "networkidle" });
  const label = `${mine.text} epic`;

  await page.getByRole("button", { name: `Edit ${label}` }).click();
  await page.getByRole("textbox", { name: label }).fill("the Lord's first words");
  await agentChangesNotes(request, other, "an agent changed a sibling epic");
  await page.getByRole("button", { name: `Save ${label}` }).click();
  await expect(page.getByText("an agent changed a sibling epic")).toHaveCount(0);
  await expect(page.getByRole("button", { name: `Save ${label}` })).toHaveCount(0);

  await page.getByRole("textbox", { name: label }).fill("the Lord's second words");
  await agentChangesNotes(request, mine, "an agent changed this epic");
  await agentChangesNotes(request, mine, "an agent changed this epic again in the same moment");
  await page.getByRole("button", { name: `Save ${label}` }).click();
  await expect(page.getByText(EPIC_CHANGED_WORDS)).toBeVisible();
  await expect(page.getByRole("textbox", { name: label })).toHaveValue(/an agent changed this epic again in the same moment/);
  await expect(page.getByText("the Lord's second words")).toBeVisible();
});

test("a refused epic save reaches the page with no console or page errors", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
  page.on("pageerror", (error) => errors.push(String(error)));
  const [mine] = await liveEpics(request);
  await page.clock.install({ time: PINNED_NOW });
  await page.goto("/throne/where-i-stand/#epics", { waitUntil: "networkidle" });
  const label = `${mine.text} epic`;

  await page.getByRole("button", { name: `Edit ${label}` }).click();
  await page.getByRole("textbox", { name: label }).fill("the Lord's refused words");
  await agentChangesNotes(request, mine, "an agent changed this epic first");
  await page.getByRole("button", { name: `Save ${label}` }).click();
  await expect(page.getByText(EPIC_CHANGED_WORDS)).toBeVisible();
  await expect(page.getByText("the Lord's refused words")).toBeVisible();
  expect(errors).toEqual([]);
});
