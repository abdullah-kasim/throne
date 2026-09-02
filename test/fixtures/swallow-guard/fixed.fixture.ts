import { test } from "node:test";

// Same shape as leaking.fixture.ts, but the stdout patch is restored before
// the test yields control (no await while the patch is live), so it never
// overlaps a concurrently-running sibling's reporter output.
test("patches and restores stdout without holding it across an await", () => {
  const original = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stdout.write = original;
});

test("sibling one", async () => {
  await new Promise((resolve) => setTimeout(resolve, 10));
});

test("sibling two", async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
});
