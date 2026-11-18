import path from "node:path";
import { installDeliveryExtension, type ExtensionInstallOutcome } from "./extension-install.ts";
import { PI_DELIVERY_EXTENSION_NAME } from "./pi-delivery-client.ts";

export function piDeliveryExtensionSource(throneRoot: string): string {
  return path.join(throneRoot, "extensions", "pi", PI_DELIVERY_EXTENSION_NAME);
}

export function installPiDeliveryExtension(
  agentDirectory: string,
  source: string,
): Promise<ExtensionInstallOutcome> {
  return installDeliveryExtension({
    agentDir: agentDirectory,
    source,
    linkName: PI_DELIVERY_EXTENSION_NAME,
    findExecutable: async () => "piy",
  });
}

export const PI_INSTRUCTION_FILE_NAME = "AGENTS.md";

export function piInstructionFileSource(throneRoot: string): string {
  return path.join(throneRoot, "extensions", "pi", PI_INSTRUCTION_FILE_NAME);
}

export function installPiInstructionFile(agentDirectory: string, source: string): Promise<ExtensionInstallOutcome> {
  return installDeliveryExtension({
    agentDir: agentDirectory,
    source,
    linkName: PI_INSTRUCTION_FILE_NAME,
    linkFolder: ".",
    findExecutable: async () => "piy",
  });
}
