//! One sync round for an Epicenter folder, in-process, over libgit2:
//!
//! ```txt
//! open or init -> fetch origin -> first contact (no history yet: one
//! "Added from <machine>" commit on the remote main) or commit the working
//! tree -> merge origin/main (settle for notes, whole files otherwise) ->
//! LFS upload -> push (a rejected push fetches, merges, and pushes again)
//! ```
//!
//! The spike's counterpart of `packages/cli/src/sync/sync.ts`. No `git` or
//! `git-lfs` program runs, nothing is written into Git configuration but
//! `remote.origin`, and the bearer token is only ever an HTTP header.
//!
//! The note merge is the host's: `NoteMerge` is `settle` from
//! `@epicenter/definition/merge` when the host is Bun, and a stand-in in the
//! Rust tests until `settle` is ported.

pub mod lfs;
pub mod merge;
pub mod worktree;

use std::fmt;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use git2::{Commit, FetchOptions, Oid, PushOptions, RemoteCallbacks, Repository, RepositoryInitOptions, Signature};

pub use lfs::Endpoint as LfsEndpoint;

/// A folder's unfinished local writes (ADR-0702); never committed.
pub const STATE_DIRECTORY: &str = ".epicenter";
const MAIN: &str = "refs/heads/main";
const REMOTE_MAIN: &str = "refs/remotes/origin/main";
const LAST_SEEN: &str = "refs/epicenter/last-seen";
const ATTEMPTS: usize = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Synced,
    /// Transient: the network, a lock, a remote that kept moving. Run again.
    Retry,
    /// A person or an agent must act.
    Stopped,
}

#[derive(Debug)]
pub struct Error {
    pub status: Status,
    pub message: String,
}

impl Error {
    pub fn retry(message: String) -> Error {
        Error { status: Status::Retry, message }
    }
    pub fn stopped(message: String) -> Error {
        Error { status: Status::Stopped, message }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<git2::Error> for Error {
    fn from(e: git2::Error) -> Error {
        use git2::ErrorClass::*;
        let status = match (e.code(), e.class()) {
            (git2::ErrorCode::Locked, _) => Status::Retry,
            (_, Net | Http | Ssl | Os) => Status::Retry,
            _ => Status::Stopped,
        };
        Error { status, message: e.message().to_string() }
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Error {
        Error::retry(e.to_string())
    }
}

/// Who wrote a side, for a conflict block's label.
#[derive(Clone, Debug)]
pub struct Party {
    pub author: String,
    pub time: String,
}

/// One note both sides changed: `settle(base, current, incoming, { parties })`.
pub struct NoteInput<'a> {
    pub path: &'a str,
    pub base: Option<&'a str>,
    /// What `origin/main` holds.
    pub current: &'a str,
    /// This machine's text, arriving after it.
    pub incoming: &'a str,
    pub current_party: &'a Party,
    pub incoming_party: &'a Party,
}

/// The note merge. Returns the merged text.
pub trait NoteMerge {
    fn settle(&self, input: &NoteInput) -> Result<String, String>;
}

#[derive(Clone, Debug)]
pub struct Remote {
    pub url: String,
    /// Sent as `Authorization: Bearer <token>` on every Git and LFS request
    /// to the remote's origin; never written anywhere.
    pub token: Option<String>,
    /// Where LFS objects travel; None means `<url>/info/lfs` for an HTTP remote.
    pub lfs: Option<LfsEndpoint>,
}

impl Remote {
    fn lfs(&self) -> Option<LfsEndpoint> {
        self.lfs.clone().or_else(|| {
            (self.url.starts_with("https://") || self.url.starts_with("http://"))
                .then(|| LfsEndpoint::Http(format!("{}/info/lfs", self.url.trim_end_matches('/'))))
        })
    }
    fn header(&self) -> Option<String> {
        self.token.as_ref().map(|t| format!("Authorization: Bearer {t}"))
    }
}

pub struct Options<'a> {
    pub remote: Option<Remote>,
    /// The computer's name, for "Added from <machine>".
    pub machine: String,
    pub merge: &'a dyn NoteMerge,
}

#[derive(Debug)]
pub struct Round {
    pub status: Status,
    pub head: Option<String>,
    /// What the round did, one line each, in order.
    pub notes: Vec<String>,
    pub message: Option<String>,
}

/// Run one round for the folder at `folder`. Never returns Err: a stop is a `Round`.
pub fn sync_round(folder: &Path, options: &Options) -> Round {
    let mut notes = Vec::new();
    let outcome = open_or_init(folder).and_then(|repo| {
        let head = round(&repo, options, &mut notes)?;
        Ok((repo, head))
    });
    match outcome {
        Ok((_, head)) => Round { status: Status::Synced, head: Some(head.to_string()), notes, message: None },
        Err(e) => {
            let head = Repository::open(folder)
                .ok()
                .and_then(|r| r.refname_to_id(MAIN).ok())
                .map(|h| h.to_string());
            Round { status: e.status, head, notes, message: Some(e.message) }
        }
    }
}

/// Open the folder's own repository, or make one with `main` and no commits
/// (ADR-0735: a folder has no history until its first sync).
pub fn open_or_init(folder: &Path) -> Result<Repository, Error> {
    if folder.join(".git").exists() {
        return Ok(Repository::open(folder)?);
    }
    let mut opts = RepositoryInitOptions::new();
    opts.initial_head("main").no_reinit(true);
    Ok(Repository::init_opts(folder, &opts)?)
}

fn round(repo: &Repository, options: &Options, notes: &mut Vec<String>) -> Result<Oid, Error> {
    if repo.state() != git2::RepositoryState::Clean {
        return Err(Error::stopped(format!("a Git operation is in progress ({:?}); finish or abort it, then sync.", repo.state())));
    }
    let remote = options.remote.as_ref();
    if let Some(remote) = remote {
        ensure_origin(repo, &remote.url)?;
        fetch(repo, remote)?;
    }
    let remote_main = repo.refname_to_id(REMOTE_MAIN).ok();
    let had_history = repo.refname_to_id(MAIN).is_ok();
    let sig = signature(repo)?;
    if !had_history && remote_main.is_some() {
        first_contact(repo, remote_main.unwrap(), options, remote, notes)?;
    } else {
        let message = if had_history {
            format!("epicenter sync {}", iso_now())
        } else {
            format!("Added from {}", options.machine)
        };
        if commit_working_tree(repo, &sig, &message)?.is_some() {
            notes.push("committed local changes".into());
        }
    }
    let Some(remote) = remote else {
        notes.push("no remote: committed locally".into());
        return repo.refname_to_id(MAIN).map_err(Error::from);
    };
    for attempt in 1.. {
        if attempt > 1 {
            fetch(repo, remote)?;
        }
        let remote_main = repo.refname_to_id(REMOTE_MAIN).ok();
        if let Some(theirs) = remote_main {
            merge_remote(repo, theirs, options, remote, notes)?;
        }
        let Ok(head) = repo.refname_to_id(MAIN) else {
            notes.push("nothing to sync: the folder and the remote are empty".into());
            return Ok(Oid::zero());
        };
        if remote_main == Some(head) {
            return Ok(head);
        }
        if let Some(lfs) = remote.lfs() {
            let objects = worktree::objects_to_push(repo, head, remote_main)?;
            let sent = lfs.upload(repo.path(), &objects, remote.token.as_deref())?;
            if sent > 0 {
                notes.push(format!("uploaded {sent} LFS objects"));
            }
        }
        match push(repo, remote)? {
            None => {
                repo.reference(REMOTE_MAIN, head, true, "sync: pushed")?;
                repo.reference(LAST_SEEN, head, true, "sync: pushed")?;
                notes.push(format!("pushed {}", &head.to_string()[..7]));
                return Ok(head);
            }
            Some(reason) if moved(&reason) && attempt < ATTEMPTS => {
                notes.push(format!("push rejected ({reason}): the remote moved; fetching again"));
            }
            Some(reason) if moved(&reason) => {
                return Err(Error::retry(format!("the remote moved during each of {ATTEMPTS} pushes; nothing was lost. Run sync again.")));
            }
            Some(reason) => return Err(Error::stopped(format!("the remote refused the push: {reason}"))),
        }
    }
    unreachable!()
}

fn moved(reason: &str) -> bool {
    let r = reason.to_ascii_lowercase();
    ["stale", "non-fast-forward", "non-fastforward", "fetch first", "cannot lock ref", "failed to update ref"]
        .iter()
        .any(|m| r.contains(m))
}

/// `origin` must be `url`: a folder tracking another remote is not joined (ADR-0735).
pub fn ensure_origin(repo: &Repository, url: &str) -> Result<(), Error> {
    match repo.find_remote("origin") {
        Ok(origin) if origin.url() == Some(url) && origin.pushurl().is_none() => Ok(()),
        Ok(origin) => Err(Error::stopped(format!(
            "this folder syncs with {}, not {url}. Inspect git remote -v before syncing.",
            origin.url().unwrap_or("?")
        ))),
        Err(_) => {
            repo.remote("origin", url)?;
            Ok(())
        }
    }
}

fn callbacks<'a>() -> RemoteCallbacks<'a> {
    RemoteCallbacks::new()
}

/// `git fetch origin`, with the token as a header.
pub fn fetch(repo: &Repository, remote: &Remote) -> Result<(), Error> {
    let mut origin = repo.find_remote("origin")?;
    let mut fo = FetchOptions::new();
    fo.remote_callbacks(callbacks());
    let header = remote.header();
    let headers: Vec<&str> = header.iter().map(String::as_str).collect();
    fo.custom_headers(&headers);
    origin
        .fetch(&["+refs/heads/main:refs/remotes/origin/main"], Some(&mut fo), None)
        .map_err(|e| {
            let mut e = Error::from(e);
            if e.message.contains("403") {
                e.status = Status::Stopped;
            }
            e.message = format!("fetch failed: {}", e.message);
            e
        })?;
    Ok(())
}

/// `git push origin main:main`. Returns the remote's reason when it refused the ref.
pub fn push(repo: &Repository, remote: &Remote) -> Result<Option<String>, Error> {
    let mut origin = repo.find_remote("origin")?;
    let mut rejected: Option<String> = None;
    let header = remote.header();
    let headers: Vec<&str> = header.iter().map(String::as_str).collect();
    let result = {
        let mut cb = callbacks();
        cb.push_update_reference(|_, status| {
            if let Some(s) = status {
                rejected = Some(s.to_string());
            }
            Ok(())
        });
        let mut po = PushOptions::new();
        po.remote_callbacks(cb);
        po.custom_headers(&headers);
        origin.push(&[format!("{MAIN}:{MAIN}")], Some(&mut po))
    };
    match result {
        Ok(()) => Ok(rejected),
        // libgit2 refuses a non-fast-forward before sending when it can tell
        // from the remote's advertisement (any transport).
        Err(e) if e.code() == git2::ErrorCode::NotFastForward => Ok(Some(format!("non-fast-forward: {}", e.message()))),
        Err(e) => Err(e.into()),
    }
}

fn signature(repo: &Repository) -> Result<Signature<'static>, Error> {
    Ok(repo.signature().or_else(|_| Signature::now("Epicenter", "epicenter@localhost"))?)
}

/// Commit the working tree on `main` if it differs from `main`'s tree.
pub fn commit_working_tree(repo: &Repository, sig: &Signature, message: &str) -> Result<Option<Oid>, Error> {
    let mut index = repo.index()?;
    worktree::snapshot(repo, &mut index)?;
    let tree = index.write_tree()?;
    index.write()?;
    let parent = repo.refname_to_id(MAIN).ok().map(|id| repo.find_commit(id)).transpose()?;
    if parent.as_ref().map(|p| p.tree_id()) == Some(tree) {
        return Ok(None);
    }
    let parents: Vec<&Commit> = parent.iter().collect();
    let id = repo.commit(Some(MAIN), sig, sig, message, &repo.find_tree(tree)?, &parents)?;
    Ok(Some(id))
}

fn party_of(repo: &Repository, id: Oid) -> Result<Party, Error> {
    let c = repo.find_commit(id)?;
    let author = c.author();
    Ok(Party {
        author: author.name().unwrap_or("remote").to_string(),
        time: iso(author.when().seconds()),
    })
}

fn settler<'a>(repo: &'a Repository, theirs: Oid, options: &'a Options) -> Result<merge::Settler<'a>, Error> {
    let local = repo.config()?.get_string("user.name").unwrap_or_else(|_| "local".into());
    Ok(merge::Settler {
        repo,
        merge: options.merge,
        current: party_of(repo, theirs)?,
        incoming: Party { author: local, time: iso_now() },
    })
}

fn download(repo: &Repository, remote: &Remote, old: Option<&git2::Tree>, new: &git2::Tree, notes: &mut Vec<String>) -> Result<(), Error> {
    let missing = worktree::missing_objects(repo, old, new)?;
    if missing.is_empty() {
        return Ok(());
    }
    let lfs = remote
        .lfs()
        .ok_or_else(|| Error::stopped(format!("{} LFS objects are needed and the remote has no LFS endpoint", missing.len())))?;
    let got = lfs.download(repo.path(), &missing, remote.token.as_deref())?;
    notes.push(format!("downloaded {got} LFS objects"));
    Ok(())
}

/// ADR-0735: build this folder's first commit on top of the remote's `main`.
pub fn first_contact(repo: &Repository, theirs: Oid, options: &Options, remote: Option<&Remote>, notes: &mut Vec<String>) -> Result<Oid, Error> {
    let root = repo.workdir().expect("a working tree").to_path_buf();
    let remote_tree = repo.find_commit(theirs)?.tree()?;
    // The remote's control files first, so its attributes decide what is LFS here.
    for (path, (id, _)) in merge::entries(&remote_tree)? {
        if !merge::is_control(&path) {
            continue;
        }
        let blob = repo.find_blob(id)?;
        let here = root.join(&path);
        match std::fs::read(&here) {
            Ok(bytes) if bytes != blob.content() => {
                return Err(Error::stopped(format!(
                    "{path} differs on this computer and the remote. Resolve this Git control file before syncing."
                )))
            }
            Ok(_) => {}
            Err(_) => {
                if let Some(dir) = here.parent() {
                    std::fs::create_dir_all(dir)?;
                }
                std::fs::write(&here, blob.content())?;
            }
        }
    }
    let mut scratch = git2::Index::new()?;
    let local = worktree::snapshot(repo, &mut scratch)?;
    let s = settler(repo, theirs, options)?;
    let (tree_id, already) = merge::first_contact_tree(&s, &remote_tree, &local.entries, notes)?;
    let tree = repo.find_tree(tree_id)?;
    if let Some(remote) = remote {
        download(repo, remote, None, &tree, notes)?;
    }
    let sig = signature(repo)?;
    let parent = repo.find_commit(theirs)?;
    let id = if tree_id == parent.tree_id() {
        theirs
    } else {
        repo.commit(None, &sig, &sig, &format!("Added from {}", options.machine), &tree, &[&parent])?
    };
    repo.reference(MAIN, id, true, "sync: first contact")?;
    let mut index = repo.index()?;
    index.clear()?;
    worktree::materialize(repo, &mut index, None, &tree, &already)?;
    repo.reference(LAST_SEEN, theirs, true, "sync: first contact")?;
    notes.push(format!("added this computer's files on origin/main {}", &theirs.to_string()[..7]));
    Ok(id)
}

/// Merge the fetched `origin/main` into `main` and update the working tree.
pub fn merge_remote(repo: &Repository, theirs: Oid, options: &Options, remote: &Remote, notes: &mut Vec<String>) -> Result<(), Error> {
    let ours = repo.refname_to_id(MAIN)?;
    if ours == theirs || repo.graph_descendant_of(ours, theirs)? {
        repo.reference(LAST_SEEN, theirs, true, "sync: seen")?;
        return Ok(());
    }
    if let Ok(seen) = repo.refname_to_id(LAST_SEEN) {
        if seen != theirs && !repo.graph_descendant_of(theirs, seen)? {
            return Err(Error::stopped(format!(
                "the remote main was rewritten: it no longer contains {}, the main this clone last saw. Not merging.",
                &seen.to_string()[..7]
            )));
        }
    }
    let base = repo.merge_base(ours, theirs).map_err(|_| {
        Error::stopped("local and remote history no longer share an ancestor. Inspect git log --all --graph before syncing.".into())
    })?;
    let our_tree = repo.find_commit(ours)?.tree()?;
    let their_commit = repo.find_commit(theirs)?;
    let id = if base == ours {
        notes.push("fast-forward".into());
        theirs
    } else {
        let s = settler(repo, theirs, options)?;
        let base_tree = repo.find_commit(base)?.tree()?;
        let tree = merge::three_way(&s, &base_tree, &our_tree, &their_commit.tree()?, notes)?;
        let sig = signature(repo)?;
        repo.commit(
            None,
            &sig,
            &sig,
            "Merge origin/main",
            &repo.find_tree(tree)?,
            &[&repo.find_commit(ours)?, &their_commit],
        )?
    };
    let new_tree = repo.find_commit(id)?.tree()?;
    download(repo, remote, Some(&our_tree), &new_tree, notes)?;
    // The working tree still matches `ours` unless something wrote since the
    // commit; a real core would re-snapshot here and stop on a difference.
    let mut index = repo.index()?;
    worktree::materialize(repo, &mut index, Some(&our_tree), &new_tree, &Default::default())?;
    repo.reference(MAIN, id, true, "sync: merged origin/main")?;
    repo.reference(LAST_SEEN, theirs, true, "sync: merged")?;
    notes.push(format!("merged origin/main {}", &theirs.to_string()[..7]));
    Ok(())
}

/// The linked libgit2's version.
pub fn libgit2_version() -> (u32, u32, u32) {
    let v = git2::Version::get().libgit2_version();
    (v.0 as u32, v.1 as u32, v.2 as u32)
}

fn iso_now() -> String {
    iso(SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0))
}

/// Seconds since the epoch as `YYYY-MM-DDTHH:MM:SSZ` (Howard Hinnant's civil_from_days).
fn iso(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}
