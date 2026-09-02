export interface DuplicateSite {
  path: string;
  startLine: number;
  endLine: number;
}

export interface DuplicateSitePair {
  first: DuplicateSite;
  second: DuplicateSite;
}

export interface SkippedMalformedDuplicate {
  report: 'baseline' | 'head';
  entryIndex: number;
  firstPath: string;
  secondPath: string;
  reason: 'malformed duplicate outside campaign scope';
}

export type CampaignDuplicateEvidence =
  | {
      outcome: 'verified';
      verdict: 'clean' | 'findings';
      introducedPairs: readonly DuplicateSitePair[];
      baselineDebt: readonly DuplicateSitePair[];
      skippedMalformedDuplicates: readonly SkippedMalformedDuplicate[];
    }
  | {
      outcome: 'unverified';
      reason: string;
    };

interface DetectorSite {
  name: string;
  start: number;
  end: number;
}

interface DetectorDuplicate {
  firstFile: DetectorSite;
  secondFile: DetectorSite;
}

interface DetectorReport {
  duplicates: unknown[];
}

function detectorSitePath(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const name = (value as Record<string, unknown>).name;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

function isDetectorSite(value: unknown): value is DetectorSite {
  const path = detectorSitePath(value);
  if (path === undefined) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Number.isInteger(candidate.start) &&
    Number(candidate.start) > 0 &&
    Number.isInteger(candidate.end) &&
    Number(candidate.end) >= Number(candidate.start)
  );
}

function isDetectorDuplicate(value: unknown): value is DetectorDuplicate {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    isDetectorSite(candidate.firstFile) &&
    isDetectorSite(candidate.secondFile)
  );
}

function isDetectorReport(value: unknown): value is DetectorReport {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return Array.isArray(candidate.duplicates);
}

function duplicateSite(site: DetectorSite): DuplicateSite {
  return {
    path: site.name,
    startLine: site.start,
    endLine: site.end,
  };
}

function duplicateSiteKey(site: DuplicateSite): string {
  return JSON.stringify([site.path, site.startLine, site.endLine]);
}

function normalizedPair(duplicate: DetectorDuplicate): DuplicateSitePair {
  const sites = [
    duplicateSite(duplicate.firstFile),
    duplicateSite(duplicate.secondFile),
  ].sort((left, right) =>
    duplicateSiteKey(left).localeCompare(duplicateSiteKey(right)),
  );
  return { first: sites[0]!, second: sites[1]! };
}

function duplicatePairKey(pair: DuplicateSitePair): string {
  return JSON.stringify([
    pair.first.path,
    pair.first.startLine,
    pair.first.endLine,
    pair.second.path,
    pair.second.startLine,
    pair.second.endLine,
  ]);
}

function hasCampaignAuthoredSite(
  firstPath: string,
  secondPath: string,
  campaignPaths: ReadonlySet<string>,
): boolean {
  return campaignPaths.has(firstPath) || campaignPaths.has(secondPath);
}

function detectorDuplicatePaths(
  value: unknown,
): { firstPath: string; secondPath: string } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const firstPath = detectorSitePath(candidate.firstFile);
  const secondPath = detectorSitePath(candidate.secondFile);
  return firstPath !== undefined && secondPath !== undefined
    ? { firstPath, secondPath }
    : undefined;
}

type ParsedDetectorReport =
  | {
      outcome: 'verified';
      pairs: Map<string, DuplicateSitePair>;
      skippedMalformedDuplicates: readonly SkippedMalformedDuplicate[];
    }
  | {
      outcome: 'unverified';
      reason: string;
    };

function parseDetectorReport(
  reportName: 'baseline' | 'head',
  report: DetectorReport,
  campaignPaths: ReadonlySet<string>,
): ParsedDetectorReport {
  const pairs = new Map<string, DuplicateSitePair>();
  const skippedMalformedDuplicates: SkippedMalformedDuplicate[] = [];
  for (const [entryIndex, duplicate] of report.duplicates.entries()) {
    if (!isDetectorDuplicate(duplicate)) {
      const paths = detectorDuplicatePaths(duplicate);
      if (
        paths === undefined ||
        hasCampaignAuthoredSite(
          paths.firstPath,
          paths.secondPath,
          campaignPaths,
        )
      ) {
        return {
          outcome: 'unverified',
          reason: `${reportName} duplicate report contains a malformed campaign-relevant entry`,
        };
      }
      skippedMalformedDuplicates.push({
        report: reportName,
        entryIndex,
        ...paths,
        reason: 'malformed duplicate outside campaign scope',
      });
      continue;
    }
    const pair = normalizedPair(duplicate);
    if (
      !hasCampaignAuthoredSite(
        pair.first.path,
        pair.second.path,
        campaignPaths,
      )
    ) {
      continue;
    }
    pairs.set(duplicatePairKey(pair), pair);
  }
  return { outcome: 'verified', pairs, skippedMalformedDuplicates };
}

export function compareCampaignDuplicateReports(
  baselineReport: unknown,
  headReport: unknown,
  campaignPaths: readonly string[],
): CampaignDuplicateEvidence {
  if (!isDetectorReport(baselineReport)) {
    return {
      outcome: 'unverified',
      reason: 'baseline duplicate report is malformed',
    };
  }
  if (!isDetectorReport(headReport)) {
    return {
      outcome: 'unverified',
      reason: 'head duplicate report is malformed',
    };
  }

  const campaignPathSet = new Set(campaignPaths);
  const baseline = parseDetectorReport(
    'baseline',
    baselineReport,
    campaignPathSet,
  );
  if (baseline.outcome === 'unverified') return baseline;
  const head = parseDetectorReport('head', headReport, campaignPathSet);
  if (head.outcome === 'unverified') return head;

  const introducedPairs = [...head.pairs]
    .filter(([key]) => !baseline.pairs.has(key))
    .map(([, pair]) => pair);
  return {
    outcome: 'verified',
    verdict: introducedPairs.length === 0 ? 'clean' : 'findings',
    introducedPairs,
    baselineDebt: [...baseline.pairs.values()],
    skippedMalformedDuplicates: [
      ...baseline.skippedMalformedDuplicates,
      ...head.skippedMalformedDuplicates,
    ],
  };
}
