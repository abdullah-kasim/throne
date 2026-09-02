import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { run, type ThroneStartupDeps } from './throne-startup.ts';
import { ThroneStartupReconciliationService } from './throne-startup-reconciliation.service.ts';

export const THRONE_STARTUP_DEPS = Symbol('THRONE_STARTUP_DEPS');

/** Injectable owner for the SessionStart lifecycle transaction. */
@Injectable()
export class ThroneStartupService {
  private readonly moduleRef: ModuleRef;
  private readonly reconciliation: ThroneStartupReconciliationService;

  constructor(
    @Inject(ModuleRef) moduleRef: ModuleRef,
    @Inject(ThroneStartupReconciliationService)
    reconciliation: ThroneStartupReconciliationService,
  ) {
    this.moduleRef = moduleRef;
    this.reconciliation = reconciliation;
  }

  run(
    args: string[] = [],
    deps = this.moduleRef.get<ThroneStartupDeps>(THRONE_STARTUP_DEPS, { strict: false }),
  ): Promise<number> {
    return run(args, { ...deps, reconcile: (agents) => this.reconciliation.reconcile(agents) });
  }
}
