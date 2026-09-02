import type { INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ThroneBackendModule } from "./throne-backend.module.ts";
import { sendSdNotify, type SdNotifyPayload } from "./sd-notify.ts";
import { HostedWorkerRegistrarService } from "./hosted-worker-registrar.service.ts";
import { resolveRepoRootAndGenerationFromModuleUrl } from "../status/dist-generation.ts";
import { recordKnownGoodGeneration } from "./generation-readiness-marker.ts";
import { THRONE_BACKEND_SERVICE_UNIT_NAME } from "../status/service-health.ts";

/**
 * Boots the long-lived `throne-backend` Nest application through
 * `NestFactory.create`, distinct from `application.ts`'s one-shot
 * `CommandFactory` bootstrap used by every other CLI command. Booting this
 * never touches a live herdr session, spawns a second herdr server, or sets
 * `HERDR_SESSION` — every hosted worker consumes existing herdr/agent state
 * through the same client-side mechanisms the standalone commands already
 * use.
 *
 * Notifies systemd `READY=1` exactly once, after both the application
 * context exists AND every long-lived worker with a genuine "ready to
 * serve" condition (see `HostedWorkerRegistrarService.whenAllWorkersReady`)
 * has reached it — telling the unit's `Type=notify` startup wait that boot
 * actually finished, not merely that `onApplicationBootstrap` returned.
 * `onApplicationBootstrap` itself stays synchronous and never awaits a
 * worker's `start()`, so this wait never blocks Nest's own bootstrap on a
 * worker's entire (for a long-lived worker, infinite) lifetime — only on
 * each worker's own readiness step. This is separate from the recurring
 * `WatchdogSec=` liveness proof (see `KeepGoingHostedWorker`) and must
 * never be conflated with it: `createContext`/`notifyReady`/
 * `waitForWorkersReady` are overridable only so a test can exercise this
 * bootstrap path without booting the real module or a live
 * `NOTIFY_SOCKET`.
 */
/**
 * `READY=1` is a weak proxy for "this generation works" (Regent ruling,
 * 2026-08-14): a generation can reach readiness and then die moments later
 * -- a hosted worker throwing during its first real tick, an env problem
 * that only bites once real traffic arrives. Recording known-good the
 * INSTANT `READY=1` fires would let that generation poison the rollback
 * target it exists to protect. This delay is the same idea as
 * `MIN_UPTIME_BEFORE_SELF_RESTART_MS` (self-rebuild.hosted-worker.ts) --
 * survive your own start window before anyone trusts you -- applied on the
 * readiness side instead of the restart side. It is bounded, not a general
 * health check: a generation that dies TEN MINUTES after this window closes
 * is already recorded known-good and will not be rolled back to anything
 * else. That is a known, accepted limitation, not solved by this delay.
 */
export const KNOWN_GOOD_STABILITY_DELAY_MS = 90_000;

/** Fires `schedule` from a real, unref'd timer -- never keeps the process alive on its own. */
function realSchedule(fn: () => void, delayMs: number): void {
  const timer = setTimeout(fn, delayMs);
  timer.unref?.();
}

/**
 * Split out from `createThroneBackendApp`'s default `markGenerationReady`
 * purely so a test can inject `schedule` and prove the delay/no-write-until-
 * elapsed behavior directly, without waiting `KNOWN_GOOD_STABILITY_DELAY_MS`
 * in real time or replacing the whole `markGenerationReady` param (which
 * would test nothing about the delay itself).
 */
export function scheduleKnownGoodConfirmation(
  schedule: (fn: () => void, delayMs: number) => void = realSchedule,
  writeMarker: (unitName: string, generation: string) => void = recordKnownGoodGeneration,
  resolve: () => { repoRoot: string; generation: string } | undefined = () =>
    resolveRepoRootAndGenerationFromModuleUrl(import.meta.url),
): void {
  schedule(() => {
    const resolved = resolve();
    if (!resolved) return;
    writeMarker(THRONE_BACKEND_SERVICE_UNIT_NAME, resolved.generation);
  }, KNOWN_GOOD_STABILITY_DELAY_MS);
}

export async function createThroneBackendApp(
  createContext: () => Promise<INestApplicationContext> = () =>
    NestFactory.createApplicationContext(ThroneBackendModule, {
      logger: ["log", "warn", "error"],
    }),
  notifyReady: (payload: SdNotifyPayload) => void = sendSdNotify,
  waitForWorkersReady: (app: INestApplicationContext) => Promise<void> = (app) =>
    app.get(HostedWorkerRegistrarService).whenAllWorkersReady(),
  // Records this generation known-good. ITS READER IS GONE (2026-08-26): the
  // `ExecStartPre` rollback guard that consumed this record was removed when
  // the unit moved to `nest start --watch`, because rolling `dist` back only
  // makes sense when a reload publishes an immutable generation and restarts
  // into it. The watcher compiles in place and relaunches the child instead.
  //
  // The write is KEPT rather than deleted: `npm run build` still publishes
  // generations for the CLI and the suite's staleness guard, so "which
  // generation last reached READY=1" remains a true and occasionally useful
  // fact. Nothing acts on it automatically any more, and that is deliberate —
  // said here so the next reader does not go looking for the rollback that
  // this comment used to promise.
  //
  // Scheduled AFTER `notifyReady`, never before, and
  // only fires if this process is STILL ALIVE `KNOWN_GOOD_STABILITY_DELAY_MS`
  // later -- see that constant's own comment. Overridable only for tests; a
  // process not running from a published generation (dev/ts-node) resolves
  // no generation and this is a silent no-op, matching every other marker
  // writer in this codebase.
  markGenerationReady: () => void = () => scheduleKnownGoodConfirmation(),
): Promise<INestApplicationContext> {
  const app = await createContext();
  await waitForWorkersReady(app);
  notifyReady("READY=1");
  markGenerationReady();
  return app;
}

/**
 * Runs `throne-backend` forever: boots the app (which registers and starts
 * every hosted worker at `onApplicationBootstrap`) and never resolves on its
 * own — the process stays alive until killed, mirroring how the standalone
 * `throne-work` command is invoked today by its systemd unit.
 */
export async function runThroneBackendForever(): Promise<never> {
  await createThroneBackendApp();
  return new Promise<never>(() => {
    // Intentionally never resolves: the hosted workers keep the process
    // alive, exactly like `throne-work`'s own infinite dispatch loop does.
  });
}
