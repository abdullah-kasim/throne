#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { accessSync, constants, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { proxyFor, uploadWithBrowser } from './browser-upload.mjs';
import {
  attachmentUrlsIn,
  collapseBlankLines,
  localReference,
  readScreenshotsDraft,
  removeAnchorsOutsideFolder,
  replaceScreenshotsSection,
  rewriteBody,
  SCREENSHOTS_DRAFT_FILE,
  SCREENSHOTS_HEADING,
  verifyPublishedBody,
} from './body-rewrite.mjs';
import { writeContactSheet } from './contact-sheet.mjs';
import {
  attachToForgejoPullRequest,
  detachFromForgejoPullRequest,
  editForgejoPullRequestBody,
  FORGE_COMMAND_ON_PATH,
  forgejoEditArguments,
  isForgejoPullRequest,
  viewForgejoPullRequest,
} from './forge-command.mjs';
import { collectLooseUploads, mapUploadsToFiles } from './loose-uploads.mjs';
import {
  altTextFor,
  filesInBodyOrder,
  groupIntoPairsAndSingles,
  listMediaFiles,
  namesMissingTheirPartner,
  namesWithoutOrderPrefix,
  sizeRefusal,
} from './media-folder.mjs';

export {
  anchorNamesIn,
  anchorPair,
  anchorPairPattern,
  collapseBlankLines,
  isInsideTableRow,
  localReference,
  readScreenshotsDraft,
  removeAnchorsOutsideFolder,
  replaceScreenshotsSection,
  rewriteBody,
  SCREENSHOTS_DRAFT_FILE,
  verifyPublishedBody,
} from './body-rewrite.mjs';

export const MINIMUM_GH_VERSION_FOR_ATTACH = '2.99.0';
const GUARD_MARKER = 'throne-gh-guard-shim';
const PUBLIC_GITHUB_HOST = 'github.com';
const LIVE_BODY_FILE = 'live.md';

export function assetReference(file, url) {
  return file.kind === 'video' ? url : `![${altTextFor(file.name)}](${url})`;
}

export function removeLooseUploads(body, uploads) {
  let cleaned = body;
  for (const upload of uploads) {
    cleaned = cleaned.replace(upload.text, '');
  }
  return collapseBlankLines(cleaned);
}

export function wizardInstructions(pullRequest, files) {
  const lines = [
    `Upload wizard for https://${pullRequest.host}/${pullRequest.owner}/${pullRequest.repo}/pull/${pullRequest.number}`,
    '',
    '1. Open the pull request, press the pencil on the description, and put the cursor on an empty line under "## Screenshots".',
    `2. Drop these ${files.length} files from the media folder into the editor. They are listed in body order, where a before comes just ahead of its after. Images may go in any order (GitHub keeps their file name in the alt text); videos carry no name once uploaded, so drop the videos one at a time in EXACTLY the order they appear here and wait for each upload to finish:`,
    ...files.map((file, index) => `     ${index + 1}. ${file.name}${file.kind === 'video' ? ' (video)' : ''}`),
  ];
  lines.push('A drop landing outside the Screenshots spoiler is fine: the collect step below moves every loose upload into its anchor inside the wrapper.');
  lines.push('3. Wait until every upload has turned into a link or <img> tag, then press "Update comment".');
  lines.push('4. Say "done" here. The collect step then reads the live body, moves each upload into its anchor and removes the loose copies.');
  lines.push('', `Then run: node "$THRONE_LIVE_ROOT/.claude/skills/pr-media/publish.mjs" <pr-url> --collect`);
  return lines.join('\n');
}

export function parseArguments(argv) {
  const options = { target: undefined, folder: undefined, dryRun: false, assets: new Map(), wizard: false, collect: false, replaceAll: false, stillsOnly: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--folder') {
      options.folder = argv[index + 1];
      index += 1;
    } else if (argument === '--dry-run') {
      options.dryRun = true;
    } else if (argument === '--wizard') {
      options.wizard = true;
    } else if (argument === '--collect') {
      options.collect = true;
    } else if (argument === '--replace-all') {
      options.replaceAll = true;
    } else if (argument === '--stills-only') {
      const reason = (argv[index + 1] ?? '').trim();
      if (!reason || reason.startsWith('--')) throw new Error('--stills-only needs a reason saying why the PR changes no interaction, e.g. --stills-only "copy change only"');
      options.stillsOnly = reason;
      index += 1;
    } else if (argument === '--asset') {
      const [name, ...urlParts] = (argv[index + 1] ?? '').split('=');
      const url = urlParts.join('=');
      if (!name || !url) throw new Error('--asset takes <file name>=<uploaded url>');
      options.assets.set(name, url);
      index += 1;
    } else if (argument.startsWith('-')) {
      throw new Error(`unknown option ${argument}`);
    } else if (options.target === undefined) {
      options.target = argument;
    } else {
      throw new Error(`unexpected argument ${argument}`);
    }
  }
  if (!options.target) throw new Error('usage: publish.mjs <pr url | number> [--folder <dir>] [--dry-run] [--replace-all] [--wizard | --collect] [--asset <name>=<url>]... [--stills-only "<reason>"]');
  if (options.wizard && options.collect) throw new Error('--wizard and --collect are the two halves of one upload; run one at a time');
  return options;
}

export function resolveGhOnPath(environmentPath = process.env.PATH ?? '') {
  for (const directory of environmentPath.split(path.delimiter)) {
    const candidate = path.join(directory || '.', 'gh');
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error('gh is not on PATH');
}

function isThroneGuard(ghPath) {
  try {
    return readFileSync(ghPath, 'latin1').includes(GUARD_MARKER);
  } catch {
    return false;
  }
}

export function isVersionAtLeast(actual, minimum) {
  const parse = (version) => version.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const [a, b] = [parse(actual), parse(minimum)];
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0);
  }
  return true;
}

function runGh(gh, args, options = {}) {
  const result = spawnSync(gh.path, [...(options.bypassGuard ? gh.bypassArguments : []), ...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    env: gh.environment ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`gh ${args.join(' ')} failed (exit ${result.status}):\n${result.stderr}${result.stdout}`);
  }
  return result.stdout;
}

function ghVersion(gh) {
  return runGh(gh, ['--version']).match(/gh version (\d+\.\d+\.\d+)/)?.[1] ?? '0.0.0';
}

export function parsePullRequestTarget(target, repositoryFromCwd) {
  const asUrl = target.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (asUrl) return { host: asUrl[1], owner: asUrl[2], repo: asUrl[3], number: asUrl[4] };
  if (!/^\d+$/.test(target)) throw new Error(`${target} is neither a pull request URL nor a number`);
  const { host, owner, repo } = repositoryFromCwd();
  return { host, owner, repo, number: target };
}

function repositoryFromCwd(gh) {
  const view = JSON.parse(runGh(gh, ['repo', 'view', '--json', 'nameWithOwner,url']));
  const [owner, repo] = view.nameWithOwner.split('/');
  return { host: new URL(view.url).host, owner, repo };
}

function repositoryFlag(pullRequest) {
  return `${pullRequest.host}/${pullRequest.owner}/${pullRequest.repo}`;
}

function readLiveBody(gh, pullRequest) {
  return runGh(gh, ['pr', 'view', pullRequest.number, '-R', repositoryFlag(pullRequest), '--json', 'body', '-q', '.body']).replace(/\s+$/, '');
}

function refuseOversizedFiles(files) {
  const refusals = files.map(sizeRefusal).filter(Boolean);
  if (refusals.length > 0) throw new Error(refusals.join('\n'));
}

function refuseFolderWithoutVideo(files, stillsOnlyReason) {
  if (stillsOnlyReason || files.some((file) => file.kind === 'video')) return;
  throw new Error('the media folder holds no video, but every interaction the PR changes is recorded as a video (pr-media SKILL.md). If the PR changes no interaction at all (static styling, copy or colour only), publish again with --stills-only "<reason>"');
}

function attachArguments(files) {
  return files.flatMap((file) => ['--attach', file.kind === 'image' ? `./${file.name}#${altTextFor(file.name)}` : `./${file.name}`]);
}

export function environmentForHost(host, environment = process.env, readProxy = proxyFor) {
  if (host === PUBLIC_GITHUB_HOST || environment.HTTPS_PROXY || environment.https_proxy) return environment;
  const proxy = readProxy(host, environment);
  return proxy ? { ...environment, HTTPS_PROXY: proxy } : environment;
}

export function uploadsThroughTheBrowser(pullRequest, options) {
  return pullRequest.host !== PUBLIC_GITHUB_HOST && !options.collect && !options.wizard && options.assets.size === 0;
}

function planPublish(pullRequest, files, assets, gh, collect = false, liveBody = '', dryRun = false) {
  const enterprise = pullRequest.host !== PUBLIC_GITHUB_HOST;
  if (collect) {
    const uploads = collectLooseUploads(liveBody);
    const mapping = mapUploadsToFiles(uploads, files);
    if (mapping.missing.length > 0) {
      throw new Error(`no loose upload found in the body for: ${mapping.missing.join(', ')} (run --wizard, upload them under ${SCREENSHOTS_HEADING}, press Update comment, then --collect)`);
    }
    return { referenceFor: (file) => assetReference(file, mapping.assets.get(file.name)), attach: [], uploads, extra: mapping.extra };
  }
  if (assets.size > 0) {
    const missing = files.filter((file) => !assets.has(file.name)).map((file) => file.name);
    if (missing.length > 0) throw new Error(`--asset given for some files but not for: ${missing.join(', ')}`);
    return { referenceFor: (file) => assetReference(file, assets.get(file.name)), attach: [] };
  }
  if (enterprise && dryRun) {
    return { referenceFor: localReference, attach: [], browserUpload: true };
  }
  if (enterprise) {
    throw new Error(`${pullRequest.host} is GitHub Enterprise Server, where gh --attach is refused; the browser upload found no files to send, so run --wizard, upload by hand, then --collect (SKILL.md section 4)`);
  }
  const version = ghVersion(gh);
  if (!isVersionAtLeast(version, MINIMUM_GH_VERSION_FOR_ATTACH)) {
    throw new Error(`gh ${version} has no --attach; publishing needs gh ${MINIMUM_GH_VERSION_FOR_ATTACH} or newer: brew upgrade gh`);
  }
  return { referenceFor: localReference, attach: attachArguments(files) };
}

function describeRewrite(rewrite) {
  const lines = [];
  if (rewrite.replaced.length) lines.push(`replacing: ${rewrite.replaced.join(', ')}`);
  if (rewrite.converted.length) lines.push(`converting old placeholders: ${rewrite.converted.join(', ')}`);
  if (rewrite.renumbered.length) lines.push(`renumbering anchors: ${rewrite.renumbered.join(', ')}`);
  if (rewrite.appended.length) lines.push(`adding to ${SCREENSHOTS_HEADING}: ${rewrite.appended.join(', ')}`);
  if (rewrite.orphans.length) lines.push(`left untouched, no such file in the folder: ${rewrite.orphans.join(', ')}`);
  if (rewrite.removed?.length) lines.push(`removed, not in the folder: ${rewrite.removed.join(', ')}`);
  if (rewrite.extra?.length) lines.push(`loose uploads removed without a matching file: ${rewrite.extra.join(', ')}`);
  if (rewrite.draftApplied) lines.push(`${SCREENSHOTS_HEADING} section replaced from ${SCREENSHOTS_DRAFT_FILE}`);
  if (rewrite.stillsOnly) lines.push(`stills only: ${rewrite.stillsOnly}`);
  if (rewrite.browserUpload) lines.push(`${rewrite.browserUpload} file(s) would be uploaded through the signed-in browser before the edit`);
  if (rewrite.forgejoAttachments) lines.push(`${rewrite.forgejoAttachments} file(s) would be uploaded as Forgejo attachments before the edit`);
  return lines.join('\n');
}

function isPublicGithubUrl(target) {
  return URL.canParse(target) && new URL(target).host === PUBLIC_GITHUB_HOST;
}

function mediaFolderFor(options, number) {
  return path.resolve(options.folder ?? path.join(process.env.HOME ?? '', 'tmp', `pr-media-${number}`));
}

function readMediaFolder(folder, stillsOnlyReason) {
  const listedFiles = listMediaFiles(folder);
  refuseFolderWithoutVideo(listedFiles, stillsOnlyReason);
  const groups = groupIntoPairsAndSingles(listedFiles);
  const files = filesInBodyOrder(groups);
  const unnumbered = namesWithoutOrderPrefix(files);
  if (unnumbered.length) {
    process.stderr.write(`pr-media: ${unnumbered.length} file(s) lack the NN- order prefix, so their place in the body and the video drop order rest on plain name order: ${unnumbered.join(', ')}\n`);
  }
  const unpartnered = namesMissingTheirPartner(groups);
  if (unpartnered.length) {
    process.stderr.write(`pr-media: ${unpartnered.length} file(s) are one side of a before/after pair whose other side is not in the folder, so each is shown alone: ${unpartnered.join(', ')}\n`);
  }
  refuseOversizedFiles(files);
  return files;
}

function rewriteLiveBody(liveBody, files, folder, options, referenceFor) {
  const draft = readScreenshotsDraft(folder);
  const bodyToRewrite = draft === null ? liveBody : replaceScreenshotsSection(liveBody, draft);
  const rewrite = rewriteBody(bodyToRewrite, files, referenceFor);
  if (options.replaceAll) {
    const removal = removeAnchorsOutsideFolder(rewrite.body, files);
    Object.assign(rewrite, { body: removal.body, removed: removal.removed, orphans: [] });
  }
  if (draft !== null) rewrite.draftApplied = true;
  if (options.stillsOnly) rewrite.stillsOnly = options.stillsOnly;
  return rewrite;
}

function shellLine(argv) {
  return argv.map((argument) => (/[\s#]/.test(argument) ? `'${argument}'` : argument)).join(' ');
}

function writeBodyAndEdit(folder, body, edit) {
  const liveBodyPath = path.join(folder, LIVE_BODY_FILE);
  writeFileSync(liveBodyPath, `${body}\n`);
  try {
    edit(liveBodyPath);
  } finally {
    rmSync(liveBodyPath, { force: true });
  }
}

function verifyAndFinishPublish(publishedBody, files, folder, options, rewrite) {
  const verification = verifyPublishedBody(publishedBody, files, { replaceAll: options.replaceAll });
  if (verification.failures.length > 0) {
    throw new Error(`published body failed verification:\n${verification.failures.join('\n')}`);
  }
  writeContactSheet(folder);
  return { dryRun: false, folder, urls: verification.urls, summary: describeRewrite(rewrite), orphans: rewrite.orphans };
}

function refuseManualUploadOnForgejo(options) {
  if (!options.wizard && !options.collect && options.assets.size === 0) return;
  throw new Error(`${options.target} is a Forgejo pull request, where publish uploads every file through the Forgejo attachment API; --wizard, --collect and --asset are for GitHub Enterprise Server only`);
}

function attachEachFileToForgejo(forge, target, folder, files) {
  return new Map(files.map((file) => [file.name, attachToForgejoPullRequest(forge, target, path.join(folder, file.name)).markdown]));
}

function detachAttachmentsTakenOutOfBody(forge, target, bodyBefore, bodyAfter) {
  const stillEmbedded = attachmentUrlsIn(bodyAfter);
  for (const url of attachmentUrlsIn(bodyBefore)) {
    if (!stillEmbedded.has(url)) detachFromForgejoPullRequest(forge, target, url);
  }
}

function publishToForgejo(options, forge) {
  const pullRequest = viewForgejoPullRequest(forge, options.target);
  const folder = mediaFolderFor(options, pullRequest.number);
  const files = readMediaFolder(folder, options.stillsOnly);
  refuseManualUploadOnForgejo(options);
  const markdownByName = options.dryRun ? null : attachEachFileToForgejo(forge, options.target, folder, files);
  const referenceFor = markdownByName ? (file) => markdownByName.get(file.name) : localReference;
  const rewrite = rewriteLiveBody(pullRequest.body.replace(/\s+$/, ''), files, folder, options, referenceFor);
  if (options.dryRun) {
    rewrite.forgejoAttachments = files.length;
    const commandLine = shellLine(['throne', 'forge', ...forgejoEditArguments(options.target, path.join(folder, LIVE_BODY_FILE))]);
    return { dryRun: true, folder, body: rewrite.body, commandLine, summary: describeRewrite(rewrite) };
  }
  writeBodyAndEdit(folder, rewrite.body, (bodyFile) => editForgejoPullRequestBody(forge, options.target, bodyFile));
  const publishedBody = viewForgejoPullRequest(forge, options.target).body;
  const result = verifyAndFinishPublish(publishedBody, files, folder, options, rewrite);
  detachAttachmentsTakenOutOfBody(forge, options.target, pullRequest.body, publishedBody);
  return result;
}

export function publish(options, gh = { path: resolveGhOnPath(), bypassArguments: [] }, forge = FORGE_COMMAND_ON_PATH) {
  if (!isPublicGithubUrl(options.target) && isForgejoPullRequest(forge, options.target)) return publishToForgejo(options, forge);
  gh.bypassArguments = isThroneGuard(gh.path) ? ['--bypass'] : [];
  const pullRequest = parsePullRequestTarget(options.target, () => repositoryFromCwd(gh));
  gh.environment = environmentForHost(pullRequest.host);
  const folder = mediaFolderFor(options, pullRequest.number);
  const files = readMediaFolder(folder, options.stillsOnly);
  if (options.wizard) {
    return { wizard: true, folder, instructions: wizardInstructions(pullRequest, files) };
  }
  const liveBody = readLiveBody(gh, pullRequest);
  if (uploadsThroughTheBrowser(pullRequest, options) && !options.dryRun) {
    options.assets = uploadWithBrowser(pullRequest, files, folder);
  }
  const plan = planPublish(pullRequest, files, options.assets, gh, options.collect, liveBody, options.dryRun);
  const withoutLooseUploads = options.collect ? removeLooseUploads(liveBody, plan.uploads) : liveBody;
  const rewrite = rewriteLiveBody(withoutLooseUploads, files, folder, options, plan.referenceFor);
  if (plan.extra?.length) rewrite.extra = plan.extra;
  if (plan.browserUpload) rewrite.browserUpload = files.length;
  const editArguments = ['pr', 'edit', pullRequest.number, '-R', repositoryFlag(pullRequest), '--body-file', LIVE_BODY_FILE, ...plan.attach];
  const commandLine = shellLine(['gh', ...gh.bypassArguments, ...editArguments]);
  if (options.dryRun) {
    return { dryRun: true, folder, body: rewrite.body, commandLine, summary: describeRewrite(rewrite) };
  }
  writeBodyAndEdit(folder, rewrite.body, () => runGh(gh, editArguments, { cwd: folder, bypassGuard: true }));
  return verifyAndFinishPublish(readLiveBody(gh, pullRequest), files, folder, options, rewrite);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const result = publish(parseArguments(process.argv.slice(2)));
    if (result.wizard) {
      console.log(result.instructions);
      process.exit(0);
    }
    if (result.summary) console.log(result.summary);
    if (result.dryRun) {
      console.log(`\n--- rewritten body (dry run, nothing sent) ---\n${result.body}\n--- command (cwd ${result.folder}) ---\n${result.commandLine}`);
    } else {
      for (const [name, url] of result.urls) console.log(`${name} -> ${url}`);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
