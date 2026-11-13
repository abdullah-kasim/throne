import { monitorEventLoopDelay } from "node:perf_hooks";

const MINUTE_MS = 60_000;
const BYTES_PER_MEGABYTE = 1024 * 1024;
const NANOSECONDS_PER_MILLISECOND = 1_000_000;

let launchesSinceLastRead = 0;
let countingStarted = false;

type LaunchFunction = (...launchArguments: unknown[]) => unknown;
type BunLaunchers = { spawn: LaunchFunction; spawnSync: LaunchFunction };

function counted(launch: LaunchFunction): LaunchFunction {
  return function countedLaunch(this: unknown, ...launchArguments: unknown[]) {
    launchesSinceLastRead += 1;
    return launch.apply(this, launchArguments);
  };
}

export function countChildLaunches(): void {
  if (countingStarted) return;
  countingStarted = true;
  const bun = (globalThis as unknown as { Bun: BunLaunchers }).Bun;
  bun.spawn = counted(bun.spawn);
  bun.spawnSync = counted(bun.spawnSync);
}

export function startBackendVitals(): () => string {
  countChildLaunches();
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  launchesSinceLastRead = 0;
  return () => {
    const launches = launchesSinceLastRead;
    launchesSinceLastRead = 0;
    const residentMegabytes = Math.round(process.memoryUsage().rss / BYTES_PER_MEGABYTE);
    const meanDelay = (loopDelay.mean / NANOSECONDS_PER_MILLISECOND).toFixed(1);
    const p99Delay = (loopDelay.percentile(99) / NANOSECONDS_PER_MILLISECOND).toFixed(1);
    const maxDelay = (loopDelay.max / NANOSECONDS_PER_MILLISECOND).toFixed(1);
    loopDelay.reset();
    return `[backend-vitals] launches=${launches} rss_mb=${residentMegabytes} loop_delay_ms mean=${meanDelay} p99=${p99Delay} max=${maxDelay}`;
  };
}

export function logBackendVitalsEachMinute(log: (line: string) => void = console.log): void {
  const readMinuteLine = startBackendVitals();
  const timer = setInterval(() => {
    try {
      log(readMinuteLine());
    } catch (error) {
      console.error(`[backend-vitals] sample failed: ${String(error)}`);
    }
  }, MINUTE_MS);
  timer.unref();
}
