import { resolveAgent } from '../herdr/herdr-runtime.service.ts';
import { submitToAgentViaQueue } from '../throne-work/enqueue-heartbeat-message.ts';
import type { HerdrAgent } from '../herdr/herdr-inventory.service.ts';
import type { FloorAwareAutoscaleAction } from './decide-autoscale-action.ts';
import type {
  AlphaFloorBreachSnapshot,
  AlphaFloorSpawnOutcome,
} from './alpha-floor-breach-snapshot.ts';
import { ALPHA_FLOOR_CRON_SENDER } from './alpha-floor-sender.ts';

const ALPHA_FLOOR_NOTICE_RECIPIENT_NAME = 'Regent';

function formatBreachDuration(durationMs: number): string {
  const totalSeconds = Math.floor(durationMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

/**
 * Renders this tick's decision AND, for a `spawn` decision, what acting on
 * it actually produced.
 *
 * The past-tense `spawned "X"` clause is emitted for exactly one input: an
 * outcome of kind `spawned`, which the worker reports only after
 * `create-agent` returned success and the spawn limiter persisted. A
 * decision to spawn is never enough on its own -- see
 * `AlphaFloorSpawnOutcome`'s doc comment for the incident that rule comes
 * from. A `spawn` decision that arrives here with no outcome is a caller
 * that forgot to thread one through; it is reported as the defect it is
 * rather than being optimistically rendered as a success.
 */
function describeFloorTickDecision(
  decision: FloorAwareAutoscaleAction,
  spawnOutcome: AlphaFloorSpawnOutcome | undefined,
): string {
  if (decision.action === 'spawn') {
    const named = `"${decision.candidate.name}" for objective "${decision.candidate.objectiveCode}"`;
    if (spawnOutcome === undefined) {
      return `decided to spawn ${named} but reported no spawn outcome -- treat the Alpha as NOT spawned and check the worker log`;
    }
    if (spawnOutcome.kind === 'spawned') return `spawned ${named}`;
    if (spawnOutcome.kind === 'refused') {
      return `decided to spawn ${named} then refused before attempting it: ${spawnOutcome.reason} -- no Alpha was created`;
    }
    return `FAILED to spawn ${named} at ${spawnOutcome.stage}: ${spawnOutcome.detail} -- no Alpha was created and the objective is still unclaimed`;
  }
  if (decision.action === 'unresolved') {
    return `refused to spawn: launch history unresolved for "${decision.name}"`;
  }
  return `refused to spawn: ${decision.reason}`;
}

/**
 * Renders one breach tick's own facts -- live count, floor, shortfall
 * duration, and what this tick's decision actually RESULTED IN -- into the
 * notice body. Every clause traces to a field already on `snapshot`;
 * nothing here is inferred or guessed. That claim was previously false in
 * the one way that mattered: the decision field records an intention, and
 * rendering it in the past tense inferred a spawn that may never have
 * happened. `snapshot.spawnOutcome` is now the only source for that clause.
 */
/**
 * Does this breach tick deserve to reach the Regent at all?
 *
 * THE LORD'S RULING, 2026-08-25: "autoscaler should never alarm if there was
 * no alpha launched by it." The floor was paging on every tick of a shortfall
 * the Regent had created ON PURPOSE -- five objectives held out of the ready
 * queue behind a spike gate -- and the autoscaler was behaving correctly at
 * every step: it saw the shortfall, found nothing eligible, and refused. A
 * correct refusal that pages forever teaches its only reader to ignore floor
 * breaches, which is the one signal you least want desensitised, because the
 * day a breach is real it will look exactly like tonight's.
 *
 * The distinction the floor could not previously draw is EMPTY versus
 * STARVING. It counts live Alphas; what anyone actually cares about is
 * unstarted eligible work. Those agree until the queue is deliberately
 * gated, at which point the metric reports famine during a planned fast.
 *
 * Silent:
 * - refused because nothing is launchable at all. Not the autoscaler's
 *   shortfall to fix, and nobody needs waking for it.
 * - spawned successfully. The autoscaler closed the gap itself; a page here
 *   is an announcement, not an alarm.
 *
 * Loud, deliberately:
 * - refused while launchable work waits (cooldown, kill switch, capacity,
 *   admission, a duplicate row, an unknown queue). Work is starving.
 * - a spawn was ATTEMPTED AND FAILED. The loudest case there is: an
 *   objective sits unclaimed and nothing else will say so.
 * - a `spawn` decision that reported no outcome. A caller bug; the notice
 *   already says so, and silencing it would hide the defect.
 *
 * Note what this does NOT do: it never suppresses the worker's own log line.
 * Breach state stays fully observable in the log; only the page is gated.
 */
export function shouldPageFloorBreach(
  snapshot: AlphaFloorBreachSnapshot,
): boolean {
  if (
    snapshot.decision.action === "skip" &&
    snapshot.decision.noLaunchableWork
  ) {
    return false;
  }
  if (snapshot.spawnOutcome?.kind === "spawned") return false;
  return true;
}

export function buildFloorBreachNotice(snapshot: AlphaFloorBreachSnapshot): string {
  return (
    `Alpha floor breached: ${snapshot.liveAlphaCount} live Alpha(s) against a floor of ` +
    `${snapshot.floorMinimum}, shortfall persisting for ${formatBreachDuration(snapshot.breachDurationMs)}. ` +
    `This tick ${describeFloorTickDecision(snapshot.decision, snapshot.spawnOutcome)}.`
  );
}

export interface AlphaFloorBreachNotifyDeps {
  resolveAgent: (name: string) => Promise<HerdrAgent>;
  submitToAgent: (target: HerdrAgent, senderName: string, prompt: string) => Promise<void>;
}

export const REAL_ALPHA_FLOOR_BREACH_NOTIFY_DEPS: AlphaFloorBreachNotifyDeps = {
  resolveAgent,
  submitToAgent: submitToAgentViaQueue,
};

/**
 * Sends one breach notice to the Regent under the cron-owned sender
 * identity, via the durable queue-transport enqueue path. Called on every
 * breached tick, and sends on the ones `shouldPageFloorBreach` admits -- a
 * silent tick resolves without resolving the recipient or enqueueing
 * anything. Beyond that gate there is still no dedupe or cooldown of its
 * own: a genuinely starving court pages every tick, which is intended.
 */
export async function notifyRegentOfFloorBreach(
  snapshot: AlphaFloorBreachSnapshot,
  deps: AlphaFloorBreachNotifyDeps = REAL_ALPHA_FLOOR_BREACH_NOTIFY_DEPS,
): Promise<void> {
  if (!shouldPageFloorBreach(snapshot)) return;
  const regent = await deps.resolveAgent(ALPHA_FLOOR_NOTICE_RECIPIENT_NAME);
  await deps.submitToAgent(regent, ALPHA_FLOOR_CRON_SENDER, buildFloorBreachNotice(snapshot));
}

/**
 * Sends the idle-recovery notice to the Regent, on the same cron-owned sender
 * identity and durable queue path the floor breach uses. Deliberately NOT
 * gated by `shouldPageFloorBreach`: that gate silences an EMPTY court, and a
 * recovery is the one case where an empty court is exactly the news — work
 * existed, it was held, nobody was flying it, and the autoscaler has just
 * started it anyway.
 */
export async function notifyRegentOfIdleRecovery(
  message: string,
  deps: AlphaFloorBreachNotifyDeps = REAL_ALPHA_FLOOR_BREACH_NOTIFY_DEPS,
): Promise<void> {
  const regent = await deps.resolveAgent(ALPHA_FLOOR_NOTICE_RECIPIENT_NAME);
  await deps.submitToAgent(regent, ALPHA_FLOOR_CRON_SENDER, message);
}
