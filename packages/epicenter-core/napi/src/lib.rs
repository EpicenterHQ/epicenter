//! The sync core as a Node-API addon, so a Bun or Node program runs a
//! round in-process with `settle` from `@epicenter/definition/merge` as the
//! note merge, and turns sync on for a folder (`open`, `locate`,
//! `setSynced`, `connect`) without a `git` program.
//!
//! `sync` returns a promise: the round runs on the runtime's worker pool as
//! an `AsyncTask`, and the JavaScript thread stays free for the program's
//! other work, such as `epicenter native-host` answering the extension, or
//! a server in the same process answering the round's own requests. The
//! core calls `settle` back through a `ThreadsafeFunction`: each call is
//! queued onto the JavaScript thread, and the round's thread waits for its
//! return value.

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

use epicenter_core::{
    self as core, folder, lock, LfsEndpoint, NoteInput, NoteMerge, Options, Remote,
    Status as RoundStatus,
};
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

#[napi(object)]
pub struct SyncRemote {
    pub url: String,
    /// Sent as `Authorization: Bearer <token>` to the remote's origin; never stored.
    pub token: Option<String>,
    /// The LFS batch API base (`lfs.url`); defaults to `<url>/info/lfs`.
    pub lfs_url: Option<String>,
}

#[napi(object)]
pub struct SyncOptions {
    pub remote: Option<SyncRemote>,
    /// The computer's name, for "Added from <machine>".
    pub machine: String,
    /// How long to wait for another program's round on the folder before
    /// the round ends `retry`; two minutes when absent, as the CLI waits.
    pub turn_wait_ms: Option<u32>,
}

/// One note both sides changed, as `settle` takes it.
#[napi(object)]
pub struct SettleInput {
    pub path: String,
    pub base: Option<String>,
    pub current: String,
    pub incoming: String,
    pub current_author: String,
    pub current_time: String,
    pub incoming_author: String,
    pub incoming_time: String,
}

#[napi(object)]
pub struct SyncRound {
    /// `synced`, `retry`, or `stopped`.
    pub status: String,
    pub head: Option<String>,
    pub notes: Vec<String>,
    pub message: Option<String>,
}

/// `settle`, called with the input alone (no error-first argument), returning the merged text.
type Settle = ThreadsafeFunction<SettleInput, String, SettleInput, Status, false>;

struct JsSettle<'a>(&'a Settle);

impl NoteMerge for JsSettle<'_> {
    fn settle(&self, n: &NoteInput) -> std::result::Result<String, String> {
        let input = SettleInput {
            path: n.path.to_string(),
            base: n.base.map(str::to_string),
            current: n.current.to_string(),
            incoming: n.incoming.to_string(),
            current_author: n.current_party.author.clone(),
            current_time: n.current_party.time.clone(),
            incoming_author: n.incoming_party.author.clone(),
            incoming_time: n.incoming_party.time.clone(),
        };
        let (answer, answered) = mpsc::sync_channel(1);
        let status = self.0.call_with_return_value(
            input,
            ThreadsafeFunctionCallMode::Blocking,
            move |merged, _| {
                let _ = answer.send(merged.map_err(|e| e.reason.clone()));
                Ok(())
            },
        );
        if status != Status::Ok {
            return Err(format!("settle could not be called ({status})"));
        }
        answered
            .recv()
            .map_err(|_| "settle never answered".to_string())?
    }
}

pub struct RoundTask {
    folder: PathBuf,
    remote: Option<Remote>,
    machine: String,
    turn_wait: Duration,
    settle: Settle,
}

impl Task for RoundTask {
    type Output = core::Round;
    type JsValue = SyncRound;

    fn compute(&mut self) -> Result<core::Round> {
        Ok(core::sync_round(
            &self.folder,
            &Options {
                remote: self.remote.clone(),
                machine: self.machine.clone(),
                merge: &JsSettle(&self.settle),
                turn_wait: self.turn_wait,
            },
        ))
    }

    fn resolve(&mut self, _: Env, round: core::Round) -> Result<SyncRound> {
        Ok(SyncRound {
            status: match round.status {
                RoundStatus::Synced => "synced",
                RoundStatus::Retry => "retry",
                RoundStatus::Stopped => "stopped",
            }
            .into(),
            head: round.head,
            notes: round.notes,
            message: round.message,
        })
    }
}

/// Run one sync round for the folder at `folder` off the JavaScript
/// thread, merging notes with `settle`. Never rejects for a stop: a stop is
/// a round with status `retry` or `stopped`.
#[napi(ts_return_type = "Promise<SyncRound>")]
pub fn sync(
    folder: String,
    options: SyncOptions,
    #[napi(ts_arg_type = "(input: SettleInput) => string")] settle: Settle,
) -> AsyncTask<RoundTask> {
    AsyncTask::new(RoundTask {
        folder: PathBuf::from(folder),
        remote: options.remote.map(|r| Remote {
            lfs: r.lfs_url.map(LfsEndpoint::Http),
            url: r.url,
            token: r.token,
        }),
        machine: options.machine,
        turn_wait: options
            .turn_wait_ms
            .map(|ms| Duration::from_millis(ms.into()))
            .unwrap_or(lock::TURN_WAIT),
        settle,
    })
}

/// The libgit2 version linked into this addon.
#[napi]
pub fn libgit2_version() -> String {
    let (major, minor, patch) = core::libgit2_version();
    format!("{major}.{minor}.{patch}")
}

/// A refusal or failure from the core, as a thrown JavaScript `Error` whose
/// message is the core's.
fn thrown(e: core::Error) -> Error {
    Error::from_reason(e.message)
}

#[napi(object)]
pub struct Opened {
    /// Whether this call made the repository.
    pub initialized: bool,
    /// The Git LFS filter settings this call wrote, in order.
    pub configured: Vec<String>,
}

/// Open the folder's own repository, or make one with `main` and no
/// commits, and write the Git LFS filter settings it lacks. Throws, writing
/// nothing, for a repository in a state only a person can finish.
#[napi]
pub fn open(folder: String) -> Result<Opened> {
    let opened = folder::open(Path::new(&folder)).map_err(thrown)?;
    Ok(Opened {
        initialized: opened.initialized,
        configured: opened.configured.into_iter().map(str::to_string).collect(),
    })
}

#[napi(object)]
pub struct Located {
    /// The top of the working tree, links resolved.
    pub root: String,
    /// Whether the repository's own configuration records consent.
    pub synced: bool,
    pub origin: Option<String>,
}

/// The repository whose working tree holds `folder`, or null.
#[napi]
pub fn locate(folder: String) -> Result<Option<Located>> {
    Ok(folder::locate(Path::new(&folder))
        .map_err(thrown)?
        .map(|found| Located {
            root: found.root.to_string_lossy().into_owned(),
            synced: found.synced,
            origin: found.origin,
        }))
}

/// Record (`true`) or clear (`false`) consent to sync in the folder's own
/// repository. Returns whether its configuration changed.
#[napi]
pub fn set_synced(folder: String, synced: bool) -> Result<bool> {
    folder::set_synced(Path::new(&folder), synced).map_err(thrown)
}

/// Make `url` the folder's `origin`. Returns whether it was added; throws
/// when `origin` is another remote or pushes elsewhere.
#[napi]
pub fn connect(folder: String, url: String) -> Result<bool> {
    folder::connect(Path::new(&folder), &url).map_err(thrown)
}
