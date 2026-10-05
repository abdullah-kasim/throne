import type { SchedulerRegistry } from "@nestjs/schedule";
import { TransportConnectionError, type TransportClient } from "../transport/transport-client.ts";
import {
  createCapturedSinks,
  runCapturedWork,
  type ManualTriggerRouteResult,
} from "../transport/manual-trigger-route.ts";
import { ALPHA_AUTOSCALE_HOSTED_WORKER_NAME } from "./alpha-autoscale.hosted-worker.ts";
import {
  collectAutoscaleStatus,
  resolveAutoscaleStatusSources,
  type AutoscaleStatusSources,
} from "./autoscale-status-report.ts";
import { renderAutoscaleStatus, type AutoscaleStatusFormat } from "./autoscale-status-render.ts";

export const AUTOSCALE_STATUS_ROUTE_PATH = "autoscale-status";
const JSON_FLAG = "--json";

export function autoscaleStatusFormat(args: readonly string[]): AutoscaleStatusFormat {
  return args.includes(JSON_FLAG) ? "json" : "text";
}

export function readScheduledAutoscaleRun(
  scheduler: SchedulerRegistry | undefined,
): Date | undefined {
  if (scheduler === undefined || !scheduler.doesExist("cron", ALPHA_AUTOSCALE_HOSTED_WORKER_NAME)) {
    return undefined;
  }
  return scheduler.getCronJob(ALPHA_AUTOSCALE_HOSTED_WORKER_NAME).nextDate().toJSDate();
}

export async function renderAutoscaleStatusFrom(
  sources: AutoscaleStatusSources,
  args: readonly string[],
): Promise<string> {
  return renderAutoscaleStatus(await collectAutoscaleStatus(sources), autoscaleStatusFormat(args));
}

export function createAutoscaleStatusRouteHandler(
  scheduler: SchedulerRegistry | undefined,
  readers: Partial<AutoscaleStatusSources> = {},
): (envelope: { readonly args: readonly string[] }) => Promise<ManualTriggerRouteResult> {
  return async (envelope) => {
    const captured = createCapturedSinks();
    return runCapturedWork(captured, async () => {
      const sources = resolveAutoscaleStatusSources({
        ...readers,
        viewpoint: "backend",
        nextScheduledRun: () => readScheduledAutoscaleRun(scheduler),
      });
      captured.sinks.stdout(await renderAutoscaleStatusFrom(sources, envelope.args));
    });
  };
}

export type BackendStatusReply =
  | { readonly reached: true; readonly result: ManualTriggerRouteResult }
  | { readonly reached: false; readonly reason: string };

export async function requestAutoscaleStatusFromBackend(
  client: TransportClient,
  args: readonly string[],
): Promise<BackendStatusReply> {
  try {
    const response = await client.request(AUTOSCALE_STATUS_ROUTE_PATH, args);
    return response.ok
      ? { reached: true, result: response.result as ManualTriggerRouteResult }
      : { reached: false, reason: response.error?.message ?? "transport request failed" };
  } catch (error) {
    if (error instanceof TransportConnectionError) {
      return { reached: false, reason: error.message };
    }
    throw error;
  }
}
