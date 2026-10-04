# Honeycrisp NoteCard Item Primitive Handoff

Use this prompt in a fresh thread after July 6, 2026.

```txt
Continue the Epicenter design-system primitive adoption effort.

Mission:
Create one focused PR that converts Honeycrisp's note-card row markup to @epicenter/ui Item primitives. The exact target file is:

apps/honeycrisp/src/routes/components/NoteCard.svelte

The artifact wanted is a committed diff, pushed branch, and open PR. Stop after this PR is open and checks are green. Do not continue into Matter or any other primitive adoption task in the same branch.

State as of July 6, 2026:
- PR #2366, Button tooltip prop adoption, is merged.
- PR #2369, Empty / Loading / Spinner adoption, is merged.
- PR #2295, codex/honeycrisp-desktop-shell-20260703, is merged. This cleared the old Honeycrisp blocker.
- No open Honeycrisp PRs were found during the last check.
- No registered worktree had dirty edits to apps/honeycrisp/src/routes/components/NoteCard.svelte during the last check.
- The existing NoteCard row is a selectable div inside ContextMenu.Trigger, with nested Button actions for pin, delete, restore, and permanent delete. That nested-action shape is the decisive fact.
- Work from a fresh git worktree on a new branch from latest origin/main.
- Use bun, not npm, yarn, pnpm, or node.
- Stage explicit paths only. Never use git add . or git add -A.

Execution model:
You are the synthesis and judgment layer. Use Codex as the foot soldiers for token-heavy work whenever available: grep, file reads, caller checks, diff inspection, command execution, browser or computer use, first-pass summaries, and the actual scoped code edits. Ask Codex for bounded evidence packets and narrow edit attempts, not giant dumps. Codex should return exact paths, short decisive snippets, command outputs, diffs, and a risk summary. You should spend your own context on the ownership decision, the greenfield reflection, accepting or rejecting Codex's edit plan, and the final PR-quality synthesis.

If running in Claude Code in this repo, follow CLAUDE.md: delegate bounded execution work through `/codex:rescue`. Send one job per prompt with exact inputs, constraints, and one deliverable. Treat `/codex:review`, `/codex:adversarial-review`, `/codex:transfer`, `/codex:status`, `/codex:result`, and `/codex:cancel` as user-invoked commands; suggest them when useful, then faithfully consume the returned output before making the decision.

Codex should not be limited to research. Once the greenfield decision is made, delegate the mechanical implementation to Codex: create or use the disposable worktree, patch the target file, run the verification command, inspect the diff, and report the result. Claude or the orchestrator should review Codex's diff and reasoning before push/PR, especially around ContextMenu.Trigger composition and nested interactive elements.

Manage context aggressively:
- Do not paste whole files into the main reasoning context unless a file is tiny.
- Ask Codex to read and summarize target files with line references and only the relevant snippets.
- Keep one scratch list of settled facts, open questions, and proof commands.
- After each evidence packet, decide what it changes. If it changes nothing, do not keep expanding the search.
- The final diff must be small enough to review mentally in one pass.

Read first, using Codex when available:
1. packages/ui/src/item/item.svelte
   Why: Item.Root styling, child composition, and the base class behavior.
2. packages/ui/src/item/item-button.svelte
   Why: Shows why Item.Button is only for whole-row controls and why it is wrong for nested action buttons.
3. apps/tab-manager/src/lib/components/tabs/TabItem.svelte
   Why: Whole-row clickable reference. Read it as contrast, not as the target shape.
4. apps/whispering/src/lib/components/settings/LocalModelSelector.svelte
   Why: Row with nested actions. This is the closest reference: Item.Root, not Item.Button.
5. apps/honeycrisp/src/routes/components/NoteCard.svelte
   Why: The only implementation target.

Commands to run before editing:
git fetch origin
git worktree add ../epicenter-honeycrisp-notecard-item -b ui-honeycrisp-notecard-item origin/main
cd ../epicenter-honeycrisp-notecard-item
git status --short --branch
git log --oneline -8 -- apps/honeycrisp/src/routes/components/NoteCard.svelte

If the worktree path already exists, choose another clear disposable path. Do not reuse a dirty worktree.

Settled facts. Do not reopen these:
- Use Item.Root, not Item.Button. NoteCard contains nested action buttons; nested button HTML is invalid.
- Preserve ContextMenu behavior.
- Preserve row selection behavior.
- Preserve hover action buttons.
- Preserve selected styling.
- Preserve pinned and deleted branches.
- Preserve restore, soft delete, permanent delete, and delete confirmation behavior.
- Do not add or expose new package/ui APIs.
- Do not touch auth, workspace, session, storage, migration, or unrelated Honeycrisp files.

Known recommendation:
- Use Item.Root with child composition if ContextMenu.Trigger needs to pass props to the rendered row element.
- Keep selected and hover styling explicit in the call site. Do not try to solve the deferred selected-row primitive here.

Open question:
Does ContextMenu.Trigger require the direct child snippet path for prop merging in this component, or can Item.Root sit directly as the trigger child without losing trigger semantics? Answer this from local code and installed types, not memory. If uncertain, prefer the composition path that preserves the current trigger element and event behavior.

Greenfield reflection before editing:
Do not defer to the old div just because it exists. Start with this product sentence:

A note card owns note preview and row selection; inline buttons own fast note actions; the context menu owns secondary note actions.

Then test the current code against it:
- Which element owns selection?
- Which elements own fast actions?
- Which component owns the context menu trigger?
- Is any wrapper only preserving old markup ceremony?
- Would the product sentence survive if that wrapper disappeared?
- What would falsify the Item.Root direction? For example: broken ContextMenu.Trigger composition, invalid interactive nesting, or lost keyboard/context-menu behavior.

Name any refusal explicitly:
- Refuse Item.Button because nested actions make the row not a whole-row button.
- Refuse a new shared primitive because this is one app-specific row, not a stable package/ui abstraction.
- Refuse selected-prop work because the design-gated selected-row primitive is explicitly out of scope.

Implementation plan:
1. Let Codex read the five files above and return a compact evidence packet: relevant snippets, composition constraints, and any local patterns to copy.
2. Decide the ContextMenu.Trigger composition shape.
3. Give Codex the accepted edit shape and have Codex make the scoped code edit.
4. Convert the selectable row wrapper to Item.Root.
5. Keep nested Button actions as Button components.
6. Preserve onclick propagation guards on action buttons.
7. Keep visible layout and copy stable unless the Item primitive directly replaces wrapper classes.
8. Run format only if the repo's tooling requires it. Do not churn unrelated files.
9. Have Codex run:
   bun run --filter honeycrisp typecheck
10. Review Codex's diff:
   git diff -- apps/honeycrisp/src/routes/components/NoteCard.svelte
11. If the diff matches the decision, commit with explicit path:
   git add apps/honeycrisp/src/routes/components/NoteCard.svelte
   git commit
12. Push and open one PR.

Commit guidance:
Use a conventional commit, likely:
refactor(honeycrisp): render note cards with Item.Root

PR body guidance:
Keep it short. Explain why Item.Root is used instead of Item.Button: the card has nested action buttons, so the row cannot be a button. Do not include Testing, Test Plan, Summary, Changes, or Verification headings.

Verification:
Required:
bin or bun command:
bun run --filter honeycrisp typecheck

Recommended visual QA:
Open the Honeycrisp preview when available and check:
- selecting a note still works
- right-click/context menu still opens
- hover actions still appear
- selected row keeps its selected treatment
- deleted row actions still appear and work
- delete confirmation still opens

Final response must include:
- PR link.
- Typecheck result.
- Whether ContextMenu.Trigger required child composition.
- The greenfield refusals made.
- Any visual QA gap.

Stop conditions:
- Stop if ContextMenu.Trigger composition cannot be preserved without a larger change. Report the exact failing shape.
- Stop if typecheck fails for a reason outside NoteCard.
- Stop after the PR is open and green. Do not start Matter.
```
