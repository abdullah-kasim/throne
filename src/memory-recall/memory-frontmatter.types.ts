export const MEMORY_KINDS = [
  'trap',
  'ruling',
  'preference',
  'procedure',
  'fact',
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_STATUSES = ['active', 'superseded'] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const COSTS_IF_MISSED = ['low', 'high'] as const;
export type CostIfMissed = (typeof COSTS_IF_MISSED)[number];

export const GLOBAL_SCOPE = 'global';

export interface MemoryFrontmatter {
  readonly ask?: string;
  readonly scope?: string;
  readonly kind?: MemoryKind;
  readonly learned?: string;
  readonly status?: MemoryStatus;
  readonly superseded_by?: string;
  readonly cost_if_missed?: CostIfMissed;
  readonly name?: string;
  readonly description?: string;
  readonly type?: string;
}

export interface Memory {
  readonly filePath: string;
  readonly fileName: string;
  readonly frontmatter: MemoryFrontmatter;
  readonly body: string;
}
