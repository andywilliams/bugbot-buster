#!/usr/bin/env node
import { program } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { parsePR, fetchPRComments, checkoutPR, commitAndPush } from './github.js';
import { buildPrompt, runAI, checkAuth, getProviderName, validateComment } from './ai.js';
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

async function run(options: BusterOptions): Promise<void> {
  const { pr, interval, maxRuns, dryRun, verbose, provider, signCommits, validateComments, authors } = options;

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
        spinner.start(`Validating: ${comment.path}:${comment.line ?? '?'}...`);
        const result = await validateComment(provider, comment, workdir, verbose);
        
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
    spinner.start(`Running ${getProviderName(provider)} to fix issues...`);
    const success = await runAI(provider, prompt, workdir, verbose);

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
      console.log(chalk.dim(`\nWaiting ${interval} minutes before next check...`));
      await sleep(interval * 60 * 1000);
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
  .action((opts) => {
    const provider = opts.ai as AIProvider;
    if (provider !== 'codex' && provider !== 'claude') {
      console.error(chalk.red(`Invalid AI provider: ${opts.ai}. Use 'codex' or 'claude'`));
      process.exit(1);
    }
    run({
      pr: opts.pr,
      interval: parseInt(opts.interval, 10),
      maxRuns: parseInt(opts.maxRuns, 10),
      dryRun: opts.dryRun ?? false,
      verbose: opts.verbose ?? false,
      provider,
      signCommits: opts.sign ?? false,
      validateComments: opts.validate ?? false,
      authors: opts.authors ? opts.authors.split(',').map((a: string) => a.trim()) : undefined,
    }).catch((error) => {
      console.error(chalk.red('Fatal error:'), error);
      process.exit(1);
    });
  });

program.parse();
