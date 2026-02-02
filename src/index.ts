#!/usr/bin/env node
import { program } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { execSync } from 'child_process';
import { parsePR, fetchPRComments, checkoutPR, commitAndPush, waitForBugbotReview, fetchPRCommits, replyToThread, resolveThread } from './github.js';
import { buildPrompt, runAI, checkAuth, getProviderName, validateComment, checkIfAddressed } from './ai.js';
import {
  loadState,
  saveState,
  markAddressed,
  markIgnored,
  addRunRecord,
  filterUnaddressed,
} from './tracker.js';
import type { BusterOptions, PRComment, AIProvider } from './types.js';

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve-addressed mode: find unresolved comments that have been addressed and resolve them
 */
async function runResolveAddressed(options: BusterOptions): Promise<void> {
  const { pr, dryRun, verbose, stream, provider, authors } = options;

  console.log(chalk.bold('\n🔍 Bugbot Buster — Resolve Addressed Mode\n'));
  console.log(chalk.dim(`Using: ${getProviderName(provider)}`));
  if (authors?.length) {
    console.log(chalk.dim(`Filtering to authors: ${authors.join(', ')}`));
  }
  if (dryRun) {
    console.log(chalk.yellow('DRY RUN — will not actually resolve threads'));
  }
  console.log('');

  // Check AI provider auth
  const authCheck = checkAuth(provider);
  if (!authCheck.ok) {
    const loginCmd = provider === 'codex' ? 'codex login' : 'claude (install from npm)';
    console.error(chalk.red(`❌ ${getProviderName(provider)} not available. Run: ${loginCmd}`));
    if (authCheck.message) {
      console.error(chalk.dim(`   ${authCheck.message}`));
    }
    process.exit(1);
  }

  // Parse PR
  const spinner = ora('Parsing PR...').start();
  let prInfo;
  try {
    prInfo = parsePR(pr);
    spinner.succeed(`PR: ${prInfo.owner}/${prInfo.repo}#${prInfo.number} (${prInfo.branch})`);
  } catch (error) {
    spinner.fail('Failed to parse PR');
    console.error(error);
    process.exit(1);
  }

  // Get working directory
  const workdir = process.cwd();

  // Checkout PR branch
  spinner.start('Checking out PR branch...');
  try {
    checkoutPR(prInfo, workdir);
    spinner.succeed(`Checked out branch: ${prInfo.branch}`);
  } catch (error) {
    spinner.fail('Failed to checkout PR');
    console.error(error);
    process.exit(1);
  }

  // Fetch comments
  spinner.start('Fetching PR comments...');
  let comments;
  try {
    comments = fetchPRComments(prInfo);
    spinner.succeed(`Found ${comments.length} total review comments`);
  } catch (error) {
    spinner.fail('Failed to fetch comments');
    console.error(error);
    process.exit(1);
  }

  // Filter to unresolved only
  let unresolved = comments.filter((c) => !c.isResolved);
  if (authors?.length) {
    unresolved = unresolved.filter((c) => authors.includes(c.author));
  }

  console.log(chalk.dim(`  Unresolved threads to check: ${unresolved.length}`));

  if (unresolved.length === 0) {
    console.log(chalk.green('\n✅ No unresolved comments to check!'));
    return;
  }

  // Fetch PR commits for context
  spinner.start('Fetching PR commits...');
  const prCommits = fetchPRCommits(prInfo);
  spinner.succeed(`Found ${prCommits.length} commits on PR`);

  let resolvedCount = 0;
  let unresolvedCount = 0;

  for (const comment of unresolved) {
    const preview = comment.body.slice(0, 60).replace(/\n/g, ' ');
    spinner.start(`Checking: ${comment.path}:${comment.line ?? '?'} — ${preview}...`);

    // Get current file content
    let currentContent: string;
    try {
      currentContent = execSync(`git show HEAD:${comment.path}`, {
        cwd: workdir,
        encoding: 'utf-8',
      });
    } catch {
      spinner.info(`File not found at HEAD: ${comment.path} — skipping`);
      unresolvedCount++;
      continue;
    }

    // Get recent commits that touched this file after the comment
    let recentCommits: { sha: string; message: string; diff: string }[] = [];
    try {
      const log = execSync(
        `git log --after="${comment.createdAt}" --format="%H %s" -- "${comment.path}"`,
        { cwd: workdir, encoding: 'utf-8' }
      ).trim();

      if (log) {
        recentCommits = log.split('\n').map((line) => {
          const spaceIdx = line.indexOf(' ');
          const sha = line.slice(0, spaceIdx);
          const message = line.slice(spaceIdx + 1);
          let diff = '';
          try {
            diff = execSync(`git show ${sha} -- "${comment.path}"`, {
              cwd: workdir,
              encoding: 'utf-8',
            });
          } catch {
            // diff might fail, that's ok
          }
          return { sha, message, diff };
        });
      }
    } catch {
      // git log might fail, continue with empty commits
    }

    // Ask AI — stop spinner if streaming so output can flow through
    if (stream) {
      spinner.stop();
      console.log(chalk.cyan(`\n🤖 Checking: ${comment.path}:${comment.line ?? '?'}\n`));
    }
    const result = await checkIfAddressed(
      provider,
      comment,
      currentContent,
      recentCommits,
      workdir,
      verbose,
      stream
    );
    if (stream) console.log(''); // blank line after AI output

    if (result.addressed) {
      const shortSha = result.commitSha ? result.commitSha.slice(0, 7) : '?';
      const replyBody = result.commitSha
        ? `✅ This appears to have been addressed in commit \`${shortSha}\` — ${result.explanation}`
        : `✅ This appears to have been addressed — ${result.explanation}`;

      if (dryRun) {
        spinner.succeed(
          chalk.green(`[DRY RUN] Would resolve: ${comment.path}:${comment.line ?? '?'} — ${result.explanation}`)
        );
      } else {
        try {
          replyToThread(prInfo, comment.threadId, replyBody);
          resolveThread(comment.threadId);
          spinner.succeed(
            chalk.green(`Resolved: ${comment.path}:${comment.line ?? '?'} (${shortSha}) — ${result.explanation}`)
          );
        } catch (error) {
          spinner.fail(`Failed to resolve thread: ${comment.path}:${comment.line ?? '?'}`);
          if (verbose) console.error(error);
          unresolvedCount++;
          continue;
        }
      }
      resolvedCount++;
    } else {
      spinner.info(
        chalk.dim(`Not addressed: ${comment.path}:${comment.line ?? '?'} — ${result.explanation}`)
      );
      unresolvedCount++;
    }
  }

  // Summary
  console.log(chalk.bold('\n📊 Summary'));
  console.log(chalk.green(`  ✅ Resolved: ${resolvedCount}`));
  console.log(chalk.dim(`  ⏳ Still unresolved: ${unresolvedCount}`));
  if (dryRun && resolvedCount > 0) {
    console.log(chalk.yellow(`  (dry run — no threads were actually resolved)`));
  }
  console.log('');
}

async function run(options: BusterOptions): Promise<void> {
  const { pr, interval, maxRuns, dryRun, verbose, stream, provider, signCommits, validateComments, authors, waitForReview } = options;

  console.log(chalk.bold('\n🤖 Bugbot Buster\n'));
  console.log(chalk.dim(`Using: ${getProviderName(provider)}`));
  if (authors?.length) {
    console.log(chalk.dim(`Filtering to authors: ${authors.join(', ')}`));
  }
  console.log('');

  // Check AI provider auth
  const authCheck = checkAuth(provider);
  if (!authCheck.ok) {
    const loginCmd = provider === 'codex' ? 'codex login' : 'claude (install from npm)';
    console.error(chalk.red(`❌ ${getProviderName(provider)} not available. Run: ${loginCmd}`));
    if (authCheck.message) {
      console.error(chalk.dim(`   ${authCheck.message}`));
    }
    process.exit(1);
  }

  // Parse PR
  const spinner = ora('Parsing PR...').start();
  let prInfo;
  try {
    prInfo = parsePR(pr);
    spinner.succeed(`PR: ${prInfo.owner}/${prInfo.repo}#${prInfo.number} (${prInfo.branch})`);
  } catch (error) {
    spinner.fail('Failed to parse PR');
    console.error(error);
    process.exit(1);
  }

  // Get working directory (current dir)
  const workdir = process.cwd();

  // Checkout PR branch
  spinner.start('Checking out PR branch...');
  try {
    checkoutPR(prInfo, workdir);
    spinner.succeed(`Checked out branch: ${prInfo.branch}`);
  } catch (error) {
    spinner.fail('Failed to checkout PR');
    console.error(error);
    process.exit(1);
  }

  // Load state
  let state = loadState(workdir);
  console.log(
    chalk.dim(`Previously addressed: ${state.addressedCommentIds.length} comments, ignored: ${state.ignoredCommentIds.length}`)
  );

  // Main loop
  let runCount = 0;
  while (runCount < maxRuns) {
    runCount++;
    console.log(chalk.blue(`\n--- Run ${runCount}/${maxRuns} ---\n`));

    // Fetch comments
    spinner.start('Fetching PR comments...');
    let comments: PRComment[];
    try {
      comments = fetchPRComments(prInfo);
      spinner.succeed(`Found ${comments.length} total comments`);
    } catch (error) {
      spinner.fail('Failed to fetch comments');
      console.error(error);
      break;
    }

    // Filter unresolved and unaddressed
    const unresolved = comments.filter((c) => !c.isResolved);
    const byAuthor = authors?.length 
      ? unresolved.filter((c) => authors.includes(c.author))
      : unresolved;
    const unaddressed = filterUnaddressed(byAuthor, state);

    console.log(
      chalk.dim(
        `  Unresolved: ${unresolved.length}${authors?.length ? `, from allowed authors: ${byAuthor.length}` : ''}, New to address: ${unaddressed.length}`
      )
    );

    if (unaddressed.length === 0) {
      console.log(chalk.green('\n✅ No new comments to address!'));

      if (runCount < maxRuns) {
        console.log(chalk.dim(`Waiting ${interval} minutes before next check...`));
        await sleep(interval * 60 * 1000);
        continue;
      }
      break;
    }

    // Show comments
    console.log(chalk.yellow('\nComments to address:'));
    for (const comment of unaddressed) {
      const preview = comment.body.slice(0, 80).replace(/\n/g, ' ');
      console.log(
        chalk.dim(`  • ${comment.path}:${comment.line ?? '?'} - ${preview}...`)
      );
    }

    // Validate comments if enabled
    let toFix = unaddressed;
    const ignoredIds: number[] = [];
    
    if (validateComments) {
      console.log(chalk.cyan('\nValidating comments...'));
      const validated: PRComment[] = [];
      
      for (const comment of unaddressed) {
        if (stream) {
          spinner.stop();
          console.log(chalk.cyan(`\n🤖 Validating: ${comment.path}:${comment.line ?? '?'}\n`));
        } else {
          spinner.start(`Validating: ${comment.path}:${comment.line ?? '?'}...`);
        }
        const result = await validateComment(provider, comment, workdir, verbose, stream);
        if (stream) console.log('');
        
        if (result.valid) {
          spinner.succeed(chalk.green(`Valid: ${result.reason}`));
          validated.push(comment);
        } else {
          spinner.warn(chalk.yellow(`Ignored: ${result.reason}`));
          ignoredIds.push(comment.id);
        }
      }
      
      toFix = validated;
      
      // Save ignored comments
      if (ignoredIds.length > 0) {
        state = markIgnored(state, ignoredIds);
        saveState(workdir, state);
        console.log(chalk.dim(`\nMarked ${ignoredIds.length} comments as ignored`));
      }
      
      if (toFix.length === 0) {
        console.log(chalk.green('\n✅ All comments were invalid/ignored!'));
        continue;
      }
      
      console.log(chalk.dim(`\n${toFix.length} valid comments to fix`));
    }

    if (dryRun) {
      console.log(chalk.yellow('\n[DRY RUN] Would run Codex to fix these issues'));
      // Don't save state in dry run - just exit
      break;
    }

    // Run AI to fix issues
    const prompt = buildPrompt(toFix);
    if (stream) {
      spinner.stop();
      console.log(chalk.cyan(`\n🤖 Running ${getProviderName(provider)} to fix issues...\n`));
    } else {
      spinner.start(`Running ${getProviderName(provider)} to fix issues...`);
    }
    const success = await runAI(provider, prompt, workdir, verbose, stream);
    if (stream) console.log('');

    if (!success) {
      spinner.fail(`${getProviderName(provider)} failed to fix issues`);
      break;
    }
    spinner.succeed(`${getProviderName(provider)} completed`);

    // Commit and push
    spinner.start(`Committing${signCommits ? ' (signed)' : ''} and pushing...`);
    const sha = commitAndPush(
      `fix: address ${unaddressed.length} review comment(s)`,
      workdir,
      signCommits
    );

    if (sha) {
      spinner.succeed(`Pushed: ${sha.slice(0, 7)}`);
    } else {
      spinner.info('No changes to commit');
    }

    // Update state
    state = markAddressed(state, toFix.map((c) => c.id));
    state = addRunRecord(state, {
      commentsFound: unaddressed.length,
      commentsAddressed: toFix.length,
      commitSha: sha ?? undefined,
    });
    saveState(workdir, state);

    // Wait before next run
    if (runCount < maxRuns) {
      if (waitForReview && sha) {
        console.log(chalk.dim('\nWaiting for Bugbot to review the push...'));
        const reviewed = await waitForBugbotReview(prInfo, {
          timeoutMs: 10 * 60 * 1000,
          pollIntervalMs: 30_000,
          verbose,
        });
        if (!reviewed) {
          console.log(chalk.yellow('Bugbot review timed out — continuing anyway'));
        }
      } else {
        console.log(chalk.dim(`\nWaiting ${interval} minutes before next check...`));
        await sleep(interval * 60 * 1000);
      }
    }
  }

  console.log(chalk.bold('\n🎉 Bugbot Buster complete!\n'));
  console.log(
    chalk.dim(
      `Total addressed: ${state.addressedCommentIds.length} comments across ${state.runs.length} runs`
    )
  );
}

// CLI setup
program
  .name('bugbot-buster')
  .description('Automated PR review comment fixer using AI coding assistants')
  .version('0.1.0')
  .requiredOption('-p, --pr <pr>', 'PR to fix (owner/repo#123 or #123)')
  .option('-a, --ai <provider>', 'AI provider: codex or claude', 'codex')
  .option('-i, --interval <minutes>', 'Minutes between checks', '5')
  .option('-m, --max-runs <count>', 'Maximum number of runs', '10')
  .option('-d, --dry-run', 'Show what would be done without making changes')
  .option('-v, --verbose', 'Show detailed output')
  .option('-s, --sign', 'Sign commits with GPG (-S flag)')
  .option('--validate', 'Validate comments before fixing (ignore invalid/false positives)')
  .option('--authors <list>', 'Only process comments from these authors (comma-separated)')
  .option('--stream', 'Stream AI output to the terminal in real-time')
  .option('--wait-for-review', 'Wait for Bugbot to finish reviewing before next run (instead of fixed interval)')
  .option('-r, --resolve-addressed', 'Find and resolve review threads that have already been addressed in code')
  .action((opts) => {
    const provider = opts.ai as AIProvider;
    if (provider !== 'codex' && provider !== 'claude') {
      console.error(chalk.red(`Invalid AI provider: ${opts.ai}. Use 'codex' or 'claude'`));
      process.exit(1);
    }
    const busterOpts: BusterOptions = {
      pr: opts.pr,
      interval: parseInt(opts.interval, 10),
      maxRuns: parseInt(opts.maxRuns, 10),
      dryRun: opts.dryRun ?? false,
      verbose: opts.verbose ?? false,
      stream: opts.stream ?? false,
      provider,
      signCommits: opts.sign ?? false,
      validateComments: opts.validate ?? false,
      authors: opts.authors ? opts.authors.split(',').map((a: string) => a.trim()) : undefined,
      waitForReview: opts.waitForReview ?? false,
      resolveAddressed: opts.resolveAddressed ?? false,
    };

    const handler = busterOpts.resolveAddressed ? runResolveAddressed : run;
    handler(busterOpts).catch((error) => {
      console.error(chalk.red('Fatal error:'), error);
      process.exit(1);
    });
  });

program.parse();
