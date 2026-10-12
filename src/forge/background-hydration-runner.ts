import { hydrateDependencies } from "../git-lifecycle/dependency-hydration.ts";
import { messageOf } from "./forge-refusal.ts";

const [sourceCheckout, worktree] = process.argv.slice(2);

try {
  const result = await hydrateDependencies(sourceCheckout, worktree);
  process.stdout.write(`dependency hydration finished (${result.mode}): ${result.paths.join(", ") || "nothing to hydrate"}\n`);
} catch (error) {
  process.stderr.write(`dependency hydration failed: ${messageOf(error)}\n`);
  process.exitCode = 1;
}
