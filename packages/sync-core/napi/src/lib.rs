//! The sync core as a Node-API addon, so the CLI (Bun) runs a round
//! in-process with `settle` from `@epicenter/definition/merge` as the note
//! merge.
//!
//! Spike shape: `syncRound` is synchronous and blocks the JS thread for the
//! whole round, which is what lets the core call `settle` back directly. A
//! real binding would run the round on a worker thread (`AsyncTask`) and call
//! `settle` through a `ThreadsafeFunction`, waiting on its return value.

use std::path::Path;

use epicenter_sync_core::{self as core, LfsEndpoint, NoteInput, NoteMerge, Options, Remote, Status};
use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi(object)]
pub struct SyncRemote {
    pub url: String,
    /// Sent as `Authorization: Bearer <token>`; never stored.
    pub token: Option<String>,
    /// The LFS batch API base (`lfs.url`); defaults to `<url>/info/lfs`.
    pub lfs_url: Option<String>,
}

#[napi(object)]
pub struct SyncOptions {
    pub remote: Option<SyncRemote>,
    /// The computer's name, for "Added from <machine>".
    pub machine: String,
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

struct JsSettle<'a, 'scope> {
    settle: &'a Function<'scope, SettleInput, String>,
}

impl NoteMerge for JsSettle<'_, '_> {
    fn settle(&self, n: &NoteInput) -> std::result::Result<String, String> {
        self.settle
            .call(SettleInput {
                path: n.path.to_string(),
                base: n.base.map(str::to_string),
                current: n.current.to_string(),
                incoming: n.incoming.to_string(),
                current_author: n.current_party.author.clone(),
                current_time: n.current_party.time.clone(),
                incoming_author: n.incoming_party.author.clone(),
                incoming_time: n.incoming_party.time.clone(),
            })
            .map_err(|e| e.reason.clone())
    }
}

/// Run one sync round for the folder at `folder`, merging notes with `settle`.
#[napi]
pub fn sync_round(folder: String, options: SyncOptions, settle: Function<SettleInput, String>) -> SyncRound {
    let merge = JsSettle { settle: &settle };
    let remote = options.remote.map(|r| Remote {
        lfs: r.lfs_url.map(LfsEndpoint::Http),
        url: r.url,
        token: r.token,
    });
    let round = core::sync_round(Path::new(&folder), &Options { remote, machine: options.machine, merge: &merge });
    SyncRound {
        status: match round.status {
            Status::Synced => "synced",
            Status::Retry => "retry",
            Status::Stopped => "stopped",
        }
        .into(),
        head: round.head,
        notes: round.notes,
        message: round.message,
    }
}

/// The libgit2 version linked into this addon.
#[napi]
pub fn libgit2_version() -> String {
    let v = git2_version();
    format!("{}.{}.{}", v.0, v.1, v.2)
}

fn git2_version() -> (u32, u32, u32) {
    core::libgit2_version()
}
