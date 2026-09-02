// Requirement: a manual alpha-autoscale trigger runs the sweep and is
// registered on the backend's route dispatcher. Proves the dispatcher's own
// production route table, not the handler's own sweep logic (owned by
// alpha-autoscale-route.test.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildProductionRouteHandlers,
  SELF_TEST_ECHO_CWD_ROUTE_PATH,
} from "./transport-route-dispatcher.ts";
import { MESSAGE_STATUS_ROUTE_PATH } from "../message-status/message-status.ts";
import { KEEP_GOING_ROUTE_PATH } from "../keep-going/keep-going-route.ts";
import { NO_IDLING_ROUTE_PATH } from "../no-idling/no-idling.command.ts";
import { ALPHA_AUTOSCALE_ROUTE_PATH, handleAlphaAutoscaleRoute } from "../alpha-autoscale/alpha-autoscale-route.ts";

test("alpha-autoscale is registered on the production route dispatcher alongside message-status, keep-going, and no-idling", () => {
  const handlers = buildProductionRouteHandlers();

  assert.equal(handlers[ALPHA_AUTOSCALE_ROUTE_PATH], handleAlphaAutoscaleRoute);
  assert.ok(handlers[SELF_TEST_ECHO_CWD_ROUTE_PATH]);
  assert.ok(handlers[MESSAGE_STATUS_ROUTE_PATH]);
  assert.ok(handlers[KEEP_GOING_ROUTE_PATH]);
  assert.ok(handlers[NO_IDLING_ROUTE_PATH]);
});
