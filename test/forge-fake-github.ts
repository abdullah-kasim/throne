import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const FAKE_GITHUB_REPOSITORY = "example-bakery/staging-demo";

export interface FakeGithubComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
}

export interface FakeGithubThread {
  id: string;
  resolved: boolean;
  path: string;
  line: number | null;
  originalLine: number;
  comments: FakeGithubComment[];
}

export interface FakeGithubPullRequest {
  number: number;
  url: string;
  title: string;
  body: string;
  base: string;
  head: string;
  draft: boolean;
  state?: string;
  headSha?: string;
  mergedAt?: string;
  mergeCommit?: string;
  threads: FakeGithubThread[];
  issueComments: FakeGithubComment[];
  reviews: Array<FakeGithubComment & { state: string }>;
}

export interface FakeGithubState {
  nextId: number;
  pullRequests: FakeGithubPullRequest[];
  calls: string[][];
  media?: Record<string, string>;
}

export interface FakeGithub {
  readonly binDirectory: string;
  read(): Promise<FakeGithubState>;
  write(state: FakeGithubState): Promise<void>;
  mutatingCalls(): Promise<string[][]>;
  remove(): Promise<void>;
}

const FAKE_GH_SCRIPT = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const statePath = process.env.FAKE_GH_STATE;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);
state.calls.push(args);
const save = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
const rest = args[0] === "--bypass" ? args.slice(1) : args;
const option = (name) => { const at = rest.indexOf(name); return at < 0 ? undefined : rest[at + 1]; };
const options = (name) => rest.flatMap((value, at) => (value === name ? [rest[at + 1]] : []));
const pullRequestOf = (text) => state.pullRequests.find((pull) => pull.url === text || String(pull.number) === String(text) || pull.head === text);
const nextId = () => (state.nextId += 1);
const print = (value) => process.stdout.write(typeof value === "string" ? value + "\n" : JSON.stringify(value) + "\n");
const now = () => new Date(Date.UTC(2026, 9, 7, 12, 0, state.nextId % 60)).toISOString();
const [command, sub] = rest;
if (command === "--version") { print("gh version 2.99.0 (2026-09-01)"); save(); process.exit(0); }
if (command === "pr" && sub === "create") {
  const number = state.pullRequests.length + 7;
  const pull = { number, url: "https://github.com/" + process.env.FAKE_GH_REPOSITORY + "/pull/" + number, title: option("--title"), body: fs.readFileSync(option("--body-file"), "utf8"), base: option("--base"), head: option("--head"), draft: rest.includes("--draft"), threads: [], issueComments: [], reviews: [] };
  state.pullRequests.push(pull); save(); print(pull.url); process.exit(0);
}
if (command === "pr" && sub === "view") {
  const pull = pullRequestOf(rest[2]);
  if (!pull) { process.stderr.write("no pull request " + rest[2] + "\n"); save(); process.exit(1); }
  const fields = { number: pull.number, url: pull.url, title: pull.title, body: pull.body, state: pull.state ?? "OPEN", isDraft: pull.draft, headRefName: pull.head, baseRefName: pull.base, headRefOid: pull.headSha ?? "", mergedAt: pull.mergedAt ?? null, mergeCommit: pull.mergeCommit ? { oid: pull.mergeCommit } : null };
  save();
  if (option("-q") === ".body") { print(pull.body); process.exit(0); }
  print(Object.fromEntries(option("--json").split(",").map((field) => [field, fields[field]])));
  process.exit(0);
}
if (command === "pr" && sub === "edit") {
  const pull = pullRequestOf(rest[2]);
  let body = fs.readFileSync(path.resolve(option("--body-file")), "utf8");
  for (const attached of options("--attach")) {
    const name = attached.split("#")[0];
    body = body.split("(" + name + ")").join("(https://github.com/user-attachments/assets/" + nextId() + ")");
  }
  pull.body = body; save(); print(pull.url); process.exit(0);
}
if (command === "pr" && sub === "list") { save(); print([]); process.exit(0); }
if (command === "pr" && sub === "merge") { pullRequestOf(rest[2]).state = "MERGED"; save(); process.exit(0); }
if (command === "repo" && sub === "view") { save(); print("main"); process.exit(0); }
if (command === "api" && sub === "graphql") {
  const query = option("-f").slice("query=".length);
  const resolving = /resolveReviewThread\(input:\{threadId:"([^"]+)"\}\)/.exec(query);
  if (resolving) {
    const thread = state.pullRequests.flatMap((pull) => pull.threads).find((candidate) => candidate.id === resolving[1]);
    thread.resolved = true; save(); print({ data: { resolveReviewThread: { thread: { isResolved: true } } } }); process.exit(0);
  }
  const pull = state.pullRequests.find((candidate) => candidate.number === Number(/pullRequest\(number:(\d+)\)/.exec(query)[1]));
  const nodes = pull.threads.map((thread) => ({ id: thread.id, isResolved: thread.resolved, isOutdated: thread.line === null, path: thread.path, line: thread.line, originalLine: thread.originalLine, comments: { nodes: thread.comments.map((comment) => ({ databaseId: comment.id, author: { login: comment.author }, createdAt: comment.createdAt, body: comment.body })) } }));
  save(); print({ data: { repository: { pullRequest: { number: pull.number, title: pull.title, state: "OPEN", headRefName: pull.head, baseRefName: pull.base, reviewThreads: { nodes } } } } }); process.exit(0);
}
if (command === "api" && /^https:\/\//.test(sub)) {
  const media = (state.media ?? {})[sub];
  save();
  if (media === undefined) { process.stderr.write("HTTP 404: Not Found (" + sub + ")\n"); process.exit(1); }
  process.stdout.write(media); process.exit(0);
}
if (command === "api") {
  const route = /^repos\/[^/]+\/[^/]+\/(issues|pulls)\/(\d+)\/(comments|reviews)$/.exec(sub);
  const pull = state.pullRequests.find((candidate) => candidate.number === Number(route[2]));
  const body = options("-f").find((field) => field.startsWith("body="))?.slice("body=".length);
  if (body === undefined) {
    save();
    if (route[3] === "reviews") print(pull.reviews.map((review) => ({ id: review.id, user: { login: review.author }, state: review.state, submitted_at: review.createdAt, body: review.body })));
    else print(pull.issueComments.map((comment) => ({ id: comment.id, user: { login: comment.author }, created_at: comment.createdAt, body: comment.body })));
    process.exit(0);
  }
  const comment = { id: nextId(), author: "court-owner", body, createdAt: now() };
  const replyTo = options("-F").find((field) => field.startsWith("in_reply_to="));
  if (replyTo) pull.threads.find((thread) => thread.comments.some((candidate) => candidate.id === Number(replyTo.slice("in_reply_to=".length)))).comments.push(comment);
  else pull.issueComments.push(comment);
  save(); print({ id: comment.id }); process.exit(0);
}
process.stderr.write("fake gh does not know: " + args.join(" ") + "\n"); save(); process.exit(1);
`;

function isMutatingCall(args: readonly string[]): boolean {
  const rest = args[0] === "--bypass" ? args.slice(1) : args;
  if (rest[0] === "pr") return ["create", "edit", "comment", "merge", "close", "ready"].includes(rest[1] ?? "");
  if (rest[0] === "api") return rest.some((value) => value.startsWith("body=") || value.startsWith("query=mutation"));
  return false;
}

export async function installFakeGithub(): Promise<FakeGithub> {
  const binDirectory = await mkdtemp(path.join(tmpdir(), "fake-github-"));
  const statePath = path.join(binDirectory, "state.json");
  const ghPath = path.join(binDirectory, "gh");
  await writeFile(ghPath, FAKE_GH_SCRIPT);
  await chmod(ghPath, 0o755);
  await writeFile(statePath, JSON.stringify({ nextId: 1000, pullRequests: [], calls: [] }));
  const previous = { PATH: process.env.PATH, FAKE_GH_STATE: process.env.FAKE_GH_STATE, FAKE_GH_REPOSITORY: process.env.FAKE_GH_REPOSITORY };
  process.env.PATH = `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`;
  process.env.FAKE_GH_STATE = statePath;
  process.env.FAKE_GH_REPOSITORY = FAKE_GITHUB_REPOSITORY;
  const read = async () => JSON.parse(await readFile(statePath, "utf8")) as FakeGithubState;
  return {
    binDirectory,
    read,
    write: (state) => writeFile(statePath, JSON.stringify(state, null, 2)),
    async mutatingCalls() {
      return (await read()).calls.filter(isMutatingCall);
    },
    async remove() {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(binDirectory, { recursive: true, force: true });
    },
  };
}
