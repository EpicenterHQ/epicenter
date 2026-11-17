---
cron: "0 8 * * *"
run: ["bun", "scripts/daily-task-review.ts"]
---
Prepare a draft review of open tasks in drafts/task-review-<day>.md.
Read tasks without changing them. Keep an existing draft, including edits made
by hand. See scripts/daily-task-review.ts for the grouping rules.
