import type { ForgeDependencies } from "./forge-dependencies.ts";
import { ForgeRefusal } from "./forge-refusal.ts";
import { openForgejoApi, type ForgejoApi } from "./forgejo-api.ts";
import { readForgejoSite, type ForgejoSite } from "./forgejo-site.ts";
import { decideHostForge, FORGE } from "./host-forge.ts";
import { stagedPullRequestsInForgejoCopy } from "./staging-metadata.ts";

export const FORGEJO_TAILNET_HTTP_PORT = 8420;
export const PUBLIC_GITHUB_HOST = "github.com";

export const GITHUB_PROGRAM = { github: "gh", enterprise: "ghe" } as const;
export type GithubProgram = (typeof GITHUB_PROGRAM)[keyof typeof GITHUB_PROGRAM];

export interface PullRequestUrlTarget {
  readonly kind: "url";
  readonly text: string;
  readonly origin: string;
  readonly host: string;
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
}

export type PullRequestTarget =
  | PullRequestUrlTarget
  | { readonly kind: "number"; readonly text: string; readonly number: number }
  | { readonly kind: "branch"; readonly text: string };

export type PullRequestForgeDecision =
  | { readonly forge: typeof FORGE.forgejo; readonly reason: string; readonly twinUrl?: string }
  | { readonly forge: typeof FORGE.github; readonly program: GithubProgram; readonly reason: string };

const PULL_REQUEST_URL_PATTERN = /^(https?:\/\/[^/]+)\/([^/]+)\/([^/]+)\/pulls?\/(\d+)(?:[/?#]|$)/;

export function parsePullRequestTarget(text: string): PullRequestTarget {
  if (/^\d+$/.test(text)) return { kind: "number", text, number: Number(text) };
  if (/^https?:\/\//.test(text)) {
    const match = PULL_REQUEST_URL_PATTERN.exec(text);
    if (match === null) throw new ForgeRefusal(`"${text}" is not a pull request URL.`);
    const origin = new URL(match[1]!).origin;
    return {
      kind: "url",
      text,
      origin,
      host: new URL(origin).hostname,
      owner: match[2]!,
      repository: match[3]!,
      number: Number(match[4]),
    };
  }
  if (text === "" || text.startsWith("-")) throw new ForgeRefusal(`"${text}" is not a pull request number, URL or branch.`);
  return { kind: "branch", text };
}

export function githubProgramForHost(host: string): GithubProgram {
  return host === PUBLIC_GITHUB_HOST ? GITHUB_PROGRAM.github : GITHUB_PROGRAM.enterprise;
}

async function isForgejoOrigin(origin: string, site: ForgejoSite, dependencies: ForgeDependencies): Promise<boolean> {
  if (origin === new URL(site.rootUrl).origin) return true;
  const tailnetAddress = await dependencies.readTailnetAddress();
  return tailnetAddress !== undefined && origin === `http://${tailnetAddress}:${FORGEJO_TAILNET_HTTP_PORT}`;
}

export async function decideForgeHoldingPullRequest(
  target: PullRequestTarget,
  dependencies: ForgeDependencies,
): Promise<PullRequestForgeDecision> {
  if (target.kind !== "url") {
    const host = await decideHostForge(dependencies);
    const reason = `a pull request number or branch belongs to the repository's own forge: ${host.reason}`;
    return host.forge === FORGE.forgejo
      ? { forge: FORGE.forgejo, reason }
      : { forge: FORGE.github, program: GITHUB_PROGRAM.github, reason };
  }
  const site = await readForgejoSite();
  if (site !== undefined && (await isForgejoOrigin(target.origin, site, dependencies))) {
    return { forge: FORGE.forgejo, reason: `${target.origin} is this host's Forgejo` };
  }
  const program = githubProgramForHost(target.host);
  return {
    forge: FORGE.github,
    program,
    reason: program === GITHUB_PROGRAM.github ? `${target.host} is GitHub` : `${target.host} is GitHub Enterprise`,
  };
}

function isSamePullRequest(url: string, target: PullRequestUrlTarget): boolean {
  const parsed = parsePullRequestTarget(url);
  return (
    parsed.kind === "url" &&
    parsed.origin === target.origin &&
    parsed.owner === target.owner &&
    parsed.repository === target.repository &&
    parsed.number === target.number
  );
}

export async function forgejoTwinUrlOfGithubPullRequest(target: PullRequestUrlTarget, api: ForgejoApi): Promise<string | undefined> {
  const staged = await stagedPullRequestsInForgejoCopy(target.repository, api);
  return staged.find((pair) => isSamePullRequest(pair.githubUrl, target))?.forgejoUrl;
}

export async function decidePullRequestForge(target: PullRequestTarget, dependencies: ForgeDependencies): Promise<PullRequestForgeDecision> {
  const holder = await decideForgeHoldingPullRequest(target, dependencies);
  const site = await readForgejoSite();
  if (holder.forge === FORGE.forgejo || target.kind !== "url" || site === undefined) return holder;
  const twinUrl = await forgejoTwinUrlOfGithubPullRequest(target, await openForgejoApi(site.rootUrl, dependencies));
  if (twinUrl === undefined) return holder;
  return { forge: FORGE.forgejo, reason: `${target.text} is staged; its Forgejo twin is ${twinUrl}`, twinUrl };
}
