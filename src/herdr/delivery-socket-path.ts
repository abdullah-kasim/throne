import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  DELIVERY_CALLBACK_ENV,
  DELIVERY_HELPER_ENV,
  DELIVERY_RUNTIME_ENV,
  DELIVERY_SOCKET_ENV,
  MAX_SOCKET_PATH_BYTES,
} from "../../extensions/shared/agent-delivery-contract.ts";
import { readSpawnSpec, writeSpawnSpec } from "../agentdata/spawn-data-contracts.ts";
import { RUNTIME_THRONE_ROOT } from "../shared-policy/runtime-throne-root.ts";
import { THRONE_HOME } from "../shared-policy/throne-home.ts";

const SOCKET_FOLDER_NAME = "s";
const SOCKET_NAME_HASH_LENGTH = 16;
const CALLBACK_SOCKET_NAME = "delivery-callback.sock";

export const DELIVERY_RUNTIME_PATH = path.join(RUNTIME_THRONE_ROOT, "bin", "throne-runtime");
export const DELIVERY_HELPER_PATH = path.join(RUNTIME_THRONE_ROOT, "extensions", "claude", "delivery-helper.ts");

export interface DeliverySocketDeps {
  throneHome: string;
  recorded: (agentName: string) => Promise<string | undefined>;
  record: (agentName: string, socketPath: string, callbackSocketPath: string) => Promise<void>;
}

export function deliveryCallbackSocketPath(throneHome: string): string {
  return path.join(throneHome, CALLBACK_SOCKET_NAME);
}

export class DeliverySocketPathTooLongError extends Error {
  constructor(agentName: string, socketPath: string) {
    super(
      `the delivery socket of "${agentName}" would be ${Buffer.byteLength(socketPath)} bytes (${socketPath}), over the ${MAX_SOCKET_PATH_BYTES} byte limit, so the launch is refused`,
    );
    this.name = "DeliverySocketPathTooLongError";
  }
}

export async function chooseDeliverySocket(agentName: string, throneHome: string, recorded?: string): Promise<string> {
  const socketPath = recorded ?? (await newSocketPath(agentName, throneHome));
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
    throw new DeliverySocketPathTooLongError(agentName, socketPath);
  }
  return socketPath;
}

async function newSocketPath(agentName: string, throneHome: string): Promise<string> {
  const folder = path.join(throneHome, SOCKET_FOLDER_NAME);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const name = createHash("sha256").update(agentName).digest("hex").slice(0, SOCKET_NAME_HASH_LENGTH);
  return path.join(await realpath(folder), `${name}.sock`);
}

export function deliveryEnvironment(
  socketPath: string,
  callbackSocketPath: string,
  withHelper: boolean,
): Record<string, string> {
  return {
    [DELIVERY_SOCKET_ENV]: socketPath,
    [DELIVERY_CALLBACK_ENV]: callbackSocketPath,
    ...(withHelper ? { [DELIVERY_RUNTIME_ENV]: DELIVERY_RUNTIME_PATH, [DELIVERY_HELPER_ENV]: DELIVERY_HELPER_PATH } : {}),
  };
}

export async function recordDeliverySocketInSpawn(
  agentName: string,
  socketPath: string,
  callbackSocketPath: string,
): Promise<void> {
  const spec = await readSpawnSpec(agentName);
  if (spec === null) return;
  await writeSpawnSpec(agentName, {
    ...spec,
    delivery_socket: socketPath,
    delivery_callback: callbackSocketPath,
  });
}

export const REAL_DELIVERY_SOCKET_DEPS: DeliverySocketDeps = {
  throneHome: THRONE_HOME,
  recorded: async (agentName) => (await readSpawnSpec(agentName))?.delivery_socket,
  record: recordDeliverySocketInSpawn,
};
