import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach } from "node:test";
import {
  runForgeProcess,
  type ForgeDependencies,
  type ProcessResult,
  type ProcessRunner,
} from "../src/forge/forge-dependencies.ts";
import { startFakeForgejo, type FakeForgejo } from "./forge-fake-forgejo.ts";
import { git, initRepo } from "./git-repo-test-fixture.ts";

export const TEST_FORGEJO_TOKEN = "test-forgejo-token-5f3a9c";
export const TEST_TAILNET_ADDRESS = "192.0.2.10";

export interface ForgejoStateDirectory {
  readonly forgejoDirectory: string;
  installForgejo(rootUrl: string, options?: { readonly token?: string | null }): Promise<void>;
  remove(): Promise<void>;
}

export async function useFreshForgejoStateDirectory(): Promise<ForgejoStateDirectory> {
  const stateHome = await mkdtemp(path.join(tmpdir(), "forge-state-"));
  const forgejoDirectory = path.join(stateHome, "forgejo");
  const previousStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateHome;
  return {
    forgejoDirectory,
    async installForgejo(rootUrl, options = {}) {
      await mkdir(path.join(forgejoDirectory, "config"), { recursive: true });
      await writeFile(path.join(forgejoDirectory, "config", "app.ini"), `[server]\nDOMAIN = forge.invalid\nROOT_URL = ${rootUrl}\nHTTP_PORT = 3000\n`);
      await writeFile(path.join(forgejoDirectory, "enabled"), "");
      const token = options.token === undefined ? TEST_FORGEJO_TOKEN : options.token;
      const tokenFile = path.join(forgejoDirectory, "api-token");
      if (token === null) await rm(tokenFile, { force: true });
      else await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
    },
    async remove() {
      if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previousStateHome;
      await rm(stateHome, { recursive: true, force: true });
    },
  };
}

export interface GithubCall {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export function forgeDependenciesWithFakeGithub(
  answer: (call: GithubCall) => ProcessResult = () => ({ exitCode: 0, stdout: "", stderr: "" }),
): ForgeDependencies & { readonly githubCalls: GithubCall[] } {
  const githubCalls: GithubCall[] = [];
  const runProcess: ProcessRunner = async (file, args, options) => {
    if (file === "gh" || file === "ghe") {
      const call = { program: file, args: [...args], cwd: options.cwd };
      githubCalls.push(call);
      return answer(call);
    }
    return runForgeProcess(file, args, options);
  };
  return {
    githubCalls,
    fetch: (input, init) => fetch(input, init),
    runProcess,
    readTailnetAddress: async () => TEST_TAILNET_ADDRESS,
  };
}

export interface CheckoutWithOrigin {
  readonly repo: string;
  readonly origin: string;
  remove(): Promise<void>;
}

export async function repositoryWithOriginAndFeatureBranch(prefix: string): Promise<CheckoutWithOrigin> {
  const repo = await initRepo(prefix);
  const origin = path.join(await mkdtemp(path.join(tmpdir(), `${prefix}origin-`)), "staging-demo.git");
  await git(repo, ["init", "--bare", "-q", origin]);
  await git(repo, ["remote", "add", "origin", origin]);
  await git(repo, ["push", "-q", "origin", "main"]);
  await git(repo, ["remote", "set-head", "origin", "main"]);
  await git(repo, ["checkout", "-q", "-b", "add/feature"]);
  await writeFile(path.join(repo, "feature.txt"), "feature\n");
  await git(repo, ["add", "feature.txt"]);
  await git(repo, ["commit", "--no-gpg-sign", "-q", "-m", "add feature"]);
  return checkoutWithOrigin(repo, origin);
}

function checkoutWithOrigin(repo: string, origin: string): CheckoutWithOrigin {
  return {
    repo,
    origin,
    async remove() {
      await rm(repo, { recursive: true, force: true });
      await rm(path.dirname(origin), { recursive: true, force: true });
    },
  };
}

async function copyOfCheckout(original: CheckoutWithOrigin, prefix: string): Promise<CheckoutWithOrigin> {
  const repo = await mkdtemp(path.join(tmpdir(), prefix));
  const origin = path.join(await mkdtemp(path.join(tmpdir(), `${prefix}origin-`)), path.basename(original.origin));
  await cp(original.repo, repo, { recursive: true });
  await cp(original.origin, origin, { recursive: true });
  const repoConfig = path.join(repo, ".git", "config");
  await writeFile(repoConfig, (await readFile(repoConfig, "utf8")).replaceAll(original.origin, origin));
  return checkoutWithOrigin(repo, origin);
}

export async function commitInBareByHand(bare: string, branch: string, message: string): Promise<string> {
  const identity = ["-c", "user.name=Hand Edit", "-c", "user.email=hand-edit@example.invalid"];
  const ref = `refs/heads/${branch}`;
  const edited = await git(bare, [...identity, "commit-tree", `${ref}^{tree}`, "-p", ref, "-m", message]);
  await git(bare, ["update-ref", ref, edited]);
  return edited;
}

export function recordingGitCalls(dependencies: ForgeDependencies): ForgeDependencies & { readonly gitCalls: string[][] } {
  const gitCalls: string[][] = [];
  return {
    ...dependencies,
    gitCalls,
    runProcess: async (file, args, options) => {
      if (file === "git") gitCalls.push([...args]);
      return dependencies.runProcess(file, args, options);
    },
  };
}

export async function runForgeCapturing(
  args: readonly string[],
  dependencies: ForgeDependencies,
  cwd: string,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const { runForge } = await import("../src/forge/forge.command.ts");
  let stdout = "";
  let stderr = "";
  const exitCode = await runForge(args, dependencies, {
    cwd: () => cwd,
    writeStdout: (text) => void (stdout += text),
    writeStderr: (text) => void (stderr += text),
  });
  return { exitCode, stdout, stderr };
}

export interface ForgejoWithCheckout {
  readonly checkout: CheckoutWithOrigin;
  readonly forgejo: FakeForgejo;
  scratchDirectory(prefix: string): Promise<string>;
}

export function startForgejoWithCheckoutForEachTest(prefix: string): () => ForgejoWithCheckout {
  let state: ForgejoStateDirectory | undefined;
  let current: ForgejoWithCheckout | undefined;
  let scratchDirectories: string[] = [];
  let original: CheckoutWithOrigin | undefined;
  before(async () => {
    await import("../src/forge/forge.command.ts");
    original = await repositoryWithOriginAndFeatureBranch(prefix);
  });
  after(async () => {
    await original?.remove();
  });
  beforeEach(async () => {
    state = await useFreshForgejoStateDirectory();
    scratchDirectories = [];
    current = {
      checkout: await copyOfCheckout(original!, prefix),
      forgejo: await startFakeForgejo(TEST_FORGEJO_TOKEN),
      async scratchDirectory(scratchPrefix) {
        const directory = await mkdtemp(path.join(tmpdir(), scratchPrefix));
        scratchDirectories.push(directory);
        return directory;
      },
    };
    await state.installForgejo(current.forgejo.rootUrl);
  });
  afterEach(async () => {
    await current?.forgejo.close();
    await current?.checkout.remove();
    await Promise.all(scratchDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
    await state?.remove();
  });
  return () => current!;
}
