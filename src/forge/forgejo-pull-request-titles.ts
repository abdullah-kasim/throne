import { ForgeRefusal } from "./forge-refusal.ts";
import { parsePullRequestTarget } from "./pull-request-forge.ts";

const FORGEJO_DRAFT_TITLE_PREFIX = "WIP: ";
const DRAFT_TITLE_PATTERN = /^wip:\s*/i;
const GITHUB_TWIN_MARKER_PATTERN = /^\[GH-(?:\d+|##)\]\s*/;
const UNKNOWN_GITHUB_NUMBER = "##";

export function isDraftTitle(title: string): boolean {
  return DRAFT_TITLE_PATTERN.test(title);
}

export function titleWithoutDraftPrefix(title: string): string {
  return title.replace(DRAFT_TITLE_PATTERN, "");
}

export function forgejoTitle(title: string, draft: boolean): string {
  return draft ? `${FORGEJO_DRAFT_TITLE_PREFIX}${title}` : title;
}

function githubNumberIn(githubUrl: string): number {
  const target = parsePullRequestTarget(githubUrl);
  if (target.kind !== "url") throw new ForgeRefusal(`"${githubUrl}" is not a pull request URL.`);
  return target.number;
}

function githubTwinMarker(githubUrl: string | undefined): string {
  return `[GH-${githubUrl === undefined ? UNKNOWN_GITHUB_NUMBER : githubNumberIn(githubUrl)}]`;
}

function titleAfterDraftPrefixAndMarker(title: string): string {
  return titleWithoutDraftPrefix(title).replace(GITHUB_TWIN_MARKER_PATTERN, "");
}

export function titleNamingGithubTwin(title: string, githubUrl: string | undefined): string {
  return forgejoTitle(`${githubTwinMarker(githubUrl)} ${titleAfterDraftPrefixAndMarker(title)}`, isDraftTitle(title));
}

export function titleWithoutGithubTwinMarker(title: string): string {
  return forgejoTitle(titleAfterDraftPrefixAndMarker(title), isDraftTitle(title));
}
