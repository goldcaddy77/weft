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
