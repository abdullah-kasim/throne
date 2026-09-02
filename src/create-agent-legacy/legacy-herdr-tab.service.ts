import path from "node:path";
import { RUNTIME_THRONE_ROOT } from "./legacy-runtime-throne-root.ts";
import { Injectable } from "@nestjs/common";
import type { HerdrAgent } from "../herdr/herdr-inventory.service.ts";
import { runHerdr } from "../herdr/herdr-client.ts";
export interface CreatedTab {
  tabId: string;
  rootPaneId: string;
}

export interface HerdrTabDependencies {
  readonly runHerdr: typeof runHerdr;
}

export const DEFAULT_HERDR_TAB_DEPENDENCIES: HerdrTabDependencies = {
  runHerdr,
};

export async function createHerdrTab(
  label: string,
  cwd: string | undefined,
  deps: HerdrTabDependencies = DEFAULT_HERDR_TAB_DEPENDENCIES,
): Promise<CreatedTab> {
  const throneBinDir = path.join(RUNTIME_THRONE_ROOT, "bin");
  const inheritedPath = process.env.PATH ?? "";
  const args = [
    "tab",
    "create",
    "--label",
    label,
    "--no-focus",
    "--env",
    `PATH=${throneBinDir}:${inheritedPath}`,
  ];
  if (cwd) {
    args.push("--cwd", cwd);
  }
  const { stdout } = await deps.runHerdr(args);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (cause) {
    throw new Error(
      `herdr tab create: output was not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const result = (
    parsed as {
      result?: {
        tab?: { tab_id?: unknown };
        root_pane?: { pane_id?: unknown };
      };
    } | null
  )?.result;
  const tabId = result?.tab?.tab_id;
  const rootPaneId = result?.root_pane?.pane_id;
  if (typeof tabId !== "string" || typeof rootPaneId !== "string") {
    throw new Error(
      'herdr tab create: JSON missing "result.tab.tab_id" / "result.root_pane.pane_id" string — unexpected shape',
    );
  }
  return { tabId, rootPaneId };
}

export async function closeHerdrPane(
  paneId: string,
  deps: HerdrTabDependencies = DEFAULT_HERDR_TAB_DEPENDENCIES,
): Promise<void> {
  await deps.runHerdr(["pane", "close", paneId]);
}

export async function closeHerdrTab(
  tabId: string,
  deps: HerdrTabDependencies = DEFAULT_HERDR_TAB_DEPENDENCIES,
): Promise<void> {
  await deps.runHerdr(["tab", "close", tabId]);
}

export async function createTab(
  label: string,
  cwd?: string,
): Promise<CreatedTab> {
  return createHerdrTab(label, cwd);
}

export async function closePane(paneId: string): Promise<void> {
  return closeHerdrPane(paneId);
}

export async function closeTab(tabId: string): Promise<void> {
  return closeHerdrTab(tabId);
}

export async function closeAgentTab(
  agent: Pick<HerdrAgent, "tabId" | "paneId">,
): Promise<void> {
  return closeHerdrAgentTab(agent);
}

export async function renameTab(
  tabId: string,
  label: string,
  deps: HerdrTabDependencies = DEFAULT_HERDR_TAB_DEPENDENCIES,
): Promise<void> {
  await deps.runHerdr(["tab", "rename", tabId, label]);
}

export async function closeHerdrAgentTab(
  agent: Pick<HerdrAgent, "tabId" | "paneId">,
  deps: Pick<HerdrTabService, "closeTab" | "closePane"> = new HerdrTabService(),
): Promise<void> {
  if (agent.tabId) {
    await deps.closeTab(agent.tabId);
    return;
  }
  await deps.closePane(agent.paneId);
}

@Injectable()
export class HerdrTabService {
  private readonly deps: HerdrTabDependencies;

  constructor(deps: HerdrTabDependencies = DEFAULT_HERDR_TAB_DEPENDENCIES) {
    this.deps = deps;
  }

  createTab(label: string, cwd?: string): Promise<CreatedTab> {
    return createHerdrTab(label, cwd, this.deps);
  }

  closePane(paneId: string): Promise<void> {
    return closeHerdrPane(paneId, this.deps);
  }

  closeTab(tabId: string): Promise<void> {
    return closeHerdrTab(tabId, this.deps);
  }

  closeAgentTab(agent: Pick<HerdrAgent, "tabId" | "paneId">): Promise<void> {
    return closeHerdrAgentTab(agent, this);
  }
}
