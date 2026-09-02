import { OMNI_HARNESS_NAMES } from './omni-harness.ts';

export function omniLauncherForHarness(harness: string): string | undefined {
  if (harness === OMNI_HARNESS_NAMES.CLAUDEY_ALL_OMNI) {
    return 'claudey-all-omni';
  }
  if (harness === OMNI_HARNESS_NAMES.CODEXY_ALL_OMNI) {
    return 'codexy-all-omni';
  }
  return undefined;
}
