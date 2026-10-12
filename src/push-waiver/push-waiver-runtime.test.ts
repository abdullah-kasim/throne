import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { git, initRepo } from "../../test/git-repo-test-fixture.ts";
import { PushWaiverExitCode, run, type PushWaiverDependencies } from "./push-waiver-runtime.ts";

const AGENT = "shadow-recipes-01";
const FINDINGS = [
  "high src/search-api.ts:2 Calls an endpoint the server does not serve",
  "medium src/list.ts:1 Load more retries silently",
  "low src/search.ts:3 Empty query is not handled",
].join("\n");

interface Court {
  readonly root: string;
  readonly dataHome: string;
  readonly checkout: string;
  readonly ledger: string;
  readonly baseCommit: string;
  readonly otherPullRequestHead: string;
  readonly pushedCommit: string;
  readonly strangerRepo: string;
}

let court: Court;

async function commitFile(repo: string, relativePath: string, content: string, message: string): Promise<string> {
  await mkdir(path.dirname(path.join(repo, relativePath)), { recursive: true });
  await writeFile(path.join(repo, relativePath), content);
  await git(repo, ["add", relativePath]);
  await git(repo, ["commit", "--no-gpg-sign", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

before(async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "push-waiver-")));
  const dataHome = path.join(root, "court-home");
  const origin = await initRepo("push-waiver-origin-");
  const baseCommit = await commitFile(origin, "src/list.ts", "export const loadMore = retrySilently;\n", "list");
  await git(origin, ["checkout", "-b", "search-api"]);
  const otherPullRequestHead = await commitFile(origin, "src/search-api.ts", "export function route() {\n  return '/search';\n}\n", "search api");
  await git(origin, ["checkout", "main"]);
  const checkout = path.join(dataHome, "worktrees", "recipes", AGENT);
  await mkdir(path.dirname(checkout), { recursive: true });
  await git(root, ["clone", "--quiet", "--no-local", origin, checkout]);
  await git(checkout, ["config", "user.email", "test@throne.local"]);
  await git(checkout, ["config", "user.name", "Throne Test"]);
  await git(checkout, ["fetch", "--quiet", "origin", "search-api"]);
  await git(checkout, ["checkout", "--quiet", "-b", "recipe-search"]);
  const pushedCommit = await commitFile(checkout, "src/search.ts", "export function search(query) {\n  if (query === '') return [];\n  return find(query);\n}\n", "search");
  const ledger = path.join(dataHome, "data", AGENT);
  await mkdir(ledger, { recursive: true });
  await writeFile(path.join(ledger, "identity.md"), `# Identity — ${AGENT}\n\n- **Role:** Shadow\n`);
  const strangerRepo = path.join(root, "elsewhere", AGENT);
  await mkdir(path.dirname(strangerRepo), { recursive: true });
  await git(root, ["clone", "--quiet", "--no-local", checkout, strangerRepo]);
  court = { root, dataHome, checkout, ledger, baseCommit, otherPullRequestHead, pushedCommit, strangerRepo };
});

after(async () => {
  await rm(court.root, { recursive: true, force: true });
});

function soundEntries(): object[] {
  return [
    { finding: 1, reason: "other-open-pr", pr: 202, commit: court.otherPullRequestHead, location: "src/search-api.ts:2" },
    { finding: 2, reason: "already-on-base", commit: court.baseCommit, location: "src/list.ts:1" },
    { finding: 3, reason: "finding-wrong", location: "src/search.ts:2" },
  ];
}

async function waive(options: { entries?: object[]; findings?: string; repo?: string }): Promise<{ code: number; out: string; err: string }> {
  const scratch = await mkdtemp(path.join(court.root, "waiver-input-"));
  const findingsFile = path.join(scratch, "findings.txt");
  const entriesFile = path.join(scratch, "entries.json");
  await writeFile(findingsFile, options.findings ?? FINDINGS);
  await writeFile(entriesFile, JSON.stringify(options.entries ?? soundEntries()));
  const outputs: string[] = [];
  const errors: string[] = [];
  const dependencies: PushWaiverDependencies = {
    dataHome: court.dataHome,
    now: () => new Date("2026-10-05T12:00:00Z"),
    out: (message) => outputs.push(message),
    err: (message) => errors.push(message),
  };
  const code = await run(
    ["--repo", options.repo ?? court.checkout, "--remote", "origin", "--ref", "recipe-search", "--findings-file", findingsFile, "--entries-file", entriesFile],
    dependencies,
  );
  return { code, out: outputs.join(""), err: errors.join("") };
}

async function waiverFiles(): Promise<string[]> {
  const entries = await readdir(path.join(court.ledger, "push-waivers"), { recursive: true }).catch(() => []);
  return entries.filter((entry) => entry.endsWith(".json")).sort();
}

async function assertRefusedWithNothingWritten(
  options: Parameters<typeof waive>[0],
  expectedReason: RegExp,
): Promise<void> {
  const filesBefore = await waiverFiles();
  const result = await waive(options);
  assert.equal(result.code, PushWaiverExitCode.Refused, result.err);
  assert.match(result.err, expectedReason);
  assert.equal(result.out, "");
  assert.deepEqual(await waiverFiles(), filesBefore);
}

test("a waiver records every finding's reason and prints the one push command to run", async () => {
  const result = await waive({});
  assert.equal(result.code, PushWaiverExitCode.Written, result.err);
  const recordPath = path.join(court.ledger, "push-waivers", "origin", "recipe-search", `${court.pushedCommit}.json`);
  assert.match(result.out, new RegExp(`waiver written to ${recordPath}`));
  assert.match(result.out, /finding 1: high src\/search-api\.ts:2 Calls an endpoint the server does not serve — other-open-pr: pull request #202/);
  assert.match(result.out, /finding 2: medium src\/list\.ts:1 .* — already-on-base: base /);
  assert.match(result.out, /finding 3: low src\/search\.ts:3 .* — finding-wrong: the pushed commit already handles it at src\/search\.ts:2/);
  assert.ok(result.out.includes(`git -C ${court.checkout} push --no-verify origin recipe-search\n`));
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  assert.equal(record.agent, AGENT);
  assert.equal(record.commit, court.pushedCommit);
  assert.equal(record.remote, "origin");
  assert.equal(record.ref, "recipe-search");
  assert.equal(record.findings.length, 3);
  assert.deepEqual(record.entries.map((entry: { reason: string }) => entry.reason), ["other-open-pr", "already-on-base", "finding-wrong"]);
  assert.equal(record.entries[0].location, "src/search-api.ts:2");
});

test("a waiver accepts the check's JSON report and a passing test name as evidence", async () => {
  const findings = JSON.stringify({ findings: [{ severity: "low", path: "src/search.ts", line: 3, message: "Empty query is not handled" }] });
  const result = await waive({ findings, entries: [{ finding: 1, reason: "finding-wrong", test: "an empty query returns no recipes" }] });
  assert.equal(result.code, PushWaiverExitCode.Written, result.err);
  assert.match(result.out, /finding 1: low src\/search\.ts:3 Empty query is not handled — finding-wrong: the test "an empty query returns no recipes" passes/);
});

test("a waiver is refused when a finding has no entry", async () => {
  await assertRefusedWithNothingWritten({ entries: soundEntries().slice(0, 2) }, /finding 3 .* has no entry/);
});

test("a waiver is refused when two entries name the same finding or one names a finding that does not exist", async () => {
  await assertRefusedWithNothingWritten({ entries: [...soundEntries(), soundEntries()[0]!] }, /finding 1 has more than one entry/);
  await assertRefusedWithNothingWritten(
    { entries: [...soundEntries(), { finding: 4, reason: "finding-wrong", test: "x" }] },
    /names finding 4, but the findings file holds only 3/,
  );
});

test("a waiver is refused for a reason that is not one of the three allowed", async () => {
  const entries = soundEntries();
  entries[1] = { finding: 2, reason: "looks-fine", commit: court.baseCommit, location: "src/list.ts:1" };
  await assertRefusedWithNothingWritten({ entries }, /"looks-fine", which is not allowed.*other-open-pr, already-on-base, finding-wrong/);
});

test("a waiver is refused when an evidence commit does not resolve", async () => {
  const entries = soundEntries();
  entries[0] = { finding: 1, reason: "other-open-pr", pr: 202, commit: "0123456789abcdef0123456789abcdef01234567", location: "src/search-api.ts:2" };
  await assertRefusedWithNothingWritten({ entries }, /cites commit 0123456789abcdef0123456789abcdef01234567, which does not resolve/);
});

test("a waiver is refused when the cited file:line does not exist at that commit", async () => {
  const pastTheEnd = soundEntries();
  pastTheEnd[1] = { finding: 2, reason: "already-on-base", commit: court.baseCommit, location: "src/list.ts:2" };
  await assertRefusedWithNothingWritten({ entries: pastTheEnd }, /cites src\/list\.ts:2, which does not exist at commit/);
  const missingFile = soundEntries();
  missingFile[0] = { finding: 1, reason: "other-open-pr", pr: 202, commit: court.baseCommit, location: "src/search-api.ts:2" };
  await assertRefusedWithNothingWritten({ entries: missingFile }, /cites src\/search-api\.ts:2, which does not exist at commit/);
  const notInPushedCommit = soundEntries();
  notInPushedCommit[2] = { finding: 3, reason: "finding-wrong", location: "src/search.ts:9" };
  await assertRefusedWithNothingWritten({ entries: notInPushedCommit }, /cites src\/search\.ts:9, which does not exist at commit/);
});

test("a waiver is refused when the evidence is empty or malformed", async () => {
  const noCommit = soundEntries();
  noCommit[1] = { finding: 2, reason: "already-on-base", commit: " ", location: "src/list.ts:1" };
  await assertRefusedWithNothingWritten({ entries: noCommit }, /finding 2 has empty evidence: "commit"/);
  const noEvidence = soundEntries();
  noEvidence[2] = { finding: 3, reason: "finding-wrong" };
  await assertRefusedWithNothingWritten({ entries: noEvidence }, /finding 3 has empty evidence: "test"/);
  const noPullRequest = soundEntries();
  noPullRequest[0] = { finding: 1, reason: "other-open-pr", commit: court.otherPullRequestHead, location: "src/search-api.ts:2" };
  await assertRefusedWithNothingWritten({ entries: noPullRequest }, /"pr" must be the other pull request's number/);
  const badLocation = soundEntries();
  badLocation[1] = { finding: 2, reason: "already-on-base", commit: court.baseCommit, location: "src/list.ts" };
  await assertRefusedWithNothingWritten({ entries: badLocation }, /malformed location "src\/list\.ts": expected path:line/);
});

test("a waiver is refused when the findings file holds a line that is not a finding", async () => {
  await assertRefusedWithNothingWritten({ findings: `${FINDINGS}\nthe review took 12 seconds` }, /findings file line 4 is not a finding/);
  await assertRefusedWithNothingWritten({ findings: `${FINDINGS}\nhigh src/search.ts:3` }, /findings file line 4 is not a finding/);
  await assertRefusedWithNothingWritten({ findings: `${FINDINGS}\n12 src/search.ts:3 Empty query` }, /findings file line 4 is not a finding/);
});

test("a waiver is refused outside a court checkout, even when an agent of the same name has a ledger", async () => {
  await assertRefusedWithNothingWritten({ repo: court.strangerRepo }, /is not a court checkout/);
});

test("a waiver is refused for a checkout under the court's worktrees that has no ledger identity", async () => {
  const unregistered = path.join(court.dataHome, "worktrees", "recipes", "shadow-unregistered-01");
  await git(court.root, ["clone", "--quiet", "--no-local", court.checkout, unregistered]);
  const result = await waive({ repo: unregistered });
  assert.equal(result.code, PushWaiverExitCode.Refused);
  assert.match(result.err, /is not a court checkout/);
  await assert.rejects(readdir(path.join(court.dataHome, "data", "shadow-unregistered-01")));
});
