import {
  run as runCodexUsage,
  getUsagePayload as getCodexUsagePayload,
  type Deps as CodexUsageDeps,
} from './codex-usage.service.ts';
import {
  OpenCodeGoUsageService,
  type OpenCodeGoUsageDeps,
} from "../opencode-go-usage-remaining/opencode-go-usage.service.ts";

/**
 * Nest-owned boundary for the provider-specific usage pipelines.
 *
 * The pipelines remain independently testable and the command dependency
 * seams remain injectable, but application consumers acquire them through
 * this provider instead of importing command roots directly.
 */
export class UsageAdaptersService {
  private readonly opencodeGoUsage: OpenCodeGoUsageService;

  constructor(
    opencodeGoUsage = new OpenCodeGoUsageService(),
  ) {
    this.opencodeGoUsage = opencodeGoUsage;
  }

  writeStdout(text: string): void {
    process.stdout.write(text);
  }

  writeStderr(text: string): void {
    process.stderr.write(text);
  }

  getCodexUsagePayload(deps?: CodexUsageDeps) {
    return getCodexUsagePayload(deps);
  }

  getOpenCodeGoUsagePayload(deps?: OpenCodeGoUsageDeps) {
    return this.opencodeGoUsage.getUsagePayload(deps);
  }

  runCodexUsage(args: string[], deps: CodexUsageDeps): Promise<number> {
    return runCodexUsage(args, deps);
  }

  runOpenCodeGoUsage(
    args: string[],
    deps?: OpenCodeGoUsageDeps,
  ): Promise<number> {
    return this.opencodeGoUsage.run(args, deps);
  }
}
