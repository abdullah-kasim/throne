import net from "node:net";
import {
  HerdrClientService,
  DEFAULT_HERDR_READ_ONLY_CLIENT_DEPENDENCIES,
} from "../herdr/herdr-client.ts";
import { AGENT_STATUSES, type AgentStatus } from "../agent-statuses/agent-statuses-herdr.ts";

/**
 * A parsed `pane.agent_status_changed` subscription event, matching the
 * `PaneAgentStatusChangedEvent` shape confirmed live against
 * `herdr api schema --json` (protocol 19) and a running `throne` herdr
 * session.
 */
export interface PaneAgentStatusChangedEvent {
  readonly paneId: string;
  readonly workspaceId: string;
  readonly agentStatus: AgentStatus;
  readonly agent: string | null;
  readonly displayAgent: string | null;
  readonly title: string | null;
  readonly stateLabels: Readonly<Record<string, string>>;
}

export interface PaneAgentStatusSubscriptionDependencies {
  readonly herdrClient: HerdrClientService;
  /** Panes to open `pane.agent_status_changed` subscriptions for — the herdr
   *  wire protocol requires one explicit `pane_id` per subscription entry,
   *  there is no "every pane" wildcard, so the caller supplies the roster
   *  (e.g. via `herdr agent list`). */
  readonly listKnownPaneIds: () => Promise<readonly string[]>;
  readonly onEvent: (event: PaneAgentStatusChangedEvent) => void;
  readonly shouldStop: () => boolean;
  readonly connect: (socketPath: string) => net.Socket;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

export const DEFAULT_PANE_AGENT_STATUS_SUBSCRIPTION_DEPENDENCIES: Pick<
  PaneAgentStatusSubscriptionDependencies,
  "connect" | "sleep"
> = {
  connect: (socketPath) => net.createConnection(socketPath),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

const SUBSCRIBE_REQUEST_ID = "blocked-paging.events.subscribe";
const RECONNECT_BACKOFF_START_MS = 1_000;
const RECONNECT_BACKOFF_MAX_MS = 30_000;
/** A live connection is voluntarily recycled on this cadence, not only on a
 *  drop — the wire protocol pins a subscription to the pane ids named at
 *  subscribe time, so a pane created after subscribing is invisible to that
 *  connection until it is renewed. */
const SUBSCRIPTION_REFRESH_INTERVAL_MS = 60_000;

/**
 * Keeps a `pane.agent_status_changed` herdr subscription open for the
 * caller-supplied roster of panes, calling back with each parsed event,
 * until `shouldStop()` returns true.
 *
 * **Platform choice:** talks to herdr's socket API (`events.subscribe`)
 * directly rather than shelling out to `herdr agent wait --until blocked`.
 * The CLI primitive blocks on one named target per process and exits once a
 * matching state is reached, so watching the whole roster would mean
 * spawning and re-spawning one child process per agent and re-deriving,
 * from each exit code, whether the state was actually reached versus the
 * process simply dying — the exact ambiguity a single persistent socket
 * connection avoids by carrying every pane's subscription and every event on
 * one continuously-read stream.
 *
 * **Never throws a dropped connection out of this call.** A closed socket,
 * a `herdr` server restart, or any wire error inside one subscription
 * session is retried with exponential backoff (capped) instead of
 * propagating — an uncaught rejection here would take down the hosting
 * `throne-backend` process and every other worker registered alongside it,
 * a far worse outcome than a missed page.
 *
 * **A missed event during a drop or reconnect is invisible, and that is
 * accepted.** This subscriber is best-effort push chrome layered on top of
 * the existing `no-idling` poll sweep, never a replacement for it — the poll
 * remains the reconciling floor for anything a dropped connection, a worker
 * restart, or a socket outage causes this path to miss.
 */
export async function subscribeToPaneAgentStatusChanged(
  dependencies: PaneAgentStatusSubscriptionDependencies,
): Promise<void> {
  let backoffMilliseconds = RECONNECT_BACKOFF_START_MS;
  while (!dependencies.shouldStop()) {
    try {
      await runOneSubscriptionSession(dependencies);
      backoffMilliseconds = RECONNECT_BACKOFF_START_MS;
    } catch {
      await dependencies.sleep(backoffMilliseconds);
      backoffMilliseconds = Math.min(backoffMilliseconds * 2, RECONNECT_BACKOFF_MAX_MS);
    }
  }
}

async function runOneSubscriptionSession(
  dependencies: PaneAgentStatusSubscriptionDependencies,
): Promise<void> {
  const paneIds = await dependencies.listKnownPaneIds();
  if (paneIds.length === 0) {
    await dependencies.sleep(SUBSCRIPTION_REFRESH_INTERVAL_MS);
    return;
  }
  const socketPath = await resolveHerdrSocketPath(dependencies.herdrClient);
  const socket = dependencies.connect(socketPath);

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(refreshTimer);
      clearInterval(stopPollTimer);
      socket.removeAllListeners();
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };

    const refreshTimer = setTimeout(() => finish(), SUBSCRIPTION_REFRESH_INTERVAL_MS);
    const stopPollTimer = setInterval(() => {
      if (dependencies.shouldStop()) finish();
    }, 500);

    let buffer = "";
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({
          id: SUBSCRIBE_REQUEST_ID,
          method: "events.subscribe",
          params: {
            subscriptions: paneIds.map((paneId) => ({
              type: "pane.agent_status_changed",
              pane_id: paneId,
            })),
          },
        })}\n`,
      );
    });
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length === 0) continue;
        const event = parsePaneAgentStatusChangedLine(line);
        if (event) dependencies.onEvent(event);
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () => finish());
  });
}

async function resolveHerdrSocketPath(herdrClient: HerdrClientService): Promise<string> {
  const status = await herdrClient.run(["status", "server"]);
  for (const line of status.stdout.trim().split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    if (key === "socket") return line.slice(separator + 1).trim();
  }
  throw new Error('herdr status server did not report a "socket" field');
}

/** Parses one newline-delimited JSON message from the subscription
 *  connection. Returns `null` for anything that is not a well-formed
 *  `pane.agent_status_changed` event envelope — including the initial
 *  `events.subscribe` RPC acknowledgement, which carries no `event` field
 *  and is intentionally ignored here. */
export function parsePaneAgentStatusChangedLine(
  line: string,
): PaneAgentStatusChangedEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const envelope = parsed as Record<string, unknown>;
  if (envelope.event !== "pane.agent_status_changed") return null;

  const data = envelope.data;
  if (typeof data !== "object" || data === null) return null;
  const row = data as Record<string, unknown>;
  if (typeof row.pane_id !== "string" || typeof row.workspace_id !== "string") return null;
  if (
    typeof row.agent_status !== "string" ||
    !(AGENT_STATUSES as readonly string[]).includes(row.agent_status)
  ) {
    return null;
  }

  return {
    paneId: row.pane_id,
    workspaceId: row.workspace_id,
    agentStatus: row.agent_status as AgentStatus,
    agent: typeof row.agent === "string" ? row.agent : null,
    displayAgent: typeof row.display_agent === "string" ? row.display_agent : null,
    title: typeof row.title === "string" ? row.title : null,
    stateLabels:
      typeof row.state_labels === "object" && row.state_labels !== null
        ? (row.state_labels as Record<string, string>)
        : {},
  };
}

export function defaultHerdrClient(): HerdrClientService {
  return new HerdrClientService(DEFAULT_HERDR_READ_ONLY_CLIENT_DEPENDENCIES);
}
