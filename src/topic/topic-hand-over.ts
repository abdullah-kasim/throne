import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { HERDR_AGENT_NAME_MAX_LENGTH, herdrAgentNameRefusal } from "../herdr/herdr-identity.service.ts";
import { resolveAgent } from "../herdr/herdr-runtime.service.ts";
import { forkBriefPath } from "../create-agent/fork-origin.ts";
import { readDriftPrompt } from "../create-agent/drift-prompt.ts";
import { run as runCreateAgent } from "../create-agent/create.ts";
import { run as runSpawnGitTree } from "../spawn-git-tree/spawn-git-tree-runtime.ts";
import { GitTreeCreationService } from "../git-lifecycle/git-tree-creation.service.ts";
import { SendAgentCommand } from "../send-agent/send-agent.command.ts";
import { THRONE_PROJECT_DIR } from "../git-lifecycle/git-worktree.service.ts";

export type HandOverStep = "relay" | "brief" | "worktree" | "launch";

export interface HandOverDependencies {
  findLivePane(name: string): Promise<string | undefined>;
  readLordPrompt(originName: string, ledgerDirectory: string): Promise<string | undefined>;
  relay(name: string, prompt: string): Promise<void>;
  prepareWorktree(forkName: string): Promise<string>;
  launch(createAgentArguments: string[]): Promise<void>;
}

export type HandOverResult =
  | { readonly ok: true; readonly name: string; readonly pane: string; readonly relayed: boolean }
  | { readonly ok: false; readonly step: HandOverStep; readonly reason: string };

class StepFailure extends Error {
  constructor(readonly step: HandOverStep, reason: string) {
    super(reason);
  }
}

const NOTHING_SETTLED = "nothing settled";

export function forkNameFor(slug: string): string {
  return `stager-${slug}`.slice(0, HERDR_AGENT_NAME_MAX_LENGTH).replace(/-+$/, "");
}

export function forkNameRefusal(slug: string): string | undefined {
  return herdrAgentNameRefusal(forkNameFor(slug));
}

export function forkBriefText(slug: string, lordPrompt: string, settled: string | undefined): string {
  const quoted = lordPrompt.split("\n").map((line) => `> ${line}`).join("\n");
  return [
    `INTENT: Act on the Lord's prompt that moved the conversation to the topic "${slug}", quoted verbatim:\n${quoted}`,
    `SCOPE: The topic "${slug}", as that prompt asks; the origin Stager did no research on it.`,
    `RULINGS: ${settled ?? NOTHING_SETTLED}`,
    "VERIFIED-NOUNS: none; verify every code noun against the live tree before relying on it.",
    "REUSE: none recorded.",
    "",
  ].join("\n");
}

async function step<T>(name: HandOverStep, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof StepFailure) throw error;
    throw new StepFailure(name, error instanceof Error ? error.message : String(error));
  }
}

async function requireLordPrompt(
  name: HandOverStep,
  originName: string,
  ledgerDirectory: string,
  dependencies: HandOverDependencies,
): Promise<string> {
  const prompt = await step(name, () => dependencies.readLordPrompt(originName, ledgerDirectory));
  if (prompt === undefined) throw new StepFailure(name, `the Lord's prompt could not be read from ${originName}'s transcript`);
  return prompt;
}

export async function handOverChangedTopic(
  originName: string,
  slug: string,
  settled: string | undefined,
  ledgerDirectory: string,
  dependencies: HandOverDependencies,
): Promise<HandOverResult> {
  const name = forkNameFor(slug);
  try {
    const livePane = await step("relay", () => dependencies.findLivePane(name));
    if (livePane !== undefined) {
      const prompt = await requireLordPrompt("relay", originName, ledgerDirectory, dependencies);
      await step("relay", () => dependencies.relay(name, prompt));
      return { ok: true, name, pane: livePane, relayed: true };
    }
    const prompt = await requireLordPrompt("brief", originName, ledgerDirectory, dependencies);
    await step("brief", async () => {
      const briefPath = forkBriefPath(name, ledgerDirectory);
      await mkdir(path.dirname(briefPath), { recursive: true });
      await writeFile(briefPath, forkBriefText(slug, prompt, settled));
    });
    const tree = await step("worktree", () => dependencies.prepareWorktree(name));
    await step("launch", () =>
      dependencies.launch([
        "--topic-from", originName,
        "--role", "Stager",
        "--supervisor", "Regent",
        "--name", name,
        "--cwd", tree,
        "--non-campaign",
      ]),
    );
    const pane = await step("launch", () => dependencies.findLivePane(name));
    if (pane === undefined) throw new StepFailure("launch", `${name} is not live after its launch`);
    return { ok: true, name, pane, relayed: false };
  } catch (error) {
    const failure = error as StepFailure;
    return { ok: false, step: failure.step, reason: failure.message };
  }
}

async function exitCodeOf(action: () => Promise<unknown>): Promise<number> {
  const previous = process.exitCode;
  process.exitCode = 0;
  try {
    await action();
    return Number(process.exitCode ?? 0);
  } finally {
    process.exitCode = previous;
  }
}

export const PRODUCTION_HAND_OVER: HandOverDependencies = {
  findLivePane: async (name) => (await resolveAgent(name).catch(() => undefined))?.paneId,
  readLordPrompt: (originName, ledgerDirectory) => readDriftPrompt(originName, ledgerDirectory),
  relay: async (name, prompt) => {
    const code = await exitCodeOf(() => new SendAgentCommand().run([name, prompt]));
    if (code !== 0) throw new Error(`send-agent exited ${code}`);
  },
  prepareWorktree: async (forkName) => {
    const treeCreation = new GitTreeCreationService();
    let treePath: string | undefined;
    const recordingTreeCreation = Object.assign(Object.create(treeCreation), {
      create: async (...creation: Parameters<GitTreeCreationService["create"]>) => {
        const created = await treeCreation.create(...creation);
        treePath = created.treePath;
        return created;
      },
    }) as GitTreeCreationService;
    const code = await runSpawnGitTree([forkName, "--repo", THRONE_PROJECT_DIR, "--non-campaign"], { treeCreation: recordingTreeCreation });
    if (code !== 0 || treePath === undefined) throw new Error(`spawn-git-tree exited ${code}`);
    return treePath;
  },
  launch: async (createAgentArguments) => {
    const code = await runCreateAgent(createAgentArguments);
    if (code !== 0) throw new Error(`create-agent exited ${code}`);
  },
};
