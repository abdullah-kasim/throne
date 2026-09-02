import { readRevisionFile, type RunGit } from './campaign-evidence-git.ts';
import type { SectionResult } from './campaign-evidence-domain.ts';

export const EXTRACTED_SYMBOL_SHARED_MODULE_PREFIX = 'src/shared-policy';

export interface ExtractedSymbolDefinitionSite {
  path: string;
  line: number;
}

export interface ExtractedSymbolFinding {
  symbol: string;
  definitionFile: string;
  otherSites: readonly ExtractedSymbolDefinitionSite[];
}

export type CampaignExtractedSymbolEvidence =
  | {
      outcome: 'verified';
      verdict: 'clean' | 'findings';
      findings: readonly ExtractedSymbolFinding[];
    }
  | {
      outcome: 'unverified';
      reason: string;
    };

export interface ExtractedSymbolSweepDeps {
  runGit: RunGit;
}

interface NewlyExtractedSharedExport {
  symbol: string;
  file: string;
}

interface ParsedGitGrepMatch {
  path: string;
  line: number;
  content: string;
}

const EXPORTED_TOP_LEVEL_DECLARATION =
  /^export\s+(?:async\s+)?(?:const|function|class)\s+([A-Za-z_$][\w$]*)/gm;
const IDENTIFIER_REGEX_ESCAPE = /[.*+?^${}()|[\]\\]/g;

function exportedSymbolNames(content: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const match of content.matchAll(EXPORTED_TOP_LEVEL_DECLARATION)) {
    names.add(match[1]!);
  }
  return names;
}

function sharedModuleDefinitionFiles(
  listing: string,
): readonly string[] {
  return listing
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) => line.endsWith('.ts') && !line.endsWith('.spec.ts'),
    );
}

async function newlyExtractedSharedExports(
  repo: string,
  base: string,
  head: string,
  sharedModulePrefix: string,
  runGit: RunGit,
): Promise<readonly NewlyExtractedSharedExport[] | undefined> {
  const listing = await runGit(repo, [
    'ls-tree',
    '-r',
    '--name-only',
    head,
    '--',
    sharedModulePrefix,
  ]);
  if (listing.code !== 0) return undefined;

  const extracted: NewlyExtractedSharedExport[] = [];
  for (const file of sharedModuleDefinitionFiles(listing.stdout)) {
    const [headContent, baseContent] = await Promise.all([
      readRevisionFile(repo, head, file, runGit),
      readRevisionFile(repo, base, file, runGit),
    ]);
    if (headContent === null) continue;
    const headExports = exportedSymbolNames(headContent);
    const baseExports =
      baseContent === null ? new Set<string>() : exportedSymbolNames(baseContent);
    for (const symbol of headExports) {
      if (!baseExports.has(symbol)) extracted.push({ symbol, file });
    }
  }
  return extracted;
}

function isDeclarationLine(line: string, symbol: string): boolean {
  const escapedSymbol = symbol.replace(IDENTIFIER_REGEX_ESCAPE, '\\$&');
  const declarationPattern = new RegExp(
    `(^|[^\\w$])(export\\s+)?(async\\s+)?(function|class)\\s+${escapedSymbol}\\b` +
      `|(^|[^\\w$])(export\\s+)?const\\s+${escapedSymbol}\\s*=`,
  );
  return declarationPattern.test(line);
}

function parseGitGrepMatch(
  rawLine: string,
  head: string,
): ParsedGitGrepMatch | undefined {
  const revisionPrefix = `${head}:`;
  if (!rawLine.startsWith(revisionPrefix)) return undefined;
  const afterRevision = rawLine.slice(revisionPrefix.length);
  const pathSeparator = afterRevision.indexOf(':');
  if (pathSeparator === -1) return undefined;
  const path = afterRevision.slice(0, pathSeparator);
  const afterPath = afterRevision.slice(pathSeparator + 1);
  const lineSeparator = afterPath.indexOf(':');
  if (lineSeparator === -1) return undefined;
  const line = Number(afterPath.slice(0, lineSeparator));
  if (!Number.isInteger(line) || line <= 0) return undefined;
  return { path, line, content: afterPath.slice(lineSeparator + 1) };
}

async function exactIdentifierDefinitionSites(
  repo: string,
  symbol: string,
  definitionFile: string,
  head: string,
  runGit: RunGit,
): Promise<readonly ExtractedSymbolDefinitionSite[] | undefined> {
  const grepResult = await runGit(repo, [
    'grep',
    '-n',
    '-w',
    '-F',
    symbol,
    head,
    '--',
    '*.ts',
  ]);
  if (grepResult.code !== 0 && grepResult.code !== 1) return undefined;

  const sites: ExtractedSymbolDefinitionSite[] = [];
  for (const rawLine of grepResult.stdout.split('\n')) {
    if (rawLine.length === 0) continue;
    const match = parseGitGrepMatch(rawLine, head);
    if (match === undefined) return undefined;
    if (match.path === definitionFile) continue;
    if (!isDeclarationLine(match.content, symbol)) continue;
    sites.push({ path: match.path, line: match.line });
  }
  return sites;
}

export async function deriveExtractedSymbolEvidence(
  options: {
    repo: string;
    base: string;
    head: string;
    sharedModulePrefix?: string;
  },
  deps: ExtractedSymbolSweepDeps,
): Promise<CampaignExtractedSymbolEvidence> {
  const sharedModulePrefix =
    options.sharedModulePrefix ?? EXTRACTED_SYMBOL_SHARED_MODULE_PREFIX;
  const extracted = await newlyExtractedSharedExports(
    options.repo,
    options.base,
    options.head,
    sharedModulePrefix,
    deps.runGit,
  );
  if (extracted === undefined) {
    return {
      outcome: 'unverified',
      reason: 'could not list shared-policy exports',
    };
  }

  const findings: ExtractedSymbolFinding[] = [];
  for (const { symbol, file } of extracted) {
    const otherSites = await exactIdentifierDefinitionSites(
      options.repo,
      symbol,
      file,
      options.head,
      deps.runGit,
    );
    if (otherSites === undefined) {
      return {
        outcome: 'unverified',
        reason: `whole-repo sweep failed for "${symbol}"`,
      };
    }
    if (otherSites.length > 0) {
      findings.push({ symbol, definitionFile: file, otherSites });
    }
  }
  return {
    outcome: 'verified',
    verdict: findings.length === 0 ? 'clean' : 'findings',
    findings,
  };
}

export async function extractedSymbolSection(
  options: { repo: string; base: string; head: string },
  deps: ExtractedSymbolSweepDeps,
): Promise<SectionResult> {
  const evidence = await deriveExtractedSymbolEvidence(options, deps);
  return evidence.outcome === 'verified'
    ? { status: evidence.verdict, evidence }
    : { status: 'unverified', reason: evidence.reason };
}
