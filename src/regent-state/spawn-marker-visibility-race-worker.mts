// Standalone worker spawned as a REAL, separate OS process by the
// spawn-marker visibility-gap tests in `regent-state.service.test.ts`. Not
// itself a test.
//
// Runs ONE full `resurrectRegent` call against a shared `regentDir` (argv[2])
// with `findLiveRegent` ALWAYS reporting Absent (herdr never sees a Regent —
// the exact "just spawned, tab herdr hasn't reflected yet" shape this
// bundle's fix targets) and a configurable spawn-marker visibility window
// (argv[3], milliseconds — the "CONFIGURABLE DELAY representing herdr's
// registration latency" the deliverable calls for). `startAgent` resolves
// instantly, so the resurrection lock is held only briefly and is released
// long before a second, independently-launched process's own check would
// land — exactly the gap the lock alone cannot close, and exactly why this
// needs a REAL second OS process (a same-process `Promise.all`, as the
// sibling lock-race tests explain, would still share one lock instance's
// happens-before ordering and could not reproduce a check landing strictly
// AFTER the first process has already exited). Prints `{"spawned": boolean}`
// as one JSON line.
import { resurrectRegent, type ResurrectDeps } from "./regent-state.service.ts";

const [, , regentDir, windowMsRaw] = process.argv;
if (!regentDir || !windowMsRaw) {
  throw new Error(
    "spawn-marker-visibility-race-worker: usage <regentDir> <spawnMarkerWindowMs>",
  );
}

let spawned = false;

const deps: ResurrectDeps = {
  startAgent: async () => {
    spawned = true;
    return {} as Awaited<ReturnType<ResurrectDeps["startAgent"]>>;
  },
  deliverOpeningPrompt: async () => {},
  readRegentHarness: async () => "claude",
  readRegentRoute: async () => undefined,
  // Herdr NEVER sees the Regent in this worker — every process's own view of
  // liveness is "absent", exactly the just-spawned-but-invisible shape only
  // the durable spawn marker (not herdr) can catch.
  findLiveRegent: async () => null,
  writeStderr: () => {},
  throneRoot: "/throne",
  regentDir,
  spawnMarkerWindowMs: Number(windowMsRaw),
};

await resurrectRegent(deps);
process.stdout.write(`${JSON.stringify({ spawned })}\n`);
