import path from 'node:path';
import { RUNTIME_THRONE_ROOT } from '../shared-policy/runtime-throne-root.ts';
import { Injectable } from '@nestjs/common';
import type { HerdrAgent } from '../herdr/herdr-inventory.service.ts';
import { runHerdr } from './herdr-client.ts';
import { loadUserConfigFile } from '../user-config-loader.ts';
import {
  readOriginUrl,
  resolveGitIdentityForRemote,
  type GitIdentity,
} from '../git-identity/git-identity.command.ts';
export interface CreatedTab {
  tabId: string;
  rootPaneId: string;
}

export interface HerdrTabDependencies {
  readonly runHerdr: typeof runHerdr;
  /** The identity every commit made in the tab is signed with, from the live
   *  config.user.ts `identity` section, exported as git's own author and
   *  committer variables so git signs natively and no global or per-repo
   *  config is ever written. `undefined` exports nothing and leaves the
   *  bin/git shim to STOP on a machine-local identity. */
  readonly readGitIdentity?: (cwd: string | undefined) => Promise<TabGitIdentity | undefined>;
}

/** The identity plus the origin it was chosen for, so the bin/git shim can
 *  tell when a commit targets a different repository than the tab's cwd and
 *  must re-resolve instead of trusting the tab's variables. */
export interface TabGitIdentity extends GitIdentity {
  origin?: string;
}

let identityCacheBust = 0;

/** Read fresh per tab: the Lord edits config.user.ts while the court runs, and
 *  a tab spawned after the edit must carry the new value. A config that cannot
 *  be loaded must not stop a tab from being created — it is reported and the
 *  shim's STOP remains the backstop. */
export async function readConfiguredGitIdentity(cwd: string | undefined): Promise<TabGitIdentity | undefined> {
  try {
    const file = await loadUserConfigFile(undefined, `${Date.now()}-${++identityCacheBust}`);
    const origin = cwd === undefined ? undefined : await readOriginUrl(cwd);
    const identity = resolveGitIdentityForRemote(file?.identity, origin);
    return identity === undefined ? undefined : { ...identity, ...(origin === undefined ? {} : { origin }) };
  } catch (error) {
    process.stderr.write(
      `herdr tab create: git identity not exported, config.user.ts could not be loaded: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return undefined;
  }
}

export function gitIdentityEnvironment(identity: TabGitIdentity | undefined): string[] {
  if (identity === undefined) return [];
  return [
    '--env', `GIT_AUTHOR_NAME=${identity.name}`,
    '--env', `GIT_AUTHOR_EMAIL=${identity.email}`,
    '--env', `GIT_COMMITTER_NAME=${identity.name}`,
    '--env', `GIT_COMMITTER_EMAIL=${identity.email}`,
    // Signing rides on git's own env-injected config (git >= 2.31), so a
    // plain `git commit` in the tab signs without any config file written.
    '--env', 'GIT_CONFIG_COUNT=4',
    '--env', 'GIT_CONFIG_KEY_0=user.signingkey', '--env', `GIT_CONFIG_VALUE_0=${identity.signingKey}`,
    '--env', 'GIT_CONFIG_KEY_1=commit.gpgsign', '--env', 'GIT_CONFIG_VALUE_1=true',
    '--env', 'GIT_CONFIG_KEY_2=tag.gpgsign', '--env', 'GIT_CONFIG_VALUE_2=true',
    '--env', 'GIT_CONFIG_KEY_3=gpg.format', '--env', `GIT_CONFIG_VALUE_3=${identity.signingFormat}`,
    '--env', `THRONE_GIT_SIGNING_KEY=${identity.signingKey}`,
    '--env', `THRONE_GIT_SIGNING_FORMAT=${identity.signingFormat}`,
    ...(identity.origin === undefined ? [] : ['--env', `THRONE_GIT_IDENTITY_ORIGIN=${identity.origin}`]),
  ];
}

export const DEFAULT_HERDR_TAB_DEPENDENCIES: HerdrTabDependencies = { runHerdr };

export async function createHerdrTab(
  label: string,
  cwd: string | undefined,
  deps: HerdrTabDependencies = DEFAULT_HERDR_TAB_DEPENDENCIES,
): Promise<CreatedTab> {
  const throneBinDir = path.join(RUNTIME_THRONE_ROOT, 'bin');
  const inheritedPath = process.env.PATH ?? '';
  const args = [
    'tab',
    'create',
    '--label',
    label,
    '--no-focus',
    '--env',
    `PATH=${throneBinDir}:${inheritedPath}`,
    '--env',
    'THRONE_AGENT_PANE=1',
    ...gitIdentityEnvironment(await (deps.readGitIdentity ?? readConfiguredGitIdentity)(cwd)),
  ];
  if (cwd) {
    args.push('--cwd', cwd);
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
  const result = (parsed as {
    result?: { tab?: { tab_id?: unknown }; root_pane?: { pane_id?: unknown } };
  } | null)?.result;
  const tabId = result?.tab?.tab_id;
  const rootPaneId = result?.root_pane?.pane_id;
  if (typeof tabId !== 'string' || typeof rootPaneId !== 'string') {
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
  await deps.runHerdr(['pane', 'close', paneId]);
}

export async function closeHerdrTab(
  tabId: string,
  deps: HerdrTabDependencies = DEFAULT_HERDR_TAB_DEPENDENCIES,
): Promise<void> {
  await deps.runHerdr(['tab', 'close', tabId]);
}

export async function createTab(label: string, cwd?: string): Promise<CreatedTab> {
  return createHerdrTab(label, cwd);
}

export async function closePane(paneId: string): Promise<void> {
  return closeHerdrPane(paneId);
}

export async function closeTab(tabId: string): Promise<void> {
  return closeHerdrTab(tabId);
}

export async function closeAgentTab(agent: Pick<HerdrAgent, 'tabId' | 'paneId'>): Promise<void> {
  return closeHerdrAgentTab(agent);
}

export async function renameTab(
  tabId: string,
  label: string,
  deps: HerdrTabDependencies = DEFAULT_HERDR_TAB_DEPENDENCIES,
): Promise<void> {
  await deps.runHerdr(['tab', 'rename', tabId, label]);
}

export async function closeHerdrAgentTab(
  agent: Pick<HerdrAgent, 'tabId' | 'paneId'>,
  deps: Pick<HerdrTabService, 'closeTab' | 'closePane'> = new HerdrTabService(),
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

  closeAgentTab(agent: Pick<HerdrAgent, 'tabId' | 'paneId'>): Promise<void> {
    return closeHerdrAgentTab(agent, this);
  }
}
