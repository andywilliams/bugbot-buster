import { execSync, spawn } from 'child_process';
import type { PRComment, AIProvider } from './types.js';

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
 * Run AI provider to fix issues
 */
export async function runAI(
  provider: AIProvider,
  prompt: string,
  workdir: string,
  verbose: boolean
): Promise<boolean> {
  if (provider === 'codex') {
    return runCodex(prompt, workdir, verbose);
  } else {
    return runClaude(prompt, workdir, verbose);
  }
}

/**
 * Run Codex CLI
 */
async function runCodex(
  prompt: string,
  workdir: string,
  verbose: boolean
): Promise<boolean> {
  return new Promise((resolve) => {
    const args = ['exec', '--full-auto', prompt];

    if (verbose) {
      console.log('Running Codex with prompt:', prompt.slice(0, 200) + '...');
    }

    const proc = spawn('codex', args, {
      cwd: workdir,
      stdio: verbose ? 'inherit' : 'pipe',
    });

    let output = '';

    if (!verbose && proc.stdout) {
      proc.stdout.on('data', (data) => {
        output += data.toString();
      });
    }

    if (!verbose && proc.stderr) {
      proc.stderr.on('data', (data) => {
        output += data.toString();
      });
    }

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(true);
      } else {
        if (!verbose) {
          console.error('Codex failed:', output);
        }
        resolve(false);
      }
    });

    proc.on('error', (error) => {
      console.error('Failed to run Codex:', error);
      resolve(false);
    });
  });
}

/**
 * Run Claude Code CLI
 */
async function runClaude(
  prompt: string,
  workdir: string,
  verbose: boolean
): Promise<boolean> {
  return new Promise((resolve) => {
    // Claude Code CLI uses --print for non-interactive mode with --dangerously-skip-permissions
    const args = [
      '--print',
      '--dangerously-skip-permissions',
      prompt,
    ];

    if (verbose) {
      console.log('Running Claude with prompt:', prompt.slice(0, 200) + '...');
    }

    const proc = spawn('claude', args, {
      cwd: workdir,
      stdio: verbose ? 'inherit' : 'pipe',
    });

    let output = '';

    if (!verbose && proc.stdout) {
      proc.stdout.on('data', (data) => {
        output += data.toString();
      });
    }

    if (!verbose && proc.stderr) {
      proc.stderr.on('data', (data) => {
        output += data.toString();
      });
    }

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(true);
      } else {
        if (!verbose) {
          console.error('Claude failed:', output);
        }
        resolve(false);
      }
    });

    proc.on('error', (error) => {
      console.error('Failed to run Claude:', error);
      resolve(false);
    });
  });
}

/**
 * Check if the selected AI provider is available and authenticated
 */
export function checkAuth(provider: AIProvider): boolean {
  try {
    if (provider === 'codex') {
      const status = execSync('codex login status', { encoding: 'utf-8' });
      return status.includes('Logged in');
    } else {
      // Claude Code CLI - just check if it exists
      execSync('claude --version', { encoding: 'utf-8' });
      return true;
    }
  } catch {
    return false;
  }
}

/**
 * Get display name for provider
 */
export function getProviderName(provider: AIProvider): string {
  return provider === 'codex' ? 'OpenAI Codex' : 'Claude Code';
}
