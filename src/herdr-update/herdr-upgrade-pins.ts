import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const CLIENT_PIN_PATH = 'src/herdr/herdr-client.ts';
const RELEASE_PIN_PATH = 'src/install-services/herdr-release.service.ts';
const RELEASE_TARGETS = ['linux-aarch64', 'linux-x86_64', 'macos-aarch64', 'macos-x86_64'] as const;
const CLIENT_TAG_LINE = /export const OWNED_HERDR_CLIENT_RELEASE_TAG = '[^']+';/;
const CLIENT_PROTOCOL_LINE = /export const THRONE_HERDR_PROTOCOL = '[^']+';/;
const SHA256_DIGEST_PREFIX = 'sha256:';

export const HERDR_PIN_PATHS: readonly string[] = [CLIENT_PIN_PATH, RELEASE_PIN_PATH];

export type HerdrReleaseMetadata = {
  readonly assets: readonly { readonly name: string; readonly digest?: string }[];
};

export type HerdrPinTarget = {
  readonly tag: string;
  readonly protocol: string;
  readonly repositorySlug: string;
  readonly metadata: HerdrReleaseMetadata;
};

export type RewrittenHerdrPins = { readonly client: string; readonly release: string };

export function herdrPinCommitMessage(tag: string): string {
  return `Pin herdr to ${tag}`;
}

function clientSourcePinnedTo(source: string, target: HerdrPinTarget): string {
  if (!CLIENT_TAG_LINE.test(source) || !CLIENT_PROTOCOL_LINE.test(source)) {
    throw new Error('herdr-client.ts pin constants not found in their expected shape');
  }
  return source
    .replace(CLIENT_TAG_LINE, `export const OWNED_HERDR_CLIENT_RELEASE_TAG = '${target.tag}';`)
    .replace(CLIENT_PROTOCOL_LINE, `export const THRONE_HERDR_PROTOCOL = '${target.protocol}';`);
}

function releaseDigest(metadata: HerdrReleaseMetadata, filename: string): string {
  const digest = metadata.assets.find((asset) => asset.name === filename)?.digest;
  if (!digest?.startsWith(SHA256_DIGEST_PREFIX)) {
    throw new Error(`no sha256 digest in release metadata for ${filename}`);
  }
  return digest.slice(SHA256_DIGEST_PREFIX.length);
}

function releaseSourcePinnedTo(source: string, target: HerdrPinTarget): string {
  let release = source
    .replace(/version: '[^']+',/, `version: '${target.tag.replace(/^v/, '')}',`)
    .replace(/repository: '[^']+',/, `repository: '${target.repositorySlug}',`)
    .replace(/tag: '[^']+',/, `tag: '${target.tag}',`);
  for (const platform of RELEASE_TARGETS) {
    const filename = `herdr-${platform}`;
    const digestSlot = new RegExp(`(filename: '${filename}',\\s*\\n\\s*sha256: ')[0-9a-f]{64}(')`);
    if (!digestSlot.test(release)) throw new Error(`could not locate the ${platform} sha256 slot`);
    release = release.replace(digestSlot, `$1${releaseDigest(target.metadata, filename)}$2`);
  }
  return release;
}

export async function rewrittenHerdrPins(
  repository: string,
  target: HerdrPinTarget,
): Promise<RewrittenHerdrPins> {
  return {
    client: clientSourcePinnedTo(await readFile(path.join(repository, CLIENT_PIN_PATH), 'utf8'), target),
    release: releaseSourcePinnedTo(await readFile(path.join(repository, RELEASE_PIN_PATH), 'utf8'), target),
  };
}

export async function writeHerdrPins(repository: string, pins: RewrittenHerdrPins): Promise<void> {
  await writeFile(path.join(repository, CLIENT_PIN_PATH), pins.client);
  await writeFile(path.join(repository, RELEASE_PIN_PATH), pins.release);
}

export async function dirtyPathsOutsideHerdrPins(repository: string): Promise<string> {
  const excludedPins = HERDR_PIN_PATHS.map((pinPath) => `:!${pinPath}`);
  const { stdout } = await execFileAsync('git', ['-C', repository, 'status', '--porcelain', '--', '.', ...excludedPins]);
  return stdout.trim();
}
