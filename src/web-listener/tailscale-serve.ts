import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { parseNamingTheField } from "../web-api-contract/parse-naming-the-field.ts";
import type { TailnetPlace, TailnetRoute } from "./tailnet-routes.ts";

const TAILSCALE_COMMAND_TIMEOUT_MS = 30_000;

const runCommand = promisify(execFile);

const tailscaleServeStatus = z.object({
  AllowFunnel: z.record(z.string(), z.boolean()).optional(),
  Web: z
    .record(
      z.string(),
      z.object({
        Handlers: z.record(z.string(), z.object({ Proxy: z.string().optional() })).optional(),
      }),
    )
    .optional(),
});

const tailscaleSelfStatus = z.object({ Self: z.object({ DNSName: z.string() }) });

export type TailscaleServeStatus = z.infer<typeof tailscaleServeStatus>;

type TailscaleServeHandler = NonNullable<
  NonNullable<TailscaleServeStatus["Web"]>[string]["Handlers"]
>[string];

export function handlerAtPlace(
  status: TailscaleServeStatus,
  place: TailnetPlace,
): TailscaleServeHandler | undefined {
  const hostAndPortSuffix = `:${place.httpsPort}`;
  const webEntry = Object.entries(status.Web ?? {}).find(([hostAndPort]) =>
    hostAndPort.endsWith(hostAndPortSuffix),
  );
  return webEntry?.[1].Handlers?.[place.path];
}

export function funnelIsOnAtPort(status: TailscaleServeStatus, httpsPort: number): boolean {
  return Object.entries(status.AllowFunnel ?? {}).some(
    ([hostAndPort, funnelIsOn]) => funnelIsOn && hostAndPort.endsWith(`:${httpsPort}`),
  );
}

async function runTailscale(tailscaleCommand: string, tailscaleArguments: readonly string[]): Promise<string> {
  const { stdout } = await runCommand(tailscaleCommand, [...tailscaleArguments], {
    timeout: TAILSCALE_COMMAND_TIMEOUT_MS,
  });
  return stdout;
}

export async function readTailscaleServeStatus(tailscaleCommand: string): Promise<TailscaleServeStatus> {
  const output = await runTailscale(tailscaleCommand, ["serve", "status", "--json"]);
  return parseNamingTheField(tailscaleServeStatus, JSON.parse(output), "tailscale serve status");
}

export async function readTailnetHostName(tailscaleCommand: string): Promise<string> {
  const output = await runTailscale(tailscaleCommand, ["status", "--self", "--json"]);
  const { Self } = parseNamingTheField(tailscaleSelfStatus, JSON.parse(output), "tailscale status");
  return Self.DNSName.replace(/\.$/, "");
}

export async function serveRouteOnTheTailnet(tailscaleCommand: string, route: TailnetRoute): Promise<void> {
  await runTailscale(tailscaleCommand, [
    "serve",
    "--bg",
    `--https=${route.httpsPort}`,
    "--set-path",
    route.path,
    route.target,
  ]);
}

export async function stopServingOnTheTailnet(tailscaleCommand: string, place: TailnetPlace): Promise<void> {
  await runTailscale(tailscaleCommand, ["serve", `--https=${place.httpsPort}`, "--set-path", place.path, "off"]);
}
