import { IdentityLineReadStatus } from "../agentdata/identity-data.service.ts";
import type { DeliveryVerdict } from "../verify-delivery/verify-delivery-runtime.ts";
import type { ReapDeps } from "./reap-agent.types.ts";

export function reapDepsWithNothingToTearDown(
  dependencies: Pick<ReapDeps, "listAgents"> & Partial<ReapDeps>,
): ReapDeps {
  return {
    sleep: async () => {},
    closeAgentTab: async () => {},
    removeTree: async () => false,
    archiveAgentData: async () => "archived",
    listCompletedAgents: async () => [],
    listRegisteredAgents: async () => [],
    readAgentSupervisor: async () => ({
      status: IdentityLineReadStatus.FieldAbsent,
    }),
    readTreeBase: async () => null,
    readTreeRepo: async () => undefined,
    readSpawnCwd: async () => undefined,
    checkDeliveryVerdict: async (): Promise<DeliveryVerdict> => ({
      status: "missing-provenance",
      missingFields: "test fixture",
    }),
    recordTiming: async () => {},
    notify: async () => undefined,
    cleanupAgentScratch: async () => [],
    terminateWorktreeProcesses: async () => ({ killed: [], failed: [] }),
    ...dependencies,
  };
}
