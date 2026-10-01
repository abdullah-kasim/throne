import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
export const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm']);
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

export function mediaKind(name) {
  const extension = path.extname(name).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  return undefined;
}

export const ORDER_PREFIX = /^\d{2,}-/;

export function altTextFor(name) {
  return path.basename(name, path.extname(name)).replace(ORDER_PREFIX, '').replace(/[-_]+/g, ' ');
}

export function namesWithoutOrderPrefix(files) {
  return files.filter((file) => !ORDER_PREFIX.test(file.name)).map((file) => file.name);
}

export function listMediaFiles(folder) {
  let entries;
  try {
    entries = readdirSync(folder);
  } catch {
    throw new Error(`media folder does not exist: ${folder}`);
  }
  const files = entries
    .filter((name) => !name.startsWith('.') && mediaKind(name) !== undefined)
    .sort()
    .map((name) => ({ name, kind: mediaKind(name), bytes: statSync(path.join(folder, name)).size }));
  if (files.length === 0) {
    throw new Error(`no images or videos in ${folder} (accepted: ${[...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS].join(' ')})`);
  }
  return files;
}

const PAIR_SIDE_SUFFIX = /-(before|after)$/;

function stemOf(name) {
  return path.basename(name, path.extname(name));
}

export function pairSideOf(name) {
  return stemOf(name).match(PAIR_SIDE_SUFFIX)?.[1];
}

export function pairStemOf(name) {
  return stemOf(name).replace(PAIR_SIDE_SUFFIX, '');
}

export function groupIntoPairsAndSingles(files) {
  const groups = [];
  const pairsByStem = new Map();
  for (const file of files) {
    const side = pairSideOf(file.name);
    if (!side) {
      groups.push({ single: file });
      continue;
    }
    const stem = pairStemOf(file.name);
    let pair = pairsByStem.get(stem);
    if (!pair) {
      pair = { stem, before: undefined, after: undefined };
      pairsByStem.set(stem, pair);
      groups.push({ pair });
    }
    if (pair[side]) throw new Error(`${pair[side].name} and ${file.name} are both the ${side} side of ${stem}; keep one`);
    pair[side] = file;
  }
  return groups.map((group) => {
    if (!group.pair || (group.pair.before && group.pair.after)) return group;
    return { single: group.pair.before ?? group.pair.after };
  });
}

export function filesInBodyOrder(groups) {
  return groups.flatMap((group) => (group.pair ? [group.pair.before, group.pair.after] : [group.single]));
}

export function namesMissingTheirPartner(groups) {
  return groups.filter((group) => group.single && pairSideOf(group.single.name)).map((group) => group.single.name);
}

export function sizeRefusal(file) {
  if (file.bytes === 0) return `${file.name} is empty`;
  const limit = file.kind === 'image' ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
  if (file.bytes > limit) {
    return `${file.name} is ${formatMegabytes(file.bytes)} MB; GitHub accepts ${file.kind}s up to ${formatMegabytes(limit)} MB`;
  }
  return undefined;
}

function formatMegabytes(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '');
}
