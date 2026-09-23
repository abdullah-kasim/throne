import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import { meaningfulWords } from '../relevance-classifier/rules-backend.ts';

export interface Candidate {
  path: string;
  reasons: string[];
  score: number;
}

export interface GatherCandidatesOptions {
  budget?: number;
  env?: NodeJS.ProcessEnv;
}

const MAX_CANDIDATES = 200;
const MAX_FILE_SIZE = '200K';
const TOP_CANDIDATES_FOR_IMPORT_HOP = 10;
const HISTORY_LOG_LIMIT = 20;
const DEFAULT_RG_SEARCH_DIRS = ['/opt/homebrew/bin'];

const WORD_MATCH_SCORE = 3;
const PATH_MATCH_SCORE = 2;
const HISTORY_MATCH_SCORE = 2;
const IMPORT_NEIGHBOUR_SCORE = 4;

const EXCLUDE_GLOBS = [
  '!**/node_modules/**',
  '!**/dist/**',
  '!**/package-lock.json',
  '!**/*.lock',
];

const IDENTIFIER_TOKEN_PATTERN = /[A-Za-z][A-Za-z0-9_]*/g;
const CAMEL_OR_SNAKE_PATTERN = /[a-z0-9][A-Z]|_/;
const RESOLUTION_SUFFIXES = [
  '',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '/index.ts',
  '/index.tsx',
  '/index.js',
];

function splitIdentifierIntoWords(token: string): string {
  return token.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
}

export function meaningfulWordsAndTokens(text: string): ReadonlySet<string> {
  const words = new Set(meaningfulWords(text));
  const identifierTokens = text.match(IDENTIFIER_TOKEN_PATTERN) ?? [];
  for (const token of identifierTokens) {
    if (!CAMEL_OR_SNAKE_PATTERN.test(token)) continue;
    for (const word of meaningfulWords(splitIdentifierIntoWords(token))) {
      words.add(word);
    }
  }
  return words;
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function resolveRgPath(
  env: NodeJS.ProcessEnv,
  includeDefaultSearchDirs: boolean,
): Promise<string> {
  const pathDirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const searchDirs = includeDefaultSearchDirs
    ? [...new Set([...DEFAULT_RG_SEARCH_DIRS, ...pathDirs])]
    : pathDirs;
  for (const dir of searchDirs) {
    const candidate = path.join(dir, 'rg');
    if (await isExecutableFile(candidate)) return candidate;
  }
  throw new Error(
    'ripgrep (`rg`) was not found at /opt/homebrew/bin/rg or on PATH; install ripgrep to use `throne locate`.',
  );
}

function stripLeadingDotSlash(relPath: string): string {
  return relPath.startsWith('./') ? relPath.slice(2) : relPath;
}

function runRg(rgPath: string, args: string[], cwd: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      rgPath,
      args,
      { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        const exitCode =
          error && 'code' in error && typeof error.code === 'number'
            ? error.code
            : undefined;
        if (error && exitCode !== 1) {
          reject(error);
          return;
        }
        resolve(
          stdout
            .split('\n')
            .map((line) => stripLeadingDotSlash(line.trim()))
            .filter(Boolean),
        );
      },
    );
  });
}

function listFiles(rgPath: string, root: string): Promise<string[]> {
  const args = ['--files', '--max-filesize', MAX_FILE_SIZE];
  for (const glob of EXCLUDE_GLOBS) args.push('--glob', glob);
  args.push('--', '.');
  return runRg(rgPath, args, root);
}

function wordMatchFiles(
  rgPath: string,
  root: string,
  word: string,
): Promise<string[]> {
  const args = [
    '--files-with-matches',
    '--fixed-strings',
    '--max-filesize',
    MAX_FILE_SIZE,
  ];
  for (const glob of EXCLUDE_GLOBS) args.push('--glob', glob);
  args.push('--', word, '.');
  return runRg(rgPath, args, root);
}

function filesReferencingBasename(
  rgPath: string,
  root: string,
  basenameWithoutExtension: string,
): Promise<string[]> {
  if (basenameWithoutExtension.length < 2) return Promise.resolve([]);
  const args = [
    '--files-with-matches',
    '--fixed-strings',
    '--max-filesize',
    MAX_FILE_SIZE,
  ];
  for (const glob of EXCLUDE_GLOBS) args.push('--glob', glob);
  args.push('--', basenameWithoutExtension, '.');
  return runRg(rgPath, args, root);
}

function historyFiles(root: string, token: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      'git',
      [
        'log',
        `-S${token}`,
        '--name-only',
        '-n',
        String(HISTORY_LOG_LIMIT),
        '--pretty=format:',
      ],
      { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve([]);
          return;
        }
        resolve(stdout.split('\n').map((line) => line.trim()).filter(Boolean));
      },
    );
  });
}

function basenameWithoutExtension(relPath: string): string {
  const base = path.posix.basename(relPath);
  const dotIndex = base.lastIndexOf('.');
  return dotIndex > 0 ? base.slice(0, dotIndex) : base;
}

function extractImportSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  for (const match of content.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
    specifiers.push(match[1]);
  }
  for (const match of content.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    specifiers.push(match[1]);
  }
  for (const match of content.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)) {
    specifiers.push(match[1]);
  }
  for (const block of content.matchAll(/\bimport\s*\(([^)]*)\)/g)) {
    for (const inner of block[1].matchAll(/"([^"]+)"/g)) specifiers.push(inner[1]);
  }
  return specifiers;
}

function resolveRelativeSpecifier(
  fromRelPath: string,
  specifier: string,
  allFilesSet: ReadonlySet<string>,
): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const baseDir = path.posix.dirname(fromRelPath);
  const joined = path.posix.normalize(path.posix.join(baseDir, specifier));
  for (const suffix of RESOLUTION_SUFFIXES) {
    const candidate = `${joined}${suffix}`;
    if (allFilesSet.has(candidate)) return candidate;
  }
  return undefined;
}

async function readFileCached(
  cache: Map<string, string>,
  absPath: string,
): Promise<string> {
  const cached = cache.get(absPath);
  if (cached !== undefined) return cached;
  const content = await readFile(absPath, 'utf8').catch(() => '');
  cache.set(absPath, content);
  return content;
}

async function importNeighbourReasons(
  rgPath: string,
  root: string,
  allFilesSet: ReadonlySet<string>,
  topCandidates: readonly string[],
  contentCache: Map<string, string>,
): Promise<Map<string, Set<string>>> {
  const additions = new Map<string, Set<string>>();
  const addNeighbour = (relPath: string, anchorRelPath: string) => {
    const reasons = additions.get(relPath) ?? new Set<string>();
    reasons.add(`imports:${anchorRelPath}`);
    additions.set(relPath, reasons);
  };

  for (const anchorRelPath of topCandidates) {
    const anchorContent = await readFileCached(
      contentCache,
      path.join(root, anchorRelPath),
    );
    for (const specifier of extractImportSpecifiers(anchorContent)) {
      const resolved = resolveRelativeSpecifier(anchorRelPath, specifier, allFilesSet);
      if (resolved && resolved !== anchorRelPath) addNeighbour(resolved, anchorRelPath);
    }

    const basename = basenameWithoutExtension(anchorRelPath);
    const referencing = await filesReferencingBasename(rgPath, root, basename);
    for (const otherRelPath of referencing) {
      if (otherRelPath === anchorRelPath || !allFilesSet.has(otherRelPath)) continue;
      const otherContent = await readFileCached(
        contentCache,
        path.join(root, otherRelPath),
      );
      const resolvesToAnchor = extractImportSpecifiers(otherContent).some(
        (specifier) =>
          resolveRelativeSpecifier(otherRelPath, specifier, allFilesSet) ===
          anchorRelPath,
      );
      if (resolvesToAnchor) addNeighbour(otherRelPath, anchorRelPath);
    }
  }

  return additions;
}

function pathDepth(relPath: string): number {
  return relPath.split('/').length;
}

async function gatherCandidatesForRoot(
  rgPath: string,
  root: string,
  taskWords: readonly string[],
  scores: Map<string, { reasons: Set<string>; score: number }>,
): Promise<void> {
  const addReason = (relPath: string, reason: string, weight: number) => {
    const entry = scores.get(relPath) ?? { reasons: new Set<string>(), score: 0 };
    if (!entry.reasons.has(reason)) {
      entry.reasons.add(reason);
      entry.score += weight;
    }
    scores.set(relPath, entry);
  };

  const allFiles = await listFiles(rgPath, root);
  const allFilesSet = new Set(allFiles);

  for (const word of taskWords) {
    const matches = await wordMatchFiles(rgPath, root, word);
    for (const relPath of matches) {
      if (allFilesSet.has(relPath)) addReason(relPath, `matches:${word}`, WORD_MATCH_SCORE);
    }
  }

  for (const relPath of allFiles) {
    const pathWords = meaningfulWordsAndTokens(relPath);
    for (const word of taskWords) {
      if (pathWords.has(word)) addReason(relPath, `path:${word}`, PATH_MATCH_SCORE);
    }
  }

  for (const token of taskWords) {
    const historyPaths = await historyFiles(root, token);
    for (const relPath of historyPaths) {
      if (allFilesSet.has(relPath)) {
        addReason(relPath, `history:${token}`, HISTORY_MATCH_SCORE);
      }
    }
  }

  const topCandidates = [...scores.entries()]
    .filter(([relPath]) => allFilesSet.has(relPath))
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, TOP_CANDIDATES_FOR_IMPORT_HOP)
    .map(([relPath]) => relPath);

  const contentCache = new Map<string, string>();
  const neighbourReasons = await importNeighbourReasons(
    rgPath,
    root,
    allFilesSet,
    topCandidates,
    contentCache,
  );
  for (const [relPath, reasons] of neighbourReasons) {
    for (const reason of reasons) addReason(relPath, reason, IMPORT_NEIGHBOUR_SCORE);
  }
}

export async function gatherCandidates(
  task: string,
  roots: readonly string[],
  opts: GatherCandidatesOptions = {},
): Promise<Candidate[]> {
  const rgPath = await resolveRgPath(opts.env ?? process.env, opts.env === undefined);
  const taskWords = [...meaningfulWordsAndTokens(task)];
  const scores = new Map<string, { reasons: Set<string>; score: number }>();

  for (const root of roots) {
    await gatherCandidatesForRoot(rgPath, root, taskWords, scores);
  }

  const candidates: Candidate[] = [...scores.entries()].map(
    ([filePath, { reasons, score }]) => ({
      path: filePath,
      reasons: [...reasons],
      score,
    }),
  );

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return pathDepth(a.path) - pathDepth(b.path);
  });

  const budget = Math.min(opts.budget ?? MAX_CANDIDATES, MAX_CANDIDATES);
  return candidates.slice(0, budget);
}
