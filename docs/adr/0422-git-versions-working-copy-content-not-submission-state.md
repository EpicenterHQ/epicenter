# 0422. Git versions working-copy content, not submission state

- **Status:** Proposed
- **Date:** 2026-09-22
- **Relates:** [ADR-0418](0418-push-translates-file-differences-into-ordinary-edits.md) defines field submissions and interruption handling; [ADR-0420](0420-epicenter-working-copies-use-the-matter-file-contract.md) defines the portable table format.
- **Unbuilt:** Git-ignore scaffolding, checkout-local query index placement, ownership-aware filesystem writes, and safe clone admission. Current checkout does not implement this complete layout or workflow.

## Context

Developers should be able to commit, branch, inspect, and back up working-copy
files with Git. A Git commit records file history; it does not prove that an
Epicenter Push succeeded. Versioning the submission baseline or interruption
marker would let a branch switch rewind that bookkeeping independently of the
live document.

## Decision

**Git versions portable content. Each working folder keeps its own local
submission state under `.epicenter/`.**

```text
working-copy/
  .gitignore
  AGENTS.md
  kv.json
  recordings/
    matter.json
    <recording-id>.md
  folders/
    matter.json
    <folder-id>.md
  .epicenter/
    manifest.json
    query.sqlite          # optional, disposable
```

A table is a directory named after the declared table. Each Markdown file is
one row, named by its stable row ID. Frontmatter contains field values; the
body contains rendered context under ADR-0420's editing restrictions.
`matter.json` describes that table's fields. `kv.json` contains root settings.
`AGENTS.md` describes the working-copy rules. These files may be versioned.

The manifest contains destination identity, the comparison baseline, and
unfinished-operation state. It is local durable bookkeeping, not a cache.
The optional SQLite index and its journal or WAL companions live beside it.
The index may be deleted and rebuilt; deleting the whole `.epicenter/`
directory loses submission state and must not be presented as cache cleanup.
This placement concerns Epicenter working copies, not standalone Matter's
current mirror location. No credentials belong in the generated file contract.

The working-copy root's versioned `.gitignore` contains this anchored rule:

```gitignore
/.epicenter/
```

Scaffolding preserves existing ignore rules and unrelated files. It does not
replace an existing `.gitignore`, initialize Git, make commits, or change the
Git index. Ignore rules do not untrack already committed metadata; users must
remove such metadata from tracking before relying on this convention. Avoid
broad `*.json` or `*.sqlite` rules that hide unrelated repository content.

**Only completed Epicenter Pull or Push advances the submission baseline.**

Git HEAD, the staging area, and branch names do not define that baseline.
Committing before Push leaves the prepared field changes pending. A historical
file checkout produces differences against the current local baseline; it can
propose reversals, subject to the same field permissions and body, schema, and
row-set restrictions. A Git branch does not select a different Epicenter store.
Each working folder, including each Git worktree, needs independent local
submission state. Never share an unfinished marker or baseline across worktrees.

Git may resolve file conflicts before submission. It does not resolve the
transaction boundary between files and the live store. An unfinished Epicenter
operation continues to block Push even after a commit or branch switch.
Do not run branch switches, merges, or file rewrites concurrently with Pull or
Push; operation-time file handling must still preserve edits or refuse rather
than silently overwrite or mark uncaptured changes submitted.

**A Git clone is readable content, not an initialized Epicenter checkout.**

Missing local metadata refuses Push. Pull must not overwrite an occupied clone
or adopt its current values as an already-submitted baseline. The initial
supported procedure is a fresh Pull into another folder, then deliberate
transfer of wanted permitted edits. Automatic clone attachment is deferred.
Git archives preserve the tracked logical files, not untracked attachments,
exact Yjs history, or local recovery state. Whole-document replacement remains
outside the feature set under ADR-0417.

**A path's shape does not establish ownership.**

Pull owns only the checkout's declared table files and explicitly managed root
files. Use the destination definition and the last materialization manifest to
establish those paths; a two-segment Markdown suffix is insufficient. Preserve
`.git` and unrelated repository paths such as `docs/README.md` or draft
folders outside the managed tables. Refuse collisions with existing unowned paths. Within a managed
table, an added Markdown file is an unsupported row creation and causes refusal;
it is not disposable content to sweep away. Definition changes must not silently
claim or discard an existing directory.

## Consequences

Git remains optional. No Git hooks, branch-to-store mapping, commit-to-submission
registry, or custom merge driver is required. Push updates only local metadata,
so successful submission need not dirty tracked files. Git status and Epicenter
submission status answer different questions.

Clones require reconciliation before their edits can be submitted. Force-adding
local metadata or restoring an old copy of it violates the workflow convention;
without independent history, automatic rollback detection is not promised.

## Considered alternatives

- Use Git HEAD as the baseline: committing a prepared edit would hide it from Push.
- Keep a dedicated local Git ref per working folder: retains the same semantic
  baseline and interruption work while making Git required.
- Version the manifest: branch switches rewind destination and submission state.
- Put the query index at the root: exposes a derived file beside authoring files
  and requires another ignore rule without improving query access.

## Verification

Exercise commit-before-Push, metadata-only successful Push, historical file
restoration, independent worktrees, and blocked interruptions across branch
switches. Missing-baseline clones must remain intact. Preserve unrelated paths
and existing ignore rules. Reject unsupported body/schema/row-set differences.
Verify that rebuilding or deleting the query index preserves the baseline and
unfinished state, and that concurrent filesystem changes cannot silently enter
the submitted baseline.
