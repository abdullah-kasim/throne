import http from "node:http";
import {
  DEFAULT_TRANSPORT_REQUEST_TIMEOUT_MS,
  resolveTransportSocketPath,
  sendTransportRequest,
  type TransportRequestMode,
  type TransportResponseEnvelope,
} from "./transport-wire-contract.ts";
import {
  checkTransportResponseStaleness,
  DEFAULT_TRANSPORT_STALENESS_DEPENDENCIES,
  type TransportStalenessDependencies,
} from "./transport-staleness-check.ts";

/**
 * Thrown when the client cannot reach `throne-backend` at all (socket
 * missing/refused, i.e. "the backend isn't running") -- distinguishable from
 * a `TransportResponseEnvelope` whose `error.kind` is `"application"`, which
 * means the backend answered but the route itself failed.
 */
export class TransportConnectionError extends Error {
  constructor(socketPath: string, cause: unknown) {
    super(`could not reach throne-backend at ${socketPath}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "TransportConnectionError";
    this.cause = cause;
  }
}

export interface TransportClientOptions {
  readonly socketPath?: string;
  readonly agent?: http.Agent;
  readonly resolveCwd?: () => string;
  readonly stalenessDependencies?: TransportStalenessDependencies;
  readonly warn?: (message: string) => void;
  readonly requestTimeoutMs?: number;
}

/**
 * The CLI-side caller for the transport wire contract. Every request carries
 * the invoking CLI process's own resolved `cwd` -- read once, at this
 * boundary, because the client IS the process whose cwd matters. No other
 * request-scoped code in this bundle reads `process.cwd()`.
 */
export class TransportClient {
  private readonly socketPath: string;
  private readonly agent: http.Agent | undefined;
  private readonly resolveCwd: () => string;
  private readonly stalenessDependencies: TransportStalenessDependencies;
  private readonly warn: (message: string) => void;
  private readonly requestTimeoutMs: number;

  constructor(options: TransportClientOptions = {}) {
    this.socketPath = options.socketPath ?? resolveTransportSocketPath();
    this.agent = options.agent;
    this.resolveCwd = options.resolveCwd ?? (() => process.cwd());
    this.stalenessDependencies = options.stalenessDependencies ?? DEFAULT_TRANSPORT_STALENESS_DEPENDENCIES;
    this.warn = options.warn ?? ((message) => console.error(message));
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TRANSPORT_REQUEST_TIMEOUT_MS;
  }

  /**
   * Checked on every request, not once at startup: either side's dist can
   * change between invocations of a short-lived CLI process, so staleness
   * evidence from a prior request tells nothing about this one.
   */
  async request(
    routePath: string,
    args: readonly string[],
    mode: TransportRequestMode = "unary",
  ): Promise<TransportResponseEnvelope> {
    let response: TransportResponseEnvelope;
    try {
      response = await sendTransportRequest(
        this.socketPath,
        { path: routePath, cwd: this.resolveCwd(), args, mode },
        this.agent,
        this.requestTimeoutMs,
      );
    } catch (error) {
      // A timeout (wedged-but-accepting backend) and an immediate refusal
      // (dead backend) are different diagnoses, but both mean the same thing
      // to a caller deciding whether to fall back: the REST path is not
      // usable right now. `TransportConnectionError`'s message includes the
      // wrapped error's own message, so the timeout-vs-refused distinction
      // still reaches the operator even though both throw the same type.
      throw new TransportConnectionError(this.socketPath, error);
    }
    const staleness = checkTransportResponseStaleness(response, this.stalenessDependencies);
    if (staleness) this.warn(`[throne] ${staleness.message}`);
    return response;
  }
}
