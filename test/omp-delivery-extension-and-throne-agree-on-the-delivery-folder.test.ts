import { test } from "node:test";
import assert from "node:assert/strict";

import { ompDeliveryDirectory } from "../src/herdr/omp-delivery-client.ts";

const extension = await import("../extensions/omp/throne-omp-delivery.ts");

const HOME = "/home/example";

test("the omp delivery extension and the throne agree on the delivery folder under THRONE_DATA_HOME", () => {
  const environment = { THRONE_DATA_HOME: "/srv/throne-home" };
  assert.equal(extension.deliveryDirectory(environment, HOME), "/srv/throne-home/data/.runtime/omp-delivery");
  assert.equal(extension.deliveryDirectory(environment, HOME), ompDeliveryDirectory(environment, HOME));
});

test("the omp delivery extension and the throne agree on the delivery folder without any override", () => {
  assert.equal(extension.deliveryDirectory({}, HOME), ompDeliveryDirectory({}, HOME));
});

test("the omp delivery extension and the throne agree on an explicit delivery folder", () => {
  const environment = { THRONE_DATA_HOME: "/srv/throne-home", THRONE_OMP_DELIVERY_DIR: "/srv/omp-requests" };
  assert.equal(extension.deliveryDirectory(environment, HOME), "/srv/omp-requests");
  assert.equal(extension.deliveryDirectory(environment, HOME), ompDeliveryDirectory(environment, HOME));
});
