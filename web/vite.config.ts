import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { WEB_APP_MOUNT_PATH } from "../src/web-api-contract/web-app-mount.ts";
import { webListenerAddress, webListenerPort } from "../src/web-listener/web-listener-address.ts";

const webRoot = import.meta.dirname;
const repositoryRoot = path.resolve(webRoot, "..");

export default defineConfig({
  root: webRoot,
  base: `${WEB_APP_MOUNT_PATH}/`,
  cacheDir: path.join(repositoryRoot, "node_modules", ".vite"),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@contract": path.join(repositoryRoot, "src", "web-api-contract"),
      "@": path.join(webRoot, "src"),
    },
  },
  server: {
    fs: { allow: [repositoryRoot] },
    proxy: { [`${WEB_APP_MOUNT_PATH}/api`]: webListenerAddress(webListenerPort()) },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test-setup.ts"],
  },
});
