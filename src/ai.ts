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
export function checkAuth(provider: AIProvider): { ok: boolean; message?: string } {
  try {
    if (provider === 'codex') {
      const status = execSync('codex login status 2>&1', { 
        encoding: 'utf-8',
        shell: true,
      });
      const isLoggedIn = status.toLowerCase().includes('logged in');
      return { ok: isLoggedIn, message: status.trim() };
    } else {
      // Claude Code CLI - just check if it exists
      execSync('claude --version', { encoding: 'utf-8' });
      return { ok: true };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { ok: false, message };
  }
}

/**
 * Get display name for provider
 */
export function getProviderName(provider: AIProvider): string {
  return provider === 'codex' ? 'OpenAI Codex' : 'Claude Code';
}

/**
 * Validate a comment - determine if it's actionable or should be ignored
 * Returns true if the comment is valid and should be fixed
 */
export async function validateComment(
  provider: AIProvider,
  comment: PRComment,
  workdir: string,
  verbose: boolean
): Promise<{ valid: boolean; reason: string }> {
  const prompt = `You are evaluating a code review comment to determine if it's a valid, actionable issue.

File: ${comment.path}${comment.line ? ` (line ${comment.line})` : ''}
Comment: ${comment.body}

Evaluate this comment and respond with ONLY a JSON object (no markdown, no explanation):
{"valid": true/false, "reason": "brief explanation"}

A comment is INVALID if:
- It's a false positive (the code is actually correct)
- It's about style preferences not in the project's style guide
- It's asking for changes that would break functionality
- It references code that doesn't exist or has already been fixed
- It's a duplicate of another comment
- It's nitpicking something trivial with no real impact

A comment is VALID if:
- It identifies a real bug or issue
- It points out a genuine code quality problem
- It suggests a meaningful improvement
- It catches a security or performance issue

Respond with the JSON only:`;

  if (provider === 'codex') {
    return validateWithCodex(prompt, workdir, verbose);
  } else {
    return validateWithClaude(prompt, workdir, verbose);
  }
}

async function validateWithCodex(
  prompt: string,
  workdir: string,
  verbose: boolean
): Promise<{ valid: boolean; reason: string }> {
  return new Promise((resolve) => {
    const proc = spawn('codex', ['exec', '--full-auto', prompt], {
      cwd: workdir,
      stdio: 'pipe',
    });

    let output = '';
    if (proc.stdout) {
      proc.stdout.on('data', (data) => {
        output += data.toString();
      });
    }
    if (proc.stderr) {
      proc.stderr.on('data', (data) => {
        output += data.toString();
      });
    }

    proc.on('close', () => {
      try {
        // Try to extract JSON from output
        const jsonMatch = output.match(/\{[\s\S]*"valid"[\s\S]*\}/);
        if (jsonMatch) {
          const result = JSON.parse(jsonMatch[0]);
          resolve({ valid: !!result.valid, reason: result.reason || '' });
        } else {
          if (verbose) console.log('Could not parse validation response:', output);
          resolve({ valid: true, reason: 'Could not parse response, assuming valid' });
        }
      } catch {
        if (verbose) console.log('Error parsing validation response:', output);
        resolve({ valid: true, reason: 'Parse error, assuming valid' });
      }
    });

    proc.on('error', () => {
      resolve({ valid: true, reason: 'Validation failed, assuming valid' });
    });
  });
}

async function validateWithClaude(
  prompt: string,
  workdir: string,
  verbose: boolean
): Promise<{ valid: boolean; reason: string }> {
  return new Promise((resolve) => {
    const proc = spawn('claude', ['--print', '--dangerously-skip-permissions', prompt], {
      cwd: workdir,
      stdio: 'pipe',
    });

    let output = '';
    if (proc.stdout) {
      proc.stdout.on('data', (data) => {
        output += data.toString();
      });
    }
    if (proc.stderr) {
      proc.stderr.on('data', (data) => {
        output += data.toString();
      });
    }

    proc.on('close', () => {
      try {
        // Try to extract JSON from output
        const jsonMatch = output.match(/\{[\s\S]*"valid"[\s\S]*\}/);
        if (jsonMatch) {
          const result = JSON.parse(jsonMatch[0]);
          resolve({ valid: !!result.valid, reason: result.reason || '' });
        } else {
          if (verbose) console.log('Could not parse validation response:', output);
          resolve({ valid: true, reason: 'Could not parse response, assuming valid' });
        }
      } catch {
        if (verbose) console.log('Error parsing validation response:', output);
        resolve({ valid: true, reason: 'Parse error, assuming valid' });
      }
    });

    proc.on('error', () => {
      resolve({ valid: true, reason: 'Validation failed, assuming valid' });
    });
  });
}
