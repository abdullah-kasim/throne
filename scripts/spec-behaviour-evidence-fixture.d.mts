export declare const OURS_EMPTY: string;
export declare const NOT_OURS_EMPTY: string;
export declare const OURS_WITH_THRONE_SPECS: string;
export declare const NOT_OURS_OWN_SPEC_NO_MAP: string;
export declare const NOT_OURS_OWN_MAP_NO_SPEC: string;
export declare const OURS_WITH_WORKTREE: string;
export declare const LINKED_WORKTREE: string;
export declare const NOT_OURS_REPOSITORIES: readonly string[];
export declare function specFileText(options: {
  name: string;
  summary: string;
  code: readonly string[];
  searchWords?: string;
  subFeatures?: readonly string[];
  extraLines?: number;
  skipSection?: string;
}): string;
export declare function buildSpecFixture(
  scratch: string,
  writeFeatureMap: (folder: string, repositoryRoot: string) => Promise<void>,
): Promise<Record<string, string>>;
