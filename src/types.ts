export interface PRComment {
  id: number;
  path: string;
  line: number | null;
  body: string;
  author: string;
  url: string;
  createdAt: string;
  isResolved: boolean;
}

export interface PRInfo {
  owner: string;
  repo: string;
  number: number;
  branch: string;
  baseBranch: string;
}

export interface BusterState {
  addressedCommentIds: number[];
  ignoredCommentIds: number[];
  lastRun: string;
  runs: RunRecord[];
}

export interface RunRecord {
  timestamp: string;
  commentsFound: number;
  commentsAddressed: number;
  commitSha?: string;
}

export type AIProvider = 'codex' | 'claude';

export interface BusterOptions {
  pr: string;
  interval: number;
  maxRuns: number;
  dryRun: boolean;
  verbose: boolean;
  provider: AIProvider;
  signCommits: boolean;
  validateComments: boolean;
  authors?: string[];
}
