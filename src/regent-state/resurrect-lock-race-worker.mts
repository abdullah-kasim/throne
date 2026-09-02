// Standalone worker spawned as a REAL, separate OS process by the
// cross-process stale-reclaim race test in `regent-state.service.test.ts`.
// Not itself a test — see that test file for why genuine OS-process
// concurrency, not a same-process `Promise.all`, is required to reproduce
// the defect this guards against. Makes one `acquireResurrectLock` call
// against the directory given as argv[2] and prints the resulting token (or
// `null`) as a single JSON line so the parent test can collect both
// processes' outcomes.
import { acquireResurrectLock } from "./regent-state.service.ts";

const dir = process.argv[2];
if (!dir) {
  throw new Error("resurrect-lock-race-worker: missing dir argument");
}

const token = await acquireResurrectLock(dir);
process.stdout.write(`${JSON.stringify({ token })}\n`);
