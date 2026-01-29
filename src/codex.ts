import { execSync, spawn } from 'child_process';
import type { PRComment } from './types.js';

/**
 * Build a prompt from comments grouped by file
 */
export function buildPrompt(comments: PRComment[]): string {
  // Group comments by file
  const byFile = new Map<string, PRComment[]>();
  for (const comment of comments) {
    const existing = byFile.get(comment.path) ?? [];
    existing.push(comment);
    byFile.set(comment.path, existing);
  }

  let prompt = 'Fix the following code review comments:\n\n';

  for (const [file, fileComments] of byFile) {
    prompt += `## ${file}\n\n`;
    for (const comment of fileComments) {
      const lineInfo = comment.line ? ` (line ${comment.line})` : '';
      prompt += `- ${comment.body}${lineInfo}\n`;
    }
    prompt += '\n';
  }

  prompt += `
After fixing all issues:
1. Make sure the code compiles/lints
2. Run any relevant tests if they exist
3. Keep changes minimal and focused on the review comments
`;

  return prompt;
}

/**
 * Run Codex CLI to fix issues
 */
export async function runCodex(
  prompt: string,
  workdir: string,
  verbose: boolean
): Promise<boolean> {
  return new Promise((resolve) => {
    const args = ['exec', '--full-auto', prompt];

    if (verbose) {
      console.log('Running Codex with prompt:', prompt.slice(0, 200) + '...');
    }

    const codex = spawn('codex', args, {
      cwd: workdir,
      stdio: verbose ? 'inherit' : 'pipe',
    });

    let output = '';

    if (!verbose && codex.stdout) {
      codex.stdout.on('data', (data) => {
        output += data.toString();
      });
    }

    if (!verbose && codex.stderr) {
      codex.stderr.on('data', (data) => {
        output += data.toString();
      });
    }

    codex.on('close', (code) => {
      if (code === 0) {
        resolve(true);
      } else {
        if (!verbose) {
          console.error('Codex failed:', output);
        }
        resolve(false);
      }
    });

    codex.on('error', (error) => {
      console.error('Failed to run Codex:', error);
      resolve(false);
    });
  });
}

/**
 * Check if Codex CLI is available and logged in
 */
export function checkCodexAuth(): boolean {
  try {
    const status = execSync('codex login status', { encoding: 'utf-8' });
    return status.includes('Logged in');
  } catch {
    return false;
  }
}
