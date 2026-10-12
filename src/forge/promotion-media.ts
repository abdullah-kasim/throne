import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { RUNTIME_THRONE_ROOT } from "../shared-policy/runtime-throne-root.ts";
import type { ProcessResult } from "./forge-dependencies.ts";
import { ForgeRefusal } from "./forge-refusal.ts";
import { issueApiPath } from "./forgejo-pull-requests.ts";
import { forgejoHostNamesIn } from "./github-bound-text.ts";
import { githubViewArguments, runGithub } from "./github-pull-requests.ts";
import { githubProgramForHost, parsePullRequestTarget } from "./pull-request-forge.ts";
import type { ForgeContext } from "./pull-request-operations.ts";
import type { ForgejoPullRequest } from "./staged-pair.ts";

const PR_MEDIA_DIRECTORY = path.join(RUNTIME_THRONE_ROOT, ".claude", "skills", "pr-media");
export const PUBLISH_SCRIPT_PATH = path.join(PR_MEDIA_DIRECTORY, "publish.mjs");
const MEDIA_FOLDER_MODULE_PATH = path.join(PR_MEDIA_DIRECTORY, "media-folder.mjs");
const STILLS_ONLY_REASON = "the Forgejo pull request being promoted holds no video";
const VIDEO_KIND = "video";
const NOTHING_TO_PUBLISH: ProcessResult = { exitCode: 0, stdout: "", stderr: "" };
const PLACEHOLDER_OPENING = "<!-- drop ";
const PLACEHOLDER_CLOSING = " here -->";
const PLACEHOLDER_PATTERN = new RegExp(`${PLACEHOLDER_OPENING}(.+?)${PLACEHOLDER_CLOSING}`, "g");
const SIGN_IN_NEEDED_PATTERN = /is not signed in|no sign-in to/;
const WIZARD_NEEDED_PATTERN = /fall back to --wizard/;

type MediaKind = "image" | "video" | undefined;

export interface MediaEmbed {
  readonly marker: string;
  readonly urlPattern: string;
  readonly name: string;
}

interface ForgejoAttachmentRecord {
  readonly name: string;
  readonly uuid: string;
  readonly browser_download_url: string;
}

export interface PromotedPair {
  readonly githubUrl: string;
  readonly forgejoUrl: string;
  readonly forgejoRootUrl: string;
}

export interface MediaMovedToFolder {
  readonly body: string;
  readonly fileNames: readonly string[];
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function mediaKindOf(fileName: string): Promise<MediaKind> {
  const mediaFolder = (await import(pathToFileURL(MEDIA_FOLDER_MODULE_PATH).href)) as { mediaKind(name: string): MediaKind };
  return mediaFolder.mediaKind(fileName);
}

function placeholderFor(fileName: string): string {
  return `${PLACEHOLDER_OPENING}${fileName}${PLACEHOLDER_CLOSING}`;
}

function placeholderNamesIn(body: string): string[] {
  return [...body.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1]!);
}

function finishingCommand(pair: PromotedPair): string {
  return `throne forge promote ${pair.forgejoUrl}`;
}

function embedsOf(url: string): RegExp {
  return new RegExp(
    [`!\\[[^\\]]*\\]\\(${url}\\)`, `<video[^>]*src="${url}"[^>]*>[\\s\\S]*?</video>`, `<img[^>]*src="${url}"[^>]*>`, url].join("|"),
    "g",
  );
}

function anchorPairHolding(body: string, marker: string): { readonly text: string; readonly name: string } | undefined {
  for (const match of body.matchAll(/<!-- pr-media: (.+?) -->[\s\S]*?<!-- \/pr-media: \1 -->/g)) {
    if (match[0].includes(marker)) return { text: match[0], name: match[1]! };
  }
  return undefined;
}

export function bodyWithPlaceholder(body: string, embed: MediaEmbed): { readonly body: string; readonly fileName: string } {
  const anchorPair = anchorPairHolding(body, embed.marker);
  if (anchorPair !== undefined) {
    return { body: body.replace(anchorPair.text, placeholderFor(anchorPair.name)), fileName: anchorPair.name };
  }
  return { body: body.replace(embedsOf(embed.urlPattern), placeholderFor(embed.name)), fileName: embed.name };
}

function forgejoAttachmentEmbed(attachment: ForgejoAttachmentRecord): MediaEmbed {
  const marker = `/attachments/${attachment.uuid}`;
  return { marker, urlPattern: `[^\\s"'()<>]*${escapeRegExp(marker)}`, name: attachment.name };
}

export async function downloadMediaForGithub(pullRequest: ForgejoPullRequest, body: string, folder: string): Promise<MediaMovedToFolder> {
  const attachments = await pullRequest.api.readJson<ForgejoAttachmentRecord[]>(`${issueApiPath(pullRequest.address)}/assets`);
  let rewritten = body;
  const fileNames: string[] = [];
  for (const attachment of attachments.filter((candidate) => body.includes(`/attachments/${candidate.uuid}`))) {
    const placed = bodyWithPlaceholder(rewritten, forgejoAttachmentEmbed(attachment));
    if ((await mediaKindOf(placed.fileName)) === undefined) continue;
    await writeFile(path.join(folder, placed.fileName), await pullRequest.api.download(attachment.browser_download_url));
    rewritten = placed.body;
    fileNames.push(placed.fileName);
  }
  return { body: rewritten, fileNames };
}

export async function publishMediaFolder(
  context: ForgeContext,
  pullRequestUrl: string,
  folder: string,
  fileNames: readonly string[],
  stillsOnlyReason: string,
): Promise<ProcessResult> {
  if (fileNames.length === 0) return NOTHING_TO_PUBLISH;
  const kinds = await Promise.all(fileNames.map(mediaKindOf));
  const stillsOnly = kinds.includes(VIDEO_KIND) ? [] : ["--stills-only", stillsOnlyReason];
  return context.dependencies.runProcess(process.execPath, [PUBLISH_SCRIPT_PATH, pullRequestUrl, "--folder", folder, ...stillsOnly], {
    cwd: context.repo,
  });
}

async function keepMediaForTheWizard(githubUrl: string, folder: string, fileNames: readonly string[]): Promise<string> {
  const target = parsePullRequestTarget(githubUrl);
  const preferredFolder = path.join(process.env.HOME ?? "", "tmp", `pr-media-${target.kind === "url" ? target.number : ""}`);
  await mkdir(path.dirname(preferredFolder), { recursive: true });
  const keptFolder = await mkdir(preferredFolder).then(
    () => preferredFolder,
    () => mkdtemp(`${preferredFolder}-`),
  );
  for (const fileName of fileNames) await copyFile(path.join(folder, fileName), path.join(keptFolder, fileName));
  return keptFolder;
}

export async function publishMediaOnGithub(
  context: ForgeContext,
  pair: PromotedPair,
  folder: string,
  fileNames: readonly string[],
): Promise<void> {
  const result = await publishMediaFolder(context, pair.githubUrl, folder, fileNames, STILLS_ONLY_REASON);
  if (result.exitCode === 0) return;
  if (SIGN_IN_NEEDED_PATTERN.test(result.stderr)) {
    throw new ForgeRefusal(
      `the upload to ${new URL(pair.githubUrl).hostname} needs you to sign in in the browser window it opens, so ${pair.githubUrl} still holds drop placeholders; sign in there, then run: ${finishingCommand(pair)}`,
    );
  }
  if (WIZARD_NEEDED_PATTERN.test(result.stderr)) {
    const keptFolder = await keepMediaForTheWizard(pair.githubUrl, folder, fileNames);
    throw new ForgeRefusal(
      `the upload to ${new URL(pair.githubUrl).hostname} needs the hand-upload wizard because its pull request page no longer offers the comment box the browser upload uses, so ${pair.githubUrl} still holds drop placeholders; the media is kept in ${keptFolder}; start the wizard, which prints its own next step; run: node ${PUBLISH_SCRIPT_PATH} ${pair.githubUrl} --folder ${keptFolder} --wizard`,
    );
  }
  throw new ForgeRefusal(
    `re-hosting the media on ${pair.githubUrl} through pr-media publish failed, so its body still holds drop placeholders; run: ${finishingCommand(pair)}: ${result.stderr.trim()}`,
  );
}

export async function refuseUnfinishedGithubBody(context: ForgeContext, pair: PromotedPair): Promise<void> {
  const program = githubProgramForHost(new URL(pair.githubUrl).hostname);
  const result = await runGithub(githubViewArguments(pair.githubUrl), { program, repo: context.repo, bypass: false }, context.dependencies);
  if (result.exitCode !== 0) throw new ForgeRefusal(`reading ${pair.githubUrl} back after the media publish failed: ${result.stderr.trim()}`);
  const body = (JSON.parse(result.stdout) as { body: string }).body;
  const placeholders = placeholderNamesIn(body);
  const forgejoHostNames = await forgejoHostNamesIn(body, pair.forgejoRootUrl, context.dependencies);
  const remaining = [
    ...(placeholders.length > 0 ? [`drop placeholders for ${placeholders.join(", ")}`] : []),
    ...(forgejoHostNames.length > 0 ? [`links to the Forgejo host ${forgejoHostNames.join(", ")}`] : []),
  ];
  if (remaining.length === 0) return;
  throw new ForgeRefusal(
    `${pair.githubUrl} still holds ${remaining.join(" and ")} after the media publish, so the promotion is not finished; run: ${finishingCommand(pair)}`,
  );
}
