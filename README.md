# 🤖 Bugbot Buster

Automated PR review comment fixer using AI coding assistants.

## What it does

### Fix mode (default)
1. Takes a GitHub PR as input
2. Fetches all unresolved review comments
3. Uses AI (Codex or Claude) to fix the issues
4. Commits and pushes the fixes
5. Waits, then checks for new comments
6. Repeats until all comments are addressed

### Resolve mode (`--resolve-addressed`)
1. Finds unresolved review threads on a PR
2. Uses AI to check if each comment has already been addressed in a subsequent commit
3. If addressed: replies with the resolving commit and marks the thread as resolved
4. If not: leaves it unresolved

## Prerequisites

- Node.js 18+
- GitHub CLI (`gh`) installed and authenticated
- One of:
  - OpenAI Codex CLI (`codex`) installed and logged in
  - Claude Code CLI (`claude`) installed
- Must be run from within a git repository

## Installation

```bash
git clone https://github.com/andywilliams/bugbot-buster.git
cd bugbot-buster
npm install
npm run build
npm link   # makes `bugbot-buster` available globally
```

Now you can run `bugbot-buster` from any repo.

## Usage

**Important:** Run from within the target repository (where the PR code lives).

```bash
# From source: run from within the repo you want to fix
cd /path/to/your-project
node /path/to/bugbot-buster/dist/index.js --pr #123

# Or with global install:
bugbot-buster --pr #123

# Use Claude Code instead of Codex
bugbot-buster --pr #123 --ai claude

# Full repo/PR path
bugbot-buster --pr andywilliams/dwlf-indicators#26

# Check every 10 minutes, max 5 runs
bugbot-buster --pr #123 --interval 10 --max-runs 5

# Dry run (show what would be done)
bugbot-buster --pr #123 --dry-run

# Verbose output
bugbot-buster --pr #123 --verbose

# Sign commits with GPG (for repos requiring signed commits)
bugbot-buster --pr #123 --sign

# Validate comments before fixing (skip false positives)
bugbot-buster --pr #123 --validate

# Only process comments from specific authors (security)
bugbot-buster --pr #123 --authors cursor
bugbot-buster --pr #123 --authors "cursor,dependabot,my-tech-lead"

# Stream AI output in real-time (see what the AI is thinking)
bugbot-buster --pr #123 --stream

# Resolve addressed comments (cleanup stale threads)
bugbot-buster --pr #123 --resolve-addressed

# Resolve + filter to specific authors + stream output
bugbot-buster --pr #123 --resolve-addressed --authors cursor --stream

# Dry run resolve (see what would be resolved without acting)
bugbot-buster --pr #123 --resolve-addressed --dry-run
```

## Options

| Option | Description | Default |
|--------|-------------|---------|
| `-p, --pr <pr>` | PR to fix (required) | - |
| `-a, --ai <provider>` | AI provider: `codex` or `claude` | codex |
| `-i, --interval <min>` | Minutes between checks | 5 |
| `-m, --max-runs <n>` | Maximum number of runs | 10 |
| `-d, --dry-run` | Preview without changes | false |
| `-v, --verbose` | Detailed output | false |
| `-s, --sign` | Sign commits with GPG | false |
| `--validate` | Validate comments, ignore invalid | false |
| `--authors <list>` | Only process comments from these authors (comma-separated) | all |
| `--stream` | Stream AI output to the terminal in real-time | false |
| `-r, --resolve-addressed` | Find and resolve already-addressed comments | false |

## How it works

1. **Fetches comments** via GitHub GraphQL API
2. **Filters** out resolved threads and previously-addressed comments
3. **Groups** comments by file for efficient Codex prompts
4. **Runs Codex** with `--full-auto` to fix issues
5. **Commits** changes with a descriptive message
6. **Tracks** addressed comment IDs in `.bugbot-state.json`

## State file

The tool creates `.bugbot-state.json` in the repo root to track:
- IDs of addressed comments (avoids re-processing)
- IDs of ignored comments (false positives, when using `--validate`)
- Run history with timestamps and commit SHAs

Add this to `.gitignore` if you don't want to track it.

## Security

### Prompt injection risk

Since bugbot-buster feeds PR comments to an AI, malicious comments could potentially trick the AI into unintended actions. The `--authors` flag mitigates this by only processing comments from trusted sources:

```bash
# Only fix comments from Cursor's Bugbot
bugbot-buster --pr #123 --authors cursor

# Trust multiple authors
bugbot-buster --pr #123 --authors "cursor,dependabot"
```

**Recommendations:**
- On public repos, always use `--authors` to filter to trusted bots/users
- On private repos with trusted team members, the risk is lower
- The `--dry-run` flag lets you preview changes before committing
- Running in a sandboxed environment adds an extra layer of protection

## Resolving addressed comments

With `--resolve-addressed`, the tool switches from "fix" mode to "cleanup" mode. Instead of making code changes, it reviews unresolved threads to check if they've already been addressed:

```bash
bugbot-buster --pr #123 --resolve-addressed
```

For each unresolved comment, the AI examines:
- The original review comment
- The current state of the file
- Recent commits that touched the file after the comment was posted

If the comment has been addressed, the tool:
1. **Replies** to the thread with the commit SHA that resolved it and a brief explanation
2. **Marks the thread as resolved** via the GitHub API

This is useful for cleaning up PRs after a round of fixes — threads that were addressed but never formally resolved show up as noise. Run with `--dry-run` first to preview what would be resolved.

## Comment validation

With `--validate`, the tool asks the AI to evaluate each comment before fixing:
- **Valid comments** are fixed as normal
- **Invalid comments** (false positives, style nitpicks, etc.) are marked as ignored
- Ignored comments are stored in state and won't be re-evaluated

## License

MIT

## Authors

Andy & Jenna 🦊
