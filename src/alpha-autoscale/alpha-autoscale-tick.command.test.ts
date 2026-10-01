// Every requirement here calls `AlphaAutoscaleTickCommand.run` directly --
// never `./bin/throne-cli` -- against a stub worker and a stubbed
// `TransportClient` subclass (the true process boundary this codebase owns:
// no real socket bind, no real backend process).
import assert from "node:assert/strict";
import { test } from "node:test";
import { AlphaAutoscaleTickCommand } from "./alpha-autoscale-tick.command.ts";
import type { AlphaAutoscaleHostedWorker } from "./alpha-autoscale.hosted-worker.ts";
import {
  TransportClient,
  TransportConnectionError,
} from "../transport/transport-client.ts";
import type { TransportResponseEnvelope } from "../transport/transport-wire-contract.ts";
import type { ManualTriggerRouteResult } from "../transport/manual-trigger-route.ts";
import {
  ALPHA_AUTOSCALE_ROUTE_PATH,
  ALPHA_AUTOSCALE_TRANSPORT_REQUEST_TIMEOUT_MS,
  createAlphaAutoscaleTransportClient,
  runAlphaAutoscaleOverTransport,
} from "./alpha-autoscale-route.ts";
import { SWEEP_LOCK_LATEST_EXPIRY_MS } from "./alpha-autoscale-sweep-lock.ts";
import {
  DEFAULT_TRANSPORT_REQUEST_TIMEOUT_MS,
  createTransportServer,
} from "../transport/transport-wire-contract.ts";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function capturingStderr(action: () => Promise<void>): Promise<string> {
  const originalWrite = process.stderr.write.bind(process.stderr);
  let stderrOutput = "";
  process.stderr.write = ((chunk: string) => {
    stderrOutput += chunk;
    return true;
  }) as typeof process.stderr.write;
  try {
    await action();
  } finally {
    process.stderr.write = originalWrite;
  }
  return stderrOutput;
}

function stubWorker(): { worker: AlphaAutoscaleHostedWorker; calls: { count: number } } {
  const calls = { count: 0 };
  const worker = {
    runOnce: async () => {
      calls.count += 1;
    },
  } as unknown as AlphaAutoscaleHostedWorker;
  return { worker, calls };
}

class StubTransportClient extends TransportClient {
  constructor(private readonly respond: (path: string, args: readonly string[]) => Promise<TransportResponseEnvelope>) {
    super();
  }

  override async request(routePath: string, args: readonly string[]): Promise<TransportResponseEnvelope> {
    return this.respond(routePath, args);
  }
}

test("alpha-autoscale-tick with no transport flag runs the sweep inside throne-backend over REST", async () => {
  const { worker, calls } = stubWorker();
  let requestedPath: string | undefined;
  const client = new StubTransportClient(async (path) => {
    requestedPath = path;
    return { ok: true, serverGeneration: "test-generation", result: { exitCode: 0, stdout: "", stderr: "" } };
  });
  const command = new AlphaAutoscaleTickCommand(worker, client);

  const stderrOutput = await capturingStderr(() => command.run([]));

  assert.equal(requestedPath, ALPHA_AUTOSCALE_ROUTE_PATH);
  assert.equal(calls.count, 0, "the default must not run the sweep in this process");
  assert.match(stderrOutput, /transport rest/);
  assert.equal(process.exitCode, 0);
  process.exitCode = 0;
});

test("alpha-autoscale-tick --local runs the sweep in this process, the explicit escape hatch", async () => {
  const { worker, calls } = stubWorker();
  const client = new StubTransportClient(async () => {
    throw new Error("must not reach the transport when --local is given");
  });
  const command = new AlphaAutoscaleTickCommand(worker, client);

  const stderrOutput = await capturingStderr(() => command.run(["--local"]));

  assert.equal(calls.count, 1);
  assert.match(stderrOutput, /transport local/);
});

test("alpha-autoscale-tick with no flag never falls back to a local sweep when the backend is unreachable", async () => {
  const { worker, calls } = stubWorker();
  const client = new StubTransportClient(async () => {
    throw new TransportConnectionError("/test/socket", new Error("ECONNREFUSED"));
  });
  const command = new AlphaAutoscaleTickCommand(worker, client);

  const stderrOutput = await capturingStderr(() => command.run([]));

  assert.equal(calls.count, 0);
  assert.equal(process.exitCode, 1);
  process.exitCode = 0;
  const failureLines = stderrOutput.split("\n").filter((line) => line.includes("unreachable"));
  assert.equal(failureLines.length, 1);
  assert.match(failureLines[0]!, /ECONNREFUSED.*--local/);
});

test("alpha-autoscale-tick exits non-zero naming --local when the backend answers with an error", async () => {
  const { worker, calls } = stubWorker();
  const client = new StubTransportClient(async () => ({
    ok: false,
    serverGeneration: "test-generation",
    error: { kind: "transport", message: "no route named alpha-autoscale" },
  }));
  const command = new AlphaAutoscaleTickCommand(worker, client);

  const stderrOutput = await capturingStderr(() => command.run([]));

  assert.equal(calls.count, 0);
  assert.equal(process.exitCode, 1);
  process.exitCode = 0;
  assert.match(stderrOutput, /no route named alpha-autoscale\. Pass --local/);
});

test("alpha-autoscale-tick --transport rest reaches the backend route and reports its result", async () => {
  const { worker, calls } = stubWorker();
  let requestedPath: string | undefined;
  const routeResult: ManualTriggerRouteResult = { exitCode: 0, stdout: "sweep ran\n", stderr: "" };
  const client = new StubTransportClient(async (path) => {
    requestedPath = path;
    return { ok: true, serverGeneration: "test-generation", result: routeResult };
  });
  const command = new AlphaAutoscaleTickCommand(worker, client);

  await command.run(["--transport", "rest"]);

  assert.equal(requestedPath, ALPHA_AUTOSCALE_ROUTE_PATH);
  assert.equal(calls.count, 0, "the local worker must not run when the transport path is taken");
  assert.equal(process.exitCode, 0);
  process.exitCode = 0;
});

test("alpha-autoscale-tick --transport rest fails loudly, naming --local, when the backend is unreachable", async () => {
  const { worker, calls } = stubWorker();
  const client = new StubTransportClient(async () => {
    throw new TransportConnectionError("/test/socket", new Error("ECONNREFUSED"));
  });
  const originalWrite = process.stderr.write.bind(process.stderr);
  let stderrOutput = "";
  process.stderr.write = ((chunk: string) => {
    stderrOutput += chunk;
    return true;
  }) as typeof process.stderr.write;
  try {
    const command = new AlphaAutoscaleTickCommand(worker, client);
    await command.run(["--transport", "rest"]);
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.equal(calls.count, 0);
  assert.equal(process.exitCode, 1);
  process.exitCode = 0;
  assert.match(stderrOutput, /--local/);
});

test("autoscale-now is the same sweep under a findable name, over REST by default and in-process with --local", async () => {
  const { AutoscaleNowCommand } = await import("./alpha-autoscale-tick.command.ts");
  const { worker, calls } = stubWorker();
  let restRequests = 0;
  const client = new StubTransportClient(async () => {
    restRequests += 1;
    return { ok: true, serverGeneration: "test-generation", result: { exitCode: 0, stdout: "", stderr: "" } };
  });
  const command = new AutoscaleNowCommand(worker, client);

  await capturingStderr(() => command.run([]));
  assert.equal(restRequests, 1);
  assert.equal(calls.count, 0);
  process.exitCode = 0;

  await capturingStderr(() => command.run(["--local"]));
  assert.equal(restRequests, 1);
  assert.equal(calls.count, 1);
  assert.ok(command instanceof AlphaAutoscaleTickCommand);
});

test("a REST sweep that runs longer than the transport's usual 10 seconds is still waited for", async () => {
  assert.ok(ALPHA_AUTOSCALE_TRANSPORT_REQUEST_TIMEOUT_MS > SWEEP_LOCK_LATEST_EXPIRY_MS);
  const directory = await mkdtemp(path.join(os.tmpdir(), "autoscale-rest-"));
  const socketPath = path.join(directory, "backend.sock");
  const server = createTransportServer({
    routeHandlers: {
      [ALPHA_AUTOSCALE_ROUTE_PATH]: async () => {
        await new Promise((resolve) => setTimeout(resolve, DEFAULT_TRANSPORT_REQUEST_TIMEOUT_MS + 1_000));
        return { exitCode: 0, stdout: "slow sweep finished\n", stderr: "" };
      },
    },
    resolveServerGeneration: () => undefined,
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    let exitCode: number | undefined;
    const stderrOutput = await capturingStderr(async () => {
      exitCode = await runAlphaAutoscaleOverTransport(createAlphaAutoscaleTransportClient(socketPath), []);
    });
    assert.equal(exitCode, 0, stderrOutput);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
