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
import { ALPHA_AUTOSCALE_ROUTE_PATH } from "./alpha-autoscale-route.ts";

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

test("alpha-autoscale-tick with no transport flag still runs the sweep in-process", async () => {
  const { worker, calls } = stubWorker();
  const client = new StubTransportClient(async () => {
    throw new Error("must not reach the transport when no flag is given");
  });
  const command = new AlphaAutoscaleTickCommand(worker, client);

  await command.run([]);

  assert.equal(calls.count, 1);
});

test("alpha-autoscale-tick --local still runs the sweep in-process, unchanged from the default", async () => {
  const { worker, calls } = stubWorker();
  const client = new StubTransportClient(async () => {
    throw new Error("must not reach the transport when --local is given");
  });
  const command = new AlphaAutoscaleTickCommand(worker, client);

  await command.run(["--local"]);

  assert.equal(calls.count, 1);
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
