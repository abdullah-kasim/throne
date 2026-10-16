import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { installCommandsForwardingTo } from "./commands-answered-in-this-process.ts";

export const FAKE_GITHUB_REPOSITORY = "example-bakery/staging-demo";
const FAKE_GITHUB_PROGRAMS = ["gh", "ghe"];

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

export interface FakeGithubWorkerRequest {
  readonly id: number;
  readonly kind: "read" | "write";
  readonly state?: FakeGithubState;
}

export interface FakeGithubWorkerReply {
  readonly id: number;
  readonly state: FakeGithubState;
}

export interface FakeGithub {
  readonly binDirectory: string;
  read(): Promise<FakeGithubState>;
  write(state: FakeGithubState): Promise<void>;
  mutatingCalls(): Promise<string[][]>;
  remove(): Promise<void>;
}

function isMutatingCall(args: readonly string[]): boolean {
  const rest = args[0] === "--bypass" ? args.slice(1) : args;
  if (rest[0] === "pr") return ["create", "edit", "comment", "merge", "close", "ready"].includes(rest[1] ?? "");
  if (rest[0] === "api") return rest.some((value) => value.startsWith("body=") || value.startsWith("query=mutation"));
  return false;
}

export async function installFakeGithub(): Promise<FakeGithub> {
  const worker = new Worker(new URL("./forge-fake-github-server.ts", import.meta.url));
  const { port } = (await once(worker, "message"))[0] as { port: number };
  const commands = await installCommandsForwardingTo(port, FAKE_GITHUB_PROGRAMS);
  let lastRequestId = 0;
  const ask = async (request: Omit<FakeGithubWorkerRequest, "id">): Promise<FakeGithubState> => {
    lastRequestId += 1;
    const id = lastRequestId;
    const replied = new Promise<FakeGithubState>((resolve) => {
      const listen = (reply: FakeGithubWorkerReply) => {
        if (reply.id !== id) return;
        worker.off("message", listen);
        resolve(reply.state);
      };
      worker.on("message", listen);
    });
    worker.postMessage({ ...request, id });
    return replied;
  };
  return {
    binDirectory: commands.binDirectory,
    read: () => ask({ kind: "read" }),
    async write(written) {
      await ask({ kind: "write", state: written });
    },
    async mutatingCalls() {
      return (await ask({ kind: "read" })).calls.filter(isMutatingCall);
    },
    async remove() {
      await commands.remove();
      await worker.terminate();
    },
  };
}
