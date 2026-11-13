import type { AddressInfo } from "node:net";
import path from "node:path";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { startWebListener } from "./web-listener-app.ts";

export async function startScratchListener(scratch: string): Promise<{ listener: NestExpressApplication; address: string }> {
  const listener = await startWebListener({ port: 0, webRoot: path.join(scratch, "web") });
  const address = `http://127.0.0.1:${(listener.getHttpServer().address() as AddressInfo).port}`;
  return { listener, address };
}
