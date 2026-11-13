export type LastMessageTagState =
  | { readonly kind: 'reapable' }
  | { readonly kind: 'reapable-failed' }
  | { readonly kind: 'retired-reapable-marker' }
  | {
      readonly kind: 'blocked';
      readonly blockedBy: readonly string[];
      readonly waitsOnOwnBackgroundRun?: boolean;
    }
  | { readonly kind: 'busy'; readonly running: string }
  | { readonly kind: 'unmarked' }
  | { readonly kind: 'unreadable' };

export type ReapabilityClaimStatus =
  | 'completed'
  | 'abandoned'
  | 'task_restart_required'
  | 'fail';
