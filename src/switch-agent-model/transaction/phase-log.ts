import type {
  SwitchPhase,
  SwitchPhaseEvent,
} from './transaction.types.ts';

export class PhaseLog {
  readonly events: SwitchPhaseEvent[] = [];

  ok(phase: SwitchPhase, detail?: string): void {
    this.events.push(detail === undefined ? { phase, status: 'ok' } : { phase, status: 'ok', detail });
  }

  failed(phase: SwitchPhase, detail: string): void {
    this.events.push({ phase, status: 'failed', detail });
  }
}
