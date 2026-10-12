export const PULL_REQUEST_VIEW_FIELDS = "number,url,title,body,state,isDraft,headRefName,baseRefName";
export const PULL_REQUEST_STATUS_FIELDS = "number,url,state,isDraft,headRefName,baseRefName,headRefOid,mergedAt,mergeCommit";
export const OPEN_PULL_REQUEST_LIST_FIELDS = "number,title,headRefName,url,files";
export const DEFAULT_OPEN_PULL_REQUEST_LIMIT = 30;
export const PULL_REQUEST_STATE = { open: "OPEN", closed: "CLOSED", merged: "MERGED" } as const;

export interface PullRequestView {
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly body: string;
  readonly state: string;
  readonly isDraft: boolean;
  readonly headRefName: string;
  readonly baseRefName: string;
}

export interface OpenPullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly headRefName: string;
  readonly url: string;
  readonly files: ReadonlyArray<{ readonly path: string }>;
}

export interface NewPullRequest {
  readonly title: string;
  readonly body: string;
  readonly base: string;
  readonly head: string;
  readonly draft: boolean;
  readonly githubUrl?: string;
}

export interface AttachedFile {
  readonly url: string;
  readonly markdown: string;
}

export interface DetachedFile {
  readonly detached: boolean;
}
