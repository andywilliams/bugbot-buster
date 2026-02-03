# Bugbot-Buster Improvements

## Bugs Fixed
- [x] **Greedy regex in JSON parsing** (Feb 3) — `{[\s\S]*"addressed"[\s\S]*}` matched the entire Codex output instead of just the JSON response. Fixed to non-greedy `{"addressed"\s*:[\s\S]*?}`. Same fix for validation regex. Pushed `f5edb23`.

## Pain Points (observed in production use)

### 1. Wrong branch pushes
- Buster pushed #155's fix to `feature/annotation-ray` instead of `feature/annotation-trend-line`
- Codex/Claude doesn't always verify which branch it's on before committing
- **Fix:** Add explicit branch verification step before `git push` — compare current branch to expected PR branch

### 2. Timeout waiting for Bugbot re-review
- Spends 5-8 min polling for Bugbot to re-review after push, often times out anyway
- Wastes sub-agent runtime (10 min timeout consumed by polling)
- **Fix:** Drop the Bugbot poll entirely — just push and report. We check Bugbot ourselves.

### 3. Codex over-fixes / scope creep
- Makes extra refactoring changes beyond the specific bug (removed exports, restructured return objects, separated concerns)
- These "improvements" can break consumers that depend on the original API
- **Fix:** Stricter prompt: "Fix ONLY the specific bug described. Do not modify any other code. Do not remove exports, rename functions, or restructure."

### 4. Stale comment detection
- Tries to fix things already resolved in current code, wastes a run
- **Fix:** Pre-flight check — read the file, check if the bug still exists before handing to Codex. The `--resolve-addressed` mode does this but the main fix mode doesn't.

### 5. Git conflicts between parallel busters
- Two busters on the same repo can clash when checking out different branches
- **Fix:** Use `git worktree` for parallel runs, or enforce sequential runs per repo

### 6. No build verification
- Can't run `npm run build` on the server (missing node_modules, npm auth issues)
- Pushes code that might not compile
- **Fix:** Either install deps in a setup step, or accept this limitation and note it in the report

### 7. Parse failures on AI output
- Codex output includes session headers, thinking blocks, tool calls — not just the answer
- JSON extraction regex was greedy (now fixed for resolve-addressed, but validate mode had same issue)
- **Fix:** ✅ Fixed in `f5edb23`. Could also add a fallback: try parsing last line, then last JSON-like block.

## Improvement Ideas

### A. Build as a proper CLI skill
- Instead of relying on sub-agent prompts, create a `bugbot-buster` Clawdbot skill
- Handles git mechanics (checkout, branch verify, push) reliably
- Only hands off to AI for the actual code fix
- Consistent behavior, no prompt drift

### B. Pre-flight stale check in fix mode
- Before running Codex, read the flagged file and check if the bug still exists
- Could be a simple grep/AST check for many common patterns
- Skip if already fixed, saving an entire Codex run

### C. Smarter Codex prompting
- Include the exact file content around the bug
- Include a "do not modify" list of files/functions
- Use `--full-auto` with a tighter sandbox

### D. Batch mode
- Process multiple PRs in one run instead of spawning separate sub-agents
- Reduces overhead, avoids git conflicts
- Sequential within a repo, parallel across repos

### E. Report format standardization
- Consistent JSON output from every run
- Makes it easier for the main agent to parse and act on results
- Include: comments_found, comments_fixed, comments_skipped, branch, commits_pushed
