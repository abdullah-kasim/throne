import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { git, initRepo } from "./git-repo-test-fixture.ts";
import { openRegentQueueAmendments } from "../src/regent-queue/regent-queue-amendments.ts";
import { openRegentQueueStore } from "../src/regent-queue/regent-queue.store.ts";
import { runBriefCommand, type BriefCommandRunner } from "../src/situation-brief/brief-command-runner.ts";
import { citedCommitTokens } from "../src/situation-brief/cited-commits.ts";
import { readOpenPullRequests } from "../src/situation-brief/open-pull-requests.ts";
import { readRepositorySituation } from "../src/situation-brief/repository-situation.ts";
import { readSiblingObjectives, rulingLinesOf } from "../src/situation-brief/sibling-objectives.ts";
import {
  composeSituationBrief,
  INFORMATIONAL_SIZE_LIMIT_BYTES,
  SITUATION_BRIEF_HEADING,
} from "../src/situation-brief/situation-brief-composer.ts";
import { composeSituationBriefForObjective } from "../src/situation-brief/situation-brief-runtime.ts";
import type { QueueAmendment } from "../src/regent-queue/regent-queue-amendments.ts";
import type { RegentQueueItemRow } from "../src/regent-queue/regent-queue.store.ts";

const cleanup: string[] = [];
test.after(async () => {
  for (const dir of cleanup) await rm(dir, { recursive: true, force: true });
});

async function commitFile(repo: string, name: string, text: string): Promise<string> {
  await writeFile(path.join(repo, name), text, "utf8");
  await git(repo, ["add", name]);
  await git(repo, ["commit", "--no-gpg-sign", "-q", "-m", `add ${name}`]);
  return git(repo, ["rev-parse", "HEAD"]);
}

async function repoWithOrigin(prefix: string): Promise<{ repo: string; remote: string }> {
  const repo = await initRepo(prefix);
  const remote = await mkdtemp(path.join(tmpdir(), `${prefix}remote-`));
  cleanup.push(repo, remote);
  await git(remote, ["init", "-q", "--bare"]);
  await git(repo, ["remote", "add", "origin", remote]);
  await git(repo, ["push", "-q", "origin", "main"]);
  return { repo, remote };
}

const withoutGitHub: BriefCommandRunner = (file, args, cwd, timeout) =>
  file === "gh" ? Promise.resolve({ ok: false, detail: "gh is not available in this test" }) : runBriefCommand(file, args, cwd, timeout);

test("a local branch left on a diverged commit is flagged, with the remote difference counted", async () => {
  const { repo } = await repoWithOrigin("brief-diverged-");
  const fork = await git(repo, ["rev-parse", "HEAD"]);
  await git(repo, ["checkout", "-q", "-b", "add/feature"]);
  const published = await commitFile(repo, "published.txt", "published\n");
  await git(repo, ["push", "-q", "origin", "add/feature"]);
  await git(repo, ["reset", "-q", "--hard", fork]);
  await commitFile(repo, "stale.txt", "stale\n");
  await git(repo, ["checkout", "-q", "main"]);

  const section = await readRepositorySituation(runBriefCommand, { repository: repo, branch: "add/feature", filedBase: published });
  const text = section.lines.join("\n");
  assert.match(text, /WARNING: the local tip does NOT contain the filed base/);
  assert.match(text, /DIFFERS from the local tip: 1 commit\(s\) only local, 1 commit\(s\) only on origin/);
});

test("a local branch equal to origin and to the filed base says so plainly", async () => {
  const { repo } = await repoWithOrigin("brief-equal-");
  const tip = await git(repo, ["rev-parse", "HEAD"]);
  const section = await readRepositorySituation(runBriefCommand, { repository: repo, branch: "main", filedBase: tip });
  const text = section.lines.join("\n");
  assert.match(text, new RegExp(`The filed base ${tip} IS the local tip`));
  assert.match(text, /identical to the local tip/);
  assert.match(text, /Checked out in: /);
  assert.doesNotMatch(text, /WARNING/);
});

test("a branch that exists only on origin is reported as not yet local", async () => {
  const { repo } = await repoWithOrigin("brief-remote-only-");
  await git(repo, ["checkout", "-q", "-b", "add/remote-only"]);
  const tip = await commitFile(repo, "remote.txt", "remote\n");
  await git(repo, ["push", "-q", "origin", "add/remote-only"]);
  await git(repo, ["checkout", "-q", "main"]);
  await git(repo, ["branch", "-q", "-D", "add/remote-only"]);
  const text = (await readRepositorySituation(runBriefCommand, { repository: repo, branch: "add/remote-only", filedBase: tip })).lines.join("\n");
  assert.match(text, new RegExp(`does not exist locally yet; it will be created at the filed base ${tip}`));
  assert.match(text, new RegExp(`Remote tip: ${tip}; there is no local branch to compare`));
});

test("a directory that is not a repository gets one honest line", async () => {
  const plain = await mkdtemp(path.join(tmpdir(), "brief-not-a-repo-"));
  cleanup.push(plain);
  const section = await readRepositorySituation(runBriefCommand, { repository: plain, branch: "main", filedBase: null });
  assert.deepEqual(section.lines, [`No git repository at ${plain}, so there are no repository facts to report.`]);
});

test("an unreachable origin is reported as unavailable rather than failing the brief", async () => {
  const repo = await initRepo("brief-no-origin-");
  cleanup.push(repo);
  const tip = await git(repo, ["rev-parse", "HEAD"]);
  const text = (await readRepositorySituation(runBriefCommand, { repository: repo, branch: "main", filedBase: tip })).lines.join("\n");
  assert.match(text, /Remote tip: unavailable/);
});

test("open pull requests are kept when they share the branch or a file the body names", async () => {
  const listing = JSON.stringify([
    { number: 7873, title: "Same branch", headRefName: "add/feature", url: "https://example.test/7873", files: [] },
    { number: 12, title: "Shares a file", headRefName: "other", url: "https://example.test/12", files: [{ path: "src/routes/metadata.ts" }] },
    { number: 13, title: "Unrelated", headRefName: "elsewhere", url: "https://example.test/13", files: [{ path: "README.md" }] },
  ]);
  const runner: BriefCommandRunner = async () => ({ ok: true, stdout: listing });
  const section = await readOpenPullRequests(runner, {
    repository: "/repo",
    branch: "add/feature",
    body: "SCOPE: touch src/routes/metadata.ts only",
  });
  assert.deepEqual(section.lines, [
    "- #7873 Same branch (add/feature; this branch) https://example.test/7873",
    "- #12 Shares a file (other; files: src/routes/metadata.ts) https://example.test/12",
  ]);
  const failing: BriefCommandRunner = async () => ({ ok: false, detail: "gh: not logged in" });
  assert.deepEqual((await readOpenPullRequests(failing, { repository: "/repo", branch: "b", body: "" })).lines, ["Unavailable (gh: not logged in)."]);
});

test("ruling lines and cited commits are extracted from a plan body", () => {
  const body = [
    "INTENT: do it",
    "RULINGS:",
    "- Lord, 2026-09-17: no retries on 429.",
    "- Lord: save the back-off.",
    "VERIFIED-NOUNS: a4b268b235 and c2603cd3a561 and 2026091 and deadbeef and a4b268b",
  ].join("\n");
  assert.deepEqual(rulingLinesOf(body), ["- Lord, 2026-09-17: no retries on 429.", "- Lord: save the back-off."]);
  assert.deepEqual(citedCommitTokens(body), ["a4b268b235", "c2603cd3a561"]);
  assert.deepEqual(rulingLinesOf("INTENT: nothing"), []);
});

function row(overrides: Partial<RegentQueueItemRow>): RegentQueueItemRow {
  return {
    id: overrides.objectiveCode ?? "id",
    objectiveCode: null,
    status: "open",
    body: "INTENT: x",
    prBranch: null,
    agentName: null,
    targetRepo: null,
    baseCommit: null,
    deliveryCommit: null,
    deliveryMirror: { verdict: "unknown", deliveryCommit: null, targetRepo: null, targetBranch: null, treeIdentity: null, checkedAt: null, reason: null },
    absorption: null,
    deferral: null,
    priority: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as RegentQueueItemRow;
}

test("siblings are rows on the same repository or branch that are live or finished within a week", () => {
  const now = 30 * 24 * 60 * 60 * 1000;
  const self = row({ objectiveCode: "self", status: "in-flight", targetRepo: "/repo", prBranch: "add/a", updatedAt: now });
  const rows = [
    self,
    row({ objectiveCode: "samerepo", status: "in-flight", targetRepo: "/repo", prBranch: "add/b", updatedAt: now - 1000, body: "RULINGS: - keep it small" }),
    row({ objectiveCode: "samebranch", status: "complete", targetRepo: "/other", prBranch: "add/a", updatedAt: now - 2 * 24 * 60 * 60 * 1000 }),
    row({ objectiveCode: "oldnews", status: "complete", targetRepo: "/repo", updatedAt: 0 }),
    row({ objectiveCode: "unrelated", status: "in-flight", targetRepo: "/else", prBranch: "add/z", updatedAt: now }),
  ];
  const lines = readSiblingObjectives(rows, self, now).lines;
  assert.deepEqual(lines, [
    "- samerepo (in-flight, branch add/b)",
    "  > - keep it small",
    "- samebranch (complete, branch add/a)",
  ]);
});

function amendment(number: number, text: string): QueueAmendment {
  return { objectiveCode: "self", number, text, wordsOf: "Lord", relayedBy: "stager-test", rowStatusWhenRecorded: "open", recordedAt: 0 };
}

test("amendments are always printed in full, and only informational lines are trimmed to stay under the limit", () => {
  const longAmendment = "x".repeat(INFORMATIONAL_SIZE_LIMIT_BYTES * 2);
  const brief = composeSituationBrief({
    objectiveCode: "self",
    composedAt: "2026-09-17T00:00:00.000Z",
    amendments: [amendment(1, "first"), amendment(2, longAmendment)],
    sections: [
      { title: "Repository", trimmable: false, lines: ["kept line"] },
      { title: "Other queue work", trimmable: true, lines: Array.from({ length: 200 }, (_, index) => `- sibling ${index} ${"y".repeat(40)}`) },
    ],
  });
  assert.ok(brief.startsWith(SITUATION_BRIEF_HEADING));
  assert.ok(brief.includes(longAmendment));
  assert.match(brief, /\*\*Queue amendments reconciled through:\*\* 2/);
  assert.match(brief, /kept line/);
  assert.match(brief, /- sibling 0 /);
  assert.doesNotMatch(brief, /- sibling 199 /);
  assert.match(brief, /older line\(s\) were left out/);
  const informational = brief.slice(brief.indexOf("### Repository"));
  assert.ok(Buffer.byteLength(informational, "utf8") < INFORMATIONAL_SIZE_LIMIT_BYTES + 400, String(Buffer.byteLength(informational, "utf8")));
});

test("a brief with no amendments says delivery waits on reconciling any that arrive later", () => {
  const brief = composeSituationBrief({ objectiveCode: "self", composedAt: "t", amendments: [], sections: [] });
  assert.match(brief, /None yet\. If one is recorded while you work you will be messaged/);
  assert.doesNotMatch(brief, /left out/);
});

test("the whole brief is composed from a real queue row, its amendments and its repository", async () => {
  const { repo } = await repoWithOrigin("brief-end-to-end-");
  const base = await git(repo, ["rev-parse", "HEAD"]);
  const dir = await mkdtemp(path.join(tmpdir(), "brief-queue-"));
  cleanup.push(dir);
  const queueFile = path.join(dir, "queue.sqlite3");
  const store = openRegentQueueStore(queueFile);
  store.insertItem({
    objectiveCode: "wired",
    body: `INTENT: wire it\nRULINGS: - Lord: be brief\nVERIFIED-NOUNS: ${base.slice(0, 10)}`,
    launch: { alphaName: "alpha-wired-01", targetRepo: repo, targetBranch: "main", baseCommit: base },
  });
  store.close();
  const amendments = openRegentQueueAmendments(queueFile);
  amendments.record({ objectiveCode: "wired", text: "also do the other thing", wordsOf: "Lord", relayedBy: "stager-test" });
  amendments.close();

  const brief = await composeSituationBriefForObjective("wired", {
    openStore: () => openRegentQueueStore(queueFile),
    openAmendments: () => openRegentQueueAmendments(queueFile),
    runCommand: withoutGitHub,
    now: () => Date.parse("2026-09-17T12:00:00Z"),
  });
  assert.match(brief, /Composed 2026-09-17T12:00:00.000Z for queue row "wired"/);
  assert.match(brief, /AMENDMENT 1 \(words of Lord, relayed by stager-test, recorded while open\):\n\nalso do the other thing/);
  assert.match(brief, /### Repository/);
  assert.match(brief, /### Other queue work on the same repository or branch\n\nNone in the queue/);
  assert.match(brief, /Unavailable \(gh is not available in this test\)/);
  assert.match(brief, new RegExp(`- ${base.slice(0, 10)}: still the tip of "main"`));
});

test("a code with no queue row yields a short brief that says so", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "brief-missing-"));
  cleanup.push(dir);
  const queueFile = path.join(dir, "queue.sqlite3");
  const brief = await composeSituationBriefForObjective("ghost", {
    openStore: () => openRegentQueueStore(queueFile),
    openAmendments: () => openRegentQueueAmendments(queueFile),
    runCommand: withoutGitHub,
    now: () => 0,
  });
  assert.match(brief, /no queue row is named "ghost"/);
});

test("situation-brief refuses anything but exactly --objective-code <code>", async () => {
  const { run } = await import("../src/situation-brief/situation-brief-runtime.ts");
  const dir = await mkdtemp(path.join(tmpdir(), "brief-refusal-"));
  cleanup.push(dir);
  const queueFile = path.join(dir, "queue.sqlite3");
  const dependencies = {
    openStore: () => openRegentQueueStore(queueFile),
    openAmendments: () => openRegentQueueAmendments(queueFile),
    runCommand: withoutGitHub,
    now: () => 0,
  };
  for (const args of [[], ["--objective-code"], ["--code", "wired"], ["--objective-code", "not a code!"], ["--objective-code", "wired", "--extra"]]) {
    const errors: string[] = [];
    const outputs: string[] = [];
    const exitCode = await run(args, dependencies, (message) => outputs.push(message), (message) => errors.push(message));
    assert.equal(exitCode, 1, JSON.stringify(args));
    assert.match(errors.join(""), /expected exactly --objective-code <code>/, JSON.stringify(args));
    assert.equal(outputs.length, 0, JSON.stringify(args));
  }
});

test("sibling lines are trimmed before pull requests and cited commits, and an unlimited brief keeps everything", () => {
  const sections = [
    { title: "Repository", trimmable: false, lines: ["repository facts"] },
    { title: "Other queue work", trimmable: true, lines: Array.from({ length: 150 }, (_, index) => `- sibling ${index} ${"s".repeat(40)}`) },
    { title: "Open pull requests", trimmable: true, lines: ["- #1 the pull request that matters"] },
    { title: "Commits the body cites", trimmable: true, lines: ["- abc1234: still the tip", "- def5678: moved 2 commit(s)"] },
  ];
  const capped = composeSituationBrief({ objectiveCode: "self", composedAt: "t", amendments: [], sections });
  assert.match(capped, /- #1 the pull request that matters/);
  assert.match(capped, /- abc1234: still the tip/);
  assert.match(capped, /- def5678: moved 2 commit\(s\)/);
  assert.doesNotMatch(capped, /- sibling 149 /);
  assert.match(capped, /left out/);

  const unlimited = composeSituationBrief({ objectiveCode: "self", composedAt: "t", amendments: [], sections, sizeLimitBytes: Number.POSITIVE_INFINITY });
  assert.match(unlimited, /- sibling 149 /);
  assert.doesNotMatch(unlimited, /left out/);
});

test("a filed base that is not a commit at all is named as a wrong hash, not as a stale branch", async () => {
  const { repo } = await repoWithOrigin("brief-fake-base-");
  const text = (
    await readRepositorySituation(runBriefCommand, {
      repository: repo,
      branch: "main",
      filedBase: "a4b268b235cfb1fd2cdb44e3db8b2b1f65e1e7a0",
    })
  ).lines.join("\n");
  assert.match(text, /the filed base a4b268b235cfb1fd2cdb44e3db8b2b1f65e1e7a0 is not a commit in this repository at all/);
  assert.doesNotMatch(text, /does NOT contain/);
});
