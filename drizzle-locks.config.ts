import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/shared-policy/lock-rows/lock-rows.schema.ts",
  out: "./drizzle-locks",
});
