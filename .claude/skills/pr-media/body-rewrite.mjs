import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { altTextFor, ORDER_PREFIX } from './media-folder.mjs';

export const SCREENSHOTS_DRAFT_FILE = 'screenshots.md';
export const SCREENSHOTS_HEADING = '## Screenshots';
const TESTING_HEADING = '## Testing';
const ATTACHMENT_URL_PATTERN = /https?:\/\/[^\s)<>"']*(?:user-attachments|\/attachments\/)[^\s)<>"']*/;

export function attachmentUrlsIn(body) {
  return new Set(body.match(new RegExp(ATTACHMENT_URL_PATTERN, 'g')) ?? []);
}

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

function placeholderNamesIn(body) {
  return [...body.matchAll(/<!-- drop (.+?) here -->/g)].map((match) => match[1]);
}

function namesClaimedByFolder(files) {
  return new Set(files.flatMap((file) => [file.name, file.name.replace(ORDER_PREFIX, '')]));
}

function anchorNamesOutsideFolder(body, files) {
  const claimedNames = namesClaimedByFolder(files);
  return [...new Set([...anchorNamesIn(body), ...placeholderNamesIn(body)])].filter((name) => !claimedNames.has(name));
}

export function removeAnchorsOutsideFolder(body, files) {
  const removed = anchorNamesOutsideFolder(body, files);
  const cleaned = removed.reduce((text, name) => text.replace(anchorPairPattern(name), '').replace(placeholderPattern(name), ''), body);
  return { body: collapseBlankLines(cleaned), removed };
}

export function localReference(file) {
  return `![${altTextFor(file.name)}](./${file.name})`;
}

export function anchorPair(file, reference, { inTableRow = false } = {}) {
  const separator = inTableRow ? ' ' : '\n';
  return `<!-- pr-media: ${file.name} -->${separator}${reference}${separator}<!-- /pr-media: ${file.name} -->`;
}

export function isInsideTableRow(text, offset) {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  return text.slice(lineStart, offset).trimStart().startsWith('|');
}

function replaceWithAnchorPair(text, pattern, file, reference) {
  return text.replace(pattern, (...match) => {
    const offset = match.at(-2);
    return anchorPair(file, reference, { inTableRow: isInsideTableRow(text, offset) });
  });
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
    const reference = referenceFor(file);
    const existing = rewritten.match(anchorPairPattern(file.name)) ?? [];
    if (existing.length > 1) throw new Error(`${file.name} has ${existing.length} anchor pairs in the body; keep one`);
    if (existing.length === 1) {
      rewritten = replaceWithAnchorPair(rewritten, anchorPairPattern(file.name), file, reference);
      replaced.push(file.name);
      continue;
    }
    if (placeholderPattern(file.name).test(rewritten)) {
      rewritten = replaceWithAnchorPair(rewritten, placeholderPattern(file.name), file, reference);
      converted.push(file.name);
      continue;
    }
    const unnumbered = file.name.replace(ORDER_PREFIX, '');
    if (unnumbered !== file.name && (rewritten.match(anchorPairPattern(unnumbered)) ?? []).length === 1) {
      rewritten = replaceWithAnchorPair(rewritten, anchorPairPattern(unnumbered), file, reference);
      renumbered.push(`${unnumbered} -> ${file.name}`);
      continue;
    }
    if (unnumbered !== file.name && placeholderPattern(unnumbered).test(rewritten)) {
      rewritten = replaceWithAnchorPair(rewritten, placeholderPattern(unnumbered), file, reference);
      renumbered.push(`${unnumbered} -> ${file.name}`);
      continue;
    }
    pending.push(anchorPair(file, reference));
    appended.push(file.name);
  }
  if (pending.length > 0) rewritten = insertIntoScreenshots(rewritten, pending);
  const claimedNames = namesClaimedByFolder(files);
  const orphans = anchorNamesIn(body).filter((name) => !claimedNames.has(name));
  return { body: rewritten, replaced, converted, renumbered, appended, orphans };
}

export function collapseBlankLines(body) {
  return body.replace(/(?:[ \t]*\r?\n){3,}/g, '\n\n');
}

export function verifyPublishedBody(body, files, { replaceAll = false } = {}) {
  const urls = new Map();
  const failures = replaceAll
    ? anchorNamesOutsideFolder(body, files).map((name) => `${name}: anchor outside the folder survived in the published body`)
    : [];
  for (const file of files) {
    const pairs = body.match(anchorPairPattern(file.name)) ?? [];
    if (pairs.length !== 1) {
      failures.push(`${file.name}: expected one anchor pair after publishing, found ${pairs.length}`);
      continue;
    }
    if (pairs[0].includes('\n') && isInsideTableRow(body, body.indexOf(pairs[0]))) {
      failures.push(`${file.name}: anchor pair in a table row spans several lines, which breaks the row`);
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
