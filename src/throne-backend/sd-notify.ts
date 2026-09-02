import { execFile } from "node:child_process";

/** A single sd_notify datagram payload, e.g. `"READY=1"` or `"WATCHDOG=1"`. */
export type SdNotifyPayload = string;

export type SdNotifyDependencies = {
  readonly env: NodeJS.ProcessEnv;
  readonly notify: (payload: SdNotifyPayload) => void;
};

/**
 * Platform-first audit finding: the systemd watchdog/readiness protocol is
 * an `AF_UNIX SOCK_DGRAM` datagram at the path `NOTIFY_SOCKET` names, but
 * Node's `node:dgram` module implements only `udp4`/`udp6` sockets — it has
 * no Unix-domain datagram support to adapt (confirmed against this repo's
 * actual Node runtime: `dgram.createSocket("unix_dgram")` throws
 * `ERR_SOCKET_BAD_TYPE`, "Valid types are: udp4, udp6"). `systemd-notify`,
 * the CLI systemd itself ships specifically for processes that cannot open
 * that socket directly, is the adapter used here instead — still no npm
 * dependency, since it shells out through `node:child_process` the same way
 * `hosted-worker-registrar.service.ts` already does for supervised
 * processes.
 */
export const REAL_SD_NOTIFY_DEPENDENCIES: SdNotifyDependencies = {
  env: process.env,
  notify: (payload) => {
    execFile("systemd-notify", [payload], (error) => {
      if (error) {
        process.stderr.write(`throne-backend: systemd-notify failed: ${error.message}\n`);
      }
    });
  },
};

let hasLoggedMissingNotifySocket = false;

/**
 * Sends one sd_notify datagram payload. A safe no-op — never throws, never
 * delays the caller, logs at most once per process lifetime rather than
 * once per call — when `NOTIFY_SOCKET` is unset (dev shell, tests, any
 * non-systemd execution).
 */
export function sendSdNotify(
  payload: SdNotifyPayload,
  dependencies: SdNotifyDependencies = REAL_SD_NOTIFY_DEPENDENCIES,
): void {
  if (!dependencies.env.NOTIFY_SOCKET) {
    if (!hasLoggedMissingNotifySocket) {
      hasLoggedMissingNotifySocket = true;
      process.stderr.write(
        "throne-backend: NOTIFY_SOCKET unset, sd_notify calls are no-ops (expected outside systemd)\n",
      );
    }
    return;
  }
  dependencies.notify(payload);
}
