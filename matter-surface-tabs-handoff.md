# Matter Surface Tabs Handoff

Use this prompt in a fresh thread after the Honeycrisp NoteCard PR is merged or explicitly skipped.

```txt
Continue the Epicenter design-system primitive adoption effort.

Mission:
Create one focused PR for Matter's surface navigation. Replace the hand-rolled surface tab pills with @epicenter/ui Tabs if Tabs honestly fit the route-navigation contract. If Tabs do not fit, create one small local Matter surface-pill component instead. The artifact wanted is a committed diff, pushed branch, and open PR.

This task is deliberately decision-heavy. Start with a greenfield clean-break reflection before editing. Do not mechanically force Tabs if the primitive creates fake local state, fights query-param ownership, or obscures route behavior.

State as of July 6, 2026:
- PR #2366, Button tooltip prop adoption, is merged.
- PR #2369, Empty / Loading / Spinner adoption, is merged.
- The Honeycrisp NoteCard PR should be merged or explicitly skipped before starting this task.
- Matter had recent churn, but no open Matter PRs were found by title/head search during the last check.
- No registered worktree had dirty edits to the Matter target files during the last check.
- The original handoff path apps/matter/src/lib/components/TablePane.svelte is stale. Current path is:
  apps/matter/src/routes/(vaults)/vault/[id]/TablePane.svelte
- Primary target files:
  apps/matter/src/routes/(vaults)/vault/[id]/VaultShell.svelte
  apps/matter/src/routes/(vaults)/vault/[id]/TablePane.svelte
- Optional sibling only if it stays tiny and cohesive:
  apps/matter/src/lib/components/TableGrid.svelte
  This optional sibling is only for repeated full-bleed Alert class cleanup, not for table behavior.
- Work from a fresh git worktree on a new branch from latest origin/main.
- Use bun, not npm, yarn, pnpm, or node.
- Stage explicit paths only. Never use git add . or git add -A.

Execution model:
You are the synthesis and judgment layer. Use Codex as the foot soldiers for token-heavy work whenever available: repo search, git history, dirty-worktree checks, file reading, local primitive inspection, diff review, command execution, first-pass summaries, and the actual scoped code edits. Codex should produce small evidence packets with exact paths, short decisive snippets, command outputs, diffs, and a risk summary. You should spend your own context on the route ownership decision, the greenfield clean-break call, accepting or rejecting Codex's edit plan, and final synthesis.

If running in Claude Code in this repo, follow CLAUDE.md: delegate bounded execution work through `/codex:rescue`. Send one job per prompt with exact inputs, constraints, and one deliverable. Treat `/codex:review`, `/codex:adversarial-review`, `/codex:transfer`, `/codex:status`, `/codex:result`, and `/codex:cancel` as user-invoked commands; suggest them when useful, then faithfully consume the returned output before making the decision.

Codex should not be limited to research. After the Tabs-vs-local-component decision is made, delegate the mechanical implementation to Codex: create or use the disposable worktree, patch the chosen files, run typecheck, inspect the diff, and report what changed. Claude or the orchestrator should review Codex's diff and reasoning before push/PR, especially around route ownership, fake local state, and URL behavior.

Manage context aggressively:
- Do not paste whole Matter files into the main context.
- Ask Codex for targeted snippets around the switchers, route helpers, and Tabs wrapper API.
- Keep separate notes for facts, recommendations, and open calls.
- After each Codex packet, write what it proves or disproves.
- Do not expand into SQLite, vault lifecycle, table query, board behavior, or integrity logic unless a direct compile error forces it.

Read first, using Codex when available:
1. packages/ui/src/tabs/*.svelte
   Why: local Tabs wrapper behavior, value binding, list variants, trigger classes, and content assumptions.
2. apps/opensidian/src/lib/components/editor/TabBar.svelte
   Why: local example of scrollable tabs with custom trigger classes.
3. apps/matter/src/routes/(vaults)/vault/[id]/VaultShell.svelte
   Why: vault-wide table and panel surface switcher.
4. apps/matter/src/routes/(vaults)/vault/[id]/TablePane.svelte
   Why: per-table grid and projection switcher.
5. apps/matter/src/lib/routes.ts
   Why: route helper and query-param ownership.
6. apps/matter/src/lib/components/TableGrid.svelte
   Why: optional Alert cleanup only. Do not read deeply unless you choose that optional cleanup.

Commands to run before editing:
git fetch origin
git worktree add ../epicenter-matter-surface-tabs -b ui-matter-surface-tabs origin/main
cd ../epicenter-matter-surface-tabs
git status --short --branch
git log --oneline -8 -- 'apps/matter/src/routes/(vaults)/vault/[id]/VaultShell.svelte' 'apps/matter/src/routes/(vaults)/vault/[id]/TablePane.svelte' apps/matter/src/lib/components/TableGrid.svelte

Also ask Codex to run a registered-worktree dirty check for these paths before editing. If another worktree has dirty edits to the same files, stop and report the path.

Settled facts. Do not reopen these:
- Route/query params own the selected Matter surface.
- Do not change query param names.
- Do not change route semantics.
- Do not change SQLite mirror, vault lifetime, table lifetime, query execution, board view, or integrity behavior.
- Do not move Matter-specific navigation semantics into packages/ui.
- Do not combine this with Honeycrisp or any other primitive adoption task.
- Do not touch auth, workspace, session, billing, or unrelated apps.

Known recommendation:
- Prefer @epicenter/ui Tabs only if it can honestly model the route-backed active value while onValueChange calls goto.
- If Tabs requires a fake local selected value or awkward no-op Tabs.Content placeholders, refuse it and write a small local Matter component for route-backed surface pills.
- The old hand-rolled duplication should not survive by inertia. It should survive only if it is clearer than the primitive because route navigation is the actual owner.

Open questions:
1. Can Tabs.Root be controlled by a route-derived value and use onValueChange to navigate without introducing fake state?
2. Does Tabs.List/Trigger styling fit the existing compact horizontal surface bar without fighting the primitive?
3. Should VaultShell and TablePane share one local Matter-only component for route-backed surface triggers?
4. Is the optional Alert class cleanup in TableGrid truly cohesive with this PR, or should it remain separate?

Greenfield reflection before editing:
Start with this product sentence:

Matter surface navigation owns one route-backed selected surface; table tabs, vault panels, and table projections are navigation choices, not local component state.

Then map current ownership:
- VaultShell reads route/query params and resolves active table, panel, and projection.
- TablePane receives the active table and optional projection.
- routes.ts creates the hrefs.
- Buttons currently render the navigation choices directly.

Test the clean-break:
- If Tabs is introduced, what owns the selected value?
- Is Tabs merely drawing the pills, or is it pretending to own navigation state?
- Would a developer pressing Go-to-Definition from a trigger land on useful ownership, or on a behavior-free wrapper?
- Does a shared local component remove duplication while keeping route ownership visible?
- What would falsify Tabs? Examples: fake local state, brittle content placeholders, unclear URL ownership, broken keyboard behavior, or more code than the old buttons.

Name refusals explicitly:
- Refuse Tabs if it creates fake local tab state.
- Refuse a packages/ui primitive because Matter route-backed surfaces are app-specific.
- Refuse optional Alert cleanup if it broadens the PR beyond surface navigation.
- Refuse compatibility with the old hand-rolled class duplication if a local Matter component keeps behavior clearer.

Decision format before editing:
Product sentence:
  ...
Current owners:
  ...
Tabs fit check:
  accepted/refused because ...
Local component check:
  accepted/refused because ...
User-visible behavior that must stay the same:
  ...
What would falsify this direction:
  ...

Implementation plan:
1. Use Codex to gather evidence from the files above, including exact snippets for current switchers and Tabs API.
2. Write the decision format before editing.
3. Give Codex the accepted implementation shape and have Codex make the scoped code edit.
4. Implement exactly one of these:
   A. Tabs-based switchers, if Tabs fits route-backed navigation cleanly.
   B. One local Matter-only route-backed surface trigger/list component, if Tabs does not fit.
5. Keep href/goto behavior equivalent to current behavior.
6. Preserve compact horizontal overflow behavior.
7. Preserve active, hover, icon, and label treatments unless replaced cleanly by Tabs styling.
8. Keep the optional Alert cleanup out unless it is tiny, obvious, and still one cohesive visual primitive cleanup.
9. Have Codex run:
   bun run --filter matter typecheck
10. Review Codex's diff:
   git diff -- 'apps/matter/src/routes/(vaults)/vault/[id]/VaultShell.svelte' 'apps/matter/src/routes/(vaults)/vault/[id]/TablePane.svelte' apps/matter/src/lib/components/TableGrid.svelte
11. If the diff matches the decision, commit with explicit paths only.
12. Push and open one PR.

Commit guidance:
If Tabs is accepted:
refactor(matter): render surface switchers with Tabs

If Tabs is refused and a local route-backed component is added:
refactor(matter): collapse surface switcher pills

PR body guidance:
Lead with the decision. If Tabs was accepted, explain why route ownership remains clear. If Tabs was refused, explain what it would have obscured and why a local component is the smaller clean break. Do not include Testing, Test Plan, Summary, Changes, or Verification headings.

Verification:
Required:
bun run --filter matter typecheck

Recommended visual QA:
Open the Matter preview when available and check:
- table surface switching still updates the URL and active state
- SQL and Database panels still update the URL and active state
- Grid/projection switching still updates the URL and active state
- horizontal overflow still works with many tables or projections
- active and hover states still read clearly

Final response must include:
- PR link.
- Typecheck result.
- Whether Tabs was accepted or refused.
- The greenfield clean-break decision text.
- Any optional Alert cleanup included or explicitly deferred.
- Any visual QA gap.

Stop conditions:
- Stop if another worktree has dirty edits to the target Matter files.
- Stop if Tabs fit is ambiguous after local API inspection. Report the exact ambiguity and recommend the local component path.
- Stop if typecheck fails for a reason outside the target files.
- Stop after the PR is open and green. Do not start another primitive adoption task.
```
