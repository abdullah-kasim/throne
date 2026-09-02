export interface CanaryTimerState {
  wasActive: boolean;
}

export interface CanaryTimerControl {
  start(): Promise<void>;
  isActive(): Promise<boolean>;
}

/** Restore the timer's exact active/inactive state after a canary, including failures. */
export async function restoreCanaryTimer(
  state: CanaryTimerState,
  control: CanaryTimerControl,
): Promise<void> {
  const active = await control.isActive();
  if (state.wasActive && !active) await control.start();
  if (!state.wasActive && active) {
    throw new Error('canary timer restoration expected inactive state');
  }
}
