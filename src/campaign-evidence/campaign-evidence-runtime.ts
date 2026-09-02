import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { renderEntranceRefusal } from '../shared-policy/entrance-refusal.ts';
import {
  EmptyRangeRefusal,
  flagBaseEqualsTarget,
  renderEmptyRangeRefusal,
  requireNonEmptyRange,
} from './campaign-evidence-range-guard.ts';
import {
  CAMPAIGN_FILE_AUTHORSHIPS,
  deriveCampaignFileEvidence,
  type CampaignFileChange,
  type CampaignFileEvidence,
  type SectionResult,
} from './campaign-evidence-domain.ts';
import {
  deriveCampaignCitationEvidence,
  type ChangedProseDocument,
} from './campaign-citations.ts';
import { compareCampaignDuplicateReports } from './campaign-duplicates.ts';
import { extractedSymbolSection } from './campaign-extracted-symbols.ts';
import { manifestSection } from './campaign-manifest-scan.ts';
import {
  campaignSourceExclusions,
  readCampaignChanges,
  readRevisionFile,
  realRunGit,
  type GitResult,
  type RunGit,
} from './campaign-evidence-git.ts';

export const CAMPAIGN_EVIDENCE_SECTIONS = [
  'inventory',
  'line-sizes',
  'citations',
  'duplicates',
  'extracted-symbols',
  'manifest',
] as const;
export type CampaignEvidenceSection =
  (typeof CAMPAIGN_EVIDENCE_SECTIONS)[number];
export interface CampaignEvidenceDeps {
  runGit: RunGit;
  readText: (filePath: string) => Promise<string>;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
  cwd: () => string;
}
interface CampaignEvidenceOptions {
  base: string;
  head: string;
  target: string;
  repo: string;
  sections: readonly CampaignEvidenceSection[];
  json: boolean;
  baselineDuplicates?: string;
  headDuplicates?: string;
}
interface CampaignEvidenceReport {
  source: 'campaign-evidence';
  base: string;
  head: string;
  target: string;
  repo: string;
  sections: Partial<Record<CampaignEvidenceSection, SectionResult>>;
}
const USAGE =
  'Usage: ./bin/throne-cli campaign-evidence --base <sha> --target <ref> --repo <path> [--head <ref>] ' +
  '[--section <name>]... [--json] ' +
  '[--baseline-duplicates <path>] [--head-duplicates <path>]\n';
const REAL_DEPS: CampaignEvidenceDeps = {
  runGit: realRunGit,
  readText: (filePath) => readFile(filePath, 'utf8'),
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
  cwd: () => process.cwd(),
};
function isCampaignEvidenceSection(
  value: string,
): value is CampaignEvidenceSection {
  return CAMPAIGN_EVIDENCE_SECTIONS.some((section) => section === value);
}
function takeFlagValue(
  args: string[],
  index: number,
  flag: string,
): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}
export function parseCampaignEvidenceArgs(
  args: string[],
  cwd: string,
): CampaignEvidenceOptions {
  let base: string | undefined;
  let head = 'HEAD';
  let target: string | undefined;
  let repo: string | undefined;
  let json = false;
  let baselineDuplicates: string | undefined;
  let headDuplicates: string | undefined;
  const sections: CampaignEvidenceSection[] = [];
  const singleFlags = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--json') {
      if (json) throw new Error('--json may be specified only once');
      json = true;
      continue;
    }
    if (arg === '--section') {
      const value = takeFlagValue(args, index, arg);
      if (!isCampaignEvidenceSection(value)) {
        throw new Error(`unknown campaign evidence section "${value}"`);
      }
      sections.push(value);
      index += 1;
      continue;
    }
    if (
      arg !== '--base' &&
      arg !== '--head' &&
      arg !== '--target' &&
      arg !== '--repo' &&
      arg !== '--baseline-duplicates' &&
      arg !== '--head-duplicates'
    ) {
      throw new Error(`unknown argument "${arg}"`);
    }
    if (singleFlags.has(arg)) {
      throw new Error(`${arg} may be specified only once`);
    }
    singleFlags.add(arg);
    const value = takeFlagValue(args, index, arg);
    if (arg === '--base') base = value;
    if (arg === '--head') head = value;
    if (arg === '--target') target = value;
    if (arg === '--repo') repo = value;
    if (arg === '--baseline-duplicates') baselineDuplicates = value;
    if (arg === '--head-duplicates') headDuplicates = value;
    index += 1;
  }

  if (base === undefined) throw new Error('--base is required');
  if (target === undefined) throw new Error('--target is required');
  if (repo === undefined) throw new Error('--repo is required');
  return {
    base,
    head,
    target,
    repo: path.resolve(cwd, repo),
    sections:
      sections.length === 0
        ? CAMPAIGN_EVIDENCE_SECTIONS
        : [...new Set(sections)],
    json,
    ...(baselineDuplicates === undefined
      ? {}
      : { baselineDuplicates: path.resolve(cwd, baselineDuplicates) }),
    ...(headDuplicates === undefined
      ? {}
      : { headDuplicates: path.resolve(cwd, headDuplicates) }),
  };
}
async function resolvedCommit(
  repo: string,
  revision: string,
  deps: CampaignEvidenceDeps,
): Promise<string> {
  const result = await deps.runGit(repo, [
    'rev-parse',
    '--verify',
    `${revision}^{commit}`,
  ]);
  const commit = result.stdout.trim();
  if (result.code !== 0 || !/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error(
      `could not resolve revision "${revision}": ${result.stderr.trim() || 'not a commit'}`,
    );
  }
  return commit;
}
async function requireBaseAncestor(
  repo: string,
  base: string,
  head: string,
  deps: CampaignEvidenceDeps,
): Promise<void> {
  const result = await deps.runGit(repo, [
    'merge-base',
    '--is-ancestor',
    base,
    head,
  ]);
  if (result.code !== 0) {
    throw new Error('base revision is not an ancestor of head revision');
  }
}
async function deriveFileEvidence(
  options: CampaignEvidenceOptions,
  base: string,
  head: string,
  deps: CampaignEvidenceDeps,
): Promise<CampaignFileEvidence> {
  let changes: CampaignFileChange[] | undefined;
  try {
    changes = await readCampaignChanges(
      options.repo,
      base,
      head,
      options.target,
      deps.runGit,
    );
  } catch (error) {
    return {
      outcome: 'unverified',
      reason:
        error instanceof Error
          ? `changed-file inventory failed: ${error.message}`
          : 'changed-file inventory failed with an unreadable error',
    };
  }
  return deriveCampaignFileEvidence(
    {
      baseRevision: base,
      headRevision: head,
      exclusions:
        changes === undefined ? [] : campaignSourceExclusions(changes),
    },
    {
      readChanges: async () => changes,
      readFile: (revision, filePath) =>
        readRevisionFile(options.repo, revision, filePath, deps.runGit),
    },
  );
}
function verifiedFileSection(
  fileEvidence: CampaignFileEvidence,
  select: (evidence: Extract<CampaignFileEvidence, { outcome: 'verified' }>) => {
    status: 'clean' | 'findings';
    evidence: unknown;
  },
): SectionResult {
  return fileEvidence.outcome === 'verified'
    ? select(fileEvidence)
    : { status: 'unverified', reason: fileEvidence.reason };
}
function isCampaignAuthored(
  change: Pick<CampaignFileChange, 'authorship'>,
): boolean {
  return change.authorship === CAMPAIGN_FILE_AUTHORSHIPS.CAMPAIGN;
}
async function citationSection(
  options: CampaignEvidenceOptions,
  head: string,
  fileEvidence: CampaignFileEvidence,
  deps: CampaignEvidenceDeps,
): Promise<SectionResult> {
  if (fileEvidence.outcome === 'unverified') {
    return { status: 'unverified', reason: fileEvidence.reason };
  }
  const documents: ChangedProseDocument[] = [];
  for (const entry of fileEvidence.inventory) {
    if (
      !isCampaignAuthored(entry) ||
      entry.headLineCount === null ||
      !entry.path.endsWith('.md')
    ) {
      continue;
    }
    const content = await readRevisionFile(
      options.repo,
      head,
      entry.path,
      deps.runGit,
    );
    if (content === null) {
      return {
        status: 'unverified',
        reason: `could not read changed prose "${entry.path}"`,
      };
    }
    documents.push({ path: entry.path, content });
  }
  const evidence = await deriveCampaignCitationEvidence(
    { headRevision: head, documents },
    {
      readFile: (revision, filePath) =>
        readRevisionFile(options.repo, revision, filePath, deps.runGit),
    },
  );
  return evidence.outcome === 'verified'
    ? { status: evidence.verdict, evidence }
    : { status: 'unverified', reason: evidence.reason };
}
async function duplicateSection(
  options: CampaignEvidenceOptions,
  base: string,
  head: string,
  deps: CampaignEvidenceDeps,
): Promise<SectionResult> {
  if (
    options.baselineDuplicates === undefined ||
    options.headDuplicates === undefined
  ) {
    return {
      status: 'unverified',
      reason:
        'duplicates require --baseline-duplicates and --head-duplicates',
    };
  }
  try {
    const changes = await readCampaignChanges(
      options.repo,
      base,
      head,
      options.target,
      deps.runGit,
    );
    if (changes === undefined) {
      return {
        status: 'unverified',
        reason: 'changed-file inventory is malformed',
      };
    }
    const baseline = JSON.parse(
      await deps.readText(options.baselineDuplicates),
    ) as unknown;
    const headReport = JSON.parse(
      await deps.readText(options.headDuplicates),
    ) as unknown;
    const evidence = compareCampaignDuplicateReports(
      baseline,
      headReport,
      changes
        .filter(isCampaignAuthored)
        .map(({ path: changedPath }) => changedPath),
    );
    return evidence.outcome === 'verified'
      ? { status: evidence.verdict, evidence }
      : { status: 'unverified', reason: evidence.reason };
  } catch (error) {
    return {
      status: 'unverified',
      reason:
        error instanceof Error
          ? `duplicate evidence failed: ${error.message}`
          : 'duplicate evidence failed with an unreadable error',
    };
  }
}
function exitCode(
  sections: Partial<Record<CampaignEvidenceSection, SectionResult>>,
): number {
  const results = Object.values(sections);
  if (results.some(({ status }) => status === 'unverified')) return 2;
  return results.some(({ status }) => status === 'findings') ? 1 : 0;
}
function lineSizesStatusLine(result: SectionResult): string {
  const evidence = result.evidence as { examinedCount?: unknown } | undefined;
  const examinedCount =
    evidence !== undefined && typeof evidence.examinedCount === 'number'
      ? evidence.examinedCount
      : undefined;
  return examinedCount === undefined
    ? `line-sizes: ${result.status}`
    : `line-sizes: ${result.status} (examined ${examinedCount} files)`;
}
function renderHuman(report: CampaignEvidenceReport): string {
  const lines = [
    `Campaign evidence ${report.base}..${report.head}`,
    `Repository: ${report.repo}`,
  ];
  for (const section of CAMPAIGN_EVIDENCE_SECTIONS) {
    const result = report.sections[section];
    if (result === undefined) continue;
    lines.push(
      '',
      section === 'line-sizes'
        ? lineSizesStatusLine(result)
        : `${section}: ${result.status}`,
    );
    if (result.reason !== undefined) lines.push(`  ${result.reason}`);
    if (result.evidence !== undefined) {
      lines.push(
        ...JSON.stringify(result.evidence, null, 2)
          .split('\n')
          .map((line) => `  ${line}`),
      );
    }
  }
  return `${lines.join('\n')}\n`;
}
export async function run(
  args: string[],
  deps: CampaignEvidenceDeps = REAL_DEPS,
): Promise<number> {
  let options: CampaignEvidenceOptions;
  try {
    options = parseCampaignEvidenceArgs(args, deps.cwd());
  } catch (error) {
    deps.writeStderr(
      `${renderEntranceRefusal({
        reason: `campaign-evidence: ${error instanceof Error ? error.message : String(error)}; campaign-evidence entrance validation rejected the supplied evidence arguments`,
        bypass: undefined,
        supervisorRoute: 'Ask your supervisor for an allowed alternative invocation.',
      })}\n${USAGE}`,
    );
    return 2;
  }

  let base: string;
  let head: string;
  try {
    base = await resolvedCommit(options.repo, options.base, deps);
    head = await resolvedCommit(options.repo, options.head, deps);
    options.target = await resolvedCommit(options.repo, options.target, deps);
    await requireBaseAncestor(options.repo, base, head, deps);
    await requireNonEmptyRange(options.repo, base, head, deps.runGit);
    flagBaseEqualsTarget(base, options.target, deps.writeStderr);
  } catch (error) {
    if (error instanceof EmptyRangeRefusal) {
      deps.writeStderr(`${renderEmptyRangeRefusal(error.base, error.head)}\n`);
      return 2;
    }
    deps.writeStderr(
      `campaign-evidence: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }

  const requested = new Set(options.sections);
  const needsFiles =
    requested.has('inventory') ||
    requested.has('line-sizes') ||
    requested.has('citations');
  const fileEvidence = needsFiles
    ? await deriveFileEvidence(options, base, head, deps)
    : undefined;
  const sections: Partial<
    Record<CampaignEvidenceSection, SectionResult>
  > = {};

  if (requested.has('inventory') && fileEvidence !== undefined) {
    sections.inventory = verifiedFileSection(fileEvidence, (evidence) => ({
      status: 'clean',
      evidence: evidence.inventory,
    }));
  }
  if (requested.has('line-sizes') && fileEvidence !== undefined) {
    sections['line-sizes'] = verifiedFileSection(fileEvidence, (evidence) => ({
      status: evidence.sizes.verdict,
      evidence: evidence.sizes,
    }));
  }
  if (requested.has('citations') && fileEvidence !== undefined) {
    sections.citations = await citationSection(
      options,
      head,
      fileEvidence,
      deps,
    );
  }
  if (requested.has('duplicates')) {
    sections.duplicates = await duplicateSection(options, base, head, deps);
  }
  if (requested.has('extracted-symbols')) {
    sections['extracted-symbols'] = await extractedSymbolSection(
      { repo: options.repo, base, head },
      { runGit: deps.runGit },
    );
  }
  if (requested.has('manifest')) {
    sections.manifest = await manifestSection(
      options.repo,
      base,
      head,
      deps.runGit,
    );
  }

  const report: CampaignEvidenceReport = {
    source: 'campaign-evidence',
    base,
    head,
    target: options.target,
    repo: options.repo,
    sections,
  };
  deps.writeStdout(
    options.json ? `${JSON.stringify(report)}\n` : renderHuman(report),
  );
  return exitCode(sections);
}
