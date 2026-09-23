#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeContactSheet } from './contact-sheet.mjs';
import { altTextFor, listMediaFiles, namesWithoutOrderPrefix, ORDER_PREFIX, sizeRefusal } from './media-folder.mjs';

export const MINIMUM_GH_VERSION_FOR_ATTACH = '2.99.0';
const GUARD_MARKER = 'throne-gh-guard-shim';
const PUBLIC_GITHUB_HOST = 'github.com';
const LIVE_BODY_FILE = 'live.md';
export const SCREENSHOTS_DRAFT_FILE = 'screenshots.md';
const SCREENSHOTS_HEADING = '## Screenshots';
const TESTING_HEADING = '## Testing';
const ATTACHMENT_URL_PATTERN = /https:\/\/[^\s)<>"']*user-attachments[^\s)<>"']*/;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function anchorPairPattern(name) {
  const escaped = escapeRegExp(name);
  return new RegExp(`<!-- pr-media: ${escaped} -->[\\s\\S]*?<!-- /pr-media: ${escaped} -->`, 'g');
}

function placeholderPattern(name) {
  return new RegExp(`<!-- drop ${escapeRegExp(name)} here -->`, 'g');
}

export function anchorNamesIn(body) {
  return [...body.matchAll(/<!-- pr-media: (.+?) -->/g)].map((match) => match[1]);
}

export function localReference(file) {
  return `![${altTextFor(file.name)}](./${file.name})`;
}

export function assetReference(file, url) {
  return file.kind === 'video' ? url : `![${altTextFor(file.name)}](${url})`;
}

export function anchorPair(file, reference) {
  return `<!-- pr-media: ${file.name} -->\n${reference}\n<!-- /pr-media: ${file.name} -->`;
}

function insertIntoScreenshots(body, pairs) {
  const addition = pairs.join('\n\n');
  const bounds = screenshotsSectionBounds(body);
  if (bounds) {
    const section = body.slice(bounds.start, bounds.end);
    const closingDetailsOffset = section.lastIndexOf('</details>');
    if (closingDetailsOffset >= 0) {
      const insertAt = bounds.start + closingDetailsOffset;
      const before = body.slice(0, insertAt).replace(/\s+$/, '');
      const after = body.slice(insertAt);
      return `${before}\n\n${addition}\n\n${after}`;
    }
    const before = body.slice(0, bounds.end).replace(/\s+$/, '');
    const after = body.slice(bounds.end);
    return `${before}\n\n${addition}\n${after ? `\n${after}` : ''}`;
  }
  const section = `${SCREENSHOTS_HEADING}\n\n${addition}`;
  const testingAt = body.search(new RegExp(`^${escapeRegExp(TESTING_HEADING)}\\s*$`, 'm'));
  if (testingAt >= 0) {
    return `${body.slice(0, testingAt).replace(/\s+$/, '')}\n\n${section}\n\n${body.slice(testingAt)}`;
  }
  return `${body.replace(/\s+$/, '')}\n\n${section}\n`;
}

function screenshotsSectionBounds(body) {
  const screenshotsAt = body.search(new RegExp(`^${escapeRegExp(SCREENSHOTS_HEADING)}\\s*$`, 'm'));
  if (screenshotsAt < 0) return null;
  const nextHeading = body.slice(screenshotsAt + SCREENSHOTS_HEADING.length).search(/^## /m);
  const end = nextHeading >= 0 ? screenshotsAt + SCREENSHOTS_HEADING.length + nextHeading : body.length;
  return { start: screenshotsAt, end };
}

export function replaceScreenshotsSection(body, draft) {
  const section = draft.trim().startsWith(SCREENSHOTS_HEADING) ? draft.trim() : `${SCREENSHOTS_HEADING}\n\n${draft.trim()}`;
  const bounds = screenshotsSectionBounds(body);
  if (bounds) {
    const after = body.slice(bounds.end);
    return `${body.slice(0, bounds.start)}${section}\n${after ? `\n${after}` : ''}`;
  }
  const testingAt = body.search(new RegExp(`^${escapeRegExp(TESTING_HEADING)}\\s*$`, 'm'));
  if (testingAt >= 0) {
    return `${body.slice(0, testingAt).replace(/\s+$/, '')}\n\n${section}\n\n${body.slice(testingAt)}`;
  }
  return `${body.replace(/\s+$/, '')}\n\n${section}\n`;
}

export function readScreenshotsDraft(folder) {
  const draftPath = path.join(folder, SCREENSHOTS_DRAFT_FILE);
  return existsSync(draftPath) ? readFileSync(draftPath, 'utf8') : null;
}

export function rewriteBody(body, files, referenceFor = localReference) {
  const replaced = [];
  const converted = [];
  const renumbered = [];
  const appended = [];
  const pending = [];
  let rewritten = body;
  for (const file of files) {
    const pair = anchorPair(file, referenceFor(file));
    const existing = rewritten.match(anchorPairPattern(file.name)) ?? [];
    if (existing.length > 1) throw new Error(`${file.name} has ${existing.length} anchor pairs in the body; keep one`);
    if (existing.length === 1) {
      rewritten = rewritten.replace(anchorPairPattern(file.name), () => pair);
      replaced.push(file.name);
      continue;
    }
    if (placeholderPattern(file.name).test(rewritten)) {
      rewritten = rewritten.replace(placeholderPattern(file.name), () => pair);
      converted.push(file.name);
      continue;
    }
    const unnumbered = file.name.replace(ORDER_PREFIX, '');
    if (unnumbered !== file.name && (rewritten.match(anchorPairPattern(unnumbered)) ?? []).length === 1) {
      rewritten = rewritten.replace(anchorPairPattern(unnumbered), () => pair);
      renumbered.push(`${unnumbered} -> ${file.name}`);
      continue;
    }
    if (unnumbered !== file.name && placeholderPattern(unnumbered).test(rewritten)) {
      rewritten = rewritten.replace(placeholderPattern(unnumbered), () => pair);
      renumbered.push(`${unnumbered} -> ${file.name}`);
      continue;
    }
    pending.push(pair);
    appended.push(file.name);
  }
  if (pending.length > 0) rewritten = insertIntoScreenshots(rewritten, pending);
  const claimedNames = new Set(files.flatMap((file) => [file.name, file.name.replace(ORDER_PREFIX, '')]));
  const orphans = anchorNamesIn(body).filter((name) => !claimedNames.has(name));
  return { body: rewritten, replaced, converted, renumbered, appended, orphans };
}

const LOOSE_IMAGE_TAG_PATTERN = /<img\b[^>]*\balt="([^"]*)"[^>]*\bsrc="(https:\/\/[^"]*user-attachments[^"]*)"[^>]*>/g;
const LOOSE_IMAGE_MARKDOWN_PATTERN = /!\[([^\]]*)\]\((https:\/\/[^\s)]*user-attachments[^\s)]*)\)/g;
const LOOSE_BARE_URL_PATTERN = /^[ \t]*(https:\/\/\S*user-attachments\S*)[ \t]*$/gm;

function stripAnchorPairs(body) {
  return body.replace(/<!-- pr-media: (.+?) -->[\s\S]*?<!-- \/pr-media: \1 -->/g, (pair) => ' '.repeat(pair.length));
}

export function collectLooseUploads(body) {
  const outsideAnchors = stripAnchorPairs(body);
  const uploads = [];
  for (const match of outsideAnchors.matchAll(LOOSE_IMAGE_TAG_PATTERN)) {
    uploads.push({ kind: 'image', alt: match[1], url: match[2], text: match[0], at: match.index });
  }
  for (const match of outsideAnchors.matchAll(LOOSE_IMAGE_MARKDOWN_PATTERN)) {
    uploads.push({ kind: 'image', alt: match[1], url: match[2], text: match[0], at: match.index });
  }
  for (const match of outsideAnchors.matchAll(LOOSE_BARE_URL_PATTERN)) {
    uploads.push({ kind: 'video', alt: '', url: match[1], text: match[0], at: match.index });
  }
  return uploads.sort((a, b) => a.at - b.at);
}

function normalizedStem(text) {
  return path.basename(text, path.extname(text)).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function mapUploadsToFiles(uploads, files) {
  const assets = new Map();
  const unmatchedImages = [];
  const images = files.filter((file) => file.kind === 'image');
  const videos = files.filter((file) => file.kind === 'video');
  for (const upload of uploads.filter((candidate) => candidate.kind === 'image')) {
    const byAlt = images.find((file) => !assets.has(file.name) && normalizedStem(file.name) === normalizedStem(upload.alt));
    if (byAlt) assets.set(byAlt.name, upload.url);
    else unmatchedImages.push(upload);
  }
  for (const upload of unmatchedImages) {
    const next = images.find((file) => !assets.has(file.name));
    if (next) assets.set(next.name, upload.url);
  }
  const videoUploads = uploads.filter((candidate) => candidate.kind === 'video');
  videos.forEach((file, index) => {
    if (videoUploads[index]) assets.set(file.name, videoUploads[index].url);
  });
  const missing = files.filter((file) => !assets.has(file.name)).map((file) => file.name);
  const extra = uploads.filter((upload) => ![...assets.values()].includes(upload.url)).map((upload) => upload.url);
  return { assets, missing, extra };
}

export function removeLooseUploads(body, uploads) {
  let cleaned = body;
  for (const upload of uploads) {
    cleaned = cleaned.replace(upload.text, '');
  }
  return collapseBlankLines(cleaned);
}

export function collapseBlankLines(body) {
  return body.replace(/(?:[ \t]*\r?\n){3,}/g, '\n\n');
}

export function wizardInstructions(pullRequest, files) {
  const videos = files.filter((file) => file.kind === 'video');
  const images = files.filter((file) => file.kind === 'image');
  const lines = [
    `Upload wizard for https://${pullRequest.host}/${pullRequest.owner}/${pullRequest.repo}/pull/${pullRequest.number}`,
    '',
    '1. Open the pull request, press the pencil on the description, and put the cursor on an empty line under "## Screenshots".',
    `2. Drop these ${files.length} files from the media folder into the editor, in file-name order: the number each name starts with is its place in the body. Images may go in any order (GitHub keeps their file name in the alt text).`,
  ];
  if (videos.length > 1) {
    lines.push(`   Videos carry no name once uploaded, so drop them one at a time in EXACTLY this order (their number prefixes, ascending) and wait for each upload to finish:`);
    videos.forEach((file, index) => lines.push(`     ${index + 1}. ${file.name}`));
  } else if (videos.length === 1) {
    lines.push(`   The one video, ${videos[0].name}, can go anywhere.`);
  }
  if (images.length) lines.push(`   Images: ${images.map((file) => file.name).join(', ')}`);
  lines.push('A drop landing outside the Screenshots spoiler is fine: the collect step below moves every loose upload into its anchor inside the wrapper.');
  lines.push('3. Wait until every upload has turned into a link or <img> tag, then press "Update comment".');
  lines.push('4. Say "done" here. The collect step then reads the live body, moves each upload into its anchor and removes the loose copies.');
  lines.push('', `Then run: node "$THRONE_LIVE_ROOT/.claude/skills/pr-media/publish.mjs" <pr-url> --collect`);
  return lines.join('\n');
}

export function verifyPublishedBody(body, files) {
  const urls = new Map();
  const failures = [];
  for (const file of files) {
    const pairs = body.match(anchorPairPattern(file.name)) ?? [];
    if (pairs.length !== 1) {
      failures.push(`${file.name}: expected one anchor pair after publishing, found ${pairs.length}`);
      continue;
    }
    const url = pairs[0].match(ATTACHMENT_URL_PATTERN)?.[0];
    if (!url) {
      failures.push(`${file.name}: anchor pair holds no user-attachments URL`);
      continue;
    }
    if (pairs[0].includes(`./${file.name}`)) {
      failures.push(`${file.name}: anchor pair still carries the local path`);
      continue;
    }
    urls.set(file.name, url);
  }
  return { urls, failures };
}

export function parseArguments(argv) {
  const options = { target: undefined, folder: undefined, dryRun: false, assets: new Map(), wizard: false, collect: false };
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
  if (!options.target) throw new Error('usage: publish.mjs <pr url | number> [--folder <dir>] [--dry-run] [--wizard | --collect] [--asset <name>=<url>]...');
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

function attachArguments(files) {
  return files.flatMap((file) => ['--attach', file.kind === 'image' ? `./${file.name}#${altTextFor(file.name)}` : `./${file.name}`]);
}

function planPublish(pullRequest, files, assets, gh, collect = false, liveBody = '') {
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
  if (enterprise) {
    throw new Error(`${pullRequest.host} is GitHub Enterprise Server, where gh --attach is refused; run --wizard, upload by hand, then --collect (SKILL.md section 4)`);
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
  if (rewrite.extra?.length) lines.push(`loose uploads removed without a matching file: ${rewrite.extra.join(', ')}`);
  if (rewrite.draftApplied) lines.push(`${SCREENSHOTS_HEADING} section replaced from ${SCREENSHOTS_DRAFT_FILE}`);
  return lines.join('\n');
}

export function publish(options, gh = { path: resolveGhOnPath(), bypassArguments: [] }) {
  gh.bypassArguments = isThroneGuard(gh.path) ? ['--bypass'] : [];
  const pullRequest = parsePullRequestTarget(options.target, () => repositoryFromCwd(gh));
  const folder = path.resolve(options.folder ?? path.join(process.env.HOME ?? '', 'tmp', `pr-media-${pullRequest.number}`));
  const files = listMediaFiles(folder);
  const unnumbered = namesWithoutOrderPrefix(files);
  if (unnumbered.length) {
    process.stderr.write(`pr-media: ${unnumbered.length} file(s) lack the NN- order prefix, so their place in the body and the video drop order rest on plain name order: ${unnumbered.join(', ')}\n`);
  }
  refuseOversizedFiles(files);
  if (options.wizard) {
    return { wizard: true, folder, instructions: wizardInstructions(pullRequest, files) };
  }
  const liveBody = readLiveBody(gh, pullRequest);
  const plan = planPublish(pullRequest, files, options.assets, gh, options.collect, liveBody);
  const withoutLooseUploads = options.collect ? removeLooseUploads(liveBody, plan.uploads) : liveBody;
  const draft = readScreenshotsDraft(folder);
  const bodyToRewrite = draft === null ? withoutLooseUploads : replaceScreenshotsSection(withoutLooseUploads, draft);
  const rewrite = rewriteBody(bodyToRewrite, files, plan.referenceFor);
  if (draft !== null) rewrite.draftApplied = true;
  if (plan.extra?.length) rewrite.extra = plan.extra;
  const editArguments = ['pr', 'edit', pullRequest.number, '-R', repositoryFlag(pullRequest), '--body-file', LIVE_BODY_FILE, ...plan.attach];
  const commandLine = ['gh', ...gh.bypassArguments, ...editArguments].map((argument) => (/[\s#]/.test(argument) ? `'${argument}'` : argument)).join(' ');
  if (options.dryRun) {
    return { dryRun: true, folder, body: rewrite.body, commandLine, summary: describeRewrite(rewrite) };
  }
  const liveBodyPath = path.join(folder, LIVE_BODY_FILE);
  writeFileSync(liveBodyPath, `${rewrite.body}\n`);
  try {
    runGh(gh, editArguments, { cwd: folder, bypassGuard: true });
  } finally {
    rmSync(liveBodyPath, { force: true });
  }
  const publishedBody = readLiveBody(gh, pullRequest);
  const verification = verifyPublishedBody(publishedBody, files);
  if (verification.failures.length > 0) {
    throw new Error(`published body failed verification:\n${verification.failures.join('\n')}`);
  }
  writeContactSheet(folder);
  return { dryRun: false, folder, urls: verification.urls, summary: describeRewrite(rewrite), orphans: rewrite.orphans };
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
