import { Injectable, Optional } from "@nestjs/common";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { Server } from "node:http";
import type { LongLivedHostedWorker } from "./hosted-worker.types.ts";
import {
  createTransportServer,
  resolveTransportSocketPath,
  type TransportRouteHandler,
} from "../transport/transport-wire-contract.ts";
import { THRONE_BACKEND_SERVICE_UNIT_NAME } from "../status/service-health.ts";
import { readServiceGenerationMarker } from "../status/service-generation-marker.ts";
import {
  MESSAGE_STATUS_ROUTE_PATH,
  handleMessageStatusRoute,
} from "../message-status/message-status.ts";
import {
  KEEP_GOING_ROUTE_PATH,
  handleKeepGoingRoute,
} from "../keep-going/keep-going-route.ts";
import {
  NO_IDLING_ROUTE_PATH,
  handleNoIdlingRoute,
} from "../no-idling/no-idling.command.ts";
import {
  ALPHA_AUTOSCALE_ROUTE_PATH,
  handleAlphaAutoscaleRoute,
} from "../alpha-autoscale/alpha-autoscale-route.ts";

export const TRANSPORT_ROUTE_DISPATCHER_WORKER_NAME = "transport-route-dispatcher";

/**
 * Reserved route this slice registers to prove the dispatcher plumbing end
 * to end. Not a real command's route -- 05 registers `message-status` under
 * its own path, reusing this same dispatcher rather than a second one.
 * Echoes the envelope's `cwd` back verbatim so a test can prove the handler
 * never fell back to its own `process.cwd()`.
 */
export const SELF_TEST_ECHO_CWD_ROUTE_PATH = "__self_test_echo_cwd__";

export function buildSelfTestRouteHandlers(): Record<string, TransportRouteHandler> {
  return {
    [SELF_TEST_ECHO_CWD_ROUTE_PATH]: async (envelope) => ({ cwd: envelope.cwd }),
  };
}

/**
 * The default handlers a production dispatcher registers when no explicit
 * `routeHandlers` override is supplied -- the self-test route plus every
 * real migrated command's route. `message-status` is the first (05); a
 * later slice's own route lands here the same way, never a second
 * dispatcher.
 */
export function buildProductionRouteHandlers(): Record<string, TransportRouteHandler> {
  return {
    ...buildSelfTestRouteHandlers(),
    [MESSAGE_STATUS_ROUTE_PATH]: handleMessageStatusRoute,
    [KEEP_GOING_ROUTE_PATH]: handleKeepGoingRoute,
    [NO_IDLING_ROUTE_PATH]: handleNoIdlingRoute,
    [ALPHA_AUTOSCALE_ROUTE_PATH]: handleAlphaAutoscaleRoute,
  };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * `sockaddr_un.sun_path`'s buffer size on Linux -- one byte short of this
 * many is bindable, the rest must fit the trailing NUL. A path at or beyond
 * this length is unbindable AF_UNIX input, but the native `bind(2)` call
 * that would otherwise report it is not a reliable source of that failure:
 * kernels and libc implementations disagree on whether an oversized path
 * fails loudly (`EINVAL`) or silently truncates and binds anyway. A silent
 * bind leaves `listen()`'s promise resolved while the caller's actual
 * intended path was never the one bound, so this dispatcher owns the check
 * itself rather than trusting the platform to reject it.
 */
const MAX_UNIX_SOCKET_PATH_BYTES = 108;

function assertUnixSocketPathIsBindable(socketPath: string): void {
  if (Buffer.byteLength(socketPath) >= MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new Error(
      `socket path is too long for a UNIX domain socket (${Buffer.byteLength(socketPath)} bytes, limit ${MAX_UNIX_SOCKET_PATH_BYTES}): ${socketPath}`,
    );
  }
}

/**
 * The listening side of the transport, hosted inside `ThroneBackendModule`
 * alongside the other hosted workers rather than on a separate bootstrap
 * path. Binds `http.Server` to a filesystem AF_UNIX path only -- no TCP
 * address form is ever passed to `listen`. Every response carries the
 * server's own generation identity, read back from the same
 * `writeServiceGenerationMarker` marker `ThroneBackendCommand` stamps at
 * startup (via `readServiceGenerationMarker`) -- this dispatcher invents no
 * second staleness mechanism.
 *
 * `routeHandlers`/`socketPath`/`markerDir` are `@Optional()` constructor
 * params, defaulting to the self-test route, the production socket path,
 * and the production marker directory respectively, so tests can point the
 * dispatcher at isolated temp paths without touching the live socket or
 * marker files.
 */
@Injectable()
export class TransportRouteDispatcherHostedWorker implements LongLivedHostedWorker {
  readonly kind = "long-lived" as const;
  readonly workerName = TRANSPORT_ROUTE_DISPATCHER_WORKER_NAME;

  private server: Server | undefined;
  private resolveReady!: () => void;
  private rejectReady!: (error: unknown) => void;
  /**
   * Resolves once the socket is bound and `listen()`'s callback has fired
   * — this worker's own definition of "ready to serve" — never once the
   * worker's whole `start()` loop returns, which for a long-lived worker
   * never happens on its own.
   */
  readonly ready: Promise<void>;

  constructor(
    @Optional() private readonly routeHandlers?: Record<string, TransportRouteHandler>,
    @Optional() private readonly socketPath?: string,
    @Optional() private readonly markerDir?: string,
  ) {
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
  }

  /**
   * Exposes `http.Server.address()` once listening -- a filesystem AF_UNIX
   * bind reports back as a string path, never the `{ port, address }` shape
   * a TCP bind would report. Lets a test prove the negative ("no TCP port
   * opened") without guessing at port numbers to probe.
   */
  boundAddress(): ReturnType<Server["address"]> | undefined {
    return this.server?.address();
  }

  async start(shouldStop: () => boolean): Promise<void> {
    const socketPath = this.socketPath ?? resolveTransportSocketPath();
    let server: Server;
    try {
      assertUnixSocketPathIsBindable(socketPath);
      await mkdir(path.dirname(socketPath), { recursive: true });
      // A prior process's socket file left behind by an unclean shutdown must
      // not block this bind -- `listen` on an already-existing path fails.
      await rm(socketPath, { force: true });

      server = createTransportServer({
        routeHandlers: this.routeHandlers ?? buildProductionRouteHandlers(),
        resolveServerGeneration: () =>
          readServiceGenerationMarker(THRONE_BACKEND_SERVICE_UNIT_NAME, this.markerDir)?.generation,
      });

      await this.listen(server, socketPath);
    } catch (error: unknown) {
      this.rejectReady(error);
      throw error;
    }
    this.server = server;
    this.resolveReady();
    try {
      while (!shouldStop()) {
        await sleep(200);
      }
    } finally {
      this.server = undefined;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private listen(server: Server, socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  }
}
