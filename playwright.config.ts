import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

const port = Number(process.env.WHERE_I_STAND_E2E_PORT || 18490);
const scratch = process.env.WHERE_I_STAND_E2E_HOME || mkdtempSync(path.join(os.tmpdir(), "where-i-stand-e2e-"));
process.env.WHERE_I_STAND_E2E_HOME = scratch;
process.env.WHERE_I_STAND_E2E_PORT = String(port);

export default defineConfig({
  testDir: "test/e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 10_000,
  workers: 1,
  reporter: "list",
  use: { baseURL: `http://127.0.0.1:${port}` },
  webServer: {
    command: [
      "bun scripts/where-i-stand-evidence/serve-product.ts",
      `--port ${port}`,
      `--data-home ${path.join(scratch, "throne-home")}`,
      `--cache-home ${path.join(scratch, "cache")}`,
      "--web-root dist/web",
    ].join(" "),
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
