//! The one owner of a native folder.
//!
//! Every window of a shell shares one `FolderOwner` per root, so they share
//! one file gate and one Git snapshot. The owner outlives any window:
//! a save it admitted lands, and a commit it admitted finishes, whether or
//! not the page that asked is still there.
//!
//! Two independent gates order its work, and they are never held together in
//! the wrong order:
//!
//! - The **file gate** admits one publication at a time: a complete `apply`
//!   batch, a directory change, or a fast-forward's file changes. It is held
//!   for that one publication and never across calls.
//! - The **Git lock** serializes work on the index and the branch: commits,
//!   staging, staged commits, and a fast-forward's ref update.
//!
//! A commit holds both: the file gate, then the Git lock. Under them it pins
//! the branch head, enumerates the folder, and hard-links every file into a
//! snapshot. It then releases the file gate and, still under the Git lock,
//! hashes the snapshot and publishes with a compare-and-swap. So a save never
//! waits for hashing, and no batch of this owner is ever seen half applied. A
//! save that lands after the snapshot is simply newer than it: the
//! observation is marked stale. A branch another Git process moved fails the
//! compare-and-swap and is reported; there is no retry.
//!
//! A save never asks for a commit. History is recorded only when a caller
//! asks for a commit of the whole folder or a staged commit. There is no
//! commit at shutdown.
//!
//! An explicit commit or fast-forward waits. It takes the file gate and then
//! tries the Git lock. If the Git lock is held it gives the gate back, waits
//! for the Git lock to be released, and starts over, so it reads the folder
//! as it is once it holds both. Nothing takes the two in the other order, and
//! nothing waits for either while it holds the other.
//!
//! Neither gate spans calls. One caller's commands interleave with every
//! other caller's, a terminal command's steps included. A write that depends
//! on an earlier read carries the SHA-256 it read and is refused if the file
//! changed since.
//!
//! The gate is not first come, first served, and a save can be delayed
//! anywhere before it, including before it reaches this process. Saves are
//! not ordered by when they were asked for: the last save to land on a path
//! wins, whichever caller sent it, and a delivery that arrives late or twice
//! lands like any other. A caller that must not overwrite newer bytes guards
//! its change with `expectedSha256`.
//!
//! The snapshot is exact against this owner's own writes, which replace files
//! by rename or link. A program that edits a file in place can still change
//! bytes the snapshot links to: that stays best effort.
//!
//! Network work runs outside both: a push or fetch in flight delays no save
//! and no commit. Listeners are called with a copy of the listener list; the
//! plugin's listener only queues the event.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, TryLockError, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use unicode_normalization::UnicodeNormalization;

use crate::files::{
    resolve_root, verify_layout, ApplyError, Children, FileChange, FileError,
    FileListing, FileRead, FileStep, Files,
};
use crate::git::{Author, Capture, Cas, CommitSummary, Git, IndexCommit, PathStatus, Remote};
use crate::history::{
    Activities, Activity, Attempt, CommitOutcome, FetchOutcome, FilesObservation, GitError,
    GitSnapshot, MergeError, MergeOutcome, MergePolicy, Observation, OwnerEvent, PendingIncoming,
    PullError, PullOutcome, PushOutcome, RecoverOutcome, StagedCommit, SyncObservation,
};
use crate::incoming::{self, Record, Written};
use crate::merge::{self, Prepared};
use crate::messages::{commit_subject, message_problem, ChangeKind};
use crate::paths::{ancestors, is_portable_path, path_problem};
use crate::runner::{CloseMode, Endings, Leaving, PassRunner};

mod recovery;

#[derive(Debug, Clone)]
pub struct FolderConfig {
    /// The folder's directory, chosen by the shell. A Git repository is
    /// initialized there if absent.
    pub root: PathBuf,
    /// The local branch history is recorded on.
    pub branch: String,
    /// Author and committer for whole-folder and staged commits.
    pub author: Author,
    pub remote: Option<Remote>,
    /// Whether the repository's own `user.name` and `user.email` decide who
    /// commits. They are read once, when the folder opens, after its lock is
    /// held and its layout verified; `author` supplies whichever of the two
    /// is not configured.
    pub use_repository_author: bool,
    /// Whether the repository's own `remote.origin.url` decides where history
    /// is pushed and fetched. It is read at the same point as the author. A
    /// repository with no `origin` keeps `remote`, which is honored whether
    /// or not this is set. The branch stays `branch`.
    ///
    /// Reading a remote enables explicit transfers, never automatic pushing.
    pub use_repository_origin: bool,
    /// Whether filesystem events are watched, so a change made outside the
    /// owner is noticed at once, even one that leaves size and time as they
    /// were. Where watching is unavailable the owner says so and relies on
    /// `watch_interval`.
    pub watch_events: bool,
    /// How often the owner compares file sizes and times to find changes made
    /// outside it, whether or not an event announced them. `None` disables
    /// the periodic check; `poll_external` still works.
    pub watch_interval: Option<Duration>,
    /// Whether the page opens this folder with `@epicenter/folder`'s own
    /// engine instead of this owner. The registry then never opens an owner
    /// for the scope: `Registry::grant` takes the folder's lock and hands the
    /// page its directory, which the page reads and writes through the
    /// shell's file system plugin. Every other field but `root`, `author`,
    /// and `branch` is the page engine's business, read from the repository.
    pub page_engine: bool,
}

impl FolderConfig {
    pub fn new(root: impl Into<PathBuf>, author: Author) -> Self {
        Self {
            root: root.into(),
            branch: "main".to_string(),
            author,
            remote: None,
            use_repository_author: false,
            use_repository_origin: false,
            watch_events: true,
            watch_interval: Some(Duration::from_secs(2)),
            page_engine: false,
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Case- and Unicode-folded spelling used only to detect destinations that
/// cannot coexist on case-insensitive filesystems. Never used for lookup.
pub(crate) fn collision_key(path: &str) -> String {
    path.nfc().collect::<String>().to_lowercase()
}

/// Take a lock only if nothing holds it right now.
fn try_lock(mutex: &Mutex<()>) -> Option<MutexGuard<'_, ()>> {
    match mutex.try_lock() {
        Ok(held) => Some(held),
        Err(TryLockError::Poisoned(poisoned)) => Some(poisoned.into_inner()),
        Err(TryLockError::WouldBlock) => None,
    }
}

// ============================================================================
// Owner state
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Stamp {
    size: u64,
    modified: Option<u128>,
}

#[derive(Default)]
struct Watch {
    primed: bool,
    stamps: BTreeMap<String, Stamp>,
    refs: String,
}

/// What filesystem events have announced since the watcher last looked.
#[derive(Default)]
struct Hints {
    paths: BTreeSet<String>,
    /// `HEAD`, the index, or a ref changed.
    git: bool,
}

struct HistoryState {
    /// Orders captures against edits. An observation captured at `n` is stale
    /// once an edit lands at a later tick.
    clock: u64,
    last_edit: u64,
    files: Observation<FilesObservation>,
    files_captured_at: u64,
    sync: Observation<SyncObservation>,
    last_commit: Option<Attempt<CommitOutcome>>,
    last_push: Option<Attempt<PushOutcome>>,
    last_fetch: Option<Attempt<Result<FetchOutcome, GitError>>>,
    last_pull: Option<Attempt<Result<PullOutcome, PullError>>>,
    last_merge: Option<Attempt<Result<MergeOutcome, MergeError>>>,
    remote_sequence: u64,
    /// The incoming record as last read: at opening, by status, and by every
    /// incoming update and recovery.
    pending_incoming: Option<PendingIncoming>,
}

type Listener = Arc<dyn Fn(&OwnerEvent) + Send + Sync>;

struct Emitted {
    sequence: u64,
    snapshot: Arc<GitSnapshot>,
}

#[cfg(test)]
#[derive(Default)]
pub(crate) struct Hooks {
    /// Runs inside an admitted `apply`, before the file gate.
    pub before_apply: Option<Arc<dyn Fn() + Send + Sync>>,
    /// Runs inside a commit while it holds the file gate and the Git lock,
    /// before it snapshots the folder.
    pub during_snapshot: Option<Arc<dyn Fn() + Send + Sync>>,
    /// Runs inside a commit under the Git lock, after the file gate was
    /// released, before the snapshot is hashed.
    pub before_hash: Option<Arc<dyn Fn() + Send + Sync>>,
    /// Runs inside a commit under the Git lock, after the snapshot was
    /// hashed, before the commit is published.
    pub after_capture: Option<Arc<dyn Fn() + Send + Sync>>,
    /// Runs inside a fast-forward after the folder was found clean, before
    /// its file changes are built.
    pub during_pull: Option<Arc<dyn Fn() + Send + Sync>>,
    /// Runs inside an admitted push, once its commit is pinned, before the
    /// transport starts.
    pub during_push: Option<Arc<dyn Fn() + Send + Sync>>,
    /// Runs inside an admitted fetch, before the transport starts.
    pub during_fetch: Option<Arc<dyn Fn() + Send + Sync>>,
    /// Asked at each boundary of an incoming update or its recovery, named
    /// as in `Inner::boundary`. Returning `true` stops the update right
    /// there, as a process that stopped would: nothing after it runs and
    /// nothing is cleaned up.
    pub incoming_boundary: Option<Arc<dyn Fn(&str) -> bool + Send + Sync>>,
}

struct Inner {
    config: FolderConfig,
    root: PathBuf,
    files: Files,
    git: Git,
    /// Held by one publication at a time, and by a commit or a scan while it
    /// snapshots the folder.
    file_gate: Mutex<()>,
    git_lock: Mutex<()>,
    state: Mutex<HistoryState>,
    emitted: Mutex<Emitted>,
    listeners: Mutex<Vec<(u64, Listener)>>,
    next_listener: AtomicU64,
    /// Counts admitted file and Git operations still running.
    admitted: Mutex<usize>,
    settled: Condvar,
    /// New work is refused.
    closing: AtomicBool,
    shutdown: Mutex<bool>,
    /// Commits and fast-forwards that were admitted and have not settled, for
    /// the snapshot's activity.
    commits: AtomicUsize,
    pulls: AtomicUsize,
    merges: AtomicUsize,
    revision: AtomicU64,
    own_in_flight: AtomicUsize,
    own_done: AtomicU64,
    watch: Mutex<Watch>,
    watching: Arc<AtomicBool>,
    hints: Mutex<Hints>,
    hinted: Condvar,
    /// The filesystem watcher, until shutdown releases it.
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
    /// Why filesystem events are not being watched, when they are not.
    watch_diagnostic: Mutex<Option<String>>,
    scan: PassRunner<Result<FilesObservation, GitError>>,
    push: PassRunner<PushOutcome>,
    fetch: PassRunner<Result<FetchOutcome, GitError>>,
    #[cfg(test)]
    hooks: Mutex<Hooks>,
    /// How many relevant announcements arrived, for telling "no event came"
    /// from "an event came and was ignored" in tests.
    #[cfg(test)]
    announced: AtomicU64,
}

struct Admission<'a>(&'a Inner);

impl Drop for Admission<'_> {
    fn drop(&mut self) {
        *lock(&self.0.admitted) -= 1;
        self.0.settled.notify_all();
    }
}

/// One admitted commit or fast-forward, counted as active from its admission,
/// including any wait for the gates, until it settles.
struct Running<'a>(&'a Inner, &'a AtomicUsize);

impl Drop for Running<'_> {
    fn drop(&mut self) {
        self.1.fetch_sub(1, Ordering::SeqCst);
        self.0.emit();
    }
}

/// Stops listening when dropped.
pub struct Subscription {
    owner: Weak<Inner>,
    id: u64,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.upgrade() {
            lock(&owner.listeners).retain(|(id, _)| *id != self.id);
        }
    }
}

/// One caller's push or fetch, from before it asks until it has its answer.
/// Dropping it withdraws the caller: a push or fetch still waiting behind
/// another never starts for it, and one that names it later is refused. A
/// transport the owner already started is not affected and runs to its end.
pub struct Request {
    owner: Weak<Inner>,
    caller: Caller,
}

/// How `push` and `fetch` know the request they run for. A push and a fetch
/// are ordered by different runners, so each has its own way to leave, read
/// and written only under its own runner's lock. Withdrawing the push side
/// says nothing to a waiting fetch, and the other way round: a fetch is told
/// it was withdrawn only by the lock that also took it out of the queue.
#[derive(Clone)]
pub struct Caller {
    push: Arc<Leaving>,
    fetch: Arc<Leaving>,
}

impl Request {
    /// What `push` or `fetch` is given to run on this request's behalf.
    pub fn caller(&self) -> Caller {
        self.caller.clone()
    }
}

impl Drop for Request {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.upgrade() {
            owner.push.withdraw(&self.caller.push);
            owner.fetch.withdraw(&self.caller.fetch);
        }
    }
}

#[derive(Clone)]
pub struct FolderOwner {
    inner: Arc<Inner>,
}

fn pass<T: Clone + Send + 'static>(
    name: &str,
    owner: &Weak<Inner>,
    endings: Endings<T>,
    run: fn(&Inner, &AtomicBool) -> T,
) -> PassRunner<T> {
    let closed = endings.closed;
    let running = owner.clone();
    let changed = owner.clone();
    PassRunner::new(
        name,
        endings,
        move |cancel| match running.upgrade() {
            Some(inner) => run(&inner, cancel),
            None => closed(),
        },
        move || {
            if let Some(inner) = changed.upgrade() {
                inner.emit();
            }
        },
    )
}

impl FolderOwner {
    /// Open the folder at `config.root`. The caller already holds the
    /// cross-process lock for the canonical root.
    pub fn open(mut config: FolderConfig) -> Result<Self, String> {
        let root = resolve_root(&config.root)?;
        // Before any Git command, including the configuration reads below: a
        // linked `.git` would send them to someone else's repository.
        verify_layout(&root)?;
        let mut git = Git::open(&root, &config.branch, config.remote.clone())?;
        // `git init` may just have created the private layout; check what it left.
        verify_layout(&root)?;
        // A directory someone already gave an identity or a remote keeps
        // them, as the `git` command line would, where the shell asked for
        // that. Each is asked for on its own.
        if config.use_repository_author {
            if let Some(name) = git.configured("user.name")? {
                config.author.name = name;
            }
            if let Some(email) = git.configured("user.email")? {
                config.author.email = email;
            }
        }
        if config.use_repository_origin {
            if let Some(url) = git.configured("remote.origin.url")? {
                config.remote = Some(Remote {
                    url,
                    branch: config.branch.clone(),
                });
                git = Git::open(&root, &config.branch, config.remote.clone())?;
            }
        }
        git.clear_snapshots();
        // An update an earlier process left is reported, never resumed.
        let pending_incoming = incoming::read(git.gitdir()).pending();
        let watching = Arc::new(AtomicBool::new(true));
        let inner = Arc::new_cyclic(|owner: &Weak<Inner>| Inner {
            files: Files::new(&root),
            file_gate: Mutex::new(()),
            git_lock: Mutex::new(()),
            state: Mutex::new(HistoryState {
                clock: 0,
                last_edit: 0,
                files: Observation::Unknown { error: None },
                files_captured_at: 0,
                sync: Observation::Unknown { error: None },
                last_commit: None,
                last_push: None,
                last_fetch: None,
                last_pull: None,
                last_merge: None,
                remote_sequence: 0,
                pending_incoming: pending_incoming.clone(),
            }),
            emitted: Mutex::new(Emitted {
                sequence: 0,
                snapshot: Arc::new(GitSnapshot {
                    branch: git.branch.clone(),
                    remote: git.remote.clone(),
                    files: Observation::Unknown { error: None },
                    sync: Observation::Unknown { error: None },
                    activity: Activities::default(),
                    last_commit: None,
                    last_push: None,
                    last_fetch: None,
                    last_pull: None,
                    last_merge: None,
                    pending_incoming,
                    closed: false,
                }),
            }),
            listeners: Mutex::new(Vec::new()),
            next_listener: AtomicU64::new(1),
            admitted: Mutex::new(0),
            settled: Condvar::new(),
            closing: AtomicBool::new(false),
            shutdown: Mutex::new(false),
            commits: AtomicUsize::new(0),
            pulls: AtomicUsize::new(0),
            merges: AtomicUsize::new(0),
            revision: AtomicU64::new(0),
            own_in_flight: AtomicUsize::new(0),
            own_done: AtomicU64::new(0),
            watch: Mutex::new(Watch::default()),
            watching: Arc::clone(&watching),
            hints: Mutex::new(Hints::default()),
            hinted: Condvar::new(),
            watcher: Mutex::new(None),
            watch_diagnostic: Mutex::new(None),
            scan: pass(
                "scan",
                owner,
                Endings {
                    failed: |cause| Err(GitError::failed("status", cause)),
                    closed: || Err(GitError::Closed),
                    cancelled: || Err(GitError::Closed),
                    withdrawn: || Err(GitError::Withdrawn),
                },
                |inner, _| inner.run_scan(),
            ),
            push: pass(
                "push",
                owner,
                Endings {
                    // A pass that panicked may already have sent the commit.
                    failed: |error| PushOutcome::Unconfirmed { error },
                    closed: || PushOutcome::Closed,
                    cancelled: || PushOutcome::Cancelled { oid: None },
                    // No commit was pinned and nothing was sent.
                    withdrawn: || PushOutcome::Cancelled { oid: None },
                },
                Inner::run_push,
            ),
            fetch: pass(
                "fetch",
                owner,
                Endings {
                    failed: |cause| Err(GitError::failed("fetch", cause)),
                    closed: || Err(GitError::Closed),
                    cancelled: || Err(GitError::Closed),
                    withdrawn: || Err(GitError::Withdrawn),
                },
                Inner::run_fetch,
            ),
            #[cfg(test)]
            hooks: Mutex::new(Hooks::default()),
            #[cfg(test)]
            announced: AtomicU64::new(0),
            git,
            root,
            config,
        });
        inner.poll_external();
        if inner.config.watch_events {
            if let Err(cause) = inner.watch_events(Arc::downgrade(&inner)) {
                // Not fatal: the periodic comparison still finds most changes.
                // It cannot see an edit that restores size and time, so say so.
                let diagnostic = format!(
                    "filesystem events are not being watched for {}: {cause}; outside changes are found by periodic comparison only",
                    inner.root.display()
                );
                log::warn!("{diagnostic}");
                *lock(&inner.watch_diagnostic) = Some(diagnostic);
            }
        }
        if inner.config.watch_events || inner.config.watch_interval.is_some() {
            let owner = Arc::downgrade(&inner);
            let interval = inner.config.watch_interval;
            std::thread::Builder::new()
                .name("folder-watch".to_string())
                .spawn(move || {
                    let mut compared = Instant::now();
                    while watching.load(Ordering::SeqCst) {
                        let Some(inner) = owner.upgrade() else { return };
                        let announced = {
                            let hints = lock(&inner.hints);
                            let wait = interval
                                .map(|interval| interval.saturating_sub(compared.elapsed()))
                                .unwrap_or(Duration::from_millis(500))
                                .min(Duration::from_millis(500));
                            let mut hints = if hints.paths.is_empty() && !hints.git {
                                inner
                                    .hinted
                                    .wait_timeout(hints, wait)
                                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                                    .0
                            } else {
                                hints
                            };
                            std::mem::take(&mut *hints)
                        };
                        if !watching.load(Ordering::SeqCst) {
                            return;
                        }
                        if !announced.paths.is_empty() || announced.git {
                            inner.heed(announced);
                        }
                        if interval.is_some_and(|interval| compared.elapsed() >= interval) {
                            compared = Instant::now();
                            inner.poll_external();
                        }
                    }
                })
                .map_err(|cause| format!("the folder watcher could not start: {cause}"))?;
        }
        Ok(Self { inner })
    }

    /// Why filesystem events are not being watched, if they were asked for
    /// and could not be. Changes are then found by periodic comparison only.
    pub fn watch_diagnostic(&self) -> Option<String> {
        lock(&self.inner.watch_diagnostic).clone()
    }

    /// Who commits, after the repository's own configuration was applied.
    pub fn author(&self) -> &Author {
        &self.inner.config.author
    }

    /// The canonical root this owner holds.
    pub fn root(&self) -> &Path {
        &self.inner.root
    }

    pub fn snapshot(&self) -> Arc<GitSnapshot> {
        Arc::clone(&lock(&self.inner.emitted).snapshot)
    }

    /// The current snapshot with its sequence number. A listener that
    /// subscribed first can drop any event numbered at or below it.
    pub fn sequenced_snapshot(&self) -> (u64, Arc<GitSnapshot>) {
        let emitted = lock(&self.inner.emitted);
        (emitted.sequence, Arc::clone(&emitted.snapshot))
    }

    /// Hear every later event. The current snapshot comes from `snapshot`.
    pub fn subscribe(
        &self,
        listener: impl Fn(&OwnerEvent) + Send + Sync + 'static,
    ) -> Subscription {
        let id = self.inner.next_listener.fetch_add(1, Ordering::SeqCst);
        lock(&self.inner.listeners).push((id, Arc::new(listener)));
        Subscription {
            owner: Arc::downgrade(&self.inner),
            id,
        }
    }

    // ------------------------------------------------------------------
    // Files
    // ------------------------------------------------------------------

    pub fn list(&self) -> Result<FileListing, FileError> {
        let _admitted = self.inner.admit()?;
        self.inner.files.list()
    }

    pub fn children(&self, directory: &str) -> Result<Children, FileError> {
        let _admitted = self.inner.admit()?;
        self.inner.files.children(directory)
    }

    pub fn read(&self, path: &str) -> Result<FileRead, FileError> {
        let _admitted = self.inner.admit()?;
        self.inner.files.read(path)
    }

    /// Reads several files; a missing or unreadable path is reported by path.
    pub fn read_many(
        &self,
        paths: &[String],
    ) -> Result<Vec<Result<FileRead, FileError>>, FileError> {
        let _admitted = self.inner.admit()?;
        Ok(paths
            .iter()
            .map(|path| self.inner.files.read(path))
            .collect())
    }

    /// Publish ordered changes. A save requests no commit; it, or the part
    /// of it that landed, only marks observations stale.
    pub fn apply(&self, changes: &[FileChange]) -> Result<(), ApplyError> {
        let refused = |error| ApplyError::Refused { error };
        let _admitted = self.inner.admit().map_err(refused)?;
        Files::validate(changes).map_err(refused)?;
        #[cfg(test)]
        self.inner.hook(|hooks| &hooks.before_apply);
        let result = {
            let _files = lock(&self.inner.file_gate);
            self.inner.publish(changes)
        };
        match &result {
            Ok(()) => {
                let steps: Vec<FileStep> = changes.iter().map(FileChange::step).collect();
                self.inner.edited(&steps);
            }
            Err(ApplyError::Partial { applied, .. }) => self.inner.edited(applied),
            // The owner itself always knows what it published; `Unconfirmed`
            // is what a caller reports when it lost track of this call.
            Err(ApplyError::Refused { .. } | ApplyError::Unconfirmed { .. }) => {}
        }
        result
    }

    /// Directory changes are not content: they request no commit.
    pub fn mkdir(&self, path: &str) -> Result<(), FileError> {
        let _admitted = self.inner.admit()?;
        let _files = lock(&self.inner.file_gate);
        self.inner.files.mkdir(path)
    }

    pub fn rmdir(&self, path: &str) -> Result<(), FileError> {
        let _admitted = self.inner.admit()?;
        let _files = lock(&self.inner.file_gate);
        self.inner.files.rmdir(path)
    }

    // ------------------------------------------------------------------
    // Git
    // ------------------------------------------------------------------

    /// A fresh, read-only inspection of uncommitted changes. Callers that ask
    /// while one is running share the scan that follows it.
    pub fn status(&self) -> Result<FilesObservation, GitError> {
        self.inner.scan.request_and_wait(None)
    }

    /// Commit current source files if they changed, and reset the index to
    /// the head either way. Waits for the file gate and the Git lock, then
    /// reads the folder, so it sees every save that landed while it waited.
    /// Never requests a push.
    pub fn commit(&self) -> CommitOutcome {
        let inner = &self.inner;
        let Ok(_admitted) = inner.admit() else {
            return CommitOutcome::Closed;
        };
        let _running = inner.running(&inner.commits);
        let (files, git) = inner.enter_both();
        // Shutdown began while this waited: nothing ran, nothing is recorded.
        if inner.closing.load(Ordering::SeqCst) {
            return CommitOutcome::Closed;
        }
        inner.commit_with(files, git)
    }

    /// A caller that may withdraw its push or fetch before the transport
    /// starts. See `Request`.
    pub fn request(&self) -> Request {
        Request {
            owner: Arc::downgrade(&self.inner),
            caller: Caller {
                push: self.inner.push.leaving(),
                fetch: self.inner.fetch.leaving(),
            },
        }
    }

    /// Request a push, after the active one if there is one, and wait for it.
    /// With `caller`, the request can be withdrawn until the push starts;
    /// without it the push is owed and runs.
    pub fn push(&self, caller: Option<&Caller>) -> PushOutcome {
        self.inner
            .push
            .request_and_wait(caller.map(|caller| &caller.push))
    }

    /// Request a fetch and wait for it, like `push`.
    pub fn fetch(&self, caller: Option<&Caller>) -> Result<FetchOutcome, GitError> {
        self.inner
            .fetch
            .request_and_wait(caller.map(|caller| &caller.fetch))
    }

    /// Apply the fetched remote head only as a clean fast-forward. Waits for
    /// the file gate and the Git lock like `commit`.
    pub fn pull_fast_forward(&self) -> Result<PullOutcome, PullError> {
        let Ok(_admitted) = self.inner.admit() else {
            return Err(GitError::Closed.into());
        };
        let _running = self.inner.running(&self.inner.pulls);
        self.inner.run_pull()
    }

    /// Merge the fetched remote head into a clean folder: a fast-forward when
    /// the branch is behind, otherwise one commit whose parents are the head
    /// and the fetched commit, published under the same record as a
    /// fast-forward. A refusal writes nothing, and so does every conflict.
    /// Histories without exactly one merge base are
    /// refused, except that `allow_unrelated_histories` merges ones with none
    /// over an empty base. A refused conflict carries both sides' committed
    /// bytes of each conflicted file when `versions` asks. Never fetches or
    /// pushes.
    pub fn merge_incoming(&self, policy: MergePolicy) -> Result<MergeOutcome, MergeError> {
        if self.inner.closing.load(Ordering::SeqCst) {
            return Err(GitError::Closed.into());
        }
        let Ok(_admitted) = self.inner.admit() else {
            return Err(GitError::Closed.into());
        };
        let _running = self.inner.running(&self.inner.merges);
        self.inner.run_merge(policy)
    }

    /// The incoming update whose record exists, read now.
    pub fn pending_incoming(&self) -> Option<PendingIncoming> {
        self.inner.read_pending().pending()
    }

    /// Finish or clear the pending incoming update, only because someone
    /// asked. It waits for the file gate and the Git lock like a
    /// fast-forward, then reads the record, the branch, the index, and every
    /// path the update changes again. It writes only paths still at their
    /// before state, and stops, keeping the record, at anything in neither
    /// state. Nothing retries it.
    pub fn recover_incoming(&self) -> Result<RecoverOutcome, PullError> {
        let Ok(_admitted) = self.inner.admit() else {
            return Err(GitError::Closed.into());
        };
        let _running = self.inner.running(&self.inner.pulls);
        self.inner.run_recovery()
    }

    /// Per-path staged and unstaged state, as `git status` reports it.
    pub fn paths(&self) -> Result<Vec<PathStatus>, GitError> {
        self.inner.manual("status", |inner| {
            let _git = lock(&inner.git_lock);
            inner.git.path_status()
        })
    }

    /// Stage `paths` in the index. `None` stages everything.
    pub fn stage(&self, paths: Option<&[String]>) -> Result<(), GitError> {
        if self.inner.closing.load(Ordering::SeqCst) {
            return Err(GitError::Closed);
        }
        let Ok(_admitted) = self.inner.admit() else {
            return Err(GitError::Closed);
        };
        let staged = {
            let _git = lock(&self.inner.git_lock);
            if let Some(pending) = self.inner.read_pending().pending() {
                return Err(GitError::IncomingPending { pending });
            }
            self.inner
                .git
                .stage(paths)
                .map_err(|cause| GitError::failed("add", cause))
        };
        self.inner.emit();
        staged
    }

    /// Commit staged changes with a user-authored message. A Git merge in
    /// progress refuses it, writing nothing.
    pub fn commit_staged(&self, message: &str) -> Result<StagedCommit, GitError> {
        let Ok(_admitted) = self.inner.admit() else {
            return Err(GitError::Closed);
        };
        self.inner.commit_staged(message)
    }

    pub fn diff(&self, staged: bool, paths: &[String]) -> Result<String, GitError> {
        self.inner.manual("diff", |inner| {
            let _git = lock(&inner.git_lock);
            inner.git.diff(staged, paths)
        })
    }

    pub fn log(&self, depth: u32) -> Result<Vec<CommitSummary>, GitError> {
        self.inner.manual("log", |inner| inner.git.log(depth))
    }

    // ------------------------------------------------------------------
    // Lifetime
    // ------------------------------------------------------------------

    /// Look for changes made outside this owner now, instead of at the next
    /// background check.
    pub fn poll_external(&self) {
        self.inner.poll_external();
    }

    /// Fence new work, cancel network work, and return once every admitted
    /// operation has settled. A save admitted before this call still lands,
    /// and a commit that already holds both locks still finishes. Nothing is
    /// committed because of shutdown: a save whose request was still waiting
    /// for the locks, or which lands after the fence, stays uncommitted.
    pub fn shutdown(&self) {
        let inner = &self.inner;
        let mut done = lock(&inner.shutdown);
        if *done {
            return;
        }
        {
            // Under the admission lock, so no operation is admitted after this.
            let _admitted = lock(&inner.admitted);
            inner.closing.store(true, Ordering::SeqCst);
        }
        inner.watching.store(false, Ordering::SeqCst);
        // Stop hearing filesystem events: taken out under the lock, dropped
        // outside it, since dropping joins the watcher's own thread.
        let watcher = lock(&inner.watcher).take();
        drop(watcher);
        inner.hinted.notify_all();
        inner.emit();
        std::thread::scope(|scope| {
            scope.spawn(|| inner.push.close(CloseMode::Cancel));
            scope.spawn(|| inner.fetch.close(CloseMode::Cancel));
            let mut admitted = lock(&inner.admitted);
            while *admitted > 0 {
                admitted = inner
                    .settled
                    .wait(admitted)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
            }
            drop(admitted);
            // An admitted fast-forward or commit may have requested a scan.
            inner.scan.close(CloseMode::Drain);
        });
        inner.emit();
        *done = true;
    }

    /// What the filesystem watcher's callback does with the paths it hears.
    #[cfg(test)]
    pub(crate) fn announce(&self, paths: &[&str]) {
        self.inner
            .announce(paths.iter().map(|path| path.to_string()));
    }

    #[cfg(test)]
    pub(crate) fn announcements(&self) -> u64 {
        self.inner.announced.load(Ordering::SeqCst)
    }

    #[cfg(test)]
    pub(crate) fn hooks(&self) -> MutexGuard<'_, Hooks> {
        lock(&self.inner.hooks)
    }
}

impl Inner {
    fn admit(&self) -> Result<Admission<'_>, FileError> {
        let mut admitted = lock(&self.admitted);
        if self.closing.load(Ordering::SeqCst) {
            return Err(FileError::Closed);
        }
        *admitted += 1;
        Ok(Admission(self))
    }

    /// Count one admitted operation as active and say so. The caller holds
    /// its admission already, so shutdown waits for what listeners hear of.
    fn running<'a>(&'a self, count: &'a AtomicUsize) -> Running<'a> {
        count.fetch_add(1, Ordering::SeqCst);
        self.emit();
        Running(self, count)
    }

    /// Wait for the file gate, then the Git lock: the only order anything
    /// takes both in. The Git lock is only tried while the gate is held. When
    /// it is busy the gate is given back first, so saves are never stuck
    /// behind a caller that is itself waiting, and the caller starts over
    /// once the Git lock was released.
    fn enter_both(&self) -> (MutexGuard<'_, ()>, MutexGuard<'_, ()>) {
        loop {
            let files = lock(&self.file_gate);
            if let Some(git) = try_lock(&self.git_lock) {
                return (files, git);
            }
            drop(files);
            drop(lock(&self.git_lock));
        }
    }

    /// Admit one explicit Git operation for its whole lifetime.
    fn manual<T>(
        &self,
        operation: &str,
        work: impl FnOnce(&Inner) -> Result<T, String>,
    ) -> Result<T, GitError> {
        let Ok(_admitted) = self.admit() else {
            return Err(GitError::Closed);
        };
        work(self).map_err(|cause| GitError::failed(operation, cause))
    }

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    fn deliver(&self, event: &OwnerEvent) {
        let listeners: Vec<Listener> = lock(&self.listeners)
            .iter()
            .map(|(_, listener)| Arc::clone(listener))
            .collect();
        for listener in listeners {
            listener(event);
        }
    }

    /// Publish the snapshot if it changed. Deliveries are ordered: the lock
    /// that numbers a snapshot is held until its listeners have run. Activity
    /// is read under that lock too, so the snapshot of the last change to it
    /// is never replaced by one read before that change.
    fn emit(&self) {
        let mut emitted = lock(&self.emitted);
        let counted = |count: &AtomicUsize| count.load(Ordering::SeqCst) > 0;
        let activity = Activities {
            scan: Activity {
                active: self.scan.active(),
            },
            commit: Activity {
                active: counted(&self.commits),
            },
            push: Activity {
                active: self.push.active(),
            },
            fetch: Activity {
                active: self.fetch.active(),
            },
            pull: Activity {
                active: counted(&self.pulls),
            },
            merge: Activity {
                active: counted(&self.merges),
            },
        };
        let snapshot = {
            let state = lock(&self.state);
            GitSnapshot {
                branch: self.git.branch.clone(),
                remote: self.git.remote.clone(),
                files: state.files.clone(),
                sync: state.sync.clone(),
                activity,
                last_commit: state.last_commit.clone(),
                last_push: state.last_push.clone(),
                last_fetch: state.last_fetch.clone().map(|attempt| Attempt {
                    result: attempt.result.into(),
                    at: attempt.at,
                }),
                last_pull: state.last_pull.clone().map(|attempt| Attempt {
                    result: attempt.result.into(),
                    at: attempt.at,
                }),
                last_merge: state.last_merge.clone().map(|attempt| Attempt {
                    result: attempt.result.into(),
                    at: attempt.at,
                }),
                pending_incoming: state.pending_incoming.clone(),
                closed: self.closing.load(Ordering::SeqCst),
            }
        };
        if *emitted.snapshot == snapshot {
            return;
        }
        emitted.sequence += 1;
        emitted.snapshot = Arc::new(snapshot);
        let event = OwnerEvent::Snapshot {
            sequence: emitted.sequence,
            snapshot: (*emitted.snapshot).clone(),
        };
        self.deliver(&event);
    }

    fn files_changed(&self, paths: Vec<String>) {
        let revision = self.revision.fetch_add(1, Ordering::SeqCst) + 1;
        self.deliver(&OwnerEvent::FilesChanged { revision, paths });
    }

    // ------------------------------------------------------------------
    // Publication
    // ------------------------------------------------------------------

    fn stamp(&self, path: &str) -> Option<Stamp> {
        let stats = std::fs::symlink_metadata(self.files.absolute(path)).ok()?;
        stats.file_type().is_file().then(|| Stamp {
            size: stats.len(),
            modified: stats
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|elapsed| elapsed.as_nanos()),
        })
    }

    /// Apply a batch and record what it left, so the external check does not
    /// mistake this owner's writes for someone else's. The caller holds the
    /// file gate.
    fn publish(&self, changes: &[FileChange]) -> Result<(), ApplyError> {
        self.own_in_flight.fetch_add(1, Ordering::SeqCst);
        let result = self.files.apply(changes);
        {
            let mut watch = lock(&self.watch);
            let touched: BTreeSet<String> = changes
                .iter()
                .flat_map(|change| {
                    change
                        .step()
                        .paths()
                        .into_iter()
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
                .collect();
            for path in touched {
                match self.stamp(&path) {
                    Some(stamp) => watch.stamps.insert(path, stamp),
                    None => watch.stamps.remove(&path),
                };
            }
        }
        self.own_done.fetch_add(1, Ordering::SeqCst);
        self.own_in_flight.fetch_sub(1, Ordering::SeqCst);
        result
    }

    /// A known file change: existing observations become stale.
    fn mark_edited(&self) -> bool {
        let mut state = lock(&self.state);
        state.clock += 1;
        state.last_edit = state.clock;
        match &mut state.files {
            Observation::Observed { stale, .. } if !*stale => {
                *stale = true;
                true
            }
            _ => false,
        }
    }

    fn edited(&self, steps: &[FileStep]) {
        self.mark_edited();
        self.emit();
        let paths: BTreeSet<&str> = steps.iter().flat_map(FileStep::paths).collect();
        self.files_changed(paths.into_iter().map(str::to_string).collect());
    }

    /// An operation failed after some of its file changes landed: mark the
    /// observation stale and ask for a fresh scan. This requests no commit.
    fn landed(&self, steps: &[FileStep]) {
        self.edited(steps);
        self.scan.request();
    }

    // ------------------------------------------------------------------
    // Observation
    // ------------------------------------------------------------------

    fn tick(&self) -> u64 {
        let mut state = lock(&self.state);
        state.clock += 1;
        state.clock
    }

    /// Record files observed at `captured_at` unless a newer observation exists.
    fn observe_files(&self, captured_at: u64, value: FilesObservation) {
        let mut state = lock(&self.state);
        if matches!(state.files, Observation::Observed { .. })
            && state.files_captured_at > captured_at
        {
            return;
        }
        state.files = Observation::Observed {
            value,
            checked_at: now_ms(),
            stale: state.last_edit > captured_at,
            error: None,
        };
        state.files_captured_at = captured_at;
    }

    fn mark_files_stale(&self) {
        if let Observation::Observed { stale, .. } = &mut lock(&self.state).files {
            *stale = true;
        }
    }

    fn fail_files(&self, cause: String) {
        let mut state = lock(&self.state);
        match &mut state.files {
            Observation::Observed { stale, error, .. } => {
                *stale = true;
                *error = Some(cause);
            }
            unknown => *unknown = Observation::Unknown { error: Some(cause) },
        }
    }

    fn refresh_sync(&self) {
        let observed = (|| {
            let head = self.git.read_branch()?;
            let remote = self.git.read_remote_tracking()?;
            let (ahead, behind) = self.git.ahead_behind(head.as_deref(), remote.as_deref())?;
            Ok::<_, String>(SyncObservation {
                head,
                remote,
                ahead: ahead as u32,
                behind: behind as u32,
            })
        })();
        let mut state = lock(&self.state);
        match observed {
            Ok(value) => {
                state.sync = Observation::Observed {
                    value,
                    checked_at: now_ms(),
                    stale: false,
                    error: None,
                }
            }
            Err(cause) => match &mut state.sync {
                Observation::Observed { stale, error, .. } => {
                    *stale = true;
                    *error = Some(cause);
                }
                unknown => *unknown = Observation::Unknown { error: Some(cause) },
            },
        }
    }

    /// Record a clean observation only if the branch still names `head`;
    /// otherwise invalidate and request a real scan. A failed reread belongs
    /// to the observation, never to the operation that already published.
    fn observe_committed(&self, captured_at: u64, head: Option<&str>) {
        let actual = match self.git.read_branch() {
            Ok(actual) => actual,
            Err(cause) => {
                self.fail_files(cause);
                return;
            }
        };
        if actual.as_deref() == head {
            self.observe_files(
                captured_at,
                FilesObservation {
                    head: head.map(str::to_string),
                    changes: Vec::new(),
                },
            );
            return;
        }
        self.mark_files_stale();
        self.scan.request();
    }

    fn run_scan(&self) -> Result<FilesObservation, GitError> {
        // The snapshot is taken under the file gate; hashing it is not.
        let (captured_at, snapshot) = {
            let _files = lock(&self.file_gate);
            (self.tick(), self.git.snapshot())
        };
        let result = match snapshot.and_then(|snapshot| self.git.observe(&snapshot)) {
            Ok(observed) => {
                let value = FilesObservation {
                    head: observed.head,
                    changes: observed.changes,
                };
                self.observe_files(captured_at, value.clone());
                self.refresh_sync();
                Ok(value)
            }
            Err(cause) => {
                self.fail_files(cause.clone());
                Err(GitError::failed("status", cause))
            }
        };
        // Status reports a pending update; reading it resumes or clears
        // nothing.
        self.read_pending();
        self.emit();
        result
    }

    /// Look for file and ref changes this owner did not make.
    fn poll_external(&self) {
        if self.own_in_flight.load(Ordering::SeqCst) > 0 {
            return;
        }
        let done = self.own_done.load(Ordering::SeqCst);
        let Ok(listing) = self.files.list() else {
            return;
        };
        let stamps: BTreeMap<String, Stamp> = listing
            .files
            .into_iter()
            .filter(|file| is_portable_path(&file.path))
            .filter_map(|file| self.stamp(&file.path).map(|stamp| (file.path, stamp)))
            .collect();
        let refs = self.git.refs_signature();
        let (changed, refs_moved) = {
            let mut watch = lock(&self.watch);
            // A publication overlapped this walk: its stamps may be older than
            // what the walk saw. The next check compares cleanly.
            if self.own_in_flight.load(Ordering::SeqCst) > 0
                || self.own_done.load(Ordering::SeqCst) != done
            {
                return;
            }
            let changed: Vec<String> = if watch.primed {
                let paths: BTreeSet<&String> = watch.stamps.keys().chain(stamps.keys()).collect();
                paths
                    .into_iter()
                    .filter(|path| watch.stamps.get(*path) != stamps.get(*path))
                    .cloned()
                    .collect()
            } else {
                Vec::new()
            };
            let refs_moved = watch.primed && watch.refs != refs;
            watch.primed = true;
            watch.stamps = stamps;
            watch.refs = refs;
            (changed, refs_moved)
        };
        self.report(changed, refs_moved);
    }

    /// Start watching the folder for filesystem events. The callback only
    /// queues what it heard; the watch thread does the looking.
    fn watch_events(&self, owner: Weak<Inner>) -> Result<(), String> {
        use notify::Watcher;
        let root = self.root.clone();
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                let (Ok(event), Some(inner)) = (event, owner.upgrade()) else {
                    return;
                };
                let relative = event.paths.iter().filter_map(|path| {
                    let relative = path.strip_prefix(&root).ok()?.to_str()?;
                    Some(relative.replace(std::path::MAIN_SEPARATOR, "/"))
                });
                inner.announce(relative);
            })
            .map_err(|cause| cause.to_string())?;
        watcher
            .watch(&self.root, notify::RecursiveMode::Recursive)
            .map_err(|cause| cause.to_string())?;
        *lock(&self.watcher) = Some(watcher);
        Ok(())
    }

    /// Queue folder-relative paths a filesystem event named, for the watch
    /// thread to look at. Refs, `HEAD`, and the index say history moved.
    /// Objects, logs, lock files, and this owner's own scratch files and
    /// snapshots say nothing, and must not wake anything.
    fn announce(&self, paths: impl Iterator<Item = String>) {
        let mut heard = Hints::default();
        for relative in paths {
            match relative.strip_prefix(".git/") {
                Some(private) => {
                    heard.git |= !private.ends_with(".lock")
                        && (private == "HEAD"
                            || private == "index"
                            || private == "packed-refs"
                            || private.starts_with("refs/"));
                }
                None if is_portable_path(&relative) => {
                    heard.paths.insert(relative);
                }
                None => {}
            }
        }
        if heard.paths.is_empty() && !heard.git {
            return;
        }
        #[cfg(test)]
        self.announced.fetch_add(1, Ordering::SeqCst);
        let mut hints = lock(&self.hints);
        hints.paths.extend(heard.paths);
        hints.git |= heard.git;
        drop(hints);
        self.hinted.notify_all();
    }

    /// Act on what filesystem events announced. An announced path is looked
    /// at even when its size and time are what they were, because an edit can
    /// restore both. Every announced path is reported, the owner's own writes
    /// included: an event cannot say who wrote, and a missed outside edit
    /// costs more than a listener rereading a file it already has. A report
    /// only marks the observation stale and tells listeners; it requests no
    /// scan and no commit, so the owner's own events cannot feed themselves.
    fn heed(&self, announced: Hints) {
        if self.own_in_flight.load(Ordering::SeqCst) > 0 {
            // A publication is recording what it wrote; look again after it.
            let mut hints = lock(&self.hints);
            hints.paths.extend(announced.paths);
            hints.git |= announced.git;
            drop(hints);
            std::thread::sleep(Duration::from_millis(5));
            return;
        }
        let changed: Vec<String> = {
            let mut watch = lock(&self.watch);
            let mut changed = Vec::new();
            for path in announced.paths {
                let now = self.stamp(&path);
                // A directory, or a file that came and went, is not a change.
                if now.is_none() && !watch.stamps.contains_key(&path) {
                    continue;
                }
                match now {
                    Some(stamp) => watch.stamps.insert(path.clone(), stamp),
                    None => watch.stamps.remove(&path),
                };
                changed.push(path);
            }
            changed
        };
        let refs_moved = announced.git && {
            let refs = self.git.refs_signature();
            let mut watch = lock(&self.watch);
            let moved = watch.primed && watch.refs != refs;
            watch.refs = refs;
            moved
        };
        self.report(changed, refs_moved);
    }

    /// Tell listeners about changes this owner did not make.
    fn report(&self, changed: Vec<String>, refs_moved: bool) {
        if refs_moved {
            // Another Git process moved a ref: the head an observation named
            // may no longer be the branch.
            self.refresh_sync();
            let mut state = lock(&self.state);
            let head = match &state.sync {
                Observation::Observed { value, .. } => value.head.clone(),
                Observation::Unknown { .. } => None,
            };
            if let Observation::Observed { value, stale, .. } = &mut state.files {
                if value.head != head {
                    *stale = true;
                }
            }
        }
        if !changed.is_empty() {
            self.mark_edited();
        }
        if refs_moved || !changed.is_empty() {
            self.emit();
        }
        if !changed.is_empty() {
            self.files_changed(changed);
        }
    }

    // ------------------------------------------------------------------
    // Commits
    // ------------------------------------------------------------------

    #[cfg(test)]
    fn hook(&self, pick: fn(&Hooks) -> &Option<Arc<dyn Fn() + Send + Sync>>) {
        // Clone out and release the hooks lock before calling: a hook may
        // wait on work that reads the hooks itself.
        let hook = pick(&lock(&self.hooks)).clone();
        if let Some(hook) = hook {
            hook();
        }
    }

    /// One whole-folder commit. The caller holds the file gate and the Git
    /// lock. The gate is released as soon as the folder is snapshotted.
    fn checkpoint(&self, files: MutexGuard<'_, ()>) -> Result<CommitOutcome, String> {
        if let Some(reason) = self.git.blocked()? {
            return Ok(CommitOutcome::Blocked { reason });
        }
        // A tree an incoming update left half changed is never committed.
        if let Some(pending) = self.read_pending().pending() {
            return Ok(CommitOutcome::Blocked {
                reason: incoming_blocks(&pending, "committing"),
            });
        }
        // The parent is pinned and the folder snapshotted under both locks,
        // so no fast-forward or staged commit of this owner falls between
        // them: bytes snapshotted for one parent are never committed on
        // another. Another Git process can still move the branch; that fails
        // the compare-and-swap below.
        let parent = self.git.read_branch()?;
        #[cfg(test)]
        self.hook(|hooks| &hooks.during_snapshot);
        let captured_at = self.tick();
        let snapshot = self.git.snapshot()?;
        // From here saves proceed. One that lands now is newer than
        // `captured_at`: this commit still holds what it snapshotted, and the
        // observation it records is stale.
        drop(files);
        #[cfg(test)]
        self.hook(|hooks| &hooks.before_hash);
        let captured = match self.git.capture(&snapshot, parent.as_deref())? {
            Capture::Blocked(reason) => return Ok(CommitOutcome::Blocked { reason }),
            Capture::Captured(captured) => captured,
        };
        drop(snapshot);
        #[cfg(test)]
        self.hook(|hooks| &hooks.after_capture);
        let parent_tree = match &parent {
            Some(parent) => self.git.tree_of(parent)?,
            None => crate::git::EMPTY_TREE.to_string(),
        };
        let built = match commit_subject(&captured.changes) {
            Some(message) if captured.tree != parent_tree => {
                let oid = self.git.write_commit(
                    &captured.tree,
                    parent.as_deref(),
                    &message,
                    &self.config.author,
                )?;
                // Reported, never retried.
                if let Cas::Lost { actual } = self.git.cas_branch(parent.as_deref(), &oid)? {
                    return Ok(CommitOutcome::BranchMoved {
                        candidate: oid,
                        expected: parent,
                        actual,
                    });
                }
                Some((oid, message))
            }
            _ => None,
        };
        let head = built
            .as_ref()
            .map(|(oid, _)| oid.clone())
            .or_else(|| parent.clone());
        // A whole-folder commit supersedes staged-only intent: every index
        // entry is reset to the head. The branch has already moved, so a
        // failure here is a warning, not a failed commit.
        let index_warning = head
            .as_deref()
            .and_then(|head| self.git.reconcile_index(head).err());
        self.observe_committed(captured_at, head.as_deref());
        Ok(match built {
            Some((oid, message)) => CommitOutcome::Committed {
                oid,
                parent,
                message,
                changed_paths: captured.changes.len() as u32,
                index_warning,
            },
            None => CommitOutcome::Unchanged {
                head: parent,
                index_warning,
            },
        })
    }

    /// Commit with both locks held, and record what happened and what is now
    /// known of the remote. The Git lock is kept until the attempt is
    /// recorded, so attempts are recorded in the order they ran.
    fn commit_with(&self, files: MutexGuard<'_, ()>, _git: MutexGuard<'_, ()>) -> CommitOutcome {
        let outcome = self
            .checkpoint(files)
            .unwrap_or_else(|error| CommitOutcome::Failed { error });
        lock(&self.state).last_commit = Some(Attempt {
            result: outcome.clone(),
            at: now_ms(),
        });
        self.refresh_sync();
        self.emit();
        outcome
    }

    /// Every check runs under the Git lock: an incoming update that stopped,
    /// or a Git operation that began, while this waited is seen here.
    fn commit_staged(&self, message: &str) -> Result<StagedCommit, GitError> {
        if let Some(reason) = message_problem(message) {
            return Err(GitError::InvalidMessage {
                reason: reason.to_string(),
            });
        }
        let failed = |cause: String| GitError::failed("commit", cause);
        let (result, changed_paths) = {
            let _git = lock(&self.git_lock);
            if let Some(pending) = self.read_pending().pending() {
                return Err(GitError::IncomingPending { pending });
            }
            if let Some(blocked) = self.git.blocked().map_err(failed)? {
                return Err(failed(blocked));
            }
            let staged = self
                .git
                .path_status()
                .map_err(failed)?
                .iter()
                .filter(|path| path.index != " " && path.index != "?")
                .count();
            let result = self
                .git
                .commit_index(message, &self.config.author)
                .map_err(failed)?;
            (result, staged)
        };
        if let IndexCommit::Committed { oid, parent } = &result {
            lock(&self.state).last_commit = Some(Attempt {
                result: CommitOutcome::Committed {
                    oid: oid.clone(),
                    parent: parent.clone(),
                    message: message.to_string(),
                    changed_paths: changed_paths as u32,
                    index_warning: None,
                },
                at: now_ms(),
            });
        }
        self.refresh_sync();
        self.mark_files_stale();
        self.emit();
        match result {
            IndexCommit::Nothing => Err(GitError::NothingToCommit),
            IndexCommit::BranchMoved { expected, actual } => {
                Err(GitError::BranchMoved { expected, actual })
            }
            IndexCommit::Committed { oid, parent } => Ok(StagedCommit { oid, parent }),
        }
    }

    // ------------------------------------------------------------------
    // Remote
    // ------------------------------------------------------------------

    fn run_push(&self, cancel: &AtomicBool) -> PushOutcome {
        if self.git.remote.is_none() {
            return PushOutcome::NoRemote;
        }
        let oid = match self.git.read_branch() {
            Ok(Some(oid)) => oid,
            Ok(None) => return PushOutcome::NothingToPush,
            // No commit was pinned, so there was no attempt to describe.
            Err(reason) => return PushOutcome::Skipped { reason },
        };
        let sequence = {
            let mut state = lock(&self.state);
            state.remote_sequence += 1;
            state.remote_sequence
        };
        #[cfg(test)]
        self.hook(|hooks| &hooks.during_push);
        let outcome = match self.git.push(&oid, cancel) {
            // Git's own success is not enough when a cancel raced it: the
            // push may or may not have landed. Nothing is undone or retried;
            // a later fetch tells.
            Ok(()) if cancel.load(Ordering::SeqCst) => PushOutcome::Unconfirmed {
                error: format!("Git finished pushing {oid} as it was cancelled, so it may or may not have landed. Fetch to find out"),
            },
            Ok(()) => PushOutcome::Pushed { oid },
            Err(_) if cancel.load(Ordering::SeqCst) => PushOutcome::Cancelled { oid: Some(oid) },
            Err(error) => PushOutcome::Failed { oid, error },
        };
        // A push that started before a newer fetch or push must not replace its observation.
        if lock(&self.state).remote_sequence == sequence {
            self.refresh_sync();
        }
        lock(&self.state).last_push = Some(Attempt {
            result: outcome.clone(),
            at: now_ms(),
        });
        self.emit();
        outcome
    }

    fn run_fetch(&self, cancel: &AtomicBool) -> Result<FetchOutcome, GitError> {
        if self.git.remote.is_none() {
            return Err(GitError::NoRemote);
        }
        let sequence = {
            let mut state = lock(&self.state);
            state.remote_sequence += 1;
            state.remote_sequence
        };
        #[cfg(test)]
        self.hook(|hooks| &hooks.during_fetch);
        let result = match self.git.fetch(cancel) {
            // What Git fetched stays in the tracking ref, but it is not
            // reported as a fetch when a cancel raced it.
            Ok(_) if cancel.load(Ordering::SeqCst) => Err(GitError::failed(
                "fetch",
                "Git finished fetching as it was cancelled, so it is not reported as fetched".to_string(),
            )),
            Ok(oid) => Ok(FetchOutcome { oid }),
            Err(cause) => Err(GitError::failed("fetch", cause)),
        };
        if lock(&self.state).remote_sequence == sequence {
            self.refresh_sync();
        }
        lock(&self.state).last_fetch = Some(Attempt {
            result: result.clone(),
            at: now_ms(),
        });
        self.emit();
        result
    }

    fn run_pull(&self) -> Result<PullOutcome, PullError> {
        let result = if self.git.remote.is_none() {
            Err(GitError::NoRemote.into())
        } else {
            let (files, git) = self.enter_both();
            // Shutdown began while this waited: nothing ran, nothing is recorded.
            if self.closing.load(Ordering::SeqCst) {
                return Err(GitError::Closed.into());
            }
            match self.incoming(files, git, None) {
                Err(cause) => Err(GitError::failed("pull", cause).into()),
                Ok(Ok(outcome)) => Ok(match outcome {
                    MergeOutcome::UpToDate { head } => PullOutcome::UpToDate { head },
                    MergeOutcome::Ahead { head } => PullOutcome::Ahead { head },
                    MergeOutcome::FastForwarded {
                        from,
                        to,
                        changed_paths,
                    } => PullOutcome::FastForwarded {
                        from,
                        to,
                        changed_paths,
                    },
                    MergeOutcome::Merged { .. } => unreachable!("a pull never merges"),
                }),
                Ok(Err(MergeError::Pull { error })) => Err(error),
                Ok(Err(other)) => unreachable!("a pull never merges: {other:?}"),
            }
        };
        if !matches!(
            result,
            Err(PullError::Git {
                error: GitError::Failed { .. }
            })
        ) {
            self.refresh_sync();
        }
        lock(&self.state).last_pull = Some(Attempt {
            result: result.clone(),
            at: now_ms(),
        });
        self.emit();
        result
    }

    fn run_merge(&self, policy: MergePolicy) -> Result<MergeOutcome, MergeError> {
        let result = if self.git.remote.is_none() {
            Err(GitError::NoRemote.into())
        } else {
            let (files, git) = self.enter_both();
            // Shutdown began while this waited: nothing ran, nothing is recorded.
            if self.closing.load(Ordering::SeqCst) {
                return Err(GitError::Closed.into());
            }
            self.incoming(files, git, Some(policy))
                .unwrap_or_else(|cause| Err(GitError::failed("merge", cause).into()))
        };
        if !matches!(
            result,
            Err(MergeError::Pull {
                error: PullError::Git {
                    error: GitError::Failed { .. }
                }
            })
        ) {
            self.refresh_sync();
        }
        // The snapshot goes to every window on every change, so it records
        // which paths conflicted and not their bytes; those went to the caller.
        let recorded = match &result {
            Err(MergeError::Conflicted {
                conflicts,
                versions: Some(_),
            }) => Err(MergeError::Conflicted {
                conflicts: conflicts.clone(),
                versions: None,
            }),
            other => other.clone(),
        };
        lock(&self.state).last_merge = Some(Attempt {
            result: recorded,
            at: now_ms(),
        });
        self.emit();
        result
    }

    /// Why the tree of `commit`, `files`, cannot be written to this folder as
    /// plain bytes, if it cannot.
    fn unrepresentable(
        &self,
        commit: &str,
        files: &BTreeMap<String, (String, String)>,
    ) -> Result<Option<PullError>, String> {
        Ok(plain_problem(&self.git, commit, files)?
            .map(|(paths, reason)| PullError::Unrepresentable { paths, reason }))
    }
}

/// Why the tree of `commit`, `files`, cannot be written to a folder as plain
/// bytes, if it cannot: the paths and the reason. Incoming updates and first
/// downloads refuse on the same rules.
pub(crate) fn plain_problem(
    git: &Git,
    commit: &str,
    files: &BTreeMap<String, (String, String)>,
) -> Result<Option<(Vec<String>, String)>, String> {
    let refuse =
        |paths: Vec<String>, reason: &str| -> Result<Option<(Vec<String>, String)>, String> {
            Ok(Some((paths, reason.to_string())))
        };
    let unsupported: Vec<String> = files
        .iter()
        .filter(|(_, (mode, _))| mode != "100644")
        .map(|(path, _)| path.clone())
        .collect();
    if !unsupported.is_empty() {
        return refuse(
            unsupported,
            "symbolic links, submodules, and executable files are not plain folder files",
        );
    }
    let invalid: Vec<String> = files
        .keys()
        .filter(|path| path_problem(path).is_some())
        .cloned()
        .collect();
    if !invalid.is_empty() {
        return refuse(invalid, "some paths are not valid folder paths");
    }
    // An update writes each blob's bytes as they are stored. A commit that
    // declares a filter or a conversion for a path means something else
    // by those bytes: under `filter=lfs` the blob is a pointer, not the
    // audio. Every path is asked about, against the commit's own
    // attributes, so a commit that only adds an attribute over a file it
    // does not touch is refused as well.
    if let Some((path, attribute)) =
        git.normalizing_attribute(Some(commit), files.keys().map(String::as_str))?
    {
        return refuse(
                vec![path],
                &format!(
                    "the incoming commit declares the Git attribute {attribute}, and this folder does not apply attribute filters or conversion"
                ),
            );
    }
    let mut folded: BTreeMap<String, &String> = BTreeMap::new();
    for path in files.keys() {
        if let Some(existing) = folded.insert(collision_key(path), path) {
            return refuse(
                vec![existing.clone(), path.clone()],
                "paths collide on case-insensitive filesystems",
            );
        }
    }
    Ok(None)
}

impl Inner {
    /// One incoming update: a fast-forward for a pull (`merge` is `None`), or
    /// for a merge a fast-forward or a two-parent merge under its policy. A
    /// conflict is refused and writes nothing. The outer error is an
    /// unexpected Git failure; the inner one is a reported outcome. The file
    /// gate and the Git lock are both held until the files and the branch
    /// agree.
    fn incoming(
        &self,
        _files: MutexGuard<'_, ()>,
        _git: MutexGuard<'_, ()>,
        merge: Option<MergePolicy>,
    ) -> Result<Result<MergeOutcome, MergeError>, String> {
        // One update at a time: an earlier one is recovered explicitly first.
        if let Some(pending) = self.read_pending().pending() {
            return Ok(Err(PullError::IncomingPending { pending }.into()));
        }
        if let Some(reason) = self.git.blocked()? {
            return Ok(Err(PullError::Blocked { reason }.into()));
        }
        let captured_at = self.tick();
        let Some(fetched) = self.git.read_remote_tracking()? else {
            return Ok(Err(PullError::NoFetchedHead.into()));
        };
        let head = self.git.read_branch()?;
        let snapshot = self.git.snapshot()?;
        if let Some(reason) = self.git.checkpoint_problem(&snapshot, head.as_deref())? {
            return Ok(Err(PullError::Blocked { reason }.into()));
        }
        if head.as_deref() == Some(fetched.as_str()) {
            return Ok(Ok(MergeOutcome::UpToDate { head }));
        }
        let mut diverged = false;
        if let Some(head) = &head {
            if !self.git.is_ancestor(head, &fetched)? {
                if self.git.is_ancestor(&fetched, head)? {
                    return Ok(Ok(MergeOutcome::Ahead { head: head.clone() }));
                }
                if merge.is_none() {
                    return Ok(Err(PullError::Diverged {
                        head: head.clone(),
                        fetched,
                    }
                    .into()));
                }
                diverged = true;
            }
        }
        // The entire folder must be clean, including staged changes.
        let (committed, current, raw) = self.git.source_state(&snapshot, head.as_deref())?;
        drop(snapshot);
        let dirty = Git::changes(&committed, &current);
        if !dirty.is_empty() {
            return Ok(Err(PullError::Dirty {
                paths: dirty.into_iter().map(|change| change.path).collect(),
            }
            .into()));
        }
        if !self.git.index_matches_head()? {
            return Ok(Err(PullError::StagedChanges.into()));
        }

        let incoming = self.git.tree_files(&fetched)?;
        if let Some(refused) = self.unrepresentable(&fetched, &incoming)? {
            return Ok(Err(refused.into()));
        }
        let (next_head, target) = if !diverged {
            (fetched.clone(), incoming)
        } else {
            let policy = merge.expect("only a merge goes on past a divergence");
            let local = head.clone().expect("a diverged branch has a head");
            let bases = self.git.merge_bases(&local, &fetched)?;
            let base = match bases.as_slice() {
                [base] => Some(base.as_str()),
                // Consent to unrelated histories: both roots become parents.
                [] if policy.allow_unrelated_histories => None,
                _ => {
                    return Ok(Err(MergeError::UnsupportedHistory {
                        head: local,
                        fetched,
                        bases: bases.len() as u32,
                    }))
                }
            };
            let remote_branch = self
                .git
                .remote
                .as_ref()
                .map_or(self.git.branch.as_str(), |remote| remote.branch.as_str());
            let message = format!("Merge remote-tracking branch 'origin/{remote_branch}'");
            let prepared = merge::prepare(
                &self.git,
                base,
                &local,
                &fetched,
                &self.config.author,
                &message,
            )?;
            match prepared {
                Prepared::Conflicted { conflicts } => {
                    let versions = if policy.versions {
                        Some(merge::conflict_versions(
                            &self.git, &conflicts, &local, &fetched,
                        )?)
                    } else {
                        None
                    };
                    return Ok(Err(MergeError::Conflicted {
                        conflicts,
                        versions,
                    }));
                }
                Prepared::Unmergeable { paths, reason } => {
                    return Ok(Err(MergeError::Unmergeable { paths, reason }))
                }
                Prepared::Merged { commit, files } => {
                    if let Some(refused) = self.unrepresentable(&commit, &files)? {
                        return Ok(Err(refused.into()));
                    }
                    (commit, files)
                }
            }
        };

        let incoming_oids: BTreeMap<String, String> = target
            .iter()
            .map(|(path, (_, oid))| (path.clone(), oid.clone()))
            .collect();
        let changes = Git::changes(&committed, &incoming_oids);
        // Ignored and untracked files are preserved, never overwritten. A
        // committed file is the update's own to remove: a file can become a
        // directory, and a directory a file.
        let raw: BTreeSet<&str> = raw
            .iter()
            .map(String::as_str)
            .filter(|path| !committed.contains_key(*path))
            .collect();
        let colliding: Vec<String> = changes
            .iter()
            .filter(|change| change.kind == ChangeKind::Add)
            .map(|change| &change.path)
            .filter(|path| {
                let below = format!("{path}/");
                raw.contains(path.as_str())
                    || ancestors(path).iter().any(|parent| raw.contains(parent))
                    || raw.iter().any(|existing| existing.starts_with(&below))
            })
            .cloned()
            .collect();
        if !colliding.is_empty() {
            return Ok(Err(PullError::Collision { paths: colliding }.into()));
        }
        #[cfg(test)]
        self.hook(|hooks| &hooks.during_pull);

        // Admission: pin the commits, then put the record in place, before
        // any authored file, index entry, or ref of the branch changes.
        let record = Record::new(&self.git.branch, head.clone(), next_head);
        if self.boundary("record") {
            return Ok(Err(recovery::stopped_at("record", Vec::new()).into()));
        }
        incoming::pin(&self.git, &record)?;
        match incoming::write(self.git.gitdir(), &record) {
            Written::Durable => {}
            Written::Absent(reason) => {
                let _ = incoming::unpin(&self.git, &record);
                return Err(reason);
            }
            Written::Unknown(error) => {
                self.read_pending();
                return Ok(Err(PullError::Unconfirmed {
                    applied: Vec::new(),
                    uncertain: vec![recovery::RECORD_LABEL.to_string()],
                    error,
                }
                .into()));
            }
        }
        self.read_pending();
        if self.boundary("recorded") {
            return Ok(Err(recovery::stopped_at("recorded", Vec::new()).into()));
        }
        let result = self.finish_pull(&record, head.clone(), captured_at);
        self.read_pending();
        Ok(match result? {
            Err(error) => Err(error.into()),
            Ok(PullOutcome::FastForwarded { changed_paths, .. }) if diverged => {
                Ok(MergeOutcome::Merged {
                    from: head.expect("a merged branch has a head"),
                    to: record.next_head.clone(),
                    fetched,
                    changed_paths,
                })
            }
            Ok(PullOutcome::FastForwarded {
                from,
                to,
                changed_paths,
            }) => Ok(MergeOutcome::FastForwarded {
                from,
                to,
                changed_paths,
            }),
            Ok(PullOutcome::UpToDate { head }) => Ok(MergeOutcome::UpToDate { head }),
            Ok(PullOutcome::Ahead { head }) => Ok(MergeOutcome::Ahead { head }),
        })
    }
}

/// Why history work waits for the pending update.
fn incoming_blocks(pending: &PendingIncoming, action: &str) -> String {
    match pending {
        PendingIncoming::Recorded { operation_id, .. } => {
            format!("incoming update {operation_id} has not finished; recover it before {action}")
        }
        PendingIncoming::Unreadable { reason } => format!(
            "an incoming update's record cannot be read ({reason}); resolve it before {action}"
        ),
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        self.watching.store(false, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::mpsc;

    use crate::testing::{config, create, git, open, overwrite, TempDir};

    /// Apply `changes`, hold it after admission and before the file gate,
    /// where a slow thread would leave it, run `meanwhile`, and then let it
    /// go on.
    fn delayed(
        owner: &FolderOwner,
        changes: Vec<FileChange>,
        meanwhile: impl FnOnce(),
    ) -> Result<(), ApplyError> {
        let (hook, _, at_hook, release) = count_and_hold_first();
        owner.hooks().before_apply = Some(hook);
        let held = {
            let owner = owner.clone();
            std::thread::spawn(move || owner.apply(&changes))
        };
        at_hook.recv().unwrap();
        meanwhile();
        release.send(()).unwrap();
        held.join().unwrap()
    }

    #[test]
    fn a_save_held_before_the_gate_lands_after_a_later_one_and_stays() {
        let temp = TempDir::new("last-landed");
        let root = temp.folder("notes");
        let owner = open(&root);
        let read = |path: &str| std::fs::read_to_string(root.join(path)).ok();

        // An earlier save is held before the gate while a later one lands.
        // Nothing orders them by when they were asked for: the held save
        // lands last, whole, and its bytes stay.
        let landed = delayed(
            &owner,
            vec![overwrite("first.md", "A"), overwrite("note.md", "A")],
            || assert_eq!(owner.apply(&[overwrite("note.md", "B")]), Ok(())),
        );
        assert_eq!(landed, Ok(()));
        assert_eq!(read("note.md").as_deref(), Some("A"));
        assert_eq!(read("first.md").as_deref(), Some("A"));

        // A guard is what refuses bytes the caller did not review: the held
        // save names the hash of what it read, and the later save changed it.
        let reviewed = owner.read("note.md").unwrap().sha256;
        let refused = delayed(
            &owner,
            vec![FileChange::Replace {
                path: "note.md".to_string(),
                bytes: b"reviewed".to_vec(),
                expected_sha256: Some(reviewed),
            }],
            || assert_eq!(owner.apply(&[overwrite("note.md", "C")]), Ok(())),
        );
        assert!(
            matches!(
                &refused,
                Err(ApplyError::Refused {
                    error: FileError::Conflict { .. }
                })
            ),
            "{refused:?}"
        );
        assert_eq!(read("note.md").as_deref(), Some("C"));
    }

    #[test]
    fn a_second_delivery_of_a_landed_save_lands_again() {
        let temp = TempDir::new("duplicate-delivery");
        let root = temp.folder("notes");
        let owner = open(&root);
        let read = |path: &str| std::fs::read_to_string(root.join(path)).ok();

        // A save lands, a later one lands, and the first is delivered again,
        // as Tauri's IPC fallback does when the first reply is lost. Nothing
        // remembers the first delivery: the repeat lands and is final.
        owner.apply(&[overwrite("b.md", "three")]).unwrap();
        owner.apply(&[overwrite("b.md", "four")]).unwrap();
        assert_eq!(owner.apply(&[overwrite("b.md", "three")]), Ok(()));
        assert_eq!(read("b.md").as_deref(), Some("three"));

        // Conditions still hold for a repeat: a create finds its own first
        // delivery's file and is refused.
        owner.apply(&[create("new.md", "first")]).unwrap();
        assert!(matches!(
            owner.apply(&[create("new.md", "first")]),
            Err(ApplyError::Refused {
                error: FileError::Exists { .. }
            })
        ));
    }

    /// A folder whose one commit is on its bare remote, so a push and a
    /// fetch both have a real remote to reach.
    fn pushed(temp: &TempDir) -> (FolderOwner, String) {
        let bare = temp.folder("remote.git");
        git(
            &bare,
            &["init", "--quiet", "--bare", "--initial-branch=main"],
        );
        let root = temp.folder("notes");
        let owner = FolderOwner::open(FolderConfig {
            remote: Some(Remote {
                url: bare.display().to_string(),
                branch: "main".to_string(),
            }),
            ..config(&root)
        })
        .unwrap();
        owner.apply(&[create("a.md", "A")]).unwrap();
        owner.commit();
        let head = git(&root, &["rev-parse", "HEAD"]);
        assert_eq!(owner.push(None), PushOutcome::Pushed { oid: head.clone() });
        (owner, head)
    }

    /// A transport hook that counts every admission and holds the first one,
    /// after reporting it, until released.
    fn count_and_hold_first() -> (
        Arc<dyn Fn() + Send + Sync>,
        Arc<AtomicUsize>,
        mpsc::Receiver<()>,
        mpsc::Sender<()>,
    ) {
        let admitted = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&admitted);
        let (reached, at_hook) = mpsc::channel::<()>();
        let (release, gate) = mpsc::channel::<()>();
        let gate = Mutex::new(gate);
        let hook: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            if counter.fetch_add(1, Ordering::SeqCst) == 0 {
                reached.send(()).unwrap();
                gate.lock().unwrap().recv().unwrap();
            }
        });
        (hook, admitted, at_hook, release)
    }

    // A request is withdrawn from the push runner and then from the fetch
    // runner. These two tests stop between those steps, with the request
    // waiting in the runner that has not been told yet, and wake its waiter.
    // The waiter must not report a withdrawal that its own runner has not
    // made: it is still queued there, and its transport will start.

    #[test]
    fn a_fetch_is_not_told_it_was_withdrawn_by_the_push_half_of_a_withdrawal() {
        let temp = TempDir::new("half-withdraw-fetch");
        let (owner, head) = pushed(&temp);
        let (hook, admitted, at_hook, release) = count_and_hold_first();
        owner.hooks().during_fetch = Some(hook);
        let inner = &owner.inner;

        let a_fetching = {
            let owner = owner.clone();
            std::thread::spawn(move || owner.fetch(None))
        };
        at_hook.recv().unwrap();
        let b = owner.request();
        let caller = b.caller();
        let b_fetching = {
            let (owner, caller) = (owner.clone(), caller.clone());
            std::thread::spawn(move || owner.fetch(Some(&caller)))
        };
        while !inner.fetch.pending(&caller.fetch) {
            std::thread::yield_now();
        }

        // The first half of dropping `b`, and then a wake of every fetch
        // waiter, as any other caller's withdrawal causes.
        inner.push.withdraw(&caller.push);
        inner.fetch.withdraw(&inner.fetch.leaving());
        assert!(
            inner.fetch.pending(&caller.fetch),
            "B is still waiting for its fetch"
        );

        // B was never withdrawn from the fetch runner, so its fetch is
        // admitted when A's finishes, and B hears how it ended.
        release.send(()).unwrap();
        let fetched = Ok(FetchOutcome {
            oid: Some(head.clone()),
        });
        assert_eq!(a_fetching.join().unwrap(), fetched);
        assert_eq!(b_fetching.join().unwrap(), fetched);
        assert_eq!(admitted.load(Ordering::SeqCst), 2);

        // The second half arrives after the transport ran: nothing to undo.
        drop(b);
        assert_eq!(owner.fetch(Some(&caller)), Err(GitError::Withdrawn));
        assert_eq!(admitted.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_push_is_not_told_it_was_withdrawn_by_the_fetch_half_of_a_withdrawal() {
        let temp = TempDir::new("half-withdraw-push");
        let (owner, head) = pushed(&temp);
        let (hook, admitted, at_hook, release) = count_and_hold_first();
        owner.hooks().during_push = Some(hook);
        let inner = &owner.inner;

        let a_pushing = {
            let owner = owner.clone();
            std::thread::spawn(move || owner.push(None))
        };
        at_hook.recv().unwrap();
        let b = owner.request();
        let caller = b.caller();
        let b_pushing = {
            let (owner, caller) = (owner.clone(), caller.clone());
            std::thread::spawn(move || owner.push(Some(&caller)))
        };
        while !inner.push.pending(&caller.push) {
            std::thread::yield_now();
        }

        // Only the fetch side has been told, and every push waiter is woken.
        inner.fetch.withdraw(&caller.fetch);
        inner.push.withdraw(&inner.push.leaving());
        assert!(
            inner.push.pending(&caller.push),
            "B is still waiting for its push"
        );

        release.send(()).unwrap();
        let pushed = PushOutcome::Pushed { oid: head };
        assert_eq!(a_pushing.join().unwrap(), pushed);
        assert_eq!(b_pushing.join().unwrap(), pushed);
        assert_eq!(admitted.load(Ordering::SeqCst), 2);

        drop(b);
        assert_eq!(
            owner.push(Some(&caller)),
            PushOutcome::Cancelled { oid: None }
        );
        assert_eq!(admitted.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn dropping_a_request_withdraws_it_where_it_waits_and_nowhere_reports_early() {
        let temp = TempDir::new("whole-withdraw");
        let (owner, head) = pushed(&temp);
        let (push_hook, pushes, at_push, release_push) = count_and_hold_first();
        let (fetch_hook, fetches, at_fetch, release_fetch) = count_and_hold_first();
        owner.hooks().during_push = Some(push_hook);
        owner.hooks().during_fetch = Some(fetch_hook);
        let inner = &owner.inner;

        // One push and one fetch are admitted and held. Two requests wait
        // behind them: B for a fetch, C for a push.
        let a_pushing = {
            let owner = owner.clone();
            std::thread::spawn(move || owner.push(None))
        };
        let a_fetching = {
            let owner = owner.clone();
            std::thread::spawn(move || owner.fetch(None))
        };
        at_push.recv().unwrap();
        at_fetch.recv().unwrap();
        let (b, c) = (owner.request(), owner.request());
        let (b_caller, c_caller) = (b.caller(), c.caller());
        let b_fetching = {
            let (owner, caller) = (owner.clone(), b_caller.clone());
            std::thread::spawn(move || owner.fetch(Some(&caller)))
        };
        let c_pushing = {
            let (owner, caller) = (owner.clone(), c_caller.clone());
            std::thread::spawn(move || owner.push(Some(&caller)))
        };
        while !(inner.fetch.pending(&b_caller.fetch) && inner.push.pending(&c_caller.push)) {
            std::thread::yield_now();
        }

        // Each whole withdrawal takes its request out of the runner it waits
        // in, and that runner is the one that tells its waiter.
        drop(b);
        assert_eq!(b_fetching.join().unwrap(), Err(GitError::Withdrawn));
        assert!(inner.push.pending(&c_caller.push), "C was not touched");
        drop(c);
        assert_eq!(
            c_pushing.join().unwrap(),
            PushOutcome::Cancelled { oid: None }
        );

        // The admitted transports finish, and no other ever started.
        release_push.send(()).unwrap();
        release_fetch.send(()).unwrap();
        assert_eq!(
            a_pushing.join().unwrap(),
            PushOutcome::Pushed { oid: head.clone() }
        );
        assert_eq!(
            a_fetching.join().unwrap(),
            Ok(FetchOutcome { oid: Some(head) })
        );
        owner.shutdown();
        assert_eq!(pushes.load(Ordering::SeqCst), 1);
        assert_eq!(fetches.load(Ordering::SeqCst), 1);
    }
}
