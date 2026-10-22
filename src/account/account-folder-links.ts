import { lstat, readlink, realpath, symlink, unlink } from "node:fs/promises";
import path from "node:path";

const SHARED_ITEM_NAMES = ["CLAUDE.md", "skills", "hooks", "plugins", "agents", "commands"] as const;
const SETTINGS_FILE_NAME = "settings.json";

export interface FolderLink {
  readonly name: string;
  readonly target: string;
}

export const LinkState = {
  Correct: "correct",
  Missing: "missing",
  PointsElsewhere: "points elsewhere",
  NotALink: "not a link",
} as const;
export type LinkState = (typeof LinkState)[keyof typeof LinkState];

export interface LinkCheck {
  readonly link: FolderLink;
  readonly state: LinkState;
  readonly actualTarget?: string;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch {
    return false;
  }
}

export async function expectedFolderLinks(primaryFolder: string): Promise<FolderLink[]> {
  const links: FolderLink[] = [];
  for (const name of SHARED_ITEM_NAMES) {
    const target = path.join(primaryFolder, name);
    if (await pathExists(target)) links.push({ name, target });
  }
  const settingsPath = path.join(primaryFolder, SETTINGS_FILE_NAME);
  if (await pathExists(settingsPath)) {
    links.push({ name: SETTINGS_FILE_NAME, target: await realpath(settingsPath) });
  }
  return links;
}

export async function checkFolderLink(folder: string, link: FolderLink): Promise<LinkCheck> {
  const linkPath = path.join(folder, link.name);
  let isSymbolicLink: boolean;
  try {
    isSymbolicLink = (await lstat(linkPath)).isSymbolicLink();
  } catch {
    return { link, state: LinkState.Missing };
  }
  if (!isSymbolicLink) return { link, state: LinkState.NotALink };
  const actualTarget = await readlink(linkPath);
  return actualTarget === link.target
    ? { link, state: LinkState.Correct }
    : { link, state: LinkState.PointsElsewhere, actualTarget };
}

export function checkFolderLinks(folder: string, links: readonly FolderLink[]): Promise<LinkCheck[]> {
  return Promise.all(links.map((link) => checkFolderLink(folder, link)));
}

export function describeLinkCheck(check: LinkCheck): string {
  const expected = `${check.link.name} -> ${check.link.target}`;
  if (check.state === LinkState.PointsElsewhere) return `${expected}: points to ${check.actualTarget}`;
  return `${expected}: ${check.state}`;
}

export async function linkSharedItem(folder: string, check: LinkCheck): Promise<void> {
  const linkPath = path.join(folder, check.link.name);
  if (check.state === LinkState.PointsElsewhere) await unlink(linkPath);
  await symlink(check.link.target, linkPath);
}
