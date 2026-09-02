import { splitLogicalLines } from './campaign-text-lines.ts';

export const HAND_AUTHORED_SOURCE_LINE_LIMIT = 500;

export interface SectionResult {
  status: 'clean' | 'findings' | 'unverified';
  evidence?: unknown;
  reason?: string;
}

export const CAMPAIGN_FILE_CHANGE_KINDS = {
  CREATED: 'created',
  CHANGED: 'changed',
  DELETED: 'deleted',
} as const;

export const CAMPAIGN_FILE_AUTHORSHIPS = {
  CAMPAIGN: 'campaign',
  ABSORBED: 'absorbed',
} as const;

export type CampaignFileChangeKind =
  (typeof CAMPAIGN_FILE_CHANGE_KINDS)[keyof typeof CAMPAIGN_FILE_CHANGE_KINDS];

export type CampaignFileAuthorship =
  (typeof CAMPAIGN_FILE_AUTHORSHIPS)[keyof typeof CAMPAIGN_FILE_AUTHORSHIPS];

export interface CampaignFileChange {
  path: string;
  kind: CampaignFileChangeKind;
  authorship: CampaignFileAuthorship;
}

export interface CampaignPathExclusion {
  pathPrefix: string;
  reason: string;
}

export interface CampaignFileEvidenceReaders {
  readChanges: (
    baseRevision: string,
    headRevision: string,
  ) => Promise<unknown>;
  readFile: (revision: string, path: string) => Promise<string | null>;
}

export interface CampaignFileInventoryEntry {
  path: string;
  kind: CampaignFileChangeKind;
  authorship: CampaignFileAuthorship;
  baseLineCount: number | null;
  headLineCount: number | null;
}

export interface ExcludedCampaignFile {
  path: string;
  reason: string;
  headLineCount: number;
}

export interface CampaignFileSizeEvidence {
  verdict: 'clean' | 'findings';
  regressions: readonly CampaignFileInventoryEntry[];
  preExistingDebt: readonly CampaignFileInventoryEntry[];
  clean: readonly CampaignFileInventoryEntry[];
  examinedCount: number;
  absorbed: readonly CampaignFileInventoryEntry[];
  exclusions: readonly ExcludedCampaignFile[];
}

export type CampaignFileEvidence =
  | {
      outcome: 'verified';
      inventory: readonly CampaignFileInventoryEntry[];
      sizes: CampaignFileSizeEvidence;
    }
  | {
      outcome: 'unverified';
      reason: string;
    };

function isCampaignFileChange(value: unknown): value is CampaignFileChange {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.path === 'string' &&
    candidate.path.length > 0 &&
    Object.values(CAMPAIGN_FILE_CHANGE_KINDS).includes(
      candidate.kind as CampaignFileChangeKind,
    ) &&
    Object.values(CAMPAIGN_FILE_AUTHORSHIPS).includes(
      candidate.authorship as CampaignFileAuthorship,
    )
  );
}

export function isRepositorySourceSizeExemptPath(filePath: string): boolean {
  return false;
}

function validatedChanges(value: unknown): CampaignFileChange[] | undefined {
  if (!Array.isArray(value) || !value.every(isCampaignFileChange)) {
    return undefined;
  }
  const paths = value.map(({ path }) => path);
  return new Set(paths).size === paths.length ? value : undefined;
}

function matchingExclusion(
  path: string,
  exclusions: readonly CampaignPathExclusion[],
): CampaignPathExclusion | undefined {
  return exclusions.find(
    ({ pathPrefix }) =>
      path === pathPrefix || path.startsWith(`${pathPrefix}/`),
  );
}

function isFileSizeRegression(
  entry: CampaignFileInventoryEntry,
  lineLimit: number,
): boolean {
  if (entry.headLineCount === null || entry.headLineCount <= lineLimit) {
    return false;
  }
  return (
    entry.baseLineCount === null ||
    entry.baseLineCount <= lineLimit ||
    entry.headLineCount > entry.baseLineCount
  );
}

function isPreExistingSizeDebt(
  entry: CampaignFileInventoryEntry,
  lineLimit: number,
): boolean {
  return (
    entry.baseLineCount !== null &&
    entry.baseLineCount > lineLimit &&
    entry.headLineCount !== null &&
    entry.headLineCount > lineLimit &&
    entry.headLineCount <= entry.baseLineCount
  );
}

async function readLineCount(
  readers: CampaignFileEvidenceReaders,
  revision: string,
  path: string,
): Promise<number | null> {
  const content = await readers.readFile(revision, path);
  return content === null ? null : splitLogicalLines(content).length;
}

async function inventoryEntry(
  change: CampaignFileChange,
  baseRevision: string,
  headRevision: string,
  readers: CampaignFileEvidenceReaders,
): Promise<CampaignFileInventoryEntry | undefined> {
  const baseLineCount =
    change.kind === CAMPAIGN_FILE_CHANGE_KINDS.CREATED
      ? null
      : await readLineCount(readers, baseRevision, change.path);
  const headLineCount =
    change.kind === CAMPAIGN_FILE_CHANGE_KINDS.DELETED
      ? null
      : await readLineCount(readers, headRevision, change.path);
  if (
    (change.kind !== CAMPAIGN_FILE_CHANGE_KINDS.CREATED &&
      baseLineCount === null) ||
    (change.kind !== CAMPAIGN_FILE_CHANGE_KINDS.DELETED &&
      headLineCount === null)
  ) {
    return undefined;
  }
  return { ...change, baseLineCount, headLineCount };
}

export async function deriveCampaignFileEvidence(
  request: {
    baseRevision: string;
    headRevision: string;
    exclusions: readonly CampaignPathExclusion[];
    lineLimit?: number;
  },
  readers: CampaignFileEvidenceReaders,
): Promise<CampaignFileEvidence> {
  if (
    request.baseRevision.length === 0 ||
    request.headRevision.length === 0 ||
    !request.exclusions.every(
      ({ pathPrefix, reason }) =>
        pathPrefix.length > 0 && reason.length > 0,
    )
  ) {
    return { outcome: 'unverified', reason: 'invalid campaign file request' };
  }
  const lineLimit = request.lineLimit ?? HAND_AUTHORED_SOURCE_LINE_LIMIT;
  if (!Number.isInteger(lineLimit) || lineLimit < 0) {
    return { outcome: 'unverified', reason: 'invalid source line limit' };
  }

  try {
    const changes = validatedChanges(
      await readers.readChanges(request.baseRevision, request.headRevision),
    );
    if (changes === undefined) {
      return {
        outcome: 'unverified',
        reason: 'changed-file inventory is malformed',
      };
    }
    const inventory: CampaignFileInventoryEntry[] = [];
    for (const change of changes) {
      const entry = await inventoryEntry(
        change,
        request.baseRevision,
        request.headRevision,
        readers,
      );
      if (entry === undefined) {
        return {
          outcome: 'unverified',
          reason: `could not read changed file "${change.path}"`,
        };
      }
      inventory.push(entry);
    }

    const exclusions: ExcludedCampaignFile[] = [];
    const absorbed: CampaignFileInventoryEntry[] = [];
    const included: CampaignFileInventoryEntry[] = [];
    for (const entry of inventory) {
      const exclusion = matchingExclusion(entry.path, request.exclusions);
      if (exclusion !== undefined && entry.headLineCount !== null) {
        exclusions.push({
          path: entry.path,
          reason: exclusion.reason,
          headLineCount: entry.headLineCount,
        });
      } else if (entry.authorship === CAMPAIGN_FILE_AUTHORSHIPS.ABSORBED) {
        absorbed.push(entry);
      } else {
        included.push(entry);
      }
    }
    const regressions = included.filter((entry) =>
      isFileSizeRegression(entry, lineLimit),
    );
    const preExistingDebt = included.filter((entry) =>
      isPreExistingSizeDebt(entry, lineLimit),
    );
    const examined = new Set([...regressions, ...preExistingDebt]);
    const clean = included.filter((entry) => !examined.has(entry));
    return {
      outcome: 'verified',
      inventory,
      sizes: {
        verdict: regressions.length === 0 ? 'clean' : 'findings',
        regressions,
        preExistingDebt,
        clean,
        examinedCount: included.length,
        absorbed,
        exclusions,
      },
    };
  } catch (error) {
    return {
      outcome: 'unverified',
      reason:
        error instanceof Error
          ? `campaign file evidence failed: ${error.message}`
          : 'campaign file evidence failed with an unreadable error',
    };
  }
}
