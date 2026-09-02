import { UsageReadersService } from "./usage-readers.service.ts";
import {
  evaluateThrottle,
  type ThrottleEvaluation,
  type ThrottleDeps,
} from "./usagethrottle.ts";
import { ThrottlePersistenceService } from "./throttle-persistence.service.ts";
import { REGENT_DIR } from "../regent-state/regent-state.service.ts";
import { readRegentRoute } from "../regent-state/regent-state.service.ts";

/** Nest owner for throttle evaluation and its usage-reader/persistence seams. */
export class ThrottleSteeringService {
  private readonly readers: UsageReadersService;
  private readonly persistence: ThrottlePersistenceService;

  constructor(
    readers = new UsageReadersService(),
    persistence = new ThrottlePersistenceService(),
  ) {
    this.readers = readers;
    this.persistence = persistence;
  }

  evaluate(
    regentHarness: string,
    overrides?: Partial<ThrottleDeps>,
  ): Promise<ThrottleEvaluation> {
    return evaluateThrottle(regentHarness, {
      readThrottleState: (dir) => this.persistence.read(dir),
      writeThrottleState: (state, dir) => this.persistence.write(state, dir),
      getClaudeUsagePayload: () => this.readers.claude(),
      getCodexUsagePayload: () => this.readers.codex(),
      getOpenCodeGoUsagePayload: () => this.readers.opencodeGo(),
      readRegentRoute,
      now: () => new Date(),
      regentDir: REGENT_DIR,
      ...overrides,
    });
  }
}
