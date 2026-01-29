# 🤖 Bugbot Buster

Automated PR review comment fixer using AI coding assistants.

## What it does

1. Takes a GitHub PR as input
2. Fetches all unresolved review comments
3. Uses AI (Codex or Claude) to fix the issues
4. Commits and pushes the fixes
5. Waits, then checks for new comments
6. Repeats until all comments are addressed

## Prerequisites

- Node.js 18+
- GitHub CLI (`gh`) installed and authenticated
- One of:
  - OpenAI Codex CLI (`codex`) installed and logged in
  - Claude Code CLI (`claude`) installed
- Must be run from within a git repository

## Installation

```bash
npm install -g bugbot-buster
```

Or run directly:

```bash
npx bugbot-buster --pr owner/repo#123
```

## Usage

```bash
# Fix comments on a PR using Codex (default)
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
- Run history with timestamps and commit SHAs

Add this to `.gitignore` if you don't want to track it.

## License

MIT

## Authors

Andy & Jenna 🦊
