import http from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { RUNTIME_DATA_HOME } from "../shared-policy/runtime-data-home.ts";

/**
 * The one envelope shape crossing the UNIX socket in both directions. `cwd`
 * is the invoking CLI's own resolved working directory -- the contract's
 * only source of truth for request-scoped paths. A server-side route
 * handler must never resolve `process.cwd()` for request-scoped work; it
 * reads this field instead.
 */
export type TransportRequestMode = "unary" | "job";

export interface TransportRequestEnvelope {
  readonly path: string;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly mode: TransportRequestMode;
}

export interface TransportErrorEnvelope {
  readonly kind: "transport" | "application";
  readonly message: string;
}

export interface TransportResponseEnvelope<TResult = unknown> {
  readonly ok: boolean;
  readonly serverGeneration: string | undefined;
  readonly result?: TResult;
  readonly error?: TransportErrorEnvelope;
}

export type JobStatusState = "running" | "done" | "failed";

export interface JobStatusResult<TResult = unknown> {
  readonly jobId: string;
  readonly status: JobStatusState;
  readonly result?: TResult;
  readonly error?: TransportErrorEnvelope;
}

/** A route handler resolves one request's result; job mode wraps the same handler in job bookkeeping. */
export type TransportRouteHandler = (envelope: TransportRequestEnvelope) => Promise<unknown>;

/**
 * Reserved route path a client polls with `args: [jobId]` to observe a
 * submitted job's status. Not a real command route -- routes never register
 * under this name.
 */
export const JOB_STATUS_ROUTE_PATH = "__job_status__";

export function resolveTransportSocketPath(runtimeDataHome: string = RUNTIME_DATA_HOME): string {
  return path.join(runtimeDataHome, "state", "throne-backend.sock");
}

function toApplicationError(error: unknown): TransportErrorEnvelope {
  return { kind: "application", message: error instanceof Error ? error.message : String(error) };
}

function toTransportError(message: string): TransportErrorEnvelope {
  return { kind: "transport", message };
}

interface JobRecord {
  status: JobStatusState;
  result?: unknown;
  error?: TransportErrorEnvelope;
}

/**
 * Backs the job/streaming mode: a submitted job runs to completion
 * independent of the connection that submitted it, and any later poll
 * observes whatever status it has reached. In-memory only -- a server
 * restart drops in-flight jobs, matching this pass's scope (proving the
 * primitive, not a durable work queue).
 */
class TransportJobStore {
  private readonly jobs = new Map<string, JobRecord>();

  submit(run: () => Promise<unknown>): string {
    const jobId = randomUUID();
    this.jobs.set(jobId, { status: "running" });
    run()
      .then((result) => this.jobs.set(jobId, { status: "done", result }))
      .catch((error) => this.jobs.set(jobId, { status: "failed", error: toApplicationError(error) }));
    return jobId;
  }

  poll(jobId: string): JobStatusResult | undefined {
    const record = this.jobs.get(jobId);
    if (!record) return undefined;
    return { jobId, status: record.status, result: record.result, error: record.error };
  }
}

export interface CreateTransportServerOptions {
  readonly routeHandlers: Readonly<Record<string, TransportRouteHandler>>;
  readonly resolveServerGeneration: () => string | undefined;
}

/**
 * Platform-first choice: Node's `http.Server` bound to a filesystem path
 * (`listen({ path })`) gets request/response message framing for free --
 * the HTTP parser already handles a body split across multiple socket
 * reads/writes and keeps one malformed request from corrupting the next
 * request on a reused connection. Hand-rolled NDJSON framing would have to
 * re-derive exactly that guarantee, so it is not used here.
 */
export function createTransportServer(options: CreateTransportServerOptions): http.Server {
  const jobStore = new TransportJobStore();
  return http.createServer((request, response) => {
    void handleTransportRequest(request, response, options, jobStore);
  });
}

async function handleTransportRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: CreateTransportServerOptions,
  jobStore: TransportJobStore,
): Promise<void> {
  const serverGeneration = options.resolveServerGeneration();
  let envelope: TransportRequestEnvelope;
  try {
    envelope = await readTransportRequestBody(request);
  } catch (error) {
    writeTransportResponse(response, 400, {
      ok: false,
      serverGeneration,
      error: toTransportError(error instanceof Error ? error.message : String(error)),
    });
    return;
  }

  if (envelope.path === JOB_STATUS_ROUTE_PATH) {
    const jobId = envelope.args[0];
    const status = jobId === undefined ? undefined : jobStore.poll(jobId);
    if (!status) {
      writeTransportResponse(response, 404, {
        ok: false,
        serverGeneration,
        error: toTransportError(`unknown job id: ${jobId ?? "(missing)"}`),
      });
      return;
    }
    writeTransportResponse(response, 200, { ok: true, serverGeneration, result: status });
    return;
  }

  const handler = options.routeHandlers[envelope.path];
  if (!handler) {
    writeTransportResponse(response, 404, {
      ok: false,
      serverGeneration,
      error: toTransportError(`unknown route: ${envelope.path}`),
    });
    return;
  }

  if (envelope.mode === "job") {
    const jobId = jobStore.submit(() => handler(envelope));
    writeTransportResponse(response, 202, { ok: true, serverGeneration, result: { jobId } });
    return;
  }

  try {
    const result = await handler(envelope);
    writeTransportResponse(response, 200, { ok: true, serverGeneration, result });
  } catch (error) {
    writeTransportResponse(response, 200, { ok: false, serverGeneration, error: toApplicationError(error) });
  }
}

function readTransportRequestBody(request: http.IncomingMessage): Promise<TransportRequestEnvelope> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as TransportRequestEnvelope);
      } catch {
        reject(new Error("malformed transport request body"));
      }
    });
    request.on("error", reject);
  });
}

function writeTransportResponse(
  response: http.ServerResponse,
  statusCode: number,
  envelope: TransportResponseEnvelope,
): void {
  const body = Buffer.from(JSON.stringify(envelope));
  response.writeHead(statusCode, { "content-type": "application/json", "content-length": body.length });
  response.end(body);
}

/**
 * Bound on a single round trip before the client gives up and reports the
 * backend unreachable rather than hanging forever. A dead socket file
 * (nothing listening, nothing accepting) rejects near-instantly on its own,
 * but a wedged-but-accepting backend that never writes a response would
 * otherwise hang the caller indefinitely -- exactly the "never hang" failure
 * mode a debugging trigger must not have. 10s comfortably exceeds any real
 * route handler's expected latency (message-status/keep-going/no-idling all
 * complete in well under a second) without making an operator wait through
 * multiple retries of a genuinely dead backend.
 */
export const DEFAULT_TRANSPORT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Thrown when a request was sent but no complete response arrived within the
 * timeout -- distinguishable from an immediate connection refusal (dead
 * socket) by callers that want to report the two differently.
 */
export class TransportTimeoutError extends Error {
  constructor(socketPath: string, timeoutMs: number) {
    super(`no response from throne-backend at ${socketPath} within ${timeoutMs}ms`);
    this.name = "TransportTimeoutError";
  }
}

/**
 * The connection primitive both server and client sit on: a request/response
 * round trip over a filesystem AF_UNIX socket, no TCP address form accepted.
 */
export function sendTransportRequest(
  socketPath: string,
  envelope: TransportRequestEnvelope,
  agent?: http.Agent,
  timeoutMs: number = DEFAULT_TRANSPORT_REQUEST_TIMEOUT_MS,
): Promise<TransportResponseEnvelope> {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(envelope));
    const request = http.request(
      {
        socketPath,
        path: "/",
        method: "POST",
        agent,
        headers: { "content-type": "application/json", "content-length": body.length },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as TransportResponseEnvelope);
          } catch (error) {
            reject(error);
          }
        });
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    // `setTimeout` fires on inactivity (no data either direction within the
    // window), not just on connect -- covers a backend that accepts the
    // connection then never responds, not only a refused connection.
    request.setTimeout(timeoutMs, () => {
      request.destroy(new TransportTimeoutError(socketPath, timeoutMs));
    });
    request.write(body);
    request.end();
  });
}

/** Polls a job submitted via a `mode: "job"` request until the caller stops asking. */
export function pollTransportJobStatus(
  socketPath: string,
  jobId: string,
  cwd: string,
  agent?: http.Agent,
): Promise<TransportResponseEnvelope<JobStatusResult>> {
  return sendTransportRequest(
    socketPath,
    { path: JOB_STATUS_ROUTE_PATH, cwd, args: [jobId], mode: "unary" },
    agent,
  ) as Promise<TransportResponseEnvelope<JobStatusResult>>;
}
