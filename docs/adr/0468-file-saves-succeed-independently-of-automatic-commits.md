# 0468. File saves succeed independently of automatic commits

- **Status:** Accepted
- **Date:** 2026-09-30
- **Amended by:** [ADR-0529](0529-commits-happen-only-on-sync-or-when-a-person-saves-a-version.md): saves no longer request automatic commits; a commit happens only when sync checkpoints or a person saves a version. Save independence and separate outcome reporting remain.

## Context

The earlier proposal required every completed app save to have a recoverable
Git commit. That coupled ordinary file publication to pending refs, durable
operation evidence, and recovery before acknowledging a save.

The desired experience is a folder of Markdown and media files that apps and
agents edit freely. Git records useful checkpoints. A failure to record history
does not undo a successful file save. Concurrent overwrites, missing intermediate
versions, and checkpoints of partial external workflows are accepted costs.

## Decision

**Files are saved data; Git checkpoints need not retain every saved version.**
A successful mutation returns its file-publication result without waiting for
history or network work. A commit failure does not undo that save. Drafts,
received provider results and unconfirmed file operations remain app-owned work
until published, reconciled or explicitly discarded. Git cannot rediscover
content that exists only in memory.

For example, a note can be saved as A, then B, then C before a checkpoint.
The current file contains C. The next successful checkpoint may record only C;
A and B need not be recoverable. If the app closes before that checkpoint,
C remains saved. A later edit or explicit action can checkpoint it. This is history of
checkpoints, not an audit log of saves.

**A successful managed edit attempts history without scheduling future work.**
After file publication, the owner starts a background checkpoint attempt when
automatic history is enabled. An unavailable runner or shared lock skips the
attempt, with no pending pass, rerun bit, retry timer or catch-up promise.
A later successful edit or explicit action rediscovers current saved files.
Individual public operations request history independently under ADR-0482.
An incomplete Git incoming record refuses checkpoints until explicit recovery
completes; ordinary multi-file app workflows impose no such hold. There is no periodic trigger, debounce or final close checkpoint.

Ownership is local resource ownership, not a globally elected leader.
Owners that address the same stored folder share Git exclusion. An automatic
attempt must atomically acquire that exclusion without waiting; checking a busy
flag before a separate acquisition is insufficient. No leader registry,
election, failover or queued automatic retry is required. The owner observes
background failures and exposes history status; fire-and-forget describes the
save caller's independence, not an unhandled promise or abandoned resources.

If the last attempt is skipped or fails, saved files may remain uncommitted
indefinitely until another managed edit or explicit action. External edits alone
need not trigger automatic history. Opening or refreshing a folder does not
promise an automatic checkpoint.

The checkpoint includes current portable source, including other writers'
changes. It does not certify one app action or an instantaneous native folder
snapshot. Unchanged content needs no empty commit. Several saves can enter one
checkpoint; intermediate bytes may never enter history. A later attempt can
also fail, so eventual history and remote delivery are not guaranteed.

**Automatic history has no future scheduling obligation.**
The owner can retain a running operation to protect resources and prevent
unsafe overlap. It retains no automatic request for execution afterward.
Automatic history stays local even when a remote exists. Only an explicit
push or commit-and-push request starts outgoing transport. A failed push needs
no remembered pending-push request: a later explicit request discovers outgoing
commits from Git.
Local commits and outgoing transport remain independent so a slow push does
not hold file publication. Whether an explicit concurrent action refuses as
busy or joins compatible work must be verified against callers; it must not
silently promise a later automatic pass.

Automatic history is one owner-wide policy for table, KV, file and terminal
changes. Its enablement remains `commitOnEdit`: it requests a best-effort
attempt, not a promise that every edit enters history. Native shell configuration owns
native policy; browser acquisition configures its owner. Explicit commit and
push controls remain available when automatic history is disabled. Staged
manual authoring requires automatic whole-folder checkpoints to be disabled.
Empty directories have no Git tree content. Confirmed files from an unfinished
application workflow may enter a later checkpoint without repairing that
workflow. Incoming Git adoption uses ADR-0474's distinct checkpoint hold.

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

Refreshing the display does not retry a file mutation. An app with an
unconfirmed publication must reconcile its original target before retrying.
Saved uncommitted files need only a history attempt; unpublished drafts or
provider output still need file publication. Neither state requires replaying
the provider request or the original application workflow.

**The explicit outgoing-history recovery action is "Commit and push".** It reads current saved
source, attempts a commit when changes exist, and then attempts to push the Git
commits and their ordinary file objects. If there is nothing to commit, it can
still push existing local commits. Automatic commits never attempt a push.
Network work does not hold an application
editing lock. Failure
leaves saved files and local commits intact; a later explicit attempt catches up.
No future attempt or eventual delivery is guaranteed.

`folder.git.commitAndPush()` is the awaitable API for this explicit action.
Its result distinguishes commit and push outcomes, including nothing to
commit, no configured remote, and a skipped push after commit failure.
A concurrent explicit request must report its actual admission outcome;
it cannot claim a checkpoint containing changes an earlier attempt did not read.
The push result identifies the commit
actually attempted; later local edits do not turn that outcome into proof that
the entire folder is synchronized. Ordinary file methods return no per-save
Git receipt or promise that their exact accepted bytes entered a commit.

Network attempts need deadlines and cancellation supported by their transport.
A caller timing out does not prove the underlying work stopped. A running slot
stays occupied until its work settles; a timeout cannot admit overlapping Git
work. File storage, hooks, signing, and transports can delay completion. This
decision promises neither a universal commit deadline nor that every backend
can cancel an in-flight commit.

**Closing does not require a final automatic checkpoint.**
Close fences new requests. It retains ownership
of active operations until they settle or safely cancel before releasing their
resources. It creates no last-minute commit or push obligation. Application
close still protects unsaved drafts, admitted writes, uncertain mutations and
received provider outputs. Saved uncommitted files remain available on reopening.

**Publication success survives observation failure.**
After a Git ref update succeeds, the operation retains its committed outcome
and actual commit identity. A later failed status refresh reports an observation
problem; it cannot reclassify the published commit as failed. Newer edits can
already make the folder uncommitted again without invalidating that receipt.

The action does not save editor drafts or apply incoming remote changes.
Remote adoption and merge follow ADR-0474's explicit actions. Saved,
uncommitted, and not synced are separate facts, even when one control attempts
both commit and push. Report actual file-save failure in the editor, commit
failure in history status, and upload/push failure in sync status.

**The initial history backend records included media as ordinary Git file objects.**
Text and binary files use the same history policy and source-selection rules.
The backend introduces no asset namespace, media immutability rule, separate
upload service, or lazy hydration. Remotes are optional. Managed plain-byte
checkpoints and incoming adoption must refuse unsupported attribute
transformations; this does not claim to disable filters in ordinary Git commands.

Applications or people may author Git ignore rules. Ignored untracked media
does not enter Git history or reach another device through Git synchronization.
That is an explicit product or repository choice, not a folder-wide audio
default or extension whitelist. Native Git also reads repository-local and
global excludes; the browser currently interprets folder `.gitignore` files.
Complete current-state backup has a separate inclusion rule under ADR-0481.

LFS, a hosted media service, and lazy payload availability are deferred whole
capabilities. Supporting them later requires coherent object transfer,
materialization, and historical retention, not an attribute toggle. They are
not prerequisites for the ordinary-file API. A remote's refusal of a binary
object can block the branch's push, including its text changes; it remains a
push failure and never reverses the saved files or local commit.

Native apps and agents can edit concurrently without an application-wide lock.
A stale-source check is a local safeguard, not operating-system-wide isolation.
Related-file operations can stop partway through, and a later commit can capture
that state. An editor buffer retains only the text it still owns; it is not
durable recovery after disposal, closing, or reload. Existing Yjs applications
keep their current implementation until deliberately migrated.

## Consequences

- Saved uncommitted source is expected between checkpoints. Failed or skipped
  attempts can leave it uncommitted after close; a push attempt does not establish
  remote synchronization.
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
  history growth, and binary transfer cost still need validation.

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
and measuring the production adapter's automatic-attempt cost. The production
browser adapter now stores files in OPFS (ADR-0497), which these runs did not
measure.
They do not validate production Git ref
concurrency, power-loss durability, or transport cancellation.

## Considered alternatives

- Require a commit before acknowledging every save. It restores durable pending
  operations and recovery for a history guarantee the user declined.
- Await commit and push in every file method. Filesystem discovery and network
  delays would hold the file result even after the edit was accepted.
- Watch arbitrary writers and schedule catch-up commits. Managed publication
  and explicit actions provide trigger boundaries; observation hints remain
  useful for refreshing app views without promising automatic history.
- Remember one pending pass during an active attempt. It restores a scheduling
  obligation the chosen best-effort contract does not require.
- Add a trailing per-edit debounce. It retains edit-triggered timer state and
  close-flush promises the chosen immediate-attempt model does not require.
- Periodically checkpoint current files. It can discover external edits and
  retry skipped work without an outbox, but introduces a timer, repeated idle
  discovery and timer lifecycle. The chosen contract accepts uncommitted files
  without automatic catch-up, so those mechanisms are unnecessary.
- Make every caller commit manually. It removes automatic runners but makes
  ordinary users responsible for remembering history and outgoing backup.
- Commit only app-attributed changes. It requires attribution and does not
  isolate edits when several writers change the same file.
- Roll back saved files after commit failure. It discards a successful edit and
  can overwrite a newer writer's changes.
