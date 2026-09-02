// Stand the throne court down: the systemd `disable --now` analogue for the
// Regent. Sets the durable desired-state to `dismissed` so the immortal
// keep-going watchdog stops BOTH nudging and resurrecting, and reaps the live
// Regent harness so it is actually gone.
//
// This is the Lord's ONLY way to make a Regent's death STICK: a bare kill/exit
// would just be resurrected on the next timer tick, because the manner of death
// is undetectable (see regentstate.ts). Idempotent — dismissing an
// already-dismissed, already-dead court is a clean no-op.
//
// `--keep-harness` sets the flag WITHOUT reaping (mark dismissed but leave the
// current Regent session running — e.g. to let it finish a thought first).

import { closeTab } from "../herdr/herdr-tab.service.ts";
import { AgentResolutionError } from "../herdr/herdr-identity-contracts.ts";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";
import {
  DESIRED_STATES,
  findLiveRegent,
  writeDesiredState,
  REGENT_NAME,
} from "../regent-state/regent-state.service.ts";

const KEEP_HARNESS_FLAG = "--keep-harness";

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Injectable seam — defaults to the real primitives; tests supply stubs. */
export interface DismissDeps {
  writeDesiredState: typeof writeDesiredState;
  findLiveRegent: typeof findLiveRegent;
  closeTab: typeof closeTab;
}

export const REAL_DEPS: DismissDeps = {
  writeDesiredState,
  findLiveRegent,
  closeTab,
};

function parseDismissRegentArgs(args: string[]): boolean {
  if (args.length === 0) return false;
  if (args.length === 1 && args[0] === KEEP_HARNESS_FLAG) return true;
  throw new Error(`unknown argument "${args.join(" ")}"; usage: dismiss-regent [${KEEP_HARNESS_FLAG}]`);
}

export async function run(
  args: string[],
  deps: DismissDeps = REAL_DEPS,
): Promise<number> {
  let keepHarness: boolean;
  try {
    keepHarness = parseDismissRegentArgs(args);
  } catch (error) {
    process.stderr.write(
      `${renderEntranceRefusal({
        reason: `dismiss-regent entrance validation rejected the supplied dismissal arguments: ${
          error instanceof Error ? error.message : String(error)
        }`,
        bypass: undefined,
        supervisorRoute: "Ask your supervisor for an allowed alternative invocation.",
      })}\n`,
    );
    return 1;
  }

  // Persist intent FIRST — before any reap. `dismiss-regent` is often run FROM
  // the Regent itself, so closing its tab can kill THIS very process; writing
  // the flag first guarantees the watchdog will not resurrect even if we die
  // mid-reap.
  try {
    await deps.writeDesiredState(DESIRED_STATES.DISMISSED);
  } catch (err) {
    process.stderr.write(
      `dismiss-regent: could not persist desired-state "dismissed" (${errText(err)})\n`,
    );
    return 1;
  }
  process.stdout.write('dismiss-regent: desired-state set to "dismissed".\n');

  if (keepHarness) {
    process.stdout.write(
      "dismiss-regent: --keep-harness given; leaving any live Regent running.\n",
    );
    return 0;
  }

  // Reap the live Regent, if any. A missing Regent is the SUCCESS case (already
  // down); only a genuine herdr failure while a Regent IS present is an error —
  // and even then the durable flag already blocks resurrection.
  let regent;
  try {
    regent = await deps.findLiveRegent();
  } catch (err) {
    if (err instanceof AgentResolutionError) {
      process.stdout.write(
        `dismiss-regent: no single live Regent to reap (${err.message}); court is down.\n`,
      );
      return 0;
    }
    process.stderr.write(
      `dismiss-regent: could not resolve the Regent (${errText(err)}); flag is set, harness left as-is.\n`,
    );
    return 1;
  }

  if (regent === null) {
    process.stdout.write(
      "dismiss-regent: no live Regent to reap; court is already down.\n",
    );
    return 0;
  }

  if (!regent.tabId) {
    process.stderr.write(
      "dismiss-regent: live Regent has no tab id; cannot reap its tab (flag is set).\n",
    );
    return 1;
  }

  try {
    await deps.closeTab(regent.tabId);
    process.stdout.write(
      `dismiss-regent: reaped the live Regent (closed tab "${regent.tabId}").\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(
      `dismiss-regent: failed to close the Regent tab (${errText(err)}); ` +
        "flag is set, so the watchdog will not resurrect.\n",
    );
    return 1;
  }
}
