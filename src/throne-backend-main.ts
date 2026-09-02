/**
 * The service entry point, and nothing else.
 *
 * WHY THIS FILE EXISTS. `throne-backend` is a nest-commander subcommand, so
 * running it meant `node dist/src/tools.js throne-backend` — an executable
 * plus an argument. `nest start --watch` spawns `<outDir>/<sourceRoot>/
 * <entryFile>` directly and has nowhere to put that argument, so the CLI's
 * own watch mode could not be used and the service instead grew its own
 * rebuild-and-restart machinery. This file is the argument-free target that
 * lets the standard tool do the job.
 *
 * WHAT THAT REPLACES, and it is the point rather than a side effect. The
 * service used to reload itself by publishing a new immutable generation and
 * calling `systemctl restart` on its own unit. That is a DELIBERATE stop, so
 * `Restart=always` correctly declines to undo it, and with
 * `StartLimitBurst=5` inside 120s systemd can give up permanently. On
 * 2026-08-26 the backend restarted into a generation that never reached
 * `READY=1` and stayed down for FOUR HOURS — taking the Regent resurrection
 * tick, the idle sweep, the autoscaler and the message-queue drain with it,
 * because all fourteen workers are schedules inside this one process.
 *
 * Under `nest start --watch` the long-lived process is the CLI and the app is
 * its child. A bad build crash-loops inside the watcher, systemd never sees a
 * stop, the start limit is never touched, and fixing the source recompiles and
 * relaunches automatically. The failure class is removed rather than guarded
 * against.
 *
 * `Type=notify` still works because the unit sets `NotifyAccess=all`: the
 * READY=1 signal comes from this child rather than the unit's main process,
 * and `all` is precisely what permits that.
 *
 * This file deliberately holds no logic. Everything it needs already exists
 * behind `runThroneBackendForever`, which the `throne-backend` command also
 * calls — one boot path, two entry points, no drift.
 */
import { THRONE_BACKEND_SERVICE_UNIT_NAME } from "./status/service-health.ts";
import { writeServiceGenerationMarkerSafely } from "./status/service-generation-marker.ts";
import { runThroneBackendForever } from "./throne-backend/throne-backend-app.ts";

writeServiceGenerationMarkerSafely(
  THRONE_BACKEND_SERVICE_UNIT_NAME,
  import.meta.url,
  new Date().toISOString(),
  process.pid,
);

await runThroneBackendForever();
