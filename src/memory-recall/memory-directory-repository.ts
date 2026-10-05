import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { physicalPath } from './memory-files.ts';

const SLUG_SEPARATOR = '-';
const HIDDEN_NAME_PREFIX = '.';

async function namesInDirectory(directory: string): Promise<readonly string[]> {
  try {
    return await readdir(directory);
  } catch {
    return [];
  }
}

async function directorySpelledBySlug(parent: string, remainingSlug: string): Promise<string | undefined> {
  if (remainingSlug === '') return parent;
  const longestNamesFirst = [...(await namesInDirectory(parent))].sort((left, right) => right.length - left.length);
  for (const name of longestNamesFirst) {
    const slugContinuesWithName =
      remainingSlug === name || remainingSlug.startsWith(`${name}${SLUG_SEPARATOR}`);
    if (!slugContinuesWithName) continue;
    const found = await directorySpelledBySlug(path.join(parent, name), remainingSlug.slice(name.length + 1));
    if (found !== undefined) return found;
  }
  return undefined;
}

export function repositoryNameOfCheckout(checkout: string): string {
  const name = path.basename(checkout);
  return name.startsWith(HIDDEN_NAME_PREFIX) ? path.basename(path.dirname(checkout)) : name;
}

async function walkStartOfSlug(
  slug: string,
  homeDirectory: string,
): Promise<{ directory: string; remainingSlug: string }> {
  if (slug.startsWith(SLUG_SEPARATOR)) {
    return { directory: path.sep, remainingSlug: slug.slice(SLUG_SEPARATOR.length) };
  }
  return { directory: await physicalPath(homeDirectory), remainingSlug: slug };
}

export async function checkoutOfMemoryDirectory(
  memoryDirectory: string,
  homeDirectory: string,
): Promise<string | undefined> {
  const { directory, remainingSlug } = await walkStartOfSlug(path.basename(memoryDirectory), homeDirectory);
  return directorySpelledBySlug(directory, remainingSlug);
}

export async function repositoryNameOfMemoryDirectory(
  memoryDirectory: string,
  homeDirectory: string,
): Promise<string | undefined> {
  const checkout = await checkoutOfMemoryDirectory(memoryDirectory, homeDirectory);
  return checkout === undefined ? undefined : repositoryNameOfCheckout(checkout);
}
