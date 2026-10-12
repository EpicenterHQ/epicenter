//! The IPC surface: one thin command per owner operation.
//!
//! Every command but `attach` names a session by resource ID. The ID is looked
//! up in the invoking webview's own resource table, and the session is then
//! checked against the invoking window's label, so a page can only use a
//! session it attached itself. No command accepts a root, an author, a remote,
//! or a history policy.
//!
//! Owner calls block on files and `git`, so each runs on the blocking pool,
//! never on the thread that drives the windows.

use std::collections::BTreeMap;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use epicenter_folder_core::files::{
    ApplyError, Children, FileChange, FileError, FileListing, FileRead,
};
use epicenter_folder_core::git::{CommitSummary, PathStatus};
use epicenter_folder_core::history::{
    CommitOutcome, FetchOutcome, FilesObservation, GitError, GitSnapshot, MergeError, MergeOutcome,
    MergePolicy, OwnerEvent, PullError, PullOutcome, PushOutcome, RecoverOutcome, Settled,
};
use epicenter_folder_core::owner::{Caller, FolderOwner};
use epicenter_folder_core::registry::AttachError;
use serde::Serialize;
use specta::Type;
use tauri::{Manager, Resource, ResourceId, Runtime, Webview};
use tauri_specta::Event;

use crate::lifecycle::{Instance, Live, SessionState};
use crate::Folders;

/// The shared Git snapshot of a scope changed.
#[derive(Debug, Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct FolderSnapshotChanged {
    pub scope: String,
    /// Only grows; an event numbered at or below the last one seen is stale.
    pub sequence: u64,
    pub snapshot: GitSnapshot,
}

/// Files of a scope changed, through any window or outside the app.
#[derive(Debug, Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct FolderFilesChanged {
    pub scope: String,
    pub revision: u64,
    pub paths: Vec<String>,
}

/// The version of this command contract. A page built against another
/// version is refused at attach, before it can change anything.
///
/// Version 9 is the unreleased command contract. Push and fetch name a
/// session-owned request that can withdraw before transport admission. No
/// command holds the folder across calls or names a terminal lease. A read
/// returns its bytes and their SHA-256, and a file change is one of create,
/// replace, overwrite, remove, or move. Replace, remove, and move take an
/// optional `expectedSha256` guard; a replacement without one still requires
/// an existing file.
///
/// Version 5 added the incoming record: the snapshot's `pendingIncoming`,
/// `recover_incoming`, and the refusals a pending update causes. Version 6
/// made `replace`'s `expectedSha256` optional: a version 5 page would read a
/// missing unguarded target as `Conflict`, not `NotFound`. Version 7 removed
/// the number `apply` named and the `Superseded` refusal: saves are no longer
/// ordered by the page, and the last to land wins. Version 8 added
/// `merge_incoming`, with a `conflicts` mode that could leave a merge
/// unfinished, and the snapshot's `merging`, `lastMerge`, and merge
/// activity. Within version 8, `merge_incoming` also gained optional
/// `allowUnrelatedHistories` and `versions`.
///
/// Version 9 removed unfinished merges: `merge_incoming` takes no
/// `conflicts` and refuses every conflict, its outcome has no `conflicted`
/// status, and the snapshot's `merging`, a recorded incoming update's
/// `merge`, the `Unmerged` refusal, and a staged commit's `incoming` and
/// `mergeStateWarning` are gone. A Git merge a person began outside
/// Epicenter blocks commits and incoming updates instead. A version 8 page
/// asking to leave conflicts would get a refusal, and would read the missing
/// `merging` as no merge in progress.
///
/// Version 10 removed manual history: every save commits. The snapshot's
/// `commitOnEdit`, the `stage` and `commit_staged` commands, `diff`'s
/// `staged`, and the `InvalidMessage`, `NothingToCommit`, `AutomaticHistory`,
/// `BranchMoved`, and `IncomingPending` Git refusals are gone. A version 9
/// page would read the missing `commitOnEdit` as manual history and call
/// commands that no longer exist. Any other version is refused at attach.
pub const PROTOCOL: u32 = 10;

/// What a window receives when it attaches to a scope.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Attached {
    /// Names this window's session in every later call.
    pub session: u32,
    /// The canonical directory the owner holds, for showing to a person.
    pub root: String,
    /// The snapshot at attach; events numbered above `sequence` follow it.
    pub sequence: u64,
    pub snapshot: GitSnapshot,
}

/// One window's session as the webview's resource table holds it, so a
/// command can find it by resource ID. The session itself is `SessionState`,
/// which the plugin's lifecycle state also reaches, weakly, to end it when
/// the page or the window goes away. `detach` closes the resource; a
/// destroyed window's table cannot be reached, so its sessions are ended
/// through the lifecycle instead. The owner and every other session carry on.
struct SessionResource(Arc<SessionState>);

const SESSION_RESOURCE: &str = "epicenter-folder-session";

impl Resource for SessionResource {
    fn name(&self) -> std::borrow::Cow<'_, str> {
        SESSION_RESOURCE.into()
    }

    fn close(self: Arc<Self>) {
        self.0.end();
    }
}

/// The identity of one actual webview, kept in that webview's own resource
/// table. Clones of a `Webview` share its table; a new webview created under
/// the same label has its own. See `lifecycle`.
struct InstanceResource(Arc<Instance>);

const INSTANCE_RESOURCE: &str = "epicenter-folder-webview";

impl Resource for InstanceResource {
    fn name(&self) -> std::borrow::Cow<'_, str> {
        INSTANCE_RESOURCE.into()
    }
}

/// Give a webview Tauri just announced its instance. A webview that already
/// has one keeps it.
pub(crate) fn adopt<R: Runtime>(webview: &Webview<R>) {
    if instance(webview).is_some() {
        return;
    }
    let created = webview
        .state::<Folders>()
        .lifecycles
        .created(webview.window().label());
    webview.resources_table().add(InstanceResource(created));
}

/// The instance of exactly this webview, read from its own table.
fn instance<R: Runtime>(webview: &Webview<R>) -> Option<Arc<Instance>> {
    let table = webview.resources_table();
    let rid = table
        .names()
        .find(|(_, name)| name == INSTANCE_RESOURCE)
        .map(|(rid, _)| rid)?;
    table
        .get::<InstanceResource>(rid)
        .ok()
        .map(|resource| Arc::clone(&resource.0))
}

/// A page is going away: a reload or a navigation. A webview's resource table
/// outlives its pages, so the sessions the old page attached are ended here,
/// which stops its events and withdraws its unstarted pushes and fetches,
/// and an attach still in flight for the old page is fenced. Only this plugin's resources are
/// touched. The owner, what it already admitted, and every other window
/// carry on.
pub(crate) fn end_page<R: Runtime>(webview: &Webview<R>) {
    // This webview's own instance: a handle to a destroyed webview that
    // shares a label with a live one ends nothing of the live one's.
    if let Some(instance) = instance(webview) {
        instance.page_started();
    }
    #[cfg(test)]
    crate::tests::page_advanced(webview.label());
    // The ended sessions are inert; drop their table entries as well. Only
    // those: the new page may already have attached, and its session sits in
    // this same table. Which sessions the old page's were is decided by the
    // instance, above; here an entry goes only if its session has ended. The
    // table lock is held while each session is asked, and a session's own
    // lock is the innermost one, so this takes nothing `register` holds.
    let mut table = webview.resources_table();
    let ended: Vec<ResourceId> = table
        .names()
        .filter(|(_, name)| name == SESSION_RESOURCE)
        .map(|(rid, _)| rid)
        .filter(|rid| {
            table
                .get::<SessionResource>(*rid)
                .is_ok_and(|resource| resource.0.ended())
        })
        .collect();
    for rid in ended {
        let _ = table.close(rid);
    }
}

const NO_SESSION: &str = "this window has no such folder session; attach first";

fn session<R: Runtime>(webview: &Webview<R>, rid: ResourceId) -> Result<Arc<SessionState>, String> {
    let resource = webview
        .resources_table()
        .get::<SessionResource>(rid)
        .map_err(|_| NO_SESSION.to_string())?;
    Ok(Arc::clone(&resource.0))
}

fn owner<R: Runtime>(webview: &Webview<R>, rid: ResourceId) -> Result<FolderOwner, String> {
    session(webview, rid)?.owner(webview.label())
}

fn file_denied(reason: String) -> FileError {
    FileError::Denied { reason }
}

fn git_denied(reason: String) -> GitError {
    GitError::Denied { reason }
}

/// Run blocking owner work off the window thread.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
    lost: impl FnOnce(String) -> T,
) -> T {
    match tauri::async_runtime::spawn_blocking(work).await {
        Ok(value) => value,
        Err(cause) => lost(cause.to_string()),
    }
}

/// A read whose worker was lost changed nothing: an ordinary failure.
fn file_lost<T>(operation: &'static str) -> impl FnOnce(String) -> Result<T, FileError> {
    move |cause| {
        Err(FileError::Io {
            path: String::new(),
            operation: operation.to_string(),
            cause,
        })
    }
}

/// A publication whose worker was lost may have reached the folder.
fn file_unconfirmed(operation: &'static str, path: String) -> impl FnOnce(String) -> FileError {
    move |cause| FileError::Unconfirmed {
        path,
        operation: operation.to_string(),
        cause,
    }
}

fn git_lost<T>(operation: &'static str) -> impl FnOnce(String) -> Result<T, GitError> {
    move |cause| Err(GitError::failed(operation, cause))
}

/// A Git change whose worker was lost may have reached history.
fn git_unconfirmed(operation: &'static str) -> impl FnOnce(String) -> GitError {
    move |cause| GitError::Unconfirmed {
        operation: operation.to_string(),
        cause,
    }
}

// ============================================================================
// Sessions
// ============================================================================

/// Attach this window to a scope the shell registered for it. The folder is
/// locked and opened on its first attach and stays open afterward.
#[tauri::command]
#[specta::specta]
pub async fn attach<R: Runtime>(
    webview: Webview<R>,
    scope: String,
    protocol: u32,
) -> Result<Attached, AttachError> {
    if protocol != PROTOCOL {
        return Err(AttachError::Incompatible {
            host: PROTOCOL,
            page: protocol,
        });
    }
    let label = webview.label().to_string();
    // The instance and page this attach belongs to: those of exactly this
    // webview, read from its own table. This handle can outlive its window,
    // and another window can take its label meanwhile; the label says nothing
    // about which webview this is.
    let gone = || AttachError::Unavailable {
        message: "the page that was attaching is gone".to_string(),
    };
    let instance = instance(&webview).ok_or_else(gone)?;
    let attaching_page = instance.page().ok_or_else(gone)?;
    let app = webview.app_handle().clone();
    let attaching = (scope.clone(), label.clone());
    let session = blocking(
        move || {
            let session = app
                .state::<Folders>()
                .registry
                .attach(&attaching.0, &attaching.1);
            #[cfg(test)]
            crate::tests::attach_opened(&attaching.1);
            session
        },
        |message| Err(AttachError::Unavailable { message }),
    )
    .await?;
    let owner = session
        .authorize(&label)
        .map_err(|message| AttachError::Unavailable { message })?
        .clone();

    // The owner calls listeners while it holds its snapshot lock, so the
    // listener only queues; a thread of this session does the emitting.
    let (queue, events) = mpsc::channel::<OwnerEvent>();
    let queue = Mutex::new(queue);
    let subscription = owner.subscribe(move |event| {
        let _ = queue
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .send(event.clone());
    });
    let target = webview.app_handle().clone();
    let (event_scope, event_label) = (scope, label.clone());
    std::thread::Builder::new()
        .name("folder-events".to_string())
        .spawn(move || {
            // Ends when the subscription, and so the sender, is dropped.
            for event in events {
                let _ = match event {
                    OwnerEvent::Snapshot { sequence, snapshot } => FolderSnapshotChanged {
                        scope: event_scope.clone(),
                        sequence,
                        snapshot,
                    }
                    .emit_to(&target, event_label.as_str()),
                    OwnerEvent::FilesChanged { revision, paths } => FolderFilesChanged {
                        scope: event_scope.clone(),
                        revision,
                        paths,
                    }
                    .emit_to(&target, event_label.as_str()),
                };
            }
        })
        .map_err(|cause| AttachError::Unavailable {
            message: format!("the folder event thread could not start: {cause}"),
        })?;

    let (sequence, snapshot) = owner.sequenced_snapshot();
    let state = SessionState::new(
        &instance,
        Live {
            session,
            requests: BTreeMap::new(),
            _subscription: subscription,
        },
    );
    // Registered only if the page that asked is still this webview's current
    // page. Its window may have been destroyed, or the page reloaded, while
    // the folder was being opened; the session would belong to nobody.
    let registered = instance.register(attaching_page, &state, || {
        webview
            .resources_table()
            .add(SessionResource(Arc::clone(&state)))
    });
    let Some(rid) = registered else {
        state.end();
        return Err(gone());
    };
    Ok(Attached {
        session: rid,
        root: owner.root().display().to_string(),
        sequence,
        snapshot: (*snapshot).clone(),
    })
}

/// End this window's session. Saves it already made still land, a commit the
/// owner already admitted still finishes, and every other window is
/// unaffected.
#[tauri::command]
#[specta::specta]
pub fn detach<R: Runtime>(webview: Webview<R>, session: u32) {
    let _ = webview.resources_table().close(session);
}

// ============================================================================
// Files
// ============================================================================

#[tauri::command]
#[specta::specta]
pub async fn list<R: Runtime>(webview: Webview<R>, session: u32) -> Result<FileListing, FileError> {
    let owner = owner(&webview, session).map_err(file_denied)?;
    blocking(move || owner.list(), file_lost("enumerate")).await
}

#[tauri::command]
#[specta::specta]
pub async fn children<R: Runtime>(
    webview: Webview<R>,
    session: u32,
    directory: String,
) -> Result<Children, FileError> {
    let owner = owner(&webview, session).map_err(file_denied)?;
    blocking(move || owner.children(&directory), file_lost("list")).await
}

#[tauri::command]
#[specta::specta]
pub async fn read<R: Runtime>(
    webview: Webview<R>,
    session: u32,
    path: String,
) -> Result<FileRead, FileError> {
    let owner = owner(&webview, session).map_err(file_denied)?;
    blocking(move || owner.read(&path), file_lost("read")).await
}

/// One result per requested path, in the order given.
#[tauri::command]
#[specta::specta]
pub async fn read_many<R: Runtime>(
    webview: Webview<R>,
    session: u32,
    paths: Vec<String>,
) -> Result<Vec<Settled<FileRead, FileError>>, FileError> {
    let owner = owner(&webview, session).map_err(file_denied)?;
    blocking(
        move || {
            Ok(owner
                .read_many(&paths)?
                .into_iter()
                .map(Settled::from)
                .collect())
        },
        file_lost("read"),
    )
    .await
}

/// Publish ordered changes. Where the folder commits on edit, a complete
/// batch requests an automatic local commit. While the folder is busy,
/// requests coalesce and wait for its protection.
///
/// Saves are published in the order they reach the folder, not the order a
/// page asked for them. The last to land on a path wins, from any window, and
/// a delivery that arrives late or twice lands like any other. A change that
/// must not overwrite bytes its caller did not review carries
/// `expectedSha256`.
#[tauri::command]
#[specta::specta]
pub async fn apply<R: Runtime>(
    webview: Webview<R>,
    session: u32,
    changes: Vec<FileChange>,
) -> Result<(), ApplyError> {
    let owner = owner(&webview, session).map_err(|reason| ApplyError::Refused {
        error: file_denied(reason),
    })?;
    let path = changes
        .first()
        .map(|change| change.step().paths()[0].to_string())
        .unwrap_or_default();
    #[cfg(test)]
    let label = webview.label().to_string();
    blocking(
        move || {
            #[cfg(test)]
            crate::tests::apply_admitted(&label);
            owner.apply(&changes)
        },
        // Not a refusal: some of the batch may have landed.
        |cause| {
            Err(ApplyError::Unconfirmed {
                path,
                operation: "publishing to".to_string(),
                cause,
            })
        },
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn mkdir<R: Runtime>(
    webview: Webview<R>,
    session: u32,
    path: String,
) -> Result<(), FileError> {
    let owner = owner(&webview, session).map_err(file_denied)?;
    let lost = file_unconfirmed("creating", path.clone());
    blocking(move || owner.mkdir(&path), |cause| Err(lost(cause))).await
}

#[tauri::command]
#[specta::specta]
pub async fn rmdir<R: Runtime>(
    webview: Webview<R>,
    session: u32,
    path: String,
) -> Result<(), FileError> {
    let owner = owner(&webview, session).map_err(file_denied)?;
    let lost = file_unconfirmed("removing", path.clone());
    blocking(move || owner.rmdir(&path), |cause| Err(lost(cause))).await
}

// ============================================================================
// Git
// ============================================================================

#[tauri::command]
#[specta::specta]
pub async fn status<R: Runtime>(
    webview: Webview<R>,
    session: u32,
) -> Result<FilesObservation, GitError> {
    let owner = owner(&webview, session).map_err(git_denied)?;
    blocking(move || owner.status(), git_lost("status")).await
}

/// Commit the folder's current files. This waits for the folder and settles
/// as an outcome, never as an error, once the session is accepted.
#[tauri::command]
#[specta::specta]
pub async fn commit<R: Runtime>(
    webview: Webview<R>,
    session: u32,
) -> Result<CommitOutcome, GitError> {
    let owner = owner(&webview, session).map_err(git_denied)?;
    Ok(blocking(
        move || owner.commit(),
        |error| CommitOutcome::Unconfirmed { error },
    )
    .await)
}

/// Announce a push or fetch this window is about to ask for, and get the
/// number that names it. The request is this session's: only this session can
/// use it or withdraw it, and it ends with the session.
#[tauri::command]
#[specta::specta]
pub fn open_request<R: Runtime>(webview: Webview<R>, session: u32) -> Result<u64, GitError> {
    let resource = self::session(&webview, session).map_err(git_denied)?;
    let owner = owner(&webview, session).map_err(git_denied)?;
    resource.open_request(owner.request()).map_err(git_denied)
}

/// Withdraw a request this session opened. A push or fetch for it that the
/// owner has not started never starts, and one that names it later is
/// refused. A transport the owner already started runs to its end.
/// Withdrawing a request that is gone does nothing.
#[tauri::command]
#[specta::specta]
pub fn withdraw_request<R: Runtime>(webview: Webview<R>, session: u32, request: u64) {
    if let Ok(resource) = self::session(&webview, session) {
        resource.close_request(request);
    }
}

/// The owner and the caller's way to withdraw, for the one push or fetch that
/// `request` was opened for.
fn requested<R: Runtime>(
    webview: &Webview<R>,
    rid: ResourceId,
    request: u64,
) -> Result<(Arc<SessionState>, FolderOwner, Caller), String> {
    let session = session(webview, rid)?;
    let owner = session.owner(webview.label())?;
    let caller = session.use_request(request)?;
    Ok((session, owner, caller))
}

/// Push for a request this session opened. It waits behind a running push and
/// can be withdrawn until the owner starts its transport.
#[tauri::command]
#[specta::specta]
pub async fn push<R: Runtime>(
    webview: Webview<R>,
    session: u32,
    request: u64,
) -> Result<PushOutcome, GitError> {
    let (resource, owner, caller) = requested(&webview, session, request).map_err(git_denied)?;
    let outcome = blocking(
        move || owner.push(Some(&caller)),
        |error| PushOutcome::Unconfirmed { error },
    )
    .await;
    resource.close_request(request);
    Ok(outcome)
}

/// Fetch for a request this session opened, like `push`.
#[tauri::command]
#[specta::specta]
pub async fn fetch<R: Runtime>(
    webview: Webview<R>,
    session: u32,
    request: u64,
) -> Result<FetchOutcome, GitError> {
    let (resource, owner, caller) = requested(&webview, session, request).map_err(git_denied)?;
    let outcome = blocking(
        move || owner.fetch(Some(&caller)),
        |cause| Err(git_unconfirmed("fetch")(cause)),
    )
    .await;
    resource.close_request(request);
    outcome
}

#[tauri::command]
#[specta::specta]
pub async fn pull_fast_forward<R: Runtime>(
    webview: Webview<R>,
    session: u32,
) -> Result<PullOutcome, PullError> {
    let owner = owner(&webview, session).map_err(|reason| PullError::from(git_denied(reason)))?;
    blocking(
        move || owner.pull_fast_forward(),
        |cause| Err(git_unconfirmed("pull")(cause).into()),
    )
    .await
}

/// Merge the fetched remote head: a fast-forward when the branch is behind,
/// otherwise a two-parent merge. A conflict is refused and writes nothing.
/// Never fetches.
///
/// `allowUnrelatedHistories` merges histories that share no commit over an
/// empty base; `versions` asks a refused conflict for each conflicted file's
/// committed bytes on both sides. Both are `false` when absent or `null`.
#[tauri::command]
#[specta::specta]
pub async fn merge_incoming<R: Runtime>(
    webview: Webview<R>,
    session: u32,
    allow_unrelated_histories: Option<bool>,
    versions: Option<bool>,
) -> Result<MergeOutcome, MergeError> {
    let owner = owner(&webview, session).map_err(|reason| MergeError::from(git_denied(reason)))?;
    let policy = MergePolicy {
        allow_unrelated_histories: allow_unrelated_histories.unwrap_or(false),
        versions: versions.unwrap_or(false),
    };
    blocking(
        move || owner.merge_incoming(policy),
        |cause| Err(git_unconfirmed("merge")(cause).into()),
    )
    .await
}

/// Finish or clear this folder's pending incoming update, only because the
/// page asked. Opening and status report a pending update and never resume
/// it. Recovery writes only paths still at the update's before state; a path,
/// the index, or the branch in neither state stops it, keeping the record,
/// and names what to resolve.
#[tauri::command]
#[specta::specta]
pub async fn recover_incoming<R: Runtime>(
    webview: Webview<R>,
    session: u32,
) -> Result<RecoverOutcome, PullError> {
    let owner = owner(&webview, session).map_err(|reason| PullError::from(git_denied(reason)))?;
    blocking(
        move || owner.recover_incoming(),
        |cause| Err(git_unconfirmed("recover")(cause).into()),
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn paths<R: Runtime>(
    webview: Webview<R>,
    session: u32,
) -> Result<Vec<PathStatus>, GitError> {
    let owner = owner(&webview, session).map_err(git_denied)?;
    blocking(move || owner.paths(), git_lost("status")).await
}

#[tauri::command]
#[specta::specta]
pub async fn diff<R: Runtime>(
    webview: Webview<R>,
    session: u32,
    paths: Vec<String>,
) -> Result<String, GitError> {
    let owner = owner(&webview, session).map_err(git_denied)?;
    blocking(move || owner.diff(&paths), git_lost("diff")).await
}

#[tauri::command]
#[specta::specta]
pub async fn log<R: Runtime>(
    webview: Webview<R>,
    session: u32,
    depth: u32,
) -> Result<Vec<CommitSummary>, GitError> {
    let owner = owner(&webview, session).map_err(git_denied)?;
    blocking(move || owner.log(depth), git_lost("log")).await
}
