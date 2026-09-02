import type { SectionResult } from './campaign-evidence-domain.ts';
import type { RunGit } from './campaign-evidence-git.ts';
import { excludingQuotedContext } from './quoted-context-exclusion.ts';

const PLAN_CITATION_PATTERN =
  /\(todo [0-9]+\)|per todo [0-9]|slice [0-9]{2}/;
// Excludes a marker that only appears inside inline-code/quoted prose (see
// `quoted-context-exclusion.ts`) — a comment reading `kept for reference` as
// literal quoted text about the convention, not the convention itself, must
// not fail this scan. (Note the backticks here, not double quotes: the
// exclusion only recognizes backtick/single-quote/pipe/slash — 99c caught
// this exact file nearly tripping its own scan by quoting the phrase with
// double quotes instead.)
const GRAVEYARD_MARKER_PATTERN = excludingQuotedContext(
  '_(old|legacy|v2)\\b|kept for reference',
);

interface ManifestScan {
  name: string;
  command: string;
  matches: readonly string[];
}

function addedLines(diff: string): readonly string[] {
  return diff
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('++'));
}

async function runManifestScan(
  name: string,
  command: string,
  diffArgs: string[],
  pattern: RegExp,
  repo: string,
  runGit: RunGit,
): Promise<ManifestScan> {
  const result = await runGit(repo, diffArgs);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `${name}: git diff failed`);
  }
  const matches = addedLines(result.stdout).filter((line) =>
    pattern.test(line),
  );
  return { name, command, matches };
}

export async function manifestSection(
  repo: string,
  base: string,
  head: string,
  runGit: RunGit,
): Promise<SectionResult> {
  try {
    const scans = await Promise.all([
      runManifestScan(
        'plan-citation-scan',
        `git diff -U0 ${base}..${head} -- ` +
          "':(exclude,glob)**/test/**' ':(exclude,glob)test/**' | " +
          "grep -E '^\\+[^+]' | grep -nE '\\(todo [0-9]+\\)|per todo [0-9]|slice [0-9]{2}'",
        [
          'diff',
          '-U0',
          `${base}..${head}`,
          '--',
          ':(exclude,glob)**/test/**',
          ':(exclude,glob)test/**',
        ],
        PLAN_CITATION_PATTERN,
        repo,
        runGit,
      ),
      runManifestScan(
        'graveyard-marker-scan',
        `git diff -U0 ${base}..${head} | grep -E '^\\+[^+]' | ` +
          'grep -nE "(^|[^\\`\\\'|/])(_(old|legacy|v2)\\\\b|kept for reference)"',
        ['diff', '-U0', `${base}..${head}`],
        GRAVEYARD_MARKER_PATTERN,
        repo,
        runGit,
      ),
    ]);
    const findings = scans.some((scan) => scan.matches.length > 0);
    return {
      status: findings ? 'findings' : 'clean',
      evidence: {
        entries: scans.map((scan) => ({
          name: scan.name,
          command: scan.command,
          pass: scan.matches.length === 0 ? 'no output' : undefined,
          matches: scan.matches.length === 0 ? undefined : scan.matches,
        })),
      },
    };
  } catch (error) {
    return {
      status: 'unverified',
      reason:
        error instanceof Error
          ? `manifest scan failed: ${error.message}`
          : 'manifest scan failed with an unreadable error',
    };
  }
}
