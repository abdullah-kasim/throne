// Bring the throne court back: the systemd `enable --now` analogue for the
// Regent. Sets the durable desired-state to `running` (clearing any
// `dismissed`) and, if no Regent is live, resurrects one NOW so the Lord does
// not wait up to a full timer interval for the watchdog.
//
// Idempotent: with a Regent already live it only clears the flag; it NEVER
// spawns a second Regent (the whole court addresses one `Regent` by name).

import {
  DESIRED_STATES,
  findLiveRegent,
  resurrectRegent,
  writeDesiredState,
} from "../regent-state/regent-state.service.ts";

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Injectable seam — defaults to the real primitives; tests supply stubs. */
export interface SummonDeps {
  writeDesiredState: typeof writeDesiredState;
  findLiveRegent: typeof findLiveRegent;
  resurrectRegent: typeof resurrectRegent;
}

export const REAL_DEPS: SummonDeps = {
  writeDesiredState,
  findLiveRegent,
  resurrectRegent,
};

export async function run(
  _args: string[],
  deps: SummonDeps = REAL_DEPS,
): Promise<number> {
  try {
    await deps.writeDesiredState(DESIRED_STATES.RUNNING);
  } catch (err) {
    process.stderr.write(
      `summon-regent: could not persist desired-state "running" (${errText(err)})\n`,
    );
    return 1;
  }
  process.stdout.write('summon-regent: desired-state set to "running".\n');

  let regent;
  try {
    regent = await deps.findLiveRegent();
  } catch (err) {
    // Could not determine liveness — do NOT risk spawning a duplicate on top of
    // a possibly-live Regent. The flag is set; the watchdog will converge.
    process.stderr.write(
      `summon-regent: could not check for a live Regent (${errText(err)}); ` +
        "flag is set — the watchdog will resurrect on its next tick if needed.\n",
    );
    return 1;
  }

  if (regent !== null) {
    process.stdout.write(
      "summon-regent: a Regent is already live; nothing to resurrect.\n",
    );
    return 0;
  }

  try {
    await deps.resurrectRegent();
    process.stdout.write(
      "summon-regent: no live Regent — resurrected a fresh Regent.\n",
    );
    return 0;
  } catch (err) {
    process.stderr.write(
      `summon-regent: resurrection failed (${errText(err)})\n`,
    );
    return 1;
  }
}
