import { HARNESS_NAMES } from '../harness-routing/harness.ts';
import type { UsagePayload } from '../plan-usage-remaining/telemetry.types.ts';
import type { CodexUsagePayload } from './codex-usage.service.ts';
import type { OpenCodeGoUsagePayload } from "../opencode-go-usage-remaining/opencode-go-usage.service.ts";

const OPENCODE_GO_PROVIDER = "opencode-go" as const;

export interface UsageReaderDependencies {
  getClaudeUsage: () => Promise<UsagePayload>;
  getCodexUsage: () => Promise<CodexUsagePayload>;
  getOpenCodeGoUsage: () => Promise<OpenCodeGoUsagePayload>;
  now?: () => string;
}
export type UsageReader = UsageReaderDependencies['getClaudeUsage'];
export type CodexUsageReader = UsageReaderDependencies['getCodexUsage'];
export type OpenCodeGoUsageReader = UsageReaderDependencies['getOpenCodeGoUsage'];

function usageIsoTime(deps: UsageReaderDependencies): string {
  return deps.now?.() ?? new Date().toISOString();
}

function readOnce<T>(
  read: () => Promise<T>,
  fallback: (error: unknown) => T,
): () => Promise<T> {
  let result: Promise<T> | undefined;
  return () => {
    result ??= Promise.resolve()
      .then(read)
      .catch((error: unknown) => fallback(error));
    return result;
  };
}

/**
 * Nest-owned platform readers shared by command policy and startup services.
 * Keeping these readers outside command adapters prevents non-command runtime
 * consumers from depending on legacy command modules.
 */
export function createUsageReaders(deps: UsageReaderDependencies) {
  return {
    claude: readOnce(deps.getClaudeUsage, (error: unknown) => ({
      source: "error" as const,
      harness: HARNESS_NAMES.CLAUDE,
      as_of: usageIsoTime(deps),
      error: error instanceof Error ? error.message : String(error),
    })),
    codex: readOnce(deps.getCodexUsage, (error: unknown) => ({
      source: "error" as const,
      harness: HARNESS_NAMES.CODEX,
      as_of: usageIsoTime(deps),
      error: error instanceof Error ? error.message : String(error),
    })),
    opencodeGo: readOnce(deps.getOpenCodeGoUsage, (error: unknown) => ({
      source: "error" as const,
      provider: OPENCODE_GO_PROVIDER,
      harness: OPENCODE_GO_PROVIDER,
      as_of: usageIsoTime(deps),
      error: error instanceof Error ? error.message : String(error),
    })),
  };
}
