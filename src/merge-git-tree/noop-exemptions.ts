import type { SpawnSpec } from "../agentdata/spawn-data-contracts.ts";
import {
  readAgentSupervisor as realReadAgentSupervisor,
  IdentityLineReadStatus,
} from "../agentdata/identity-data.service.ts";
import {
  checkDeliveryVerdict as realCheckDeliveryVerdict,
  type DeliveryVerdict,
} from "../verify-delivery/verify-delivery-runtime.ts";
import {
  isTerminalDeliveryShadowName,
  isTerminalGateShadowName,
} from "./terminal-gate-shadow.ts";

export function isNoopExemptFromWlsRefusal(
  name: string,
  spawnSpec: SpawnSpec | null,
): boolean {
  return (
    spawnSpec?.deliverable_shape === "verdict-only" ||
    isTerminalGateShadowName(name)
  );
}

export async function isDeliveryGateNoopExempt(
  name: string,
  dataDir: string | undefined,
  deps: {
    readAgentSupervisor?: typeof realReadAgentSupervisor;
    checkDeliveryVerdict?: (
      name: string,
      dataDir: string | undefined,
    ) => Promise<DeliveryVerdict>;
  } = {},
): Promise<boolean> {
  if (!isTerminalDeliveryShadowName(name)) return false;
  const supervisorRead = await (
    deps.readAgentSupervisor ?? realReadAgentSupervisor
  )(name, dataDir);
  // A field-absent supervisor (no supervisor recorded) and a read that never
  // resolved (can't know the supervisor at all) both mean the same thing for
  // this gate: there is no confirmed supervisor to check a delivery verdict
  // against, so the exemption is refused -- the pre-existing, already-safe
  // default (normal delivery gating still applies). Only a resolved value
  // proceeds to the delivery-verdict check.
  if (supervisorRead.status !== IdentityLineReadStatus.Found) return false;
  const verdict = await (deps.checkDeliveryVerdict ?? realCheckDeliveryVerdict)(
    supervisorRead.value,
    dataDir,
  );
  return verdict.status === "delivered";
}
