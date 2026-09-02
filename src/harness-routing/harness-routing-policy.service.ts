import { Injectable } from "@nestjs/common";
import { modelEffortRange } from "./policy/capabilities.ts";
import { resolveFreshEffort, steerSpawn } from "./policy/steering.ts";
import type { SteerInput, SteerResult } from "./policy/steering.types.ts";
import type { Harness } from "./harness.ts";

/** Nest owner for fresh mechanical model steering. */
@Injectable()
export class HarnessRoutingPolicyService {
  steer(input: SteerInput): SteerResult {
    return steerSpawn(input);
  }

  resolveEffort(options: Parameters<typeof resolveFreshEffort>[0]) {
    return resolveFreshEffort(options);
  }

  effortRange(harness: Harness, model: string) {
    return modelEffortRange(harness, model);
  }
}
