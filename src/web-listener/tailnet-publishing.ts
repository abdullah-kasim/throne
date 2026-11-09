import { mkdir } from "node:fs/promises";
import path from "node:path";
import { previewsFromConfig } from "../previews/preview-entries.ts";
import { withExclusiveFileLock } from "../shared-policy/exclusive-file-lock.ts";
import { readTailnetLedger, writeTailnetLedger, type TailnetLedger } from "./tailnet-ledger.ts";
import { isSameTailnetPlace, wantedTailnetRoutes, type TailnetPlace, type TailnetRoute } from "./tailnet-routes.ts";
import {
  funnelIsOnAtPort,
  handlerAtPlace,
  readTailnetHostName,
  readTailscaleServeStatus,
  serveRouteOnTheTailnet,
  stopServingOnTheTailnet,
  type TailscaleServeStatus,
} from "./tailscale-serve.ts";

export interface TailnetPublishingDependencies {
  readonly tailscaleCommand: string;
  readonly ledgerPath: string;
  readonly listenerPort: number;
  readonly configPath?: string;
  readonly log: (message: string) => void;
}

export interface TailnetState {
  readonly hostName: string;
  readonly status: TailscaleServeStatus;
  readonly ledger: TailnetLedger;
}

const TAILNET_LEDGER_LOCK_NAME = "tailnet ledger";

function ledgerHoldsPlace(ledger: TailnetLedger, place: TailnetPlace): boolean {
  return ledger.places.some((held) => isSameTailnetPlace(held, place));
}

function refusalOf(route: TailnetRoute, status: TailscaleServeStatus, ledger: TailnetLedger): string | undefined {
  const refusedPlace = `refused ${route.path} on port ${route.httpsPort}`;
  if (funnelIsOnAtPort(status, route.httpsPort)) return `${refusedPlace}: funnel is enabled there; left alone`;
  const handler = handlerAtPlace(status, route);
  if (handler === undefined || ledgerHoldsPlace(ledger, route)) return undefined;
  const holder = handler.Proxy ?? "something that is not a proxy";
  return `${refusedPlace}: held by ${holder}, which this code did not create; left alone`;
}

function ledgerWithPlace(ledger: TailnetLedger, place: TailnetPlace): TailnetLedger {
  if (ledgerHoldsPlace(ledger, place)) return ledger;
  return { places: [...ledger.places, { httpsPort: place.httpsPort, path: place.path }] };
}

function ledgerWithoutPlace(ledger: TailnetLedger, place: TailnetPlace): TailnetLedger {
  return { places: ledger.places.filter((held) => !isSameTailnetPlace(held, place)) };
}

async function reconcileTailnet(dependencies: TailnetPublishingDependencies): Promise<void> {
  const { tailscaleCommand, ledgerPath, listenerPort, configPath, log } = dependencies;
  const status = await readTailscaleServeStatus(tailscaleCommand);
  let ledger = await readTailnetLedger(ledgerPath);
  const wantedRoutes = wantedTailnetRoutes(listenerPort, await previewsFromConfig(configPath));
  for (const route of wantedRoutes) {
    const refusal = refusalOf(route, status, ledger);
    if (refusal !== undefined) {
      log(refusal);
    } else if (handlerAtPlace(status, route)?.Proxy !== route.target) {
      await serveRouteOnTheTailnet(tailscaleCommand, route);
      ledger = ledgerWithPlace(ledger, route);
      await writeTailnetLedger(ledgerPath, ledger);
    }
  }
  for (const place of ledger.places) {
    if (wantedRoutes.some((route) => isSameTailnetPlace(route, place))) continue;
    if (handlerAtPlace(status, place) !== undefined) await stopServingOnTheTailnet(tailscaleCommand, place);
    ledger = ledgerWithoutPlace(ledger, place);
    await writeTailnetLedger(ledgerPath, ledger);
  }
}

export async function publishWantedTailnetRoutes(dependencies: TailnetPublishingDependencies): Promise<void> {
  const { ledgerPath } = dependencies;
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  await withExclusiveFileLock(`${ledgerPath}.lock`, TAILNET_LEDGER_LOCK_NAME, () => reconcileTailnet(dependencies));
}

export async function refusalToPublish(
  route: TailnetRoute,
  dependencies: TailnetPublishingDependencies,
): Promise<string | undefined> {
  const status = await readTailscaleServeStatus(dependencies.tailscaleCommand);
  return refusalOf(route, status, await readTailnetLedger(dependencies.ledgerPath));
}

export async function describeTailnetState(dependencies: TailnetPublishingDependencies): Promise<TailnetState> {
  const { tailscaleCommand, ledgerPath } = dependencies;
  return {
    hostName: await readTailnetHostName(tailscaleCommand),
    status: await readTailscaleServeStatus(tailscaleCommand),
    ledger: await readTailnetLedger(ledgerPath),
  };
}

export function routeIsLive(route: TailnetRoute, { status, ledger }: TailnetState): boolean {
  return ledgerHoldsPlace(ledger, route) && handlerAtPlace(status, route)?.Proxy === route.target;
}
