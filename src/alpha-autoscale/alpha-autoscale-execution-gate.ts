import { AsyncSerialGate } from "../transport/manual-trigger-route.ts";

/**
 * Serializes every in-process invocation of the alpha-autoscale sweep --
 * both `AlphaAutoscaleHostedWorker.runOnce()`'s scheduled cron ticks AND the
 * REST route's manual triggers -- so a manual poke can never execute
 * concurrently with the cron tick of the same command inside the same
 * `throne-backend` process. Unlike `keep-going` (whose sweep is a separate
 * exported `run()` function both the hosted worker and its route import),
 * alpha-autoscale's entire sweep body lives inside `runOnce()` itself, so
 * neither the hosted-worker file (which wraps its own `runOnce()` body in
 * this gate) nor the route file (which needs both this gate and the
 * hosted-worker class) can hold the instance without importing the other --
 * this file imports from neither, breaking that cycle. One gate instance,
 * shared by both call sites; a second instance would defeat the point.
 */
export const alphaAutoscaleExecutionGate = new AsyncSerialGate();
