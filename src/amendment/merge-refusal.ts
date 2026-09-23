import path from "node:path";
import {
  IdentityLineReadStatus,
  readAgentRole,
} from "../agentdata/identity-data.service.ts";
import { DEFAULT_DATA_DIR } from "../agentdata/spawn-data-contracts.ts";
import { openRegentQueueAmendments } from "../regent-queue/regent-queue-amendments.ts";
import { REGENT_QUEUE_DATABASE_FILE_NAME } from "../regent-queue/regent-queue-database.ts";
import { judgeAgentReconciliation } from "./check-reconciled-runtime.ts";

const ALPHA_ROLE = "alpha";

async function isAlpha(agentName: string, dataDir: string): Promise<boolean> {
  const role = await readAgentRole(agentName, dataDir);
  return (
    role.status === IdentityLineReadStatus.Found &&
    (role.value ?? "").trim().toLowerCase() === ALPHA_ROLE
  );
}

export async function refuseUnreconciledQueueAmendments(
  agentName: string,
  dataDir: string = DEFAULT_DATA_DIR,
): Promise<string | undefined> {
  if (!(await isAlpha(agentName, dataDir))) return undefined;
  const verdict = await judgeAgentReconciliation(agentName, {
    dataDir,
    openAmendments: () =>
      openRegentQueueAmendments(path.join(dataDir, REGENT_QUEUE_DATABASE_FILE_NAME)),
    out: () => undefined,
    err: () => undefined,
  });
  return verdict.reconciled
    ? undefined
    : `"${agentName}" may not land its branch yet: ${verdict.reason}`;
}
