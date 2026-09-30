# 0468. File saves succeed independently of automatic commits

- **Status:** Proposed
- **Date:** 2026-09-30
- **Implementation:** independent saves, eager automatic commit attempts, independent pushes, and actionable history status in Todos.
- **Unbuilt:** released application integration and production Git LFS storage in Cloudflare R2.

## Context

The earlier proposal required every completed app save to have a recoverable
Git commit. That coupled ordinary file publication to pending refs, durable
operation evidence, and recovery before acknowledging a save.

The desired experience is a folder of Markdown and media files that apps and
agents edit freely. Git records useful checkpoints. A failure to record history
does not undo a successful file save. Concurrent overwrites, missing intermediate
versions, and checkpoints of partial external workflows are accepted costs.

## Decision

**Files are saved data. By default, after the file operation completes, a
mutation requests an eager background Git commit and returns its accepted file
result without waiting for history or network work.**
Commit failure does not turn that save into failure or restore the previous
files. Typing remains in the editor until its save boundary; a keystroke does
not itself require a commit.

The commit captures the folder's saved portable source, including other writers'
changes. It does not certify an isolated app action or an instantaneous native
folder snapshot. Unchanged content needs no empty commit. Failure leaves current
files available for the next explicit commit attempt; overwritten intermediate
versions may never enter history. No save outbox, persisted job queue, timed
retry loop, application-wide editing lock, or writer registration is required.
Git retains its normal object and ref safety. A competing branch update must
not be overwritten through a blind forced update.

**The opened folder coordinates commit requests with one active pass and one
pending pass.** A request received during an active pass asks for the next pass:
the active pass may already have read the files. Several pending requests share
that next pass rather than creating a job for every save. This coordination
serializes this owner's Git attempts; it does not block file edits or serialize
other processes. Coalescing can omit intermediate saves from history. Messages
describe the source actually captured, not a list of supposedly isolated saves.

**Coalescing is not a timed debounce.** If the runner is idle, a request starts
work without waiting for a quiet period. If it is busy, requests share the next
pass. This bounds the backlog, not commit frequency: fast Git can create one
commit per save, while expensive discovery can run almost continuously during
sustained editing. The history layer introduces no debounce duration or timer.
Editors own their save boundaries and typing batches. Do not delay file saving
solely to reduce Git work, because that enlarges the unsaved-input window.
Production measurements must establish whether discovery or history volume
needs further work; the scratch adapter does not establish a suitable cadence.

**A proposed `git.commitOnEdit` open option defaults to `true` and is fixed for
the opened owner's lifetime.** Setting it to `false` suppresses that handle's
implicit commit and outgoing requests. File results and status invalidation
still work; explicit `git.commitAndPush()` remains available. An importer or CLI
can save several files and then request one explicit attempt. The option is
runtime configuration, not authored folder data or a global editing mode.
Another enabled handle or external Git tool can still commit those files.
No mutable toggle, scoped suspension, or timing option is introduced. The native
Todos CLI opens with automatic commits disabled and explicitly commits and
pushes its completed changes. `git.commit()` attempts only the local commit;
`git.commitAndPush()` explicitly requests both stages.

Outgoing work has an independent runner with one active attempt and one pending
request. Each attempt captures the commit it will push; a later pass reads the
latest local commit. A slow upload or push does not block local commit attempts.
Failure is reported without a timed retry. A later save or explicit action may
request another attempt; nothing promises an eventual commit or delivery.

**History status describes current saved files against the latest commit.**
Use "Uncommitted changes", not "Unstaged changes": modified, deleted, new,
and already staged source may differ from committed history. The status uses
the same portable-source inclusion rules as committing. Generated indexes,
private receipts, credentials, and known implementation scratch files are not
portable source. Malformed authored source remains saved data.

Refresh status on opening, returning to the app, and explicit action. Known
saves and Git changes invalidate affected observations. Reuse commit discovery
when it provides the required observation; activity notifications do not require
another full scan. A successful commit can coexist with newer uncommitted edits.
Without continuous observation, status describes the latest check. A failed
status read must not appear as a clean folder. ADR-0471 records the shared status
snapshot and its explicit refresh and subscription API.

**The explicit recovery action is "Commit and push".** It reads current saved
source, attempts a commit when changes exist, uploads required Git LFS objects,
verifies their availability, and then attempts to push the Git commits. If
there is nothing to commit, it can still push existing local commits. A successful
automatic commit also attempts this upload-and-push sequence when a remote is
configured. Network work does not hold an application editing lock. Failure
leaves saved files and local commits intact; a later explicit attempt catches up.
No future attempt or eventual delivery is guaranteed.

`folder.git.commitAndPush()` is the awaitable API for this explicit action.
Its result distinguishes commit and upload/push outcomes, including nothing to
commit, no configured remote, and a skipped push after commit failure. A request
made during an active commit waits for the requested next pass, not an earlier
pass that may exclude the current files. The push result identifies the commit
actually attempted; later local edits do not turn that outcome into proof that
the entire folder is synchronized. Ordinary file methods return no per-save
Git receipt or promise that their exact accepted bytes entered a commit.

Network attempts need deadlines and cancellation supported by their transport.
A caller timing out does not prove the underlying work stopped. A running slot
stays occupied until its work settles; a timeout cannot admit overlapping Git
work. File storage, hooks, signing, and transports can delay completion. This
decision promises neither a universal commit deadline nor that every backend
can cancel an in-flight commit.

Closing fences new requests and settles admitted local commit passes. It cancels
all outgoing attempts that have not started, including already pending ones;
commits finishing during close do not start automatic uploads or pushes. Active
network work receives cancellation through the owner's signal and stays owned
until it actually settles. An explicit command reports its local commit outcome
and skipped or cancelled outgoing work separately. Close cannot claim completion
while work still uses acquired resources, and has no universal duration bound.
Saved files and local commits remain available for a later owner's attempt.

The action does not save editor drafts or apply incoming remote changes.
Remote adoption and merge semantics require their own explicit design. Saved,
uncommitted, and not synced are separate facts, even when one control attempts
both commit and push. Report actual file-save failure in the editor, commit
failure in history status, and upload/push failure in sync status.

**Use Git LFS for media, with a local object copy and Cloudflare R2 for remote
objects.** Working files and complete saved-folder copies contain actual media.
Git stores pointer blobs; the authenticated LFS API authorizes R2 transfers.
Renaming unchanged media changes its tree path, not its LFS SHA-256 object ID,
and needs no new payload upload. R2 does not itself implement the LFS protocol.
Git object reachability alone does not retain LFS payloads; retained history
needs the corresponding media. Initial retention does not automatically prune
old media. Compaction and permanent erasure are separate decisions.

Native apps and agents can edit concurrently without an application-wide lock.
A stale-source check is a local safeguard, not operating-system-wide isolation.
Related-file operations can stop partway through, and a later commit can capture
that state. An editor buffer retains only the text it still owns; it is not
durable recovery after disposal, closing, or reload. Existing Yjs applications
keep their current implementation until deliberately migrated.

## Consequences

- The usual app-only path leaves no uncommitted source after a successful commit
  attempt. Concurrent edits or failures can leave changes; an attempted push
  does not establish remote synchronization.
- Ordinary saves need no pending-ref journal solely to complete history.
- With automatic commits disabled, uncommitted source is an expected state;
  local history and outgoing backup depend on an explicit action or another
  writer. The shared snapshot exposes the immutable policy to consumers.
- Agents need not commit before another writer can checkpoint their saved files.
  Uncommitted source is not a protected draft area.
- Commits and their messages cannot promise that reverting a commit undoes only
  the app action that triggered it.
- Related-file publication, media capture, and remote adoption must report their
  actual outcomes. A commit neither completes nor repairs a partial rename.
- Discovery cost depends on the filesystem adapter. Browser background promises
  do not move CPU work off the main thread. Production adapter performance,
  history growth, and the LFS integration still need validation.

## Measurement evidence

Scratch measurements on 2026-09-30 changed one approximately 1,985-byte Markdown
note per sample. These are warm-run medians, not latency guarantees:

| Environment | Notes | Discover changes | Create commit | Discover, stage changed files, and commit |
| --- | ---: | ---: | ---: | ---: |
| Native Git on macOS | 1,000 | 28 ms | 49 ms | 103 ms |
| Native Git on macOS | 10,000 | 39 ms | 57 ms | 127 ms |
| Chrome, isomorphic-git 1.38.5, scratch IndexedDB filesystem | 1,000 | 373 ms | 10 ms | 389 ms |
| Chrome, isomorphic-git 1.38.5, scratch IndexedDB filesystem | 10,000 | 10.6 s | 75 ms | 10.8 s |

Native runs used nine samples per size with hooks and signing disabled. Browser
runs used seven samples and an adapter with individual IndexedDB transactions
for filesystem reads, not the Epicenter production adapter or LightningFS.
Initial creation, initial commits, LFS uploads, and remote pushes were excluded.
The browser's maximum observed gap in a 10 ms timer was 218 ms at 10,000 notes.
These results justify separating file acknowledgement from history completion
and avoiding periodic full scans. They do not validate production Git ref
concurrency, power-loss durability, or transport cancellation.

## Considered alternatives

- Require a commit before acknowledging every save. It restores durable pending
  operations and recovery for a history guarantee the user declined.
- Await commit and push in every file method. Filesystem discovery and network
  delays would hold the file result even after the edit was accepted.
- Watch arbitrary writers and schedule catch-up commits. Explicit app save and
  user action boundaries remove the need to infer when another writer finished.
- Add a configurable trailing commit debounce. It introduces pending timers,
  explicit bypass, close behavior, and a maximum wait to prevent continuous
  editing from postponing history indefinitely. Eager coalescing keeps the
  initial design free of that scheduling machinery.
- Make every caller commit manually. It removes automatic runners but makes
  ordinary users responsible for remembering history and outgoing backup.
- Commit only app-attributed changes. It requires attribution and does not
  isolate edits when several writers change the same file.
- Roll back saved files after commit failure. It discards a successful edit and
  can overwrite a newer writer's changes.
