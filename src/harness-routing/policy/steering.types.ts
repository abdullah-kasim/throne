import type { Harness } from '../harness.ts';
import type { ModelPair, ModelPairPool } from '../../config.ts';
import type { HarnessUsage } from './usage.ts';

export interface SteerBypass {
  readonly model: boolean;
  readonly effort: boolean;
  readonly zeroQuota: boolean;
  readonly usage: boolean;
}

export interface SteerInput {
  role: 'alpha' | 'shadow';
  isValidateGate: boolean;
  requested: ModelPair;
  requestedEffort?: number;
  supervisorPair?: ModelPair;
  usage?: {
    claude: HarnessUsage;
    codex: HarnessUsage;
    opencode?: HarnessUsage;
  };
  bypass: SteerBypass;
  allowedPairs: ModelPairPool;
  targetEffort?: number;
}

export type SteerRefusal = {
  kind: 'refuse';
  steer: 'model' | 'usage' | 'effort';
  message: string;
};

export type SteerResult =
  | {
      kind: 'launch';
      harness: Harness;
      model: string;
      effort: number;
      note: string;
      durableRoutingNote?: true;
      desperation?: true;
      effortOverrideNote?: string;
    }
  | SteerRefusal;
