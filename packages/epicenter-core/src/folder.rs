//! A folder's repository outside a round: open or make it, find it, record
//! consent, and attach its origin. Everything a program does to turn sync
//! on, before the first round, without a `git` program.

use std::path::{Path, PathBuf};

use git2::{Repository, RepositoryInitOptions, RepositoryOpenFlags, RepositoryState};

use crate::{Error, LAST_SEEN};

/// The consent to sync (ADR-0750): `epicenter.synced = true` in the
/// folder's own `.git/config`.
pub const SYNCED: &str = "epicenter.synced";

/// ADR-0733's Git LFS filter settings. They name the `git-lfs` command and
/// no path, so they hold on any machine. The core cleans and smudges LFS
/// files itself and never runs them; they are for a person's own `git`,
/// which without them reads an LFS file raw whenever it re-checks one (a
/// file written in the same second as the index, for one) and reports it
/// modified.
pub const LFS_FILTER: [(&str, &str); 4] = [
    ("filter.lfs.clean", "git-lfs clean -- %f"),
    ("filter.lfs.smudge", "git-lfs smudge -- %f"),
    ("filter.lfs.process", "git-lfs filter-process"),
    ("filter.lfs.required", "true"),
];

/// A folder's repository, opened or just made.
pub struct Opened {
    pub repo: Repository,
    /// Whether this call made the repository.
    pub initialized: bool,
    /// The LFS filter settings this call wrote, in order.
    pub configured: Vec<&'static str>,
}

/// Open the folder's own repository, or make one with `main` and no
/// commits (ADR-0735: a folder has no history until its first sync), and
/// write the LFS filter settings it lacks. A repository in a state only a
/// person can finish is refused before anything is written.
pub fn open(folder: &Path) -> Result<Opened, Error> {
    let (repo, initialized) = if folder.join(".git").exists() {
        (Repository::open(folder)?, false)
    } else {
        let mut opts = RepositoryInitOptions::new();
        opts.initial_head("main").no_reinit(true);
        (Repository::init_opts(folder, &opts)?, true)
    };
    if let Some(problem) = refusal(&repo)? {
        return Err(Error::stopped(problem));
    }
    let configured = write_lfs_filter(&repo)?;
    Ok(Opened {
        repo,
        initialized,
        configured,
    })
}

/// Why Epicenter must not change this repository's files, naming the
/// command that resolves it (ADR-0741), or None.
pub fn refusal(repo: &Repository) -> Result<Option<String>, Error> {
    let finish = match repo.state() {
        RepositoryState::Clean => None,
        RepositoryState::Merge => Some("a merge is in progress. Finish it with git commit, or run git merge --abort"),
        RepositoryState::Revert | RepositoryState::RevertSequence => {
            Some("a revert is in progress. Finish it, or run git revert --abort")
        }
        RepositoryState::CherryPick | RepositoryState::CherryPickSequence => {
            Some("a cherry-pick is in progress. Finish it, or run git cherry-pick --abort")
        }
        RepositoryState::Rebase
        | RepositoryState::RebaseInteractive
        | RepositoryState::RebaseMerge
        | RepositoryState::ApplyMailbox
        | RepositoryState::ApplyMailboxOrRebase => {
            Some("a rebase is in progress. Finish it, or run git rebase --abort")
        }
        RepositoryState::Bisect => Some("a bisect is in progress. End it with git bisect reset"),
    };
    if let Some(finish) = finish {
        return Ok(Some(format!("{finish}, before running Epicenter.")));
    }
    if repo.index()?.has_conflicts() {
        return Ok(Some(
            "unmerged entries exist. Resolve them and commit before running Epicenter.".into(),
        ));
    }
    let head = repo.find_reference("HEAD")?;
    match head.symbolic_target() {
        None => Ok(Some(
            "HEAD is detached. Run git checkout main before running Epicenter.".into(),
        )),
        Some("refs/heads/main") => Ok(None),
        Some(other) => Ok(Some(format!(
            "this repository is on {}, but Epicenter syncs only main. Run git checkout main before running Epicenter.",
            other.strip_prefix("refs/heads/").unwrap_or(other)
        ))),
    }
}

/// Write each LFS filter setting the repository's own configuration lacks;
/// a value a person set stays. Returns the keys written.
fn write_lfs_filter(repo: &Repository) -> Result<Vec<&'static str>, Error> {
    let mut config = repo.config()?.open_level(git2::ConfigLevel::Local)?;
    let mut written = Vec::new();
    for (key, value) in LFS_FILTER {
        if config.get_entry(key).is_err() {
            config.set_str(key, value)?;
            written.push(key);
        }
    }
    Ok(written)
}

/// The repository a folder is in, as a program deciding whether to sync
/// it reads it.
pub struct Located {
    /// The top of the working tree, links resolved.
    pub root: PathBuf,
    /// Whether the repository's own configuration records consent.
    pub synced: bool,
    /// `remote.origin.url`, when set.
    pub origin: Option<String>,
}

/// The repository whose working tree holds `folder`, searching upward as
/// `git rev-parse --show-toplevel` does and stopping at each directory in
/// `GIT_CEILING_DIRECTORIES`; None when there is none, or it is bare.
pub fn locate(folder: &Path) -> Result<Option<Located>, Error> {
    let ceilings: Vec<PathBuf> = std::env::var_os("GIT_CEILING_DIRECTORIES")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default();
    let repo = match Repository::open_ext(folder, RepositoryOpenFlags::empty(), &ceilings) {
        Ok(repo) => repo,
        Err(e) if e.code() == git2::ErrorCode::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let Some(workdir) = repo.workdir() else {
        return Ok(None);
    };
    let root = std::fs::canonicalize(workdir)?;
    let local = repo.config()?.open_level(git2::ConfigLevel::Local)?;
    let synced = local.get_bool(SYNCED).unwrap_or(false);
    let origin = local.get_string("remote.origin.url").ok();
    Ok(Some(Located {
        root,
        synced,
        origin,
    }))
}

/// Record or clear consent in the folder's own repository. Returns whether
/// the configuration changed.
pub fn set_synced(folder: &Path, synced: bool) -> Result<bool, Error> {
    let repo = Repository::open(folder)?;
    let mut local = repo.config()?.open_level(git2::ConfigLevel::Local)?;
    let current = local.get_entry(SYNCED).ok().map(|e| e.value().map(str::to_string));
    if synced {
        if current == Some(Some("true".into())) {
            return Ok(false);
        }
        local.set_bool(SYNCED, true)?;
        return Ok(true);
    }
    if current.is_none() {
        return Ok(false);
    }
    local.remove_multivar(SYNCED, ".*")?;
    Ok(true)
}

/// Make `url` the folder's `origin`: nothing when it already is, and a
/// refusal when `origin` is another remote or pushes elsewhere (ADR-0741).
/// A new origin forgets the last remote `main` seen, which belonged to
/// another remote or to none. Returns whether `origin` was added.
///
/// Takes no round lock: it only adds an origin where there is none, and a
/// round running meanwhile read no origin, so it fetched nothing and left
/// no last-seen behind for this to remove.
pub fn connect(folder: &Path, url: &str) -> Result<bool, Error> {
    let repo = Repository::open(folder)?;
    let local = repo.config()?.open_level(git2::ConfigLevel::Local)?;
    let pushurl = local.get_string("remote.origin.pushurl").ok();
    match local.get_string("remote.origin.url").ok() {
        Some(current) if current != url => Err(Error::stopped(format!(
            "origin is already {current}. Inspect it with git remote -v before changing it."
        ))),
        _ if pushurl.as_deref().is_some_and(|p| p != url) => Err(Error::stopped(
            "origin has a different push URL. Inspect it with git remote -v.".into(),
        )),
        Some(_) => Ok(false),
        None => {
            repo.remote("origin", url)?;
            if let Ok(mut seen) = repo.find_reference(LAST_SEEN) {
                seen.delete()?;
            }
            Ok(true)
        }
    }
}
