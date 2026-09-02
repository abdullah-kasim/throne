// Split out of no-idling-run.ts to keep that file under the hand-authored
// 500-line limit (test/nest-commander-boundary.test.ts) -- this holds the
// output-sink fallbacks and the report-only ("dry-run") notify guard, plus
// the Regent-notice constants/predicate shared by no-idling-run.ts and
// notify-stale-tabs.ts. Both of those files import from here rather than
// from each other, which is what keeps that pair acyclic
// (test/campaign-evidence/source-file-structure.spec.ts's dependency-graph
// check forbids cycles even where TS's `import type` erasure would make one
// runtime-harmless).
import type { HerdrAgent } from '../herdr/herdr-inventory.service.ts';
import { agentStatusAcceptsInput } from '../herdr/herdr-inventory.service.ts';
import type { NoIdlingDependencies } from './no-idling-dependencies.types.ts';
import { NO_IDLING_SENDER } from './no-idling-sender.ts';

export { NO_IDLING_SENDER };
export const NO_IDLING_SUBMIT_TIMEOUT_MS = 5_000;

// Exported for reuse by `blocked-paging`'s Regent-paging worker, which pages
// the Regent through this same guard rather than re-deriving it.
export function regentAcceptsNotice(status: HerdrAgent['agentStatus']): boolean {
  return status === 'working' || agentStatusAcceptsInput(status);
}

export interface RunNoIdlingOptions {
  /**
   * Whether this sweep is allowed to actually message agents.
   * Defaults to `true` -- every EXISTING caller (the hosted cron worker,
   * and any caller that omits `options` entirely) keeps sending real
   * notices exactly as before this field existed. The `no-idling` CLI
   * command is the one caller that overrides this to `false` by default
   * (see its own file for the reasoning): a debugging trigger whose default
   * action spams every live Alpha with duplicate notices is a footgun, and
   * since the standalone `throne-no-idling` systemd timer was retired in
   * this campaign's cutover (KGR), the CLI command is no longer anyone's
   * production notification path -- only the hosted cron worker is, and it
   * always passes `notify: true` explicitly.
   */
  readonly notify?: boolean;
}

export function writeOut(deps: NoIdlingDependencies, text: string): void {
  (deps.stdout ?? ((t: string) => process.stdout.write(t)))(text);
}

export function writeErr(deps: NoIdlingDependencies, text: string): void {
  (deps.stderr ?? ((t: string) => process.stderr.write(t)))(text);
}

/**
 * Wraps `submitToAgent` so a report-only run (`notify: false`) never sends a
 * real message -- it logs what WOULD have been sent instead. Every other
 * dependency, and every branch of `runNoIdling`'s own logic (which families
 * are fully idle, which are excluded and why, which agents are untasked),
 * runs identically in both modes: this is the single, minimal-blast-radius
 * point where the real side effect is swapped out, not a parallel dry-run
 * code path that could drift from the real one.
 */
export function withNotifyGuard(
  deps: NoIdlingDependencies,
  notify: boolean,
): NoIdlingDependencies {
  if (notify) return deps;
  return {
    ...deps,
    submitToAgent: async (target) => {
      writeOut(
        deps,
        `no-idling: [dry-run] suppressed a real notice to ${target.name ?? target.paneId} -- pass --notify to send for real.\n`,
      );
    },
  };
}
