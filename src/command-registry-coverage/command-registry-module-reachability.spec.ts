import assert from "node:assert/strict";
import { test } from "node:test";
import { NestCommanderApplicationModule } from "../application.module.ts";
import { COMMAND_REGISTRY } from "../shared-policy/command-registry.ts";

function providedTokens(module: unknown, seen = new Set<unknown>()): Set<unknown> {
  const tokens = new Set<unknown>();
  if (seen.has(module)) return tokens;
  seen.add(module);
  const providers = (Reflect.getMetadata("providers", module as object) ?? []) as readonly unknown[];
  for (const provider of providers) {
    tokens.add(typeof provider === "object" && provider !== null && "provide" in provider ? provider.provide : provider);
  }
  const imports = (Reflect.getMetadata("imports", module as object) ?? []) as readonly unknown[];
  for (const imported of imports) {
    for (const token of providedTokens(imported, seen)) tokens.add(token);
  }
  return tokens;
}

test("every registered command is provided by the application module so the built CLI can run it", () => {
  const tokens = providedTokens(NestCommanderApplicationModule);
  const unreachable = COMMAND_REGISTRY.filter((entry) => !tokens.has(entry.provider)).map((entry) => entry.name);
  assert.deepEqual(unreachable, []);
});
