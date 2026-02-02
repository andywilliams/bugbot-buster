import { execSync, spawn } from 'child_process';
import chalk from 'chalk';
import type { PRComment, AIProvider, ResolveResult, CommitInfo } from './types.js';

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
  verbose: boolean,
  stream: boolean = false
): Promise<boolean> {
  if (provider === 'codex') {
    return runCodex(prompt, workdir, verbose, stream);
  } else {
    return runClaude(prompt, workdir, verbose, stream);
  }
}

/**
 * Run Codex CLI
 */
async function runCodex(
  prompt: string,
  workdir: string,
  verbose: boolean,
  stream: boolean = false
): Promise<boolean> {
  return new Promise((resolve) => {
    const args = ['exec', '--full-auto', prompt];

    if (verbose) {
      console.log('Running Codex with prompt:', prompt.slice(0, 200) + '...');
    }

    const useInherit = verbose || stream;
    const proc = spawn('codex', args, {
      cwd: workdir,
      stdio: useInherit ? 'inherit' : 'pipe',
    });

    let output = '';

    if (!useInherit && proc.stdout) {
      proc.stdout.on('data', (data) => {
        output += data.toString();
      });
    }

    if (!useInherit && proc.stderr) {
      proc.stderr.on('data', (data) => {
        output += data.toString();
      });
    }

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(true);
      } else {
        if (!useInherit) {
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
/**
 * Extract text content from Claude stream-json output.
 * Parses JSON lines and concatenates text_delta values.
 */
function extractTextFromStreamJson(raw: string): string {
  let text = '';
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const delta = event?.event?.delta?.text;
      if (delta) text += delta;
      const content = event?.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.text) text += block.text;
        }
      }
    } catch {
      // Not a JSON line — plain text (codex output)
      text += line + '\n';
    }
  }
  return text;
}

/**
 * Parse and stream text deltas from a chunk of stream-json output
 */
function streamJsonChunk(chunk: string): void {
  for (const line of chunk.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const text = event?.event?.delta?.text;
      if (text) process.stdout.write(text);
    } catch { /* skip non-JSON lines */ }
  }
}

async function runClaude(
  prompt: string,
  workdir: string,
  verbose: boolean,
  stream: boolean = false
): Promise<boolean> {
  return new Promise((resolve) => {
    const args = [
      '--print',
      ...(stream ? ['--output-format', 'stream-json'] : []),
      '--dangerously-skip-permissions',
      prompt,
    ];

    if (verbose) {
      console.log('Running Claude with prompt:', prompt.slice(0, 200) + '...');
    }

    const useInherit = verbose && !stream;
    const proc = spawn('claude', args, {
      cwd: workdir,
      stdio: useInherit ? 'inherit' : 'pipe',
    });

    let output = '';

    if (!useInherit && proc.stdout) {
      proc.stdout.on('data', (data) => {
        const chunk = data.toString();
        output += chunk;
        if (stream) streamJsonChunk(chunk);
      });
    }

    if (!useInherit && proc.stderr) {
      proc.stderr.on('data', (data) => {
        output += data.toString();
      });
    }

    proc.on('close', (code) => {
      if (stream) process.stdout.write('\n');
      if (code === 0) {
        resolve(true);
      } else {
        if (!useInherit && !stream) {
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
  verbose: boolean,
  stream: boolean = false
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

  return runValidation(provider, prompt, workdir, verbose, stream);
}

async function runValidation(
  provider: AIProvider,
  prompt: string,
  workdir: string,
  verbose: boolean,
  stream: boolean = false
): Promise<{ valid: boolean; reason: string }> {
  const isStreamClaude = stream && provider === 'claude';
  const cmd = provider === 'codex'
    ? { bin: 'codex', args: ['exec', '--full-auto', prompt] }
    : { bin: 'claude', args: [
        '--print',
        ...(isStreamClaude ? ['--output-format', 'stream-json'] : []),
        '--dangerously-skip-permissions',
        prompt,
      ] };

  return new Promise((resolve) => {
    const proc = spawn(cmd.bin, cmd.args, {
      cwd: workdir,
      stdio: 'pipe',
    });

    let output = '';
    if (proc.stdout) {
      proc.stdout.on('data', (data) => {
        const chunk = data.toString();
        output += chunk;
        if (stream) {
          if (isStreamClaude) streamJsonChunk(chunk);
          else process.stdout.write(chunk);
        }
      });
    }
    if (proc.stderr) {
      proc.stderr.on('data', (data) => {
        output += data.toString();
      });
    }

    proc.on('close', () => {
      if (stream) process.stdout.write('\n');
      const textOutput = isStreamClaude ? extractTextFromStreamJson(output) : output;

      if (verbose && !stream && textOutput.trim()) {
        console.log(chalk.dim('--- AI output ---'));
        console.log(textOutput.trim());
        console.log(chalk.dim('--- end ---'));
      }
      try {
        const jsonMatch = textOutput.match(/\{[\s\S]*"valid"[\s\S]*\}/);
        if (jsonMatch) {
          const result = JSON.parse(jsonMatch[0]);
          resolve({ valid: !!result.valid, reason: result.reason || '' });
        } else {
          if (verbose) console.log('Could not parse validation response:', textOutput);
          resolve({ valid: true, reason: 'Could not parse response, assuming valid' });
        }
      } catch {
        if (verbose) console.log('Error parsing validation response:', textOutput);
        resolve({ valid: true, reason: 'Parse error, assuming valid' });
      }
    });

    proc.on('error', () => {
      resolve({ valid: true, reason: 'Validation failed, assuming valid' });
    });
  });
}

/**
 * Check if a review comment has already been addressed in recent commits.
 * Returns whether it was addressed, which commit likely fixed it, and an explanation.
 */
export async function checkIfAddressed(
  provider: AIProvider,
  comment: PRComment,
  currentFileContent: string,
  recentCommits: { sha: string; message: string; diff: string }[],
  workdir: string,
  verbose: boolean,
  stream: boolean = false
): Promise<ResolveResult> {
  const lineContext = comment.line
    ? (() => {
        const lines = currentFileContent.split('\n');
        const start = Math.max(0, comment.line - 10);
        const end = Math.min(lines.length, comment.line + 10);
        return lines
          .slice(start, end)
          .map((l, i) => {
            const lineNum = start + i + 1;
            const marker = lineNum === comment.line ? ' >>>' : '    ';
            return `${marker}${lineNum}: ${l}`;
          })
          .join('\n');
      })()
    : currentFileContent.slice(0, 3000);

  const commitsContext = recentCommits
    .map(
      (c) =>
        `### Commit ${c.sha.slice(0, 7)}: ${c.message}\n\`\`\`diff\n${c.diff.slice(0, 2000)}\n\`\`\``
    )
    .join('\n\n');

  const prompt = `You are evaluating whether a code review comment has been addressed by subsequent commits.

## Review Comment
File: ${comment.path}${comment.line ? ` (line ${comment.line})` : ''}
Author: ${comment.author}
Comment: ${comment.body}

## Current File Content (around the relevant area)
\`\`\`
${lineContext}
\`\`\`

## Recent Commits That Touched This File
${commitsContext || '(No recent commits touched this file)'}

## Task
Has this review comment been addressed? Look at the comment, the current state of the file, and the commit diffs.

Respond with ONLY a JSON object (no markdown, no explanation):
{"addressed": true/false, "commitSha": "full_sha_if_addressed_or_null", "explanation": "brief description of what changed or why it's not addressed"}`;

  return runResolveCheck(provider, prompt, workdir, verbose, stream);
}

async function runResolveCheck(
  provider: AIProvider,
  prompt: string,
  workdir: string,
  verbose: boolean,
  stream: boolean = false
): Promise<ResolveResult> {
  const isStreamClaude = stream && provider === 'claude';
  const cmd = provider === 'codex'
    ? { bin: 'codex', args: ['exec', '--full-auto', prompt] }
    : { bin: 'claude', args: [
        '--print',
        ...(isStreamClaude ? ['--output-format', 'stream-json'] : []),
        '--dangerously-skip-permissions',
        prompt,
      ] };

  return new Promise((resolve) => {
    const proc = spawn(cmd.bin, cmd.args, {
      cwd: workdir,
      stdio: 'pipe',
    });

    let output = '';
    if (proc.stdout) {
      proc.stdout.on('data', (data) => {
        const chunk = data.toString();
        output += chunk;
        if (stream) {
          if (isStreamClaude) streamJsonChunk(chunk);
          else process.stdout.write(chunk);
        }
      });
    }
    if (proc.stderr) {
      proc.stderr.on('data', (data) => {
        output += data.toString();
      });
    }

    proc.on('close', () => {
      if (stream) process.stdout.write('\n');
      const textOutput = isStreamClaude ? extractTextFromStreamJson(output) : output;

      if (verbose && !stream && textOutput.trim()) {
        console.log(chalk.dim('--- AI output ---'));
        console.log(textOutput.trim());
        console.log(chalk.dim('--- end ---'));
      }
      try {
        const jsonMatch = textOutput.match(/\{[\s\S]*"addressed"[\s\S]*\}/);
        if (jsonMatch) {
          const result = JSON.parse(jsonMatch[0]);
          resolve({
            addressed: !!result.addressed,
            commitSha: result.commitSha ?? undefined,
            explanation: result.explanation || '',
          });
        } else {
          if (verbose) console.log('Could not parse resolve-check response:', textOutput);
          resolve({ addressed: false, explanation: 'Could not parse AI response' });
        }
      } catch {
        if (verbose) console.log('Error parsing resolve-check response:', textOutput);
        resolve({ addressed: false, explanation: 'Parse error in AI response' });
      }
    });

    proc.on('error', (error) => {
      if (verbose) console.error('Failed to run resolve check:', error);
      resolve({ addressed: false, explanation: 'AI provider error' });
    });
  });
}
