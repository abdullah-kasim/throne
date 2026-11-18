import assert from "node:assert/strict";
import { test } from "node:test";
import { deliveryCallbackRequest } from "./delivery-callback.ts";

const validCallback = { id: "message-1", pane: "pane-1", status: "delivered", as: "turn" };

test("a delivery callback with every field is a valid callback", () => {
  assert.equal(deliveryCallbackRequest.safeParse(validCallback).success, true);
});

test("a delivery callback with an unknown status is not a valid callback", () => {
  assert.equal(deliveryCallbackRequest.safeParse({ ...validCallback, status: "busy" }).success, false);
});
