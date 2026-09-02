import {
  createUsageReaders,
  type UsageReaderDependencies,
} from "../shared-policy/usage-readers.ts";
import { UsageAdaptersService } from "../shared-policy/usage-adapters.service.ts";
import { PlanUsageRemainingService } from "./legacy-plan-usage-remaining.service.ts";

/**
 * DI owner for the single-read usage snapshot shared by routing and policy.
 * The reader factory remains pure; this service owns its lifetime and makes
 * the one-read-per-process contract explicit to Nest consumers.
 */
export class UsageReadersService {
  private readonly readers: ReturnType<typeof createUsageReaders>;

  constructor(
    adaptersOrDependencies:
      | UsageAdaptersService
      | UsageReaderDependencies
      | PlanUsageRemainingService = new UsageAdaptersService(),
    dependencies?: UsageReaderDependencies,
    planUsage?: PlanUsageRemainingService,
  ) {
    const directPlanUsage =
      adaptersOrDependencies instanceof PlanUsageRemainingService
        ? adaptersOrDependencies
        : planUsage;
    const adapters =
      adaptersOrDependencies instanceof UsageAdaptersService
        ? adaptersOrDependencies
        : new UsageAdaptersService();
    const readerDependencies =
      adaptersOrDependencies instanceof UsageAdaptersService
        ? (dependencies ??
          realUsageReaderDependencies(adapters, directPlanUsage))
        : adaptersOrDependencies instanceof PlanUsageRemainingService
          ? realUsageReaderDependencies(adapters, directPlanUsage)
          : adaptersOrDependencies;
    this.readers = createUsageReaders(readerDependencies);
  }

  readonly claude = () => this.readers.claude();

  readonly codex = () => this.readers.codex();

  readonly opencodeGo = () => this.readers.opencodeGo();
}

export function realUsageReaderDependencies(
  adapters = new UsageAdaptersService(),
  planUsage?: PlanUsageRemainingService,
): UsageReaderDependencies {
  return {
    getClaudeUsage: () => {
      if (planUsage === undefined) {
        throw new Error(
          "PlanUsageRemainingService is required for Claude usage",
        );
      }
      return planUsage.getUsagePayload();
    },
    getCodexUsage: () => adapters.getCodexUsagePayload(),
    getOpenCodeGoUsage: () => adapters.getOpenCodeGoUsagePayload(),
  };
}
