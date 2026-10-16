import type { ForgeDependencies } from "./forge-dependencies.ts";
import { forgejoHostNamesIn } from "./github-bound-text.ts";
import { FORGE, type Forge } from "./host-forge.ts";
import { isEmbeddedAsMedia, mediaKindOf } from "./promotion-media.ts";
import { githubHostedMediaUrlsIn } from "./staging-media.ts";

const LINK = /https?:\/\/[^\s"'()<>]+/g;
const FORGEJO_ATTACHMENT_PATH = "/attachments/";
const NO_CROSS_HOST_MEDIA_LINKS_LINE = "no cross-host media links were found";

export interface PairBodies {
  readonly forgejo: string | null;
  readonly github: string | null;
}

export interface CrossHostMediaLinks {
  readonly forgejo: readonly string[];
  readonly github: readonly string[];
}

function linksOnHostsIn(body: string, hostNames: readonly string[]): string[] {
  const lowerCaseHostNames = hostNames.map((name) => name.toLowerCase());
  const links = [...new Set(body.match(LINK) ?? [])];
  return links.filter((link) => URL.canParse(link) && lowerCaseHostNames.includes(new URL(link).hostname));
}

async function isForgejoMediaLink(body: string, link: string): Promise<boolean> {
  const pathName = new URL(link).pathname;
  if (pathName.includes(FORGEJO_ATTACHMENT_PATH) || isEmbeddedAsMedia(body, link)) return true;
  return (await mediaKindOf(pathName.split("/").pop()!)) !== undefined;
}

async function forgejoMediaLinksIn(body: string, forgejoRootUrl: string, dependencies: ForgeDependencies): Promise<string[]> {
  const forgejoLinks = linksOnHostsIn(body, await forgejoHostNamesIn(body, forgejoRootUrl, dependencies));
  const isMedia = await Promise.all(forgejoLinks.map((link) => isForgejoMediaLink(body, link)));
  return forgejoLinks.filter((_link, index) => isMedia[index]);
}

export async function crossHostMediaLinksIn(
  body: string,
  livesOn: Forge,
  forgejoRootUrl: string,
  dependencies: ForgeDependencies,
): Promise<string[]> {
  return livesOn === FORGE.forgejo ? githubHostedMediaUrlsIn(body) : forgejoMediaLinksIn(body, forgejoRootUrl, dependencies);
}

async function crossHostMediaLinksOfSide(
  body: string | null,
  livesOn: Forge,
  forgejoRootUrl: string | null,
  dependencies: ForgeDependencies,
): Promise<string[]> {
  if (body === null || forgejoRootUrl === null) return [];
  return crossHostMediaLinksIn(body, livesOn, forgejoRootUrl, dependencies);
}

export async function crossHostMediaLinksOfPair(
  bodies: PairBodies,
  forgejoRootUrl: string | null,
  dependencies: ForgeDependencies,
): Promise<CrossHostMediaLinks> {
  return {
    forgejo: await crossHostMediaLinksOfSide(bodies.forgejo, FORGE.forgejo, forgejoRootUrl, dependencies),
    github: await crossHostMediaLinksOfSide(bodies.github, FORGE.github, forgejoRootUrl, dependencies),
  };
}

export function holdsCrossHostMediaLinks(links: CrossHostMediaLinks): boolean {
  return links.forgejo.length > 0 || links.github.length > 0;
}

export function crossHostMediaLinkLines(links: CrossHostMediaLinks): string {
  const lines = [FORGE.forgejo, FORGE.github].flatMap((side) => links[side].map((link) => `${side}: ${link}`));
  return `${(lines.length > 0 ? lines : [NO_CROSS_HOST_MEDIA_LINKS_LINE]).join("\n")}\n`;
}
