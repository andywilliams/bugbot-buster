import { execSync } from 'child_process';
import type { PRComment, PRInfo } from './types.js';

/**
 * Parse PR identifier (owner/repo#123 or just #123 if in repo)
 */
export function parsePR(pr: string): PRInfo {
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

  // Get branch info
  const prData = JSON.parse(
    execSync(`gh pr view ${number} --json headRefName,baseRefName`, {
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
 * Clone or update the repo and checkout the PR branch
 */
export function checkoutPR(pr: PRInfo, workdir: string): void {
  execSync(`gh pr checkout ${pr.number}`, {
    cwd: workdir,
    stdio: 'inherit',
  });
}

/**
 * Commit and push changes
 */
export function commitAndPush(message: string, workdir: string): string | null {
  try {
    // Check if there are changes
    const status = execSync('git status --porcelain', {
      cwd: workdir,
      encoding: 'utf-8',
    });

    if (!status.trim()) {
      return null; // No changes
    }

    execSync('git add -A', { cwd: workdir });
    execSync(`git commit -m "${message}"`, { cwd: workdir });
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
