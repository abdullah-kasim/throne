import { splitLogicalLines } from './campaign-text-lines.ts';

export interface ChangedProseDocument {
  path: string;
  content: string;
}

export interface CitationHeadReader {
  readFile: (headRevision: string, path: string) => Promise<string | null>;
}

export interface CampaignCitation {
  sourcePath: string;
  sourceLine: number;
  citedPath: string;
  citedLine: number;
}

export interface ResolvedCampaignCitation extends CampaignCitation {
  resolution: 'resolved';
  content: string;
}

export interface UnresolvedCampaignCitation extends CampaignCitation {
  resolution: 'unresolved';
  reason: 'file-missing' | 'line-out-of-range';
}

export type CampaignCitationResolution =
  | ResolvedCampaignCitation
  | UnresolvedCampaignCitation;

export type CampaignCitationEvidence =
  | {
      outcome: 'verified';
      verdict: 'clean' | 'findings';
      citations: readonly CampaignCitationResolution[];
    }
  | {
      outcome: 'unverified';
      reason: string;
    };

const FILE_LINE_CITATION_PATTERN =
  /(?:^|[\s`"'([])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*):([1-9]\d*)\b/g;

function isChangedProseDocument(
  value: unknown,
): value is ChangedProseDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.path === 'string' &&
    candidate.path.length > 0 &&
    typeof candidate.content === 'string'
  );
}

function extractDocumentCitations(
  document: ChangedProseDocument,
): CampaignCitation[] {
  const citations: CampaignCitation[] = [];
  const sourceLines = splitLogicalLines(document.content);
  for (const [sourceIndex, sourceLine] of sourceLines.entries()) {
    FILE_LINE_CITATION_PATTERN.lastIndex = 0;
    for (const match of sourceLine.matchAll(FILE_LINE_CITATION_PATTERN)) {
      if (/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(match[1]!)) continue;
      citations.push({
        sourcePath: document.path,
        sourceLine: sourceIndex + 1,
        citedPath: match[1]!,
        citedLine: Number(match[2]),
      });
    }
  }
  return citations;
}

export async function deriveCampaignCitationEvidence(
  request: {
    headRevision: string;
    documents: unknown;
  },
  reader: CitationHeadReader,
): Promise<CampaignCitationEvidence> {
  if (
    request.headRevision.length === 0 ||
    !Array.isArray(request.documents) ||
    !request.documents.every(isChangedProseDocument)
  ) {
    return {
      outcome: 'unverified',
      reason: 'changed prose input is malformed',
    };
  }

  try {
    const citations = request.documents.flatMap(extractDocumentCitations);
    const headFiles = new Map<string, string[] | null>();
    const resolutions: CampaignCitationResolution[] = [];
    for (const citation of citations) {
      if (!headFiles.has(citation.citedPath)) {
        const content = await reader.readFile(
          request.headRevision,
          citation.citedPath,
        );
        headFiles.set(
          citation.citedPath,
          content === null ? null : splitLogicalLines(content),
        );
      }
      const lines = headFiles.get(citation.citedPath);
      if (lines === null || lines === undefined) {
        resolutions.push({
          ...citation,
          resolution: 'unresolved',
          reason: 'file-missing',
        });
        continue;
      }
      const content = lines[citation.citedLine - 1];
      if (content === undefined) {
        resolutions.push({
          ...citation,
          resolution: 'unresolved',
          reason: 'line-out-of-range',
        });
        continue;
      }
      resolutions.push({ ...citation, resolution: 'resolved', content });
    }
    return {
      outcome: 'verified',
      verdict: resolutions.some(
        ({ resolution }) => resolution === 'unresolved',
      )
        ? 'findings'
        : 'clean',
      citations: resolutions,
    };
  } catch (error) {
    return {
      outcome: 'unverified',
      reason:
        error instanceof Error
          ? `citation re-derivation failed: ${error.message}`
          : 'citation re-derivation failed with an unreadable error',
    };
  }
}
