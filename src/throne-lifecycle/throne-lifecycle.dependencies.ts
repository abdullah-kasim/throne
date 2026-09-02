import { REAL_SERVICE_UNIT_DEPS } from "../install-services/service-unit-renderer.service.ts";
import type { ThroneLifecycleDeps } from "./throne-lifecycle.ts";

/** Injection token so tests can provide fakes without real systemd. */
export const THRONE_LIFECYCLE_DEPENDENCIES = Symbol(
  "THRONE_LIFECYCLE_DEPENDENCIES",
);

/**
 * Production effects for pause/resume. Registered in the application module so
 * `enable-throne`/`disable-throne` are wired without a bootstrap-time setter:
 * an unwired setter left both commands dead once src/exec.ts was retired.
 *
 * Systemd is the only effect. These commands message no one — see the contract
 * comment in `throne-lifecycle.ts`.
 */
export const REAL_THRONE_LIFECYCLE_DEPS: ThroneLifecycleDeps = {
  systemctl: REAL_SERVICE_UNIT_DEPS.systemctl,
};
