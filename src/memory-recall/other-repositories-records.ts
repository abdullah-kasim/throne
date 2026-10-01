import type { OtherRepositories } from './other-repositories.ts';

export const OTHER_REPOSITORY_LEDGER_FIELD = 'otherRepository';

export interface OtherRepositoryLedgerContext {
  readonly at: string;
  readonly inputHash: string;
  readonly arm: string;
  readonly sessionId: string | null;
}

export function otherRepositoryLedgerLinesOf(
  otherRepositories: OtherRepositories,
  context: OtherRepositoryLedgerContext,
): readonly object[] {
  return otherRepositories.answers.map(({ candidate, answer, rank, listed }) => ({
    at: context.at,
    inputHash: context.inputHash,
    [OTHER_REPOSITORY_LEDGER_FIELD]: candidate.repository.checkout,
    repositoryName: candidate.repository.repositoryName,
    memoryDirectory: candidate.repository.memoryDirectory,
    memoryNamesAsked: candidate.memoryFileNames.length,
    pick: answer.pick,
    probability: answer.probability,
    backend: answer.backend,
    failedOpen: answer.failedOpen,
    ...(answer.failure === undefined ? {} : { reason: answer.failure }),
    rank,
    listed,
    arm: context.arm,
    sessionId: context.sessionId,
  }));
}
