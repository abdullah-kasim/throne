import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  disableThrone,
  enableThrone,
  type ThroneLifecycleDeps,
  type ThroneLifecycleResult,
} from './throne-lifecycle.ts';
import {
  REAL_THRONE_LIFECYCLE_DEPS,
  THRONE_LIFECYCLE_DEPENDENCIES,
} from './throne-lifecycle.dependencies.ts';

let productionDependencies: ThroneLifecycleDeps | undefined;

export function configureThroneLifecycleDependencies(
  dependencies: ThroneLifecycleDeps,
): void {
  productionDependencies = dependencies;
}

/** Injectable owner for pause/resume effects and their aggregate result. */
@Injectable()
export class ThroneLifecycleService {
  constructor(
    @Optional()
    @Inject(THRONE_LIFECYCLE_DEPENDENCIES)
    private readonly injectedDependencies?: ThroneLifecycleDeps,
  ) {}

  /**
   * Real effects unless an override is supplied: the throne must never be
   * unpausable because a bootstrap seam forgot to configure this domain.
   */
  private dependencies(): ThroneLifecycleDeps {
    return (
      productionDependencies ??
      this.injectedDependencies ??
      REAL_THRONE_LIFECYCLE_DEPS
    );
  }

  disable(): Promise<ThroneLifecycleResult> {
    return disableThrone(this.dependencies());
  }

  enable(): Promise<ThroneLifecycleResult> {
    return enableThrone(this.dependencies());
  }
}

