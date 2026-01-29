import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { BusterState, RunRecord } from './types.js';

const STATE_FILE = '.bugbot-state.json';

/**
 * Load state from file
 */
export function loadState(workdir: string): BusterState {
  const statePath = join(workdir, STATE_FILE);

  if (!existsSync(statePath)) {
    return {
      addressedCommentIds: [],
      lastRun: '',
      runs: [],
    };
  }

  try {
    const content = readFileSync(statePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return {
      addressedCommentIds: [],
      lastRun: '',
      runs: [],
    };
  }
}

/**
 * Save state to file
 */
export function saveState(workdir: string, state: BusterState): void {
  const statePath = join(workdir, STATE_FILE);
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
 * Filter out already-addressed comments
 */
export function filterUnaddressed<T extends { id: number }>(
  comments: T[],
  state: BusterState
): T[] {
  return comments.filter(
    (c) => !state.addressedCommentIds.includes(c.id)
  );
}
