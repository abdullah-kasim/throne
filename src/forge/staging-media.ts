import { rm } from "node:fs/promises";
import path from "node:path";
import { ForgeRefusal } from "./forge-refusal.ts";
import type { GithubProgram } from "./pull-request-forge.ts";
import type { ForgeContext } from "./pull-request-operations.ts";
import {
  bodyWithPlaceholder,
  escapeRegExp,
  mediaKindOf,
  publishMediaFolder,
  type MediaEmbed,
  type MediaMovedToFolder,
} from "./promotion-media.ts";

const GITHUB_HOSTED_MEDIA_URL = /https:\/\/(?:[^\s"'()<>/]+\/user-attachments\/assets|(?:private-)?user-images\.githubusercontent\.com)\/[^\s"'()<>]+/g;
const STILLS_ONLY_REASON = "the GitHub pull request being staged holds no video";
const IMAGE_EXTENSION = ".png";
const VIDEO_EXTENSION = ".mp4";
const DOWNLOAD_TO_FILE_SCRIPT = '"$0" api "$1" > "$2"';

export function githubHostedMediaUrlsIn(body: string): string[] {
  return [...new Set(body.match(GITHUB_HOSTED_MEDIA_URL) ?? [])];
}

function isEmbeddedAsImage(body: string, url: string): boolean {
  return body.includes(`](${url})`) || new RegExp(`<img[^>]*src="${escapeRegExp(url)}"`).test(body);
}

async function fileNameForMediaAt(body: string, url: string): Promise<string> {
  const lastSegment = new URL(url).pathname.split("/").pop()!;
  if ((await mediaKindOf(lastSegment)) !== undefined) return lastSegment;
  return `${lastSegment}${isEmbeddedAsImage(body, url) ? IMAGE_EXTENSION : VIDEO_EXTENSION}`;
}

async function githubMediaEmbed(body: string, url: string): Promise<MediaEmbed> {
  return { marker: url, urlPattern: escapeRegExp(url), name: await fileNameForMediaAt(body, url) };
}

async function downloadedFromGithub(context: ForgeContext, program: GithubProgram, url: string, file: string): Promise<boolean> {
  const result = await context.dependencies.runProcess("sh", ["-c", DOWNLOAD_TO_FILE_SCRIPT, program, url, file], { cwd: context.repo });
  if (result.exitCode === 0) return true;
  await rm(file, { force: true });
  return false;
}

export async function downloadMediaForForgejo(
  context: ForgeContext,
  program: GithubProgram,
  body: string,
  folder: string,
): Promise<MediaMovedToFolder> {
  let rewritten = body;
  const fileNames: string[] = [];
  for (const url of githubHostedMediaUrlsIn(body)) {
    const placed = bodyWithPlaceholder(rewritten, await githubMediaEmbed(body, url));
    if ((await mediaKindOf(placed.fileName)) === undefined) continue;
    if (!(await downloadedFromGithub(context, program, url, path.join(folder, placed.fileName)))) continue;
    rewritten = placed.body;
    fileNames.push(placed.fileName);
  }
  return { body: rewritten, fileNames };
}

export async function publishMediaOnForgejo(
  context: ForgeContext,
  forgejoUrl: string,
  folder: string,
  fileNames: readonly string[],
): Promise<void> {
  const result = await publishMediaFolder(context, forgejoUrl, folder, fileNames, STILLS_ONLY_REASON);
  if (result.exitCode !== 0) {
    throw new ForgeRefusal(
      `re-hosting the media on ${forgejoUrl} through pr-media publish failed, so its body still holds drop placeholders; stage the pull request again: ${result.stderr.trim()}`,
    );
  }
}
