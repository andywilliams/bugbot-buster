import { execSync } from 'child_process';
import type { PRComment, PRInfo, CommitInfo } from './types.js';

/**
 * Parse PR identifier (owner/repo#123 or just #123 if in repo).
 * Also accepts "current" or "." to use the PR for the current branch (via gh pr view).
 */
export function parsePR(pr: string): PRInfo {
  if (pr === 'current' || pr === '.') {
    try {
      pr = '#' + execSync('gh pr view --json number -q .number', { encoding: 'utf-8' }).trim();
    } catch {
      throw new Error('Invalid PR format: current. Use owner/repo#123 or #123');
    }
  }

  const match = pr.match(/^(?:([^/]+)\/([^#]+))?#?(\d+)$/);
  if (!match) {
    throw new Error(`Invalid PR format: ${pr}. Use owner/repo#123 or #123`);
  }

  let owner = match[1];
  let repo = match[2];
  const number = parseInt(match[3], 10);

  // If no owner/repo provided, get from current directory
  if (!owner || !repo) {
    const remote = execSync('gh repo view --json nameWithOwner -q .nameWithOwner', {
      encoding: 'utf-8',
    }).trim();
    [owner, repo] = remote.split('/');
  }

  // Get branch info (specify repo explicitly)
  const prData = JSON.parse(
    execSync(`gh pr view ${number} --repo ${owner}/${repo} --json headRefName,baseRefName`, {
      encoding: 'utf-8',
    })
  );

  return {
    owner,
    repo,
    number,
    branch: prData.headRefName,
    baseBranch: prData.baseRefName,
  };
}

/**
 * Fetch review comments on a PR
 */
export function fetchPRComments(pr: PRInfo): PRComment[] {
  const query = `
    query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: 100) {
            nodes {
              id
              isResolved
              comments(first: 10) {
                nodes {
                  id
                  databaseId
                  path
                  line
                  body
                  author { login }
                  url
                  createdAt
                }
              }
            }
          }
        }
      }
    }
  `;

  const result = JSON.parse(
    execSync(
      `gh api graphql -f query='${query}' -F owner='${pr.owner}' -F repo='${pr.repo}' -F number=${pr.number}`,
      { encoding: 'utf-8' }
    )
  );

  const threads = result.data.repository.pullRequest.reviewThreads.nodes;
  const comments: PRComment[] = [];

  for (const thread of threads) {
    // Get the first comment (the original review comment)
    const comment = thread.comments.nodes[0];
    if (comment) {
      comments.push({
        id: comment.databaseId,
        threadId: thread.id,
        path: comment.path,
        line: comment.line,
        body: comment.body,
        author: comment.author?.login ?? 'unknown',
        url: comment.url,
        createdAt: comment.createdAt,
        isResolved: thread.isResolved,
      });
    }
  }

  return comments;
}

/**
 * Wait for Cursor Bugbot to finish reviewing the PR.
 * Polls every `pollInterval` ms until the check is completed or timeout is reached.
 * Returns true if Bugbot finished, false if timed out.
 */
export async function waitForBugbotReview(
  pr: PRInfo,
  opts: { timeoutMs?: number; pollIntervalMs?: number; verbose?: boolean } = {}
): Promise<boolean> {
  const { timeoutMs = 10 * 60 * 1000, pollIntervalMs = 30_000, verbose = false } = opts;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const result = JSON.parse(
        execSync(
          `gh pr checks ${pr.number} --repo ${pr.owner}/${pr.repo} --json name,state,completedAt 2>/dev/null || echo "[]"`,
          { encoding: 'utf-8' }
        )
      );

      const bugbot = result.find?.((c: { name: string }) =>
        c.name.toLowerCase().includes('bugbot') || c.name.toLowerCase().includes('cursor')
      );

      if (!bugbot) {
        if (verbose) console.log('  No Bugbot check found yet, waiting...');
      } else if (bugbot.state === 'SUCCESS' || bugbot.state === 'NEUTRAL' || bugbot.state === 'FAILURE') {
        if (verbose) console.log(`  Bugbot review completed (${bugbot.state})`);
        return true;
      } else {
        if (verbose) console.log(`  Bugbot status: ${bugbot.state}, waiting...`);
      }
    } catch {
      if (verbose) console.log('  Failed to check Bugbot status, retrying...');
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  console.log('  ⚠️ Timed out waiting for Bugbot review');
  return false;
}

/**
 * Clone or update the repo and checkout the PR branch
 */
export function checkoutPR(pr: PRInfo, workdir: string): void {
  execSync(`gh pr checkout ${pr.number} --repo ${pr.owner}/${pr.repo}`, {
    cwd: workdir,
    stdio: 'inherit',
  });
}

/**
 * Fetch commits on a PR
 */
export function fetchPRCommits(pr: PRInfo): CommitInfo[] {
  const result = JSON.parse(
    execSync(
      `gh pr view ${pr.number} --repo ${pr.owner}/${pr.repo} --json commits`,
      { encoding: 'utf-8' }
    )
  );

  return (result.commits ?? []).map((c: { oid: string; messageHeadline: string; committedDate: string }) => ({
    sha: c.oid,
    message: c.messageHeadline,
    date: c.committedDate,
  }));
}

/**
 * Reply to a review thread using GraphQL
 */
export function replyToThread(pr: PRInfo, threadId: string, body: string): void {
  const mutation = `
    mutation($threadId: ID!, $body: String!) {
      addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
        comment { id }
      }
    }
  `;

  execSync(
    `gh api graphql -f query='${mutation}' -F threadId='${threadId}' -F body='${body.replace(/'/g, "'\\''")}'`,
    { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
  );
}

/**
 * Resolve a review thread using GraphQL
 */
export function resolveThread(threadId: string): void {
  const mutation = `
    mutation($threadId: ID!) {
      resolveReviewThread(input: { threadId: $threadId }) {
        thread { isResolved }
      }
    }
  `;

  execSync(
    `gh api graphql -f query='${mutation}' -F threadId='${threadId}'`,
    { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
  );
}

/**
 * Commit and push changes
 * @param sign - If true, sign the commit with GPG (-S flag)
 */
export function commitAndPush(message: string, workdir: string, sign = false): string | null {
  try {
    // Check if there are changes
    const status = execSync('git status --porcelain', {
      cwd: workdir,
      encoding: 'utf-8',
    });

    if (!status.trim()) {
      return null; // No changes
    }

    const signFlag = sign ? '-S ' : '';
    execSync('git add -A', { cwd: workdir });
    execSync(`git commit --no-verify ${signFlag}-m "${message}"`, { cwd: workdir });
    execSync('git push', { cwd: workdir });

    const sha = execSync('git rev-parse HEAD', {
      cwd: workdir,
      encoding: 'utf-8',
    }).trim();

    return sha;
  } catch (error) {
    console.error('Failed to commit and push:', error);
    return null;
  }
}
