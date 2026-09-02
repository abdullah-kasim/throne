import { test } from "node:test";

// Reproduces the swallow defect shape: this test patches process.stdout.write
// and holds the patch across an await, and the patched operation goes on to
// throw. Node's own crash diagnostics and the file's remaining sequential
// tests never make it to the reporter while the global writer is captured,
// so a file that declares 3 tests reports fewer than 3.
test("holds a stdout patch across an await and then fails", async () => {
  process.stdout.write = () => true;
  await new Promise((resolve) => setTimeout(resolve, 50));
  throw new Error("simulated failure while stdout is patched");
});

test("sibling one", async () => {
  await new Promise((resolve) => setTimeout(resolve, 10));
});

test("sibling two", async () => {
  await new Promise((resolve) => setTimeout(resolve, 10));
});
