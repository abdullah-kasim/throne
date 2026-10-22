import { readFile } from "node:fs/promises";
import path from "node:path";
import { parentPort } from "node:worker_threads";
import { startCommandAnsweringServer, type CommandAnswerer } from "./commands-answered-in-this-process.ts";
import { FAKE_GITHUB_REPOSITORY, type FakeGithubPullRequest, type FakeGithubState, type FakeGithubWorkerReply, type FakeGithubWorkerRequest } from "./forge-fake-github.ts";

class GithubCallFailure extends Error {}

async function answerGithubCall(state: FakeGithubState, args: readonly string[], callerDirectory: string): Promise<string> {
  state.calls.push([...args]);
  const rest = args[0] === "--bypass" ? args.slice(1) : args;
  const option = (name: string) => {
    const at = rest.indexOf(name);
    return at < 0 ? undefined : rest[at + 1];
  };
  const options = (name: string) => rest.flatMap((value, at) => (value === name ? [rest[at + 1]!] : []));
  const pullRequestOf = (text: string | undefined) =>
    state.pullRequests.find((pull) => pull.url === text || String(pull.number) === String(text) || pull.head === text);
  const nextId = () => (state.nextId += 1);
  const printed = (value: unknown) => (typeof value === "string" ? value + "\n" : JSON.stringify(value) + "\n");
  const now = () => new Date(Date.UTC(2026, 9, 7, 12, 0, state.nextId % 60)).toISOString();
  const readCallerFile = (file: string) => readFile(path.resolve(callerDirectory, file), "utf8");
  const [command, sub] = rest;
  if (command === "--version") return printed("gh version 2.99.0 (2026-09-01)");
  if (command === "pr" && sub === "create") {
    const number = state.pullRequests.length + 7;
    const pull: FakeGithubPullRequest = {
      number,
      url: `https://github.com/${FAKE_GITHUB_REPOSITORY}/pull/${number}`,
      title: option("--title")!,
      body: await readCallerFile(option("--body-file")!),
      base: option("--base")!,
      head: option("--head")!,
      draft: rest.includes("--draft"),
      threads: [],
      issueComments: [],
      reviews: [],
    };
    state.pullRequests.push(pull);
    return printed(pull.url);
  }
  if (command === "pr" && sub === "view") {
    const pull = pullRequestOf(rest[2]);
    if (!pull) throw new GithubCallFailure(`no pull request ${rest[2]}\n`);
    const fields: Record<string, unknown> = {
      number: pull.number,
      url: pull.url,
      title: pull.title,
      body: pull.body,
      state: pull.state ?? "OPEN",
      isDraft: pull.draft,
      headRefName: pull.head,
      baseRefName: pull.base,
      headRefOid: pull.headSha ?? "",
      mergedAt: pull.mergedAt ?? null,
      mergeCommit: pull.mergeCommit ? { oid: pull.mergeCommit } : null,
    };
    if (option("-q") === ".body") return printed(pull.body);
    return printed(Object.fromEntries(option("--json")!.split(",").map((field) => [field, fields[field]])));
  }
  if (command === "pr" && sub === "edit") {
    const pull = pullRequestOf(rest[2])!;
    let body = await readCallerFile(option("--body-file")!);
    for (const attached of options("--attach")) {
      const name = attached.split("#")[0];
      body = body.split("(" + name + ")").join("(https://github.com/user-attachments/assets/" + nextId() + ")");
    }
    pull.body = body;
    return printed(pull.url);
  }
  if (command === "pr" && sub === "ready") {
    pullRequestOf(rest[2])!.draft = false;
    return "";
  }
  if (command === "pr" && sub === "list") return printed([]);
  if (command === "pr" && sub === "merge") {
    pullRequestOf(rest[2])!.state = "MERGED";
    return "";
  }
  if (command === "repo" && sub === "view") return printed("main");
  if (command === "api" && sub === "graphql") {
    const query = option("-f")!.slice("query=".length);
    const resolving = /resolveReviewThread\(input:\{threadId:"([^"]+)"\}\)/.exec(query);
    if (resolving) {
      const thread = state.pullRequests.flatMap((pull) => pull.threads).find((candidate) => candidate.id === resolving[1])!;
      thread.resolved = true;
      return printed({ data: { resolveReviewThread: { thread: { isResolved: true } } } });
    }
    const pull = state.pullRequests.find((candidate) => candidate.number === Number(/pullRequest\(number:(\d+)\)/.exec(query)![1]))!;
    const nodes = pull.threads.map((thread) => ({
      id: thread.id,
      isResolved: thread.resolved,
      isOutdated: thread.line === null,
      path: thread.path,
      line: thread.line,
      originalLine: thread.originalLine,
      comments: { nodes: thread.comments.map((comment) => ({ databaseId: comment.id, author: { login: comment.author }, createdAt: comment.createdAt, body: comment.body })) },
    }));
    return printed({
      data: { repository: { pullRequest: { number: pull.number, title: pull.title, state: "OPEN", headRefName: pull.head, baseRefName: pull.base, reviewThreads: { nodes } } } },
    });
  }
  if (command === "api" && /^https:\/\//.test(sub ?? "")) {
    const media = (state.media ?? {})[sub!];
    if (media === undefined) throw new GithubCallFailure(`HTTP 404: Not Found (${sub})\n`);
    return media;
  }
  if (command === "api") {
    const route = /^repos\/[^/]+\/[^/]+\/(issues|pulls)\/(\d+)\/(comments|reviews)$/.exec(sub ?? "")!;
    const pull = state.pullRequests.find((candidate) => candidate.number === Number(route[2]))!;
    const body = options("-f").find((field) => field.startsWith("body="))?.slice("body=".length);
    if (body === undefined) {
      if (route[3] === "reviews") {
        return printed(pull.reviews.map((review) => ({ id: review.id, user: { login: review.author }, state: review.state, submitted_at: review.createdAt, body: review.body })));
      }
      return printed(pull.issueComments.map((comment) => ({ id: comment.id, user: { login: comment.author }, created_at: comment.createdAt, body: comment.body })));
    }
    const comment = { id: nextId(), author: "court-owner", body, createdAt: now() };
    const replyTo = options("-F").find((field) => field.startsWith("in_reply_to="));
    if (replyTo) {
      const repliedId = Number(replyTo.slice("in_reply_to=".length));
      pull.threads.find((thread) => thread.comments.some((candidate) => candidate.id === repliedId))!.comments.push(comment);
    } else pull.issueComments.push(comment);
    return printed({ id: comment.id });
  }
  throw new GithubCallFailure(`fake gh does not know: ${args.join(" ")}\n`);
}

function emptyGithubState(): FakeGithubState {
  return { nextId: 1000, pullRequests: [], calls: [] };
}

let state = emptyGithubState();

const answerGithub: CommandAnswerer = async (args, callerDirectory) => {
  const working = structuredClone(state);
  try {
    const stdout = await answerGithubCall(working, args, callerDirectory);
    state = working;
    return { exitCode: 0, stdout, stderr: "" };
  } catch (error) {
    if (error instanceof GithubCallFailure) {
      state.calls.push([...args]);
      return { exitCode: 1, stdout: "", stderr: error.message };
    }
    return { exitCode: 1, stdout: "", stderr: `${String(error)}\n` };
  }
};

function answerRequest(request: FakeGithubWorkerRequest): FakeGithubWorkerReply {
  if (request.kind === "write") state = request.state!;
  return { id: request.id, state };
}

const server = await startCommandAnsweringServer({ gh: answerGithub, ghe: answerGithub });
parentPort!.on("message", (request: FakeGithubWorkerRequest) => parentPort!.postMessage(answerRequest(request)));
parentPort!.postMessage({ port: (server.address() as { port: number }).port });
