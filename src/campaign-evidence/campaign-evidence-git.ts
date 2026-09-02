import { execFile } from 'node:child_process';
import path from 'node:path';
import {
  CAMPAIGN_FILE_AUTHORSHIPS,
  CAMPAIGN_FILE_CHANGE_KINDS,
  isRepositorySourceSizeExemptPath,
  type CampaignFileChange,
  type CampaignPathExclusion,
} from './campaign-evidence-domain.ts';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type RunGit = (repo: string, args: string[]) => Promise<GitResult>;

const SOURCE_EXCLUSIONS: readonly CampaignPathExclusion[] = [
  { pathPrefix: 'node_modules', reason: 'dependency tree' },
  { pathPrefix: 'vendor', reason: 'vendored tree' },
  { pathPrefix: 'dist', reason: 'generated output' },
  { pathPrefix: 'build', reason: 'generated output' },
  { pathPrefix: 'test/fixtures', reason: 'dedicated fixture tree' },
  { pathPrefix: 'test/__snapshots__', reason: 'snapshot tree' },
  { pathPrefix: 'data', reason: 'throne ledger data' },
];

const HAND_AUTHORED_SOURCE_EXTENSIONS = new Set([
  '.bash',
  '.c',
  '.cc',
  '.cjs',
  '.cpp',
  '.cs',
  '.css',
  '.fish',
  '.go',
  '.h',
  '.hpp',
  '.html',
  '.java',
  '.js',
  '.jsx',
  '.kt',
  '.lua',
  '.mjs',
  '.php',
  '.pl',
  '.pm',
  '.py',
  '.rb',
  '.rs',
  '.scss',
  '.sh',
  '.sol',
  '.sql',
  '.svelte',
  '.swift',
  '.ts',
  '.tsx',
  '.vue',
  '.zsh',
]);
const TEST_DIRECTORY_NAME = 'test';

export const realRunGit: RunGit = (repo, args) =>
  new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          code:
            error === null
              ? 0
              : typeof error.code === 'number'
                ? error.code
                : 2,
          stdout,
          stderr,
        });
      },
    );
  });

function changedFilesFromNameStatus(
  output: string,
  campaignAuthoredPaths: ReadonlySet<string>,
): CampaignFileChange[] | undefined {
  if (output.length === 0) return [];
  const changes: CampaignFileChange[] = [];
  for (const line of output.trimEnd().split('\n')) {
    const [status, changedPath, unexpected] = line.split('\t');
    if (
      unexpected !== undefined ||
      status === undefined ||
      changedPath === undefined ||
      changedPath.length === 0
    ) {
      return undefined;
    }
    const kind =
      status === 'A'
        ? CAMPAIGN_FILE_CHANGE_KINDS.CREATED
        : status === 'D'
          ? CAMPAIGN_FILE_CHANGE_KINDS.DELETED
          : status === 'M' || status === 'T'
            ? CAMPAIGN_FILE_CHANGE_KINDS.CHANGED
            : undefined;
    if (kind === undefined) return undefined;
    changes.push({
      path: changedPath,
      kind,
      authorship: campaignAuthoredPaths.has(changedPath)
        ? CAMPAIGN_FILE_AUTHORSHIPS.CAMPAIGN
        : CAMPAIGN_FILE_AUTHORSHIPS.ABSORBED,
    });
  }
  return changes;
}

function changedPathsFromLog(output: string): ReadonlySet<string> {
  return new Set(
    output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
}

function isHandAuthoredSourcePath(filePath: string): boolean {
  if (isTestFilePath(filePath)) return false;
  const extension = path.extname(filePath).toLowerCase();
  if (HAND_AUTHORED_SOURCE_EXTENSIONS.has(extension)) return true;
  return (
    extension.length === 0 &&
    ['bin/', 'scripts/'].some((prefix) => filePath.startsWith(prefix))
  );
}

function isTestFilePath(filePath: string): boolean {
  return filePath.split('/').includes(TEST_DIRECTORY_NAME);
}

export function campaignSourceExclusions(
  changes: readonly CampaignFileChange[],
): readonly CampaignPathExclusion[] {
  return [
    ...SOURCE_EXCLUSIONS,
    ...changes
      .filter(({ path: filePath }) =>
        isRepositorySourceSizeExemptPath(filePath),
      )
      .map(({ path: pathPrefix }) => ({
        pathPrefix,
        reason:
          'repository source-structure exemption (src/campaign-evidence/source-file-structure.spec.ts)',
      })),
    ...changes
      .filter(({ path: filePath }) => !isHandAuthoredSourcePath(filePath))
      .map(({ path: pathPrefix }) => ({
        pathPrefix,
        reason: isTestFilePath(pathPrefix)
          ? 'test file outside production source scope'
          : 'not a hand-authored source file',
      })),
  ];
}

export async function readCampaignChanges(
  repo: string,
  base: string,
  head: string,
  target: string,
  runGit: RunGit,
): Promise<CampaignFileChange[] | undefined> {
  const inventoryResult = await runGit(repo, [
    'diff',
    '--relative',
    '--name-status',
    '--no-renames',
    `${base}..${head}`,
    '--',
    '.',
  ]);
  if (inventoryResult.code !== 0) {
    throw new Error(inventoryResult.stderr.trim() || 'git diff failed');
  }
  const authorshipResult = await runGit(repo, [
    'log',
    '--relative',
    '--format=',
    '--name-only',
    '--no-renames',
    head,
    '--not',
    target,
    '--',
    '.',
  ]);
  if (authorshipResult.code !== 0) {
    throw new Error(
      authorshipResult.stderr.trim() ||
        'git campaign authorship scan failed',
    );
  }
  return changedFilesFromNameStatus(
    inventoryResult.stdout,
    changedPathsFromLog(authorshipResult.stdout),
  );
}

export async function readRevisionFile(
  repo: string,
  revision: string,
  filePath: string,
  runGit: RunGit,
): Promise<string | null> {
  const result = await runGit(repo, ['show', `${revision}:./${filePath}`]);
  return result.code === 0 ? result.stdout : null;
}
