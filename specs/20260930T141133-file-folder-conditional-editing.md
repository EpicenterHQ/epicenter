# File-folder editing and best-effort Git history

**Date:** 2026-09-30
**Status:** In Progress
**Owner:** Braden Wong

## One sentence

Build one editor that saves Markdown files, attempts commits and push, and exposes
uncommitted changes independently of file-save success.

## Current state and evidence

Release applications still use Yjs-backed `@epicenter/app` stores. The Todos
demo uses the experimental `@epicenter/app/files` exports described below.
Recording integration remains unbuilt. The retained `codex/file-foundation`
prototype at `60dd4e8f92` demonstrates file editing, Git/LFS, browser/native
interruption handling, and independent recovery exports. Its evidence lives in
`packages/data/evidence/file-foundation/` in that checkout. These are inspected
retained reports, not a fresh verification of this design. Its directory layout,
staging, leases, and pending-operation rules implement an older stronger
contract. Port only mechanisms needed by the chosen outcome.

## Decisions

| Decision | Record |
| --- | --- |
| Current files own source | [File authority](../docs/adr/0450-current-files-own-portable-document-data.md) |
| Captured source and conformance issues | [Entries](../docs/adr/0462-file-table-entries-carry-source-and-use-issues-for-conformance.md) |
| Source-preserving conditional updates | [Table saves](../docs/adr/0464-file-table-updates-conditionally-replace-the-captured-whole-file.md) |
| Editor buffer and baseline | [Editor ownership](../docs/adr/0465-editors-keep-unsaved-source-separate-from-the-saved-baseline.md) |
| Stable media input without required hashing | [Opened content](../docs/adr/0466-opened-media-provides-stable-input-bytes.md) |
| Partial results without a universal journal | [Interruption](../docs/adr/0467-interrupted-file-operations-report-partial-results.md) |
| Save, commit, and push are separate outcomes | [Save and history](../docs/adr/0468-file-saves-succeed-independently-of-automatic-commits.md) |
| Tree-derived automatic subjects | [Messages](../docs/adr/0469-generated-commit-messages-describe-captured-file-changes.md) |
| One folder handle and shared Git status | [Folder API](../docs/adr/0471-a-data-folder-handle-exposes-tables-kv-and-files.md) |

## Todos end-to-end implementation

Build the file-backed API in `packages/app` under explicit `/files`,
`/files/native`, and `/files/terminal` exports. Keep current Yjs callers working.
Build `apps/todos` with `@epicenter/ui`, source editing, honest Git status, a
Commit and push action, and a bottom just-bash terminal on the same files.

Automatic commits capture portable current files, construct immutable Git
objects, and advance the branch through a backend compare-and-swap. They do not
need to mutate the shared staging index. Native terminal staging commands use
native Git's index locking. Source updates preserve untouched Markdown bytes.

Incoming adoption follows [the explicit clean fast-forward decision](../docs/adr/0474-incoming-file-folder-sync-is-an-explicit-clean-fast-forward.md).
The loopback demo uses a real Git HTTP backend, bare remote, and native checkout.
The demo does not require media/LFS or a generated SQLite query index.

- [x] Create, edit, toggle, rename, delete, and repair malformed Todo source.
- [x] Verify automatic commits and durable browser reload.
- [x] Verify shell writes refresh the app and manual Git staging/commit works.
- [x] Push browser commits to the real native checkout.
- [x] Push a native commit and explicitly adopt it in the browser.
- [x] Verify offline local saves/commits and honest outgoing failure.
- [x] Verify stale-write and dirty/divergent incoming refusal preserves files.
- [x] Run computer-use acceptance and align the public API documentation.

## First file-backed note

- [ ] Port the minimal browser/native file boundary into `packages/app` without
  recreating `packages/data`. Preserve malformed and unknown authored source.
- [ ] Capture source and version from identical bytes. Implement `update(entry,
  change)` and `writeSource(entry, source)` against the observed version with
  shared preparation preserving unrelated source. Return accepted file bytes
  independently of subsequent Git and network outcomes.
- [ ] Use the existing editor buffer and baseline. Later typing stays dirty when
  an earlier save completes. File-save failure retains input; commit failure
  neither pauses autosave nor prevents baseline advancement for saved input.
- [ ] Request an eager background whole-source-folder commit after a completed
  app save by default, without delaying the accepted file result. Coordinate one
  active commit pass and one pending pass; saves during an active pass request the next
  pass. Use an independent outgoing runner so network delays do not block local
  history. No persisted queue, timed retry, watcher, writer registration,
  application-wide editing lock, or history outbox is required. Normal Git ref
  safety remains and must be verified against the actual adapter.
- [ ] Keep the history runner free of timers. Coalescing limits pending passes,
  not commit frequency. Measure continuous editing at the editor's real save
  cadence; do not delay file saves solely to compensate for Git cost.
- [ ] With the first importer or manual workflow, implement immutable runtime
  `git: { commitOnEdit: false }` open configuration, defaulting to `true`.
  Suppress only that owner's implicit commit/outgoing requests; continue status
  invalidation and explicit `commitAndPush()`. Expose the policy in the snapshot.
  Do not persist it in authored files or promise protection from other writers.
- [ ] On close, fence new history requests and settle admitted local passes.
  Cancel all not-yet-started outgoing attempts, including pending ones; request
  cancellation of active network work and retain resources until it settles.
  Report local commit success separately from skipped/cancelled outgoing work.
- [ ] Derive uncommitted status from saved source against the committed tree,
  including new/deleted files. Status and commit share source inclusion rules;
  generated indexes and private implementation data stay excluded.
- [ ] Expose `git.status()`, `git.subscribe(callback)`, and
  `git.commitAndPush()` on the opened folder. Deliver the cached snapshot
  immediately on subscription; unknown and stale observations are explicit.
  Refresh on open, focus, and explicit action. Known saves and Git changes
  invalidate observations or update them from acquired evidence. Reuse discovery
  instead of rescanning for every activity notification. A failed check retains
  stale prior observations and never claims the folder is clean.
- [ ] Coordinate one active status scan plus one pending scan. Requests during
  an active scan share the next scan. Prevent superseded results from appearing
  clean after a known change; consumers need no private async refresh cache.
- [ ] Add "Commit and push": read current saved files, commit when needed, upload
  required LFS objects, verify availability, then attempt push. With no source
  changes, still permit pushing existing local commits. Do not flush drafts or
  implicitly adopt remote changes. Distinguish file, history, and sync failures.
- [ ] After a successful automatic commit, attempt the same upload/push sequence
  when configured. Failure preserves files and local commits. No eventual retry
  or delivery is guaranteed without another explicit trigger.
- [ ] Generate subjects from the exact candidate and parent trees: one changed
  path uses `Add`, `Update`, or `Delete` with its escaped literal path; several
  use `Update N files`; no changes need no commit. Bound subjects to 72 characters
  with a count fallback. Do not infer renames, parse titles, group attachments,
  or add generated bodies, trigger hints, timestamps, or operation metadata.
  Messages never authorize recovery or promise one isolated action per commit.

## Recording integration

- [ ] Move Markdown row and same-stem audio paths during rename. Unchanged
  audio keeps the same LFS object ID. Prepare ownership/destination/reference
  checks within inspected scope; do not infer arbitrary references from strings.
- [ ] Report observable partial filesystem progress separately from history
  failure. Do not require a universal journal/fence or promise native multi-file
  atomicity. Renewed destructive attempts recheck current conditions.
- [ ] Supply stable audio bytes for playback, export, and provider input without
  mandatory media hashes, version tokens, or conditional media opens. A mutable
  lazy native path view cannot represent already captured audio.
- [ ] Separate row-input validation, audio-to-text inference, and result
  persistence/delivery. Fail missing or unusable inputs before inference. Saving
  a separate transcript does not recheck the input row or audio; updating an
  existing Markdown destination uses ordinary conditional-write protection.
  Do not recreate a deleted recording to attach a completed result.
- [ ] Keep local LFS bytes for offline use and an authenticated LFS API backed by
  Cloudflare R2 remotely. Verify uploads before publishing remote Git refs.
  Initial retention does not automatically prune historical media.

## Verification

| Sequence | Required observation |
| --- | --- |
| File save succeeds; commit fails | Saved file and advanced baseline; uncommitted status, no rollback. |
| File save fails; history is clean | Input retained and editor says not saved. |
| Type B while A saves | Only A acknowledged; B stays dirty. |
| Agent edits A; app saves B | Commit may include both; message does not promise isolated B undo. |
| Files change during commit | Captured bytes recorded; later changes eligible for next attempt. Status rechecked. |
| Branch advances concurrently | Stale ref update refuses; no forced replacement. |
| Commit succeeds; upload/push fails | Local history retained; sync remains pending. |
| Several saves arrive during a commit | One pending pass captures later files; no per-save history guarantee. |
| Continuous saves while Git is idle or busy | Eager attempts, at most one pending pass, no quiet-period timer. |
| Import through a handle with `commitOnEdit: false` | No implicit Git requests; explicit commit-and-push remains available. |
| Another enabled writer edits a manual-mode folder | The opt-out does not prevent that writer from committing saved files. |
| Close with local and outgoing work pending | Admitted local passes settle; pending pushes cancel and active network resources remain owned until settlement. |
| Push stalls while another file saves | File acknowledgement and local commit attempts continue independently. |
| Old status scan completes after a known change | It cannot replace newer observations with a false clean result. |
| Subscription begins before the first scan | Immediate delivery reports unknown observations, not a clean folder. |
| Commit and push with dirty editor | Saved files captured; draft is not implicitly flushed. |
| Native row/audio rename stops halfway | Partial state permitted and reported when observable; a commit does not repair it. |
| Capture audio A; replace path with B | Consumer continues with captured A without a media hash check. |
| Rename or delete input row during transcription | Text can still be returned and saved separately; the input row is not recreated. |
| Edit destination Markdown during transcription | A conditional destination update refuses stale source without discarding returned text. |

## Stop condition

Demonstrate one note editor with file saves, best-effort commits, and actionable
history/sync status on browser and native adapters. Measure commit/status cost,
retained bytes, and media memory with repo-derived fixtures and labeled synthetic
workloads. Reuse retained evidence where its tested contract survives; do not
present storage microbenchmarks as end-to-end durability proof.

Full release migration, remote adoption/merge semantics, production hosting/auth,
physical-phone verification, pruning, and query-index generation remain separate.
