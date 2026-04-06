task_file: reference/architecture.md
base_branch: main
work_max_iterations: 15
worktree_dir: ../worktrees
branch_prefix: ralph/
max_tasks: 0
on_stuck: skip

verify:

- bun test
- bun run typecheck
- bun run lint

reviewers:

- copilot

review_bot_patterns:

- copilot
- bugbot
- coderabbit

# Pull request title contract for agents that use this config:

# - Optional Linear prefix only when applicable: ABC-123:

# - Then a concise sentence-case action title

# - Never use a branch slug prefix, Markdown formatting, conventional prefixes,

# or a multi-sentence acceptance-criteria dump

# - Run `bun run scripts/pr-title.ts normalize ...` and

# `bun run scripts/pr-title.ts validate ...` before `gh pr create`
