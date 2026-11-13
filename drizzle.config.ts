import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/where-i-stand-store/where-i-stand.schema.ts",
  out: "./drizzle",
});
