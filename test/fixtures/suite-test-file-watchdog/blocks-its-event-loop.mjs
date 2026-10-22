import test from "node:test";

test("never yields its event loop", () => {
  for (;;);
});
