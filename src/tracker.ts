import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { BusterState, RunRecord, PRInfo } from './types.js';

const STATE_DIR = join(homedir(), '.bugbot-buster');

/**
 * Get the state file path for a specific repo and PR
 * ~/.bugbot-buster/{owner}/{repo}/pr-{number}.json
 */
function getStatePath(prInfo: PRInfo): string {
  return join(STATE_DIR, prInfo.owner, prInfo.repo, `pr-${prInfo.number}.json`);
}

/**
 * Load state from file
 */
export function loadState(_workdir: string, prInfo?: PRInfo): BusterState {
  const empty: BusterState = {
    addressedCommentIds: [],
    ignoredCommentIds: [],
    lastRun: '',
    runs: [],
  };

  if (!prInfo) return empty;

  const statePath = getStatePath(prInfo);

  if (!existsSync(statePath)) {
    return empty;
  }

  try {
    const content = readFileSync(statePath, 'utf-8');
    const state = JSON.parse(content);
    // Ensure ignoredCommentIds exists for backward compatibility
    return {
      ...state,
      ignoredCommentIds: state.ignoredCommentIds || [],
    };
  } catch {
    return empty;
  }
}

/**
 * Save state to file
 */
export function saveState(_workdir: string, state: BusterState, prInfo?: PRInfo): void {
  if (!prInfo) return;

  const statePath = getStatePath(prInfo);
  const dir = join(STATE_DIR, prInfo.owner, prInfo.repo);
  mkdirSync(dir, { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

/**
 * Mark comments as addressed
 */
export function markAddressed(
  state: BusterState,
  commentIds: number[]
): BusterState {
  const newIds = commentIds.filter(
    (id) => !state.addressedCommentIds.includes(id)
  );

  return {
    ...state,
    addressedCommentIds: [...state.addressedCommentIds, ...newIds],
  };
}

/**
 * Add a run record
 */
export function addRunRecord(
  state: BusterState,
  record: Omit<RunRecord, 'timestamp'>
): BusterState {
  return {
    ...state,
    lastRun: new Date().toISOString(),
    runs: [
      ...state.runs,
      {
        ...record,
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

/**
 * Mark comments as ignored (invalid/not-actionable)
 */
export function markIgnored(
  state: BusterState,
  commentIds: number[]
): BusterState {
  const newIds = commentIds.filter(
    (id) => !state.ignoredCommentIds.includes(id)
  );

  return {
    ...state,
    ignoredCommentIds: [...state.ignoredCommentIds, ...newIds],
  };
}

/**
 * Filter out already-addressed and ignored comments
 */
export function filterUnaddressed<T extends { id: number }>(
  comments: T[],
  state: BusterState
): T[] {
  return comments.filter(
    (c) => !state.addressedCommentIds.includes(c.id) && 
           !state.ignoredCommentIds.includes(c.id)
  );
}
