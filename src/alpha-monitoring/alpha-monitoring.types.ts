export const ALPHA_INSPECTION_CONTEXTS = [
  'ordinary',
  'blocker',
  'completion',
  'lord-status',
  'regent-diagnostic',
] as const;

export type AlphaInspectionContext = (typeof ALPHA_INSPECTION_CONTEXTS)[number];

export interface AlphaInspectionRequest {
  readonly command: 'agent-logs' | 'agent-statuses';
  readonly target: string;
  readonly context: AlphaInspectionContext;
  readonly eventId?: string;
}

export interface AlphaInspectionCaller {
  readonly name: string;
  readonly role: string;
}

export interface TrustedInspectionEvent {
  readonly recipient: string;
  readonly context: 'blocker' | 'completion' | 'lord-status';
  readonly target: string;
  readonly deliveredAt: number;
  readonly consumedAt?: number;
}

export interface AlphaInspectionState {
  readonly ordinary: Readonly<Record<string, number>>;
  readonly trustedEvents: Readonly<Record<string, TrustedInspectionEvent>>;
}

export type AlphaInspectionDecision =
  | { readonly admitted: true; readonly state: AlphaInspectionState }
  | { readonly admitted: false; readonly diagnostic: string };

export interface AlphaInspectionAdmission {
  readonly admitted: boolean;
  readonly argv: readonly string[];
  readonly diagnostic?: string;
}
