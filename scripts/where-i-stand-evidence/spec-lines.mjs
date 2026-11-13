const PASS = "PASS";
const FAIL = "FAIL";

function line(id, passed, detail) {
  return { id, result: passed ? PASS : FAIL, detail };
}

async function readJson(url) {
  const response = await fetch(url);
  return response.ok ? response.json() : undefined;
}

export const EXPECTED_EXPIRED_CODES = ["alpha-expired"];

export async function storeSpecLines(address) {
  const base = `${address}/api/where-i-stand/store`;
  const listing = await readJson(`${base}/listing`);
  if (listing === undefined) {
    return ["B4.1", "B1.7", "B1.8", "B2.2"].map((id) => ({ id, result: "NOT VERIFIED", detail: "this tree serves no where-i-stand store routes" }));
  }
  const page = await readJson(`${base}/page`);
  const sectionNamed = (name) => listing.sections.find((section) => section.name === name);
  const liveIn = (name) => page.rows.filter((row) => row.sectionId === sectionNamed(name)?.id);
  const before = (await readJson(`${base}/page`)).rows.length;
  const dryRun = await (await fetch(`${base}/purge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dryRun: true, writer: "evidence tool" }) })).json();
  const after = (await readJson(`${base}/page`)).rows.length;
  const purgedWords = dryRun.purged.map((item) => item.words).sort();
  const everyIdListed = listing.tabs.every((tab) => /^t\d+$/.test(tab.id)) && listing.sections.every((section) => /^s\d+$/.test(section.id));
  return [
    line("B4.1", everyIdListed && listing.listingToken.length > 0, `${listing.tabs.length} tabs and ${listing.sections.length} sections, each with an id; listing token ${listing.listingToken}`),
    line("B1.7", liveIn("Just happened").length === 15, `${liveIn("Just happened").length} live event lines in Just happened`),
    line("B1.8", liveIn("Delivered, not on GitHub").length === 20, `${liveIn("Delivered, not on GitHub").length} live rows in Delivered`),
    line("B2.2", JSON.stringify(purgedWords) === JSON.stringify(EXPECTED_EXPIRED_CODES) && before === after, `the dry run lists ${JSON.stringify(purgedWords)}; live rows ${before} before and ${after} after`),
  ];
}

export function networkSpecLine(networkRequests, archiveWasOpened) {
  const journal = networkRequests.filter((url) => /journal/i.test(url));
  const archived = networkRequests.filter((url) => /archived-rows/.test(url));
  const passed = journal.length === 0 && (archiveWasOpened || archived.length === 0);
  return line("B2.5", passed, `${journal.length} journal requests; ${archived.length} archived-row requests${archiveWasOpened ? " after the archive was opened" : " with the archive never opened"}`);
}
