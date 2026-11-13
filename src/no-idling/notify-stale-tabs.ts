import type { HerdrAgent } from '../herdr/herdr-inventory.service.ts';
import { buildStaleTabsMessage, buildStrandedSpawnsMessage } from './message.ts';
import { NO_IDLING_REGENT_NAME } from './idle-family.ts';
import type { NoIdlingDependencies, NoIdlingPageLedger } from './no-idling-dependencies.types.ts';
import { inMemoryPageLedger, submitUnlessAlreadyPaged } from './present-facts.ts';
import {
  writeOut,
  writeErr,
  NO_IDLING_SUBMIT_TIMEOUT_MS,
  regentAcceptsNotice,
} from './no-idling-notify-guard.ts';

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function noIdlingStaleTabsPageKey(target: HerdrAgent, tabIds: readonly string[]): string {
  const ids = [...tabIds].sort().join(',');
  return `no-idling-stale-tabs:${target.name ?? target.paneId}:${ids}`;
}

export function noIdlingStrandedSpawnsPageKey(target: HerdrAgent, tabIds: readonly string[]): string {
  const ids = [...tabIds].sort().join(',');
  return `no-idling-stranded-spawns:${target.name ?? target.paneId}:${ids}`;
}

/**
 * Notify the Regent about every stale, positively-identified throne-owned
 * tab this sweep's allowlist join found (`detectStaleTabs`). Silent when
 * none are found — a third, wholly independent
 * notice from the untasked-agent and fully-idle-family notices, following
 * the same "quiet when nothing to say" discipline. Never closes a tab;
 * closing is the Regent's call.
 */
export async function notifyRegentOfStaleTabs(
  deps: NoIdlingDependencies,
  dataDir: string,
  ledger: NoIdlingPageLedger = inMemoryPageLedger(),
): Promise<void> {
  const staleTabs = await deps.detectStaleTabs(dataDir);
  if (staleTabs.length === 0) {
    return;
  }
  try {
    const regent = await deps.resolveAgent(NO_IDLING_REGENT_NAME);
    if (!regentAcceptsNotice(regent.agentStatus)) {
      writeOut(deps, `no-idling: Regent is ${regent.agentStatus}; deferred stale-tab notice\n`);
      return;
    }
    const paged = await submitUnlessAlreadyPaged(
      deps,
      ledger,
      regent,
      buildStaleTabsMessage({ staleTabs }),
      noIdlingStaleTabsPageKey(regent, staleTabs.map((tab) => tab.tabId)),
      { composerWaitMilliseconds: NO_IDLING_SUBMIT_TIMEOUT_MS },
    );
    if (!paged) return;
    writeOut(
      deps,
      `no-idling: notified Regent about stale throne-owned tab(s) ${staleTabs
        .map((tab) => tab.label)
        .join(', ')}\n`,
    );
  } catch (error) {
    writeErr(deps, `no-idling: Regent stale-tab notice failed: ${errText(error)}\n`);
  }
}

/**
 * Notify the Regent about every live-but-stranded spawn this sweep's pane-
 * content classification found (`detectStrandedSpawns`) — a positively-
 * identified modal-blocked or opening-prompt-stranded agent, never a dead
 * tab. Silent when none are found, following the same discipline as the
 * other no-idling notices. Never closes or recovers anything itself.
 */
export async function notifyRegentOfStrandedSpawns(
  deps: NoIdlingDependencies,
  dataDir: string,
  ledger: NoIdlingPageLedger = inMemoryPageLedger(),
): Promise<void> {
  const strandedSpawns = await deps.detectStrandedSpawns(dataDir);
  if (strandedSpawns.length === 0) {
    return;
  }
  try {
    const regent = await deps.resolveAgent(NO_IDLING_REGENT_NAME);
    if (!regentAcceptsNotice(regent.agentStatus)) {
      writeOut(deps, `no-idling: Regent is ${regent.agentStatus}; deferred stranded-spawn notice\n`);
      return;
    }
    const paged = await submitUnlessAlreadyPaged(
      deps,
      ledger,
      regent,
      buildStrandedSpawnsMessage({ strandedSpawns }),
      noIdlingStrandedSpawnsPageKey(regent, strandedSpawns.map((spawn) => spawn.tabId)),
      { composerWaitMilliseconds: NO_IDLING_SUBMIT_TIMEOUT_MS },
    );
    if (!paged) return;
    writeOut(
      deps,
      `no-idling: notified Regent about stranded spawn(s) ${strandedSpawns
        .map((spawn) => spawn.agentName)
        .join(', ')}\n`,
    );
  } catch (error) {
    writeErr(deps, `no-idling: Regent stranded-spawn notice failed: ${errText(error)}\n`);
  }
}

/**
 * Recovers every live-but-stranded spawn this sweep's pane-content
 * classification found (`detectStrandedSpawns`), logging each attempt for
 * later human review. A failed remedy for one agent is logged and the sweep
 * continues to the next -- it never aborts the rest of the run.
 */
export async function recoverStrandedSpawns(
  deps: NoIdlingDependencies,
  dataDir: string,
): Promise<Set<string>> {
  const strandedSpawns = await deps.detectStrandedSpawns(dataDir);
  for (const spawn of strandedSpawns) {
    const result = await deps.recoverStrandedSpawn(
      spawn.agentName,
      spawn.classification,
      dataDir,
    );
    const summary = `${result.agentName} (${result.classification}, remedy: ${result.remedy}) -> ${result.outcome}`;
    if (result.outcome === 'failed') {
      writeErr(deps, `no-idling: stranded-spawn recovery failed: ${summary}: ${result.detail}\n`);
    } else {
      writeOut(deps, `no-idling: stranded-spawn recovery ${summary}\n`);
    }
  }
  return new Set(strandedSpawns.map((spawn) => spawn.agentName));
}
