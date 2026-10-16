import {
  createCapturedSinks,
  runCapturedWork,
  type ManualTriggerRouteResult,
} from "../transport/manual-trigger-route.ts";
import { TransportClient } from "../transport/transport-client.ts";
import {
  runAgentSettingsTick,
  type AgentSettingsTickRequest,
} from "./agent-settings-tick.ts";

export const AGENT_SETTINGS_ROUTE_PATH = "agent-settings";
export const AGENT_SETTINGS_TICK_COMMAND_NAME = "agent-settings-tick";
export const DRY_RUN_FLAG = "--dry-run";
export const AGENT_SETTINGS_TRANSPORT_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

export function createAgentSettingsTransportClient(): TransportClient {
  return new TransportClient({
    requestTimeoutMs: AGENT_SETTINGS_TRANSPORT_REQUEST_TIMEOUT_MS,
  });
}

export function routeArgumentsOf(request: AgentSettingsTickRequest): string[] {
  return request.dryRun ? [DRY_RUN_FLAG] : [];
}

export async function writeAgentSettingsTickLines(
  request: AgentSettingsTickRequest,
  writeLine: (text: string) => void,
): Promise<void> {
  for (const line of await runAgentSettingsTick(request)) {
    writeLine(`${line}\n`);
  }
}

export async function handleAgentSettingsRoute(envelope: {
  readonly args: readonly string[];
}): Promise<ManualTriggerRouteResult> {
  const captured = createCapturedSinks();
  return runCapturedWork(captured, () =>
    writeAgentSettingsTickLines(
      { dryRun: envelope.args.includes(DRY_RUN_FLAG) },
      captured.sinks.stdout,
    ),
  );
}
