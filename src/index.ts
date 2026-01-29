#!/usr/bin/env node
import { program } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { parsePR, fetchPRComments, checkoutPR, commitAndPush } from './github.js';
import { buildPrompt, runCodex, checkCodexAuth } from './codex.js';
import {
  loadState,
  saveState,
  markAddressed,
  addRunRecord,
  filterUnaddressed,
} from './tracker.js';
import type { BusterOptions, PRComment } from './types.js';

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run(options: BusterOptions): Promise<void> {
  const { pr, interval, maxRuns, dryRun, verbose } = options;

  console.log(chalk.bold('\n🤖 Bugbot Buster\n'));

  // Check Codex auth
  if (!checkCodexAuth()) {
    console.error(chalk.red('❌ Codex CLI not logged in. Run: codex login'));
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
    chalk.dim(`Previously addressed: ${state.addressedCommentIds.length} comments`)
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
    const unaddressed = filterUnaddressed(unresolved, state);

    console.log(
      chalk.dim(
        `  Unresolved: ${unresolved.length}, New to address: ${unaddressed.length}`
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

    if (dryRun) {
      console.log(chalk.yellow('\n[DRY RUN] Would run Codex to fix these issues'));
      state = markAddressed(state, unaddressed.map((c) => c.id));
      saveState(workdir, state);
      break;
    }

    // Run Codex
    const prompt = buildPrompt(unaddressed);
    spinner.start('Running Codex to fix issues...');
    const success = await runCodex(prompt, workdir, verbose);

    if (!success) {
      spinner.fail('Codex failed to fix issues');
      break;
    }
    spinner.succeed('Codex completed');

    // Commit and push
    spinner.start('Committing and pushing...');
    const sha = commitAndPush(
      `fix: address ${unaddressed.length} review comment(s)`,
      workdir
    );

    if (sha) {
      spinner.succeed(`Pushed: ${sha.slice(0, 7)}`);
    } else {
      spinner.info('No changes to commit');
    }

    // Update state
    state = markAddressed(state, unaddressed.map((c) => c.id));
    state = addRunRecord(state, {
      commentsFound: unaddressed.length,
      commentsAddressed: unaddressed.length,
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
  .description('Automated PR review comment fixer using Codex CLI')
  .version('0.1.0')
  .requiredOption('-p, --pr <pr>', 'PR to fix (owner/repo#123 or #123)')
  .option('-i, --interval <minutes>', 'Minutes between checks', '5')
  .option('-m, --max-runs <count>', 'Maximum number of runs', '10')
  .option('-d, --dry-run', 'Show what would be done without making changes')
  .option('-v, --verbose', 'Show detailed output')
  .action((opts) => {
    run({
      pr: opts.pr,
      interval: parseInt(opts.interval, 10),
      maxRuns: parseInt(opts.maxRuns, 10),
      dryRun: opts.dryRun ?? false,
      verbose: opts.verbose ?? false,
    }).catch((error) => {
      console.error(chalk.red('Fatal error:'), error);
      process.exit(1);
    });
  });

program.parse();
