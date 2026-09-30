# File-folder conditional editing

**Date:** 2026-09-30
**Status:** Draft
**Owner:** Braden Wong

## One sentence

Build one editor whose conditional saves publish captured Markdown and complete
recoverable Git revisions without losing competing edits or newer typing.

## Current state and target

Release applications still use Yjs-backed `@epicenter/app` stores. The prototype
at `codex/file-foundation`, head `60dd4e8f92`, demonstrates browser files and Git
but predates the package consolidation and current flat row layout. The target
openers and table methods below are not implemented.

The broader API catalog remains on branch `codex/file-folder-api-spec` in
`specs/20260930T104219-file-data-folder-api.md`. This slice replaces that draft's
named-part edit, retry, and editor-save assumptions; it does not duplicate its
remote or full-app migration plan.

Decision records:

| Decision | Record |
| --- | --- |
| Captured entries, source/version consistency, conformance issues | [Entry reads](../docs/adr/0462-file-table-entries-carry-source-and-use-issues-for-conformance.md) |
| One conditional whole-file save policy, two preparation methods | [Table saves](../docs/adr/0464-file-table-updates-conditionally-replace-the-captured-whole-file.md) |
| One editor source buffer, retained baseline and input | [Editor ownership](../docs/adr/0465-editors-keep-unsaved-source-separate-from-the-saved-baseline.md) |
| Actual input bytes match the reported version | [Opened content](../docs/adr/0466-opened-file-content-matches-its-captured-version.md) |
| Observed, operation-specific interrupted-operation choices | [Recovery](../docs/adr/0467-interrupted-file-operations-use-operation-specific-recovery-choices.md) |
| Completed local saves include append-only Git history | [Save history](../docs/adr/0468-every-completed-app-save-has-a-recoverable-git-revision.md) |
| Generated messages describe known intent | [Commit messages](../docs/adr/0469-generated-commit-messages-describe-known-app-operations.md) |

Current layout work keeps exact row IDs in filenames and titles in fields.
The generated root `index.sqlite3` is optional derived state and does not
authorize edits or participate in authoritative synchronization. This slice
does not change those decisions.

## Intended caller

```ts
const folder = await openLocalDataFolder(notesDefinition);
const notes = folder.tables.notes;
const read = await notes.get(id);
if (read.error || !read.data) return;
const note = read.data; // captured when the interaction begins

const titled = await notes.update(note, { fields: { title: enteredTitle } });
if (titled.error) return retainTitleInput(titled.error);

const saved = await notes.writeSource(titled.data, completeMarkdown);
if (saved.error) return retainEditorInput(saved.error);
// Success includes the exact saved entry and a completed automatic revision.
```

The examples describe target calls, not exports that already exist.
`update` accepts fields and a Markdown-string body together. `writeSource`
accepts temporarily invalid YAML. Both return the exact accepted entry after
local files and history complete. A pre-publication `WriteConflict` changes
nothing. A published but incomplete operation has distinct retained evidence
and pauses affected autosave. The result shape remains to be specified; neither
method silently refreshes and retries. Raw bytes that cannot decode as UTF-8
remain outside the text-entry API.

## Build backward from the proof

### 1. Prove one captured entry and one publisher

- [ ] Port the minimal file boundary into `packages/app`; do not recreate
  `packages/data`. Keep the browser/native platform seam and relevant lifetime
  rules from the broader plan.
- [ ] Capture literal path, source, version, and attachment observation from
  consistent bytes. Return invalid YAML through entry issues and invalid UTF-8
  through the raw file boundary.
- [ ] Implement source preparation shared by `update` and the editor adapter.
  Preserve unrelated source; add missing supported keys; validate only supplied
  fields; refuse unsupported transformations.
- [ ] Implement one strict publisher. Prepare from captured source, retain
  reachable before/after evidence and internal operation identity, recheck
  current versions and domain requirements, publish, then complete history.
  Construct the returned entry from accepted bytes. Unchanged writes still
  check preconditions and retain their bytes without requiring an empty commit.
- [ ] Use one app-managed append-only branch with no public staging workflow.
  Retain observed external bytes before displacement. Keep native current files
  authoritative and generated indexes outside the save path.
- [ ] Remove named-part comparison, refreshed-baseline retry, and `wrote:false`
  from this migration's API and tests. Existing Yjs APIs remain until migrated.

### 2. Prove the editor lifecycle with one note

- [ ] Use the actual editor's buffer and an app-owned serialized save
  controller. Do not require a public storage document handle or registry.
- [ ] Route source typing, body changes, and frontmatter controls into that
  source buffer. Use the shared preparation implementation rather than
  concatenating YAML in UI handlers.
- [ ] Autosave complete captured source through `writeSource`; retain later
  generations after acknowledgement and pause on conflict or incomplete
  publication. Batch before saving, with no delayed Git checkpoint scheduler.
- [ ] Implement clean-only reload, deferred invalidation during saving,
  identity/generation rechecks, and explicit discard/renewed-save choices.
- [ ] Retain, settle, or explicitly discard outgoing drafts before disposal.
  Git, shell, sync, and export never invoke a universal buffer flush.

### 3. Prove completed saves and interrupted publication

- [ ] Define the initial ordinary-save inspection and resolution contract before
  wiring restart recovery. Distinguish refusal, retained incomplete operation,
  and completed save without requiring a public replay ID from every caller.
- [ ] Interrupt an ordinary save after retaining evidence, replacing its file,
  advancing history, and before acknowledgement. Verify accepted bytes remain
  reachable and lost acknowledgements cannot create duplicate revisions.
- [ ] Publish A, let an external editor replace it or restore byte-identical
  before-bytes, then restart. Retain A and refuse automatic abandonment or
  overwrite inferred from path state alone.
- [ ] Change the branch between publication steps. Preserve evidence and check
  affected paths and requirements before any renewed publication. Test retention
  of acknowledged versions after an external history rewrite.
- [ ] Prove the browser's durable transaction boundary for logical files and
  completed history. If they cannot commit together, retain pending evidence.
- [ ] Generate messages from prepared intent, with generic descriptions for
  unknown external edits. Imported metadata never proves local completion.
- [ ] Measure accepted-save latency, retained bytes, and history lookup on native
  and browser storage using repo-derived fixtures and labeled synthetic tables.
  Include repeated edits, large flat tables, and actual audio bytes. Report
  storage microbenchmarks separately from end-to-end durability evidence.
- [ ] Browser shell reads and writes the saved file boundary incrementally.
  A read-modify-write observes its precondition; explicit overwrite remains a
  separate shell intent. Managed writes complete history individually; no
  whole-command transaction or separate shell file tree.

### 4. Prove media ownership and structural recovery

**Pinned media alternatives.** Start with immutable memory for a small proof.
Compare its recording-size memory cost with operation-scoped native temporary
capture. Temporary capture needs explicit cleanup and interrupted-read recovery.
Also test consumption from an immutable retained Git blob. None of these choices
requires a mirror of every current file. Defer merging `files.read` and
`files.open` until transport, consumption, memory use, and cleanup are proven.

- [ ] Open an attachment by captured reference and deliver only its identified
  bytes, or refuse. A provider must not consume a lazy mutable native file.
- [ ] Build the demonstrated attachment requirement inside the recording
  integration. Preserve row existence, identity, audio version, and complete
  candidate-set checks at publication; do not generalize to unused path guards.
- [ ] Keep result-row creation separate from the recording row. Retain refused
  paid output for review. Cross-row deletion admission remains a migration gate.

**Recovery alternatives.** Prefer a library inspection/resolution contract with
app presentation. An initial native diagnostic tool can exercise that contract,
but cannot replace the required app flow. A global `keepCurrent` does not prove
that a row pair or Git adoption is coherent.

- [ ] Extend ordinary-save inspection with coherent choices for row-pair
  create/delete, ID rename with scoped reference edits, restore, and adoption.
  Use one publication mechanism while retaining domain requirements.
- [ ] Interrupt an ID rename with audio; introduce a new attachment candidate
  or reference during recovery. Revalidate ownership, destination availability,
  and declared repair scope before completing it.
- [ ] Retain third-state evidence, recheck requirements, preserve displaced
  bytes, and define when a completed/abandoned record can be removed.
- [ ] Add only the narrow recovery surface required by those operations.
- [ ] Query history directly and restore through a fresh conditional operation.
  Keep committed media bytes reachable. Update deletion copy to describe
  recoverable history; permanent erasure and history thinning are separate work.

## Verification and stop condition

| Sequence | Required observation |
| --- | --- |
| Title dialog reads A; external writer saves B; submit | Refusal, B unchanged, entered title retained. |
| Field-only update | Untouched source byte-identical; body codec is not invoked. |
| Invalid YAML source save; invalid UTF-8 read | YAML saved with issues; undecodable bytes never become empty editable text. |
| BOM, CRLF, mixed newlines | Unchanged source round-trips; a normalizing widget requires faithful mapping or an explicit normalization decision. |
| Save A pending; type B and change a field | A advances baseline only; B and the field remain dirty and save together next. |
| A publishes; C replaces it before A acknowledges | Deferred invalidation discovers C; dirty input survives and next save refuses. |
| Clean reload pending; typing or selection begins | Old read cannot replace the new draft or another editor. |
| Changed save completes; unchanged save repeats | Exact accepted bytes in reachable completed history; fresh no-op needs no empty commit. |
| File publishes; process stops before history finishes | Pending operation and its bytes survive; no false Saved acknowledgement. |
| File publishes A; external editor restores before-bytes; restart | A remains recoverable; before-state does not authorize automatic discard. |
| History completes; reply is lost | Reconciliation prevents duplicate publication and preserves later edits. |
| Rename row/audio; new attachment appears before recovery | Ownership ambiguity refuses completion and retains evidence. |
| Open audio A; replace path with B while consumed | Consumer receives pinned A or read refuses; never mislabeled B. |
| Audio/candidate set/owner changes during provider call | Result publication refuses and output remains reviewable. |
| Kill each narrow operation between publication steps | Recognizable states complete safely; a third state or changed requirement is retained for explicit recovery. |

The first deliverable is one note with strict saves, completed automatic Git
history, and demonstrated interruption recovery. Media and adoption remain
gated on their input, storage, and recovery proofs.
This slice is complete when those exercised contracts replace the old prototype
assumptions, callers no longer coordinate source/version/encoding themselves,
and obsolete migration machinery is removed. Full app migration, hosted Git/LFS,
physical phone verification, query-index generation, and public publication are
separate work.
