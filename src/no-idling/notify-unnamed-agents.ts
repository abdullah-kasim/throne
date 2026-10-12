import type { HerdrAgent } from '../herdr/herdr-inventory.service.ts';
import { buildUnnamedAgentsMessage } from './message.ts';
import { NO_IDLING_REGENT_NAME } from './idle-family.ts';
import type { NoIdlingDependencies } from './no-idling-dependencies.types.ts';
import { ConfirmedObservationTracker } from './confirmed-observation.ts';
import { confirmUnnamedAgents } from './unnamed-agent-confirmation.ts';
import { errorText } from '../shared-policy/error-text.ts';
import {
  writeOut,
  writeErr,
  NO_IDLING_SENDER,
  NO_IDLING_SUBMIT_TIMEOUT_MS,
  regentAcceptsNotice,
} from './no-idling-notify-guard.ts';

export function noIdlingUnnamedAgentsWindowKey(
  target: HerdrAgent,
  paneIds: readonly string[],
  nowMs: number,
): string {
  const ids = [...paneIds].sort().join(',');
  return `no-idling-unnamed-agents:${target.name ?? target.paneId}:${ids}:${Math.floor(nowMs / 60_000)}`;
}

export async function notifyRegentOfUnnamedAgents(
  deps: NoIdlingDependencies,
  dataDir: string,
): Promise<void> {
  const unnamedAgents = confirmUnnamedAgents(
    await deps.detectUnnamedAgents(dataDir),
    deps.unnamedAgentTracker ?? new ConfirmedObservationTracker(),
  );
  if (unnamedAgents.length === 0) {
    return;
  }
  try {
    const regent = await deps.resolveAgent(NO_IDLING_REGENT_NAME);
    if (!regentAcceptsNotice(regent.agentStatus)) {
      writeOut(deps, `no-idling: Regent is ${regent.agentStatus}; deferred unnamed-agent notice\n`);
      return;
    }
    const paneIds = unnamedAgents.map((pane) => pane.paneId);
    await deps.submitToAgent(
      regent,
      NO_IDLING_SENDER,
      buildUnnamedAgentsMessage({ unnamedAgents }),
      {
        key: noIdlingUnnamedAgentsWindowKey(regent, paneIds, deps.now?.() ?? Date.now()),
        composerWaitMilliseconds: NO_IDLING_SUBMIT_TIMEOUT_MS,
      },
    );
    writeOut(deps, `no-idling: notified Regent about unnamed agent pane(s) ${paneIds.join(', ')}\n`);
  } catch (error) {
    writeErr(deps, `no-idling: Regent unnamed-agent notice failed: ${errorText(error)}\n`);
  }
}
