import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { startScratchListener } from "../web-listener/web-listener.test-support.ts";

const FILE_TIME = new Date("2026-10-14T09:30:00.000Z");
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

function recordsFile(): string {
  return path.join(scratch, "cache", "where-i-stand", "where-i-stand-prs.json");
}

async function writeRecords(content: string): Promise<void> {
  await mkdir(path.dirname(recordsFile()), { recursive: true });
  await writeFile(recordsFile(), content);
  await utimes(recordsFile(), FILE_TIME, FILE_TIME);
}

function get(urlPath: string): Promise<Response> {
  return fetch(`${address}/api/where-i-stand/${urlPath}`);
}

before(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), "where-i-stand-api-"));
  process.env.XDG_CACHE_HOME = path.join(scratch, "cache");
  ({ listener, address } = await startScratchListener(scratch));
});

after(async () => {
  await listener.close();
  await rm(scratch, { recursive: true, force: true });
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
