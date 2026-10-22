import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { gitInBare, serveGitOverHttp } from "./forge-fake-forgejo-git.ts";
import { EMPTY_SNAPSHOT, replaceContents, replaceEntries, type FakeForgejoSnapshot, type FakeForgejoState } from "./forge-fake-forgejo-snapshot.ts";

export const FAKE_FORGEJO_ADMIN = "court-admin";
export const FAKE_FORGEJO_ADMIN_PASSWORD = "test-admin-password-7d1e";
const SESSION_COOKIE_NAME = "session";
const SIGNED_OUT_SESSION = "fake-signed-out-session";
const SIGNED_IN_SESSION = "fake-admin-session";
const FIRST_REVIEW_ID = 5001;
const FIRST_REVIEW_COMMENT_ID = 10001;
const TARGET_NOT_FOUND = { message: "The target couldn't be found." };

export interface FakeReview {
  readonly id: number;
  readonly repository: string;
  readonly number: number;
  readonly body: string;
}

export interface FakeReviewComment {
  readonly id: number;
  readonly reviewId: number;
  readonly repository: string;
  readonly number: number;
  readonly path: string;
  readonly position: number;
  readonly original_position: number;
  readonly body: string;
  resolved: boolean;
}

export interface FakeAttachment {
  readonly id: number;
  readonly uuid: string;
  readonly repository: string;
  readonly number: number;
  readonly name: string;
  readonly bytes: number;
}

export interface FakeConversationComment {
  readonly repository: string;
  readonly number: number;
  body: string;
  readonly author?: string;
}

export interface FakeManualMerge {
  readonly repository: string;
  readonly number: number;
  readonly commit: string;
}

export interface FakeRepository {
  readonly private: boolean;
  allowManualMerge?: boolean;
}

export interface FakePullRequest {
  number: number;
  html_url: string;
  title: string;
  body: string;
  state: string;
  merged: boolean;
  merge_commit_sha?: string;
  head: { ref: string };
  base: { ref: string };
  repository: string;
}

export interface FakeForgejo extends FakeForgejoState {
  readonly rootUrl: string;
  readonly bareRepositoryPath: (repository: string) => string;
  registerPushedBranchesAfterReads(reads: number): void;
  snapshot(): Promise<FakeForgejoSnapshot>;
  restore(snapshot: FakeForgejoSnapshot): Promise<void>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

export async function startFakeForgejo(token: string, adminPassword = FAKE_FORGEJO_ADMIN_PASSWORD): Promise<FakeForgejo> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "fake-forgejo-git-"));
  const fake = {
    rootUrl: "",
    repositories: new Map<string, FakeRepository>(),
    pullRequests: [] as FakePullRequest[],
    comments: [] as FakeConversationComment[],
    attachments: [] as FakeAttachment[],
    reviews: [] as FakeReview[],
    reviewComments: [] as FakeReviewComment[],
    attachmentContents: new Map<string, Buffer>(),
    adminSignIns: [] as string[],
    markdownRequests: [] as unknown[],
    merges: [] as unknown[],
    manualMerges: [] as FakeManualMerge[],
    gitAuthorizations: [] as string[],
    pullRequestCreateRequests: [] as string[],
    bareRepositoryPath: (repository: string) => path.join(projectRoot, `${repository}.git`),
  };
  let nextAttachmentId = 0;
  let readsBeforeBranchRegisters = 0;
  const branchReads = new Map<string, number>();

  async function branchIsPushed(bare: string, branch: string): Promise<boolean> {
    return (await gitInBare(bare, ["rev-parse", "--verify", `refs/heads/${branch}`])).ok;
  }

  async function branchIsRegistered(repository: string, branch: string): Promise<boolean> {
    const pushed = await branchIsPushed(fake.bareRepositoryPath(repository), branch);
    return pushed && (branchReads.get(`${repository}:${branch}`) ?? 0) >= readsBeforeBranchRegisters;
  }

  async function answerBranchRead(response: ServerResponse, repository: string, branch: string): Promise<void> {
    if (await branchIsRegistered(repository, branch)) return sendJson(response, 200, { name: branch });
    const key = `${repository}:${branch}`;
    if (await branchIsPushed(fake.bareRepositoryPath(repository), branch)) branchReads.set(key, (branchReads.get(key) ?? 0) + 1);
    return sendJson(response, 404, TARGET_NOT_FOUND);
  }

  const expectedGitAuthorization = `Basic ${Buffer.from(`${FAKE_FORGEJO_ADMIN}:${token}`).toString("base64")}`;

  async function answerApi(request: IncomingMessage, response: ServerResponse, apiPath: string, query: URLSearchParams): Promise<void> {
    const method = request.method ?? "GET";
    if (method === "GET" && apiPath === "version") return sendJson(response, 200, { version: "16.0.5" });
    if (request.headers.authorization !== `token ${token}`) return sendJson(response, 401, { message: "token is required" });
    if (method === "GET" && apiPath === "user") return sendJson(response, 200, { login: FAKE_FORGEJO_ADMIN });
    if (method === "POST" && apiPath === "markdown") {
      fake.markdownRequests.push(JSON.parse((await readBody(request)).toString("utf8")));
      response.writeHead(200, { "Content-Type": "text/html" });
      return void response.end("<p>rendered</p>\n");
    }
    if (method === "GET" && apiPath === "user/repos") {
      const limit = Number(query.get("limit") ?? "30");
      const page = Number(query.get("page") ?? "1");
      const owned = [...fake.repositories].map(([key, { private: isPrivate }]) => {
        const [owner, name] = key.split("/");
        return { name, owner: { login: owner }, private: isPrivate };
      });
      return sendJson(response, 200, owned.slice((page - 1) * limit, page * limit));
    }
    if (method === "POST" && apiPath === "user/repos") {
      const { name, private: isPrivate } = JSON.parse((await readBody(request)).toString("utf8")) as { name: string; private: boolean };
      const key = `${FAKE_FORGEJO_ADMIN}/${name}`;
      if (fake.repositories.has(key)) return sendJson(response, 409, { message: "repository already exists" });
      await mkdir(path.dirname(fake.bareRepositoryPath(key)), { recursive: true });
      await gitInBare(projectRoot, ["init", "--bare", "-q", fake.bareRepositoryPath(key)]);
      fake.repositories.set(key, { private: isPrivate });
      return sendJson(response, 201, { name, owner: { login: FAKE_FORGEJO_ADMIN }, private: isPrivate });
    }
    const branchMatch = /^repos\/([^/]+)\/([^/]+)\/branches\/(.+)$/.exec(apiPath);
    if (method === "GET" && branchMatch !== null && fake.repositories.has(`${branchMatch[1]}/${branchMatch[2]}`)) {
      return answerBranchRead(response, `${branchMatch[1]}/${branchMatch[2]}`, decodeURIComponent(branchMatch[3]!));
    }
    const commentEdit = /^repos\/([^/]+)\/([^/]+)\/issues\/comments\/(\d+)$/.exec(apiPath);
    if (method === "PATCH" && commentEdit !== null) return answerCommentEdit(request, response, `${commentEdit[1]}/${commentEdit[2]}`, Number(commentEdit[3]));
    const match = /^repos\/([^/]+)\/([^/]+)(?:\/(pulls|issues)(?:\/(\d+)(\.diff|\/files|\/merge|\/comments|\/assets(?:\/\d+)?|\/reviews(?:\/\d+\/comments)?)?)?)?$/.exec(apiPath);
    if (match === null) return sendJson(response, 404, { message: `no route ${method} ${apiPath}` });
    const [, owner, name, collection, numberText, suffix] = match;
    const repository = `${owner}/${name}`;
    if (!fake.repositories.has(repository)) return sendJson(response, 404, { message: "repository does not exist" });
    const bare = fake.bareRepositoryPath(repository);
    if (collection === undefined && method === "PATCH") {
      const { allow_manual_merge } = JSON.parse((await readBody(request)).toString("utf8")) as { allow_manual_merge?: boolean };
      if (allow_manual_merge !== undefined) fake.repositories.get(repository)!.allowManualMerge = allow_manual_merge;
      return sendJson(response, 200, { name, owner: { login: owner } });
    }
    if (collection === undefined) return sendJson(response, 200, { name, owner: { login: owner } });
    if (collection === "pulls" && numberText === undefined && method === "GET") {
      const open = fake.pullRequests.filter((pull) => pull.repository === repository && pull.state === query.get("state"));
      return sendJson(response, 200, open.slice(0, Number(query.get("limit") ?? "30")));
    }
    if (collection === "pulls" && numberText === undefined && method === "POST") {
      const input = JSON.parse((await readBody(request)).toString("utf8")) as { title: string; body: string; head: string; base: string };
      fake.pullRequestCreateRequests.push(input.head);
      for (const branch of [input.base, input.head]) {
        if (!(await branchIsRegistered(repository, branch))) return sendJson(response, 404, TARGET_NOT_FOUND);
      }
      const number = fake.pullRequests.length + 1;
      const created: FakePullRequest = {
        number,
        html_url: `${fake.rootUrl}${repository}/pulls/${number}`,
        title: input.title,
        body: input.body,
        state: "open",
        merged: false,
        head: { ref: input.head },
        base: { ref: input.base },
        repository,
      };
      fake.pullRequests.push(created);
      return sendJson(response, 201, created);
    }
    const pull = fake.pullRequests.find((candidate) => candidate.repository === repository && candidate.number === Number(numberText));
    if (pull === undefined) return sendJson(response, 404, { message: "pull request does not exist" });
    const range = `refs/heads/${pull.base.ref}...refs/heads/${pull.head.ref}`;
    if (suffix === undefined && method === "GET") {
      const headSha = (await gitInBare(bare, ["rev-parse", `refs/heads/${pull.head.ref}`])).stdout.trim();
      return sendJson(response, 200, { ...pull, head: { ...pull.head, sha: headSha } });
    }
    if (suffix === undefined && method === "PATCH") {
      Object.assign(pull, JSON.parse((await readBody(request)).toString("utf8")));
      return sendJson(response, 201, pull);
    }
    if (suffix === "/files") {
      const names = (await gitInBare(bare, ["diff", "--name-only", range])).stdout.split("\n").filter(Boolean);
      return sendJson(response, 200, names.map((filename) => ({ filename, status: "added" })));
    }
    if (suffix === ".diff") {
      response.writeHead(200, { "Content-Type": "text/plain" });
      return void response.end((await gitInBare(bare, ["diff", range])).stdout);
    }
    if (suffix === "/merge") {
      const input = JSON.parse((await readBody(request)).toString("utf8")) as { Do: string; MergeCommitID?: string };
      if (input.Do === "manually-merged") return answerManualMerge(response, pull, input.MergeCommitID ?? "");
      fake.merges.push(input);
      pull.merged = true;
      pull.state = "closed";
      response.writeHead(200);
      return void response.end();
    }
    if (suffix?.startsWith("/reviews")) return answerReviewApi(request, response, method, suffix, pull);
    if (suffix === "/comments" && method === "GET") {
      const conversation = fake.comments
        .map((comment, index) => ({ ...comment, id: index + 1 }))
        .filter((comment) => comment.repository === repository && comment.number === pull.number)
        .map((comment) => ({ id: comment.id, body: comment.body, user: { login: comment.author ?? FAKE_FORGEJO_ADMIN }, html_url: `${pull.html_url}#issuecomment-${comment.id}` }));
      return sendJson(response, 200, conversation);
    }
    if (suffix === "/assets" && method === "GET") {
      return sendJson(
        response,
        200,
        fake.attachments
          .filter((attachment) => attachment.repository === repository && attachment.number === pull.number)
          .map(({ id, uuid, name }) => ({ id, uuid, name, browser_download_url: `${fake.rootUrl}attachments/${uuid}` })),
      );
    }
    if (suffix?.startsWith("/assets/") && method === "DELETE") {
      const index = fake.attachments.findIndex((attachment) => attachment.repository === repository && attachment.number === pull.number && `/assets/${attachment.id}` === suffix);
      if (index < 0) return sendJson(response, 404, { message: "attachment does not exist" });
      fake.attachmentContents.delete(fake.attachments[index]!.uuid);
      fake.attachments.splice(index, 1);
      response.writeHead(204);
      return void response.end();
    }
    if (suffix === "/comments") {
      const { body } = JSON.parse((await readBody(request)).toString("utf8")) as { body: string };
      fake.comments.push({ repository, number: pull.number, body });
      return sendJson(response, 201, { id: fake.comments.length, body, html_url: `${pull.html_url}#issuecomment-${fake.comments.length}` });
    }
    if (suffix === "/assets") {
      const form = await new Response(await readBody(request), { headers: { "content-type": request.headers["content-type"]! } }).formData();
      const file = form.get("attachment") as File;
      nextAttachmentId += 1;
      const uuid = `uuid-${nextAttachmentId}`;
      fake.attachments.push({ id: nextAttachmentId, uuid, repository, number: pull.number, name: query.get("name") ?? file.name, bytes: file.size });
      fake.attachmentContents.set(uuid, Buffer.from(await file.arrayBuffer()));
      return sendJson(response, 201, { uuid, name: query.get("name"), browser_download_url: `${fake.rootUrl}attachments/${uuid}` });
    }
    return sendJson(response, 404, { message: `no route ${method} ${apiPath}` });
  }

  async function answerManualMerge(response: ServerResponse, pull: FakePullRequest, commit: string): Promise<void> {
    if (fake.repositories.get(pull.repository)!.allowManualMerge !== true) {
      return sendJson(response, 405, { message: "manually-merged is not an allowed merge style for this repository" });
    }
    if (pull.state !== "open") return sendJson(response, 404, TARGET_NOT_FOUND);
    if (!(await gitInBare(fake.bareRepositoryPath(pull.repository), ["merge-base", "--is-ancestor", commit, `refs/heads/${pull.base.ref}`])).ok) {
      return sendJson(response, 422, { message: "Wrong commit ID" });
    }
    fake.manualMerges.push({ repository: pull.repository, number: pull.number, commit });
    Object.assign(pull, { merged: true, merge_commit_sha: commit, state: "closed" });
    response.writeHead(200);
    return void response.end();
  }

  async function answerCommentEdit(request: IncomingMessage, response: ServerResponse, repository: string, commentId: number): Promise<void> {
    const comment = fake.comments[commentId - 1];
    if (comment === undefined || comment.repository !== repository) return sendJson(response, 404, { message: "comment does not exist" });
    comment.body = (JSON.parse((await readBody(request)).toString("utf8")) as { body: string }).body;
    const pull = fake.pullRequests.find((candidate) => candidate.repository === repository && candidate.number === comment.number);
    return sendJson(response, 200, { id: commentId, body: comment.body, user: { login: comment.author ?? FAKE_FORGEJO_ADMIN }, html_url: `${pull?.html_url}#issuecomment-${commentId}` });
  }

  async function answerReviewApi(
    request: IncomingMessage,
    response: ServerResponse,
    method: string,
    suffix: string,
    pull: FakePullRequest,
  ): Promise<void> {
    const reviewId = Number(/^\/reviews\/(\d+)\/comments$/.exec(suffix)?.[1]);
    if (method === "GET" && suffix === "/reviews") {
      const reviews = fake.reviews.filter((review) => review.repository === pull.repository && review.number === pull.number);
      return sendJson(response, 200, reviews.map((review) => ({ id: review.id, body: review.body, user: { login: FAKE_FORGEJO_ADMIN }, html_url: `${pull.html_url}#pullrequestreview-${review.id}` })));
    }
    if (method === "GET" && reviewId > 0) {
      const comments = fake.reviewComments.filter((comment) => comment.reviewId === reviewId);
      return sendJson(
        response,
        200,
        comments.map((comment) => ({
          id: comment.id,
          body: comment.body,
          user: { login: FAKE_FORGEJO_ADMIN },
          resolver: comment.resolved ? { login: FAKE_FORGEJO_ADMIN } : null,
          path: comment.path,
          position: comment.position,
          original_position: comment.original_position,
          html_url: `${pull.html_url}/files#issuecomment-${comment.id}`,
        })),
      );
    }
    if (method === "POST" && suffix === "/reviews") {
      const input = JSON.parse((await readBody(request)).toString("utf8")) as {
        event: string;
        body: string;
        comments: Array<{ path: string; body: string; new_position?: number; old_position?: number }>;
      };
      const review: FakeReview = { id: FIRST_REVIEW_ID + fake.reviews.length, repository: pull.repository, number: pull.number, body: input.body };
      fake.reviews.push(review);
      for (const comment of input.comments) {
        fake.reviewComments.push({
          id: FIRST_REVIEW_COMMENT_ID + fake.reviewComments.length,
          reviewId: review.id,
          repository: pull.repository,
          number: pull.number,
          path: comment.path,
          position: comment.new_position ?? 0,
          original_position: comment.old_position ?? 0,
          body: comment.body,
          resolved: false,
        });
      }
      return sendJson(response, 200, { id: review.id, state: input.event, html_url: `${pull.html_url}#pullrequestreview-${review.id}` });
    }
    return sendJson(response, 404, { message: `no route ${method} ${suffix}` });
  }

  function isSignedIn(request: IncomingMessage): boolean {
    const sessions = (request.headers.cookie ?? "")
      .split(";")
      .map((pair) => pair.trim().split("="))
      .filter(([name]) => name === SESSION_COOKIE_NAME);
    return sessions[0]?.[1] === SIGNED_IN_SESSION;
  }

  function signedLineOf(comment: FakeReviewComment): number {
    return comment.position > 0 ? comment.position : -comment.original_position;
  }

  function addCodeComment(pull: FakePullRequest, form: URLSearchParams): void {
    const filePath = form.get("path") ?? "";
    const signedLine = Number(form.get("line")) * (form.get("side") === "previous" ? -1 : 1);
    const onSameLine = (comment: FakeReviewComment) =>
      comment.repository === pull.repository && comment.number === pull.number && comment.path === filePath && signedLineOf(comment) === signedLine;
    const repliedReview = fake.reviews.find((review) => review.id === Number(form.get("reply")) && review.repository === pull.repository && review.number === pull.number);
    const joinsConversation = repliedReview !== undefined && fake.reviewComments.some(onSameLine);
    const reviewId = joinsConversation ? repliedReview.id : FIRST_REVIEW_ID + fake.reviews.length;
    if (!joinsConversation) fake.reviews.push({ id: reviewId, repository: pull.repository, number: pull.number, body: "" });
    fake.reviewComments.push({
      id: FIRST_REVIEW_COMMENT_ID + fake.reviewComments.length,
      reviewId,
      repository: pull.repository,
      number: pull.number,
      path: filePath,
      position: signedLine > 0 ? signedLine : 0,
      original_position: signedLine < 0 ? -signedLine : 0,
      body: form.get("content") ?? "",
      resolved: false,
    });
  }

  async function answerWeb(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
    const form = new URLSearchParams((await readBody(request)).toString("utf8"));
    if (request.method === "POST" && pathname === "/user/login") {
      fake.adminSignIns.push(form.get("user_name") ?? "");
      if (form.get("user_name") !== FAKE_FORGEJO_ADMIN || form.get("password") !== adminPassword) {
        response.writeHead(200, { "Content-Type": "text/html" });
        return void response.end("username or password is incorrect");
      }
      response.writeHead(303, {
        Location: "/",
        "Set-Cookie": [
          `${SESSION_COOKIE_NAME}=${SIGNED_OUT_SESSION}; Path=/; HttpOnly`,
          `${SESSION_COOKIE_NAME}=${SIGNED_IN_SESSION}; Path=/; HttpOnly`,
          "lang=en-US; Path=/",
        ],
      });
      return void response.end();
    }
    const replyMatch = /^\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/files\/reviews\/comments$/.exec(pathname);
    if (request.method === "POST" && replyMatch !== null && isSignedIn(request)) {
      const pull = fake.pullRequests.find((candidate) => candidate.repository === `${replyMatch[1]}/${replyMatch[2]}` && candidate.number === Number(replyMatch[3]));
      if (pull === undefined) {
        response.writeHead(404);
        return void response.end();
      }
      addCodeComment(pull, form);
      response.writeHead(200, { "Content-Type": "text/html" });
      return void response.end("<div class=\"conversation\"></div>");
    }
    const resolveMatch = /^\/([^/]+)\/([^/]+)\/(?:issues|pulls)\/resolve_conversation$/.exec(pathname);
    if (request.method === "POST" && resolveMatch !== null && isSignedIn(request)) {
      const comment = fake.reviewComments.find((candidate) => candidate.id === Number(form.get("comment_id")));
      if (comment === undefined || comment.repository !== `${resolveMatch[1]}/${resolveMatch[2]}`) {
        response.writeHead(404);
        return void response.end();
      }
      comment.resolved = form.get("action") === "Resolve";
      response.writeHead(200, { "Content-Type": "text/html" });
      return void response.end("<div class=\"conversation\"></div>");
    }
    const attachment = /^\/attachments\/([^/]+)$/.exec(pathname);
    if (request.method === "GET" && attachment !== null && request.headers.authorization === `token ${token}`) {
      const content = fake.attachmentContents.get(attachment[1]!);
      response.writeHead(content === undefined ? 404 : 200);
      return void response.end(content);
    }
    response.writeHead(request.method === "POST" ? 303 : 404, request.method === "POST" ? { Location: "/user/login" } : {});
    response.end();
  }

  async function answerApiOrReportFailure(
    request: IncomingMessage,
    response: ServerResponse,
    apiPath: string,
    query: URLSearchParams,
  ): Promise<void> {
    try {
      await answerApi(request, response, apiPath, query);
    } catch (error) {
      sendJson(response, 500, { message: String(error) });
    }
  }

  const snapshotDirectories: string[] = [];

  async function takeSnapshot(): Promise<FakeForgejoSnapshot> {
    const bareRepositoriesCopy = await mkdtemp(path.join(tmpdir(), "fake-forgejo-snapshot-"));
    snapshotDirectories.push(bareRepositoriesCopy);
    await cp(projectRoot, bareRepositoriesCopy, { recursive: true });
    const { repositories, pullRequests, comments, attachments, reviews, reviewComments, attachmentContents, adminSignIns, markdownRequests, merges, manualMerges, gitAuthorizations, pullRequestCreateRequests } = fake;
    const records = structuredClone({ repositories, pullRequests, comments, attachments, reviews, reviewComments, attachmentContents, adminSignIns, markdownRequests, merges, manualMerges, gitAuthorizations, pullRequestCreateRequests, branchReads });
    return { records: { ...records, nextAttachmentId, readsBeforeBranchRegisters }, bareRepositoriesCopy };
  }

  async function restore(snapshot: FakeForgejoSnapshot): Promise<void> {
    const { records } = snapshot;
    replaceContents(fake.pullRequests, records.pullRequests);
    replaceContents(fake.comments, records.comments);
    replaceContents(fake.attachments, records.attachments);
    replaceContents(fake.reviews, records.reviews);
    replaceContents(fake.reviewComments, records.reviewComments);
    replaceContents(fake.adminSignIns, records.adminSignIns);
    replaceContents(fake.markdownRequests, records.markdownRequests);
    replaceContents(fake.merges, records.merges);
    replaceContents(fake.manualMerges, records.manualMerges);
    replaceContents(fake.gitAuthorizations, records.gitAuthorizations);
    replaceContents(fake.pullRequestCreateRequests, records.pullRequestCreateRequests);
    replaceEntries(fake.repositories, records.repositories);
    replaceEntries(fake.attachmentContents, records.attachmentContents);
    replaceEntries(branchReads, records.branchReads);
    nextAttachmentId = records.nextAttachmentId;
    readsBeforeBranchRegisters = records.readsBeforeBranchRegisters;
    await rm(projectRoot, { recursive: true, force: true });
    if (snapshot.bareRepositoriesCopy === null) await mkdir(projectRoot);
    else await cp(snapshot.bareRepositoriesCopy, projectRoot, { recursive: true });
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fake.invalid");
    const gitPath = /^\/([^/]+\/[^/]+\.git)(\/.*)$/.exec(url.pathname);
    if (gitPath !== null) {
      const authorization = request.headers.authorization ?? "";
      fake.gitAuthorizations.push(authorization);
      if (authorization !== expectedGitAuthorization) {
        response.writeHead(403);
        return void response.end("authorization required");
      }
      return serveGitOverHttp(request, response, projectRoot, `/${gitPath[1]}${gitPath[2]}`, url.search.slice(1), FAKE_FORGEJO_ADMIN);
    }
    if (!url.pathname.startsWith("/api/v1/")) return void answerWeb(request, response, url.pathname);
    void answerApiOrReportFailure(request, response, url.pathname.slice("/api/v1/".length), url.searchParams);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.rootUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  return {
    ...fake,
    registerPushedBranchesAfterReads(reads: number) {
      readsBeforeBranchRegisters = reads;
    },
    snapshot: takeSnapshot,
    restore,
    reset: () => restore(EMPTY_SNAPSHOT),
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(projectRoot, { recursive: true, force: true });
      await Promise.all(snapshotDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
    },
  };
}
