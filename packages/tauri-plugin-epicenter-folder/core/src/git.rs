//! Native Git storage: a real repository in `<root>/.git`.
//!
//! Every operation is one `git` process started with an argument vector, never
//! a shell. Shared state changes only through commands whose `index.lock` and
//! ref locks other Git processes respect: `update-ref` with an expected old
//! value is the branch compare-and-swap, and `reset` updates index entries.
//!
//! A whole-folder commit is built without the index: `hash-object -w
//! --no-filters` stores the exact bytes on disk, `mktree` writes the
//! directories, and `commit-tree` writes the commit. The real index is only
//! reconciled after the branch has moved. A status observation hashes without
//! writing, so observing the folder never creates an object or takes a lock.
//!
//! This is the Rust owner of `packages/app/src/files/git/{native-backend,
//! native-checkpoint,scope}.ts`, grown from the prototype in
//! `packages/app/evidence/files/native-git-prototype`.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use serde::Serialize;
use specta::Type;

use crate::messages::{ChangeKind, PathChange};
use crate::paths::{is_portable_path, path_problem};

const ZERO: &str = "0000000000000000000000000000000000000000";
/// Git's empty tree, which every repository can name without storing it.
pub const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const REMOTE_NAME: &str = "origin";
const PLAIN_ONLY: &str = "commits only write plain files";
/// Git's empty blob: the base of a file both sides added.
const EMPTY_BLOB: &str = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
/// Git operations no commit may run under. A merge in progress is checked
/// on its own (`blocked`), since this folder never finishes one.
const OPERATION_MARKERS: [&str; 5] = [
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "rebase-merge",
    "rebase-apply",
    "BISECT_LOG",
];
/// Why a merge begun outside this folder blocks its history work.
const MERGE_IN_PROGRESS: &str =
    "a Git merge is in progress; finish or abort it with Git outside Epicenter";
/// Attributes that make Git store different bytes than the working file.
const NORMALIZING: [&str; 6] = [
    "text",
    "eol",
    "crlf",
    "filter",
    "ident",
    "working-tree-encoding",
];
/// Ahead and behind counts stop here, as the shared history's bounded walk does.
const COUNT_LIMIT: &str = "--max-count=10000";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Author {
    pub name: String,
    pub email: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct Remote {
    pub url: String,
    pub branch: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct PathStatus {
    pub path: String,
    /// Staged state, as the first column of `git status --porcelain`.
    pub index: String,
    /// Unstaged state, as the second column.
    pub worktree: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct CommitAuthor {
    pub name: String,
    pub email: String,
    /// Seconds since the Unix epoch.
    pub timestamp: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct CommitSummary {
    pub oid: String,
    pub parents: Vec<String>,
    pub message: String,
    pub author: CommitAuthor,
}

/// A failed or unstartable Git command, worded as the TypeScript runner words it.
pub type Failure = String;

pub struct Output {
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

pub enum Cas {
    Moved,
    /// The branch names something other than the expected commit.
    Lost {
        actual: Option<String>,
    },
}

pub enum IndexCommit {
    Committed {
        oid: String,
        parent: Option<String>,
    },
    Nothing,
    /// The branch no longer named the pinned parent `expected`.
    BranchMoved {
        expected: Option<String>,
        actual: Option<String>,
    },
}

/// What the working files look like against the branch head.
pub struct Observed {
    pub head: Option<String>,
    pub changes: Vec<PathChange>,
}

/// The exact bytes on disk, stored as an immutable tree.
pub struct Captured {
    pub tree: String,
    pub changes: Vec<PathChange>,
}

pub enum Capture {
    /// What a plain-file commit cannot represent; nothing was written.
    Blocked(String),
    Captured(Captured),
}

/// Inherited variables that would point Git at another repository, index, or
/// object store: the names `git rev-parse --local-env-vars` lists, plus the
/// ref namespace.
fn is_repository_env(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("GIT_") else {
        return false;
    };
    const EXACT: [&str; 16] = [
        "DIR",
        "WORK_TREE",
        "IMPLICIT_WORK_TREE",
        "INDEX_FILE",
        "OBJECT_DIRECTORY",
        "ALTERNATE_OBJECT_DIRECTORIES",
        "COMMON_DIR",
        "NAMESPACE",
        "PREFIX",
        "GRAFT_FILE",
        "SHALLOW_FILE",
        "NO_REPLACE_OBJECTS",
        "REPLACE_REF_BASE",
        "CONFIG",
        "CONFIG_PARAMETERS",
        "CONFIG_COUNT",
    ];
    if EXACT.contains(&rest) {
        return true;
    }
    ["CONFIG_KEY_", "CONFIG_VALUE_"].iter().any(|prefix| {
        rest.strip_prefix(prefix)
            .is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
    })
}

/// Identity variables a commit must take from the folder's configuration, not
/// from whatever the parent process inherited.
const IDENTITY_ENV: [&str; 6] = [
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_AUTHOR_DATE",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
    "GIT_COMMITTER_DATE",
];

fn records(output: &[u8]) -> Vec<String> {
    output
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .map(|record| String::from_utf8_lossy(record).into_owned())
        .collect()
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn nul_separated<'a>(paths: impl IntoIterator<Item = &'a str>) -> Vec<u8> {
    let mut input = Vec::new();
    for path in paths {
        input.extend_from_slice(path.as_bytes());
        input.push(0);
    }
    input
}

/// Commands that read paths or names line by line unquote a line that starts
/// with a double quote. Folder paths hold no backslash or control character.
fn line_quoted(name: &str) -> String {
    if name.starts_with('"') {
        format!("\"{}\"", name.replace('"', "\\\""))
    } else {
        name.to_string()
    }
}

struct Walked {
    /// Entries a plain-file commit cannot represent, with the reason.
    special: Vec<(String, &'static str)>,
    /// Every regular file below the root, outside `.git`.
    regular: Vec<String>,
}

static SNAPSHOT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// The folder as it was at one moment: what was enumerated, and a hard link to
/// every portable file under `.git/epicenter/scratch`.
///
/// The owner publishes by renaming or linking a new file into place and never
/// rewrites one in place, so a linked file keeps the bytes it had when the
/// snapshot was taken whatever the owner publishes afterward. Taking it costs
/// one link per file and no byte is copied, so the file gate is held briefly;
/// hashing reads the links after the gate is released. A program that edits a
/// file in place can still change linked bytes: that stays best effort.
pub struct Snapshot {
    walked: Walked,
    directory: PathBuf,
    /// The snapshot directory relative to the root, for Git's path arguments.
    relative: String,
}

impl Drop for Snapshot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}

/// A private file of the Git directory, removed when dropped.
struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

#[derive(Debug, Clone)]
pub struct Git {
    root: PathBuf,
    gitdir: PathBuf,
    pub branch: String,
    branch_ref: String,
    tracking_ref: String,
    pub remote: Option<Remote>,
}

impl Git {
    /// Address the repository in `root`, initializing one on `branch` if absent.
    pub fn open(root: &Path, branch: &str, remote: Option<Remote>) -> Result<Self, Failure> {
        for name in [
            Some(branch),
            remote.as_ref().map(|remote| remote.branch.as_str()),
        ]
        .into_iter()
        .flatten()
        {
            if name.is_empty()
                || name.starts_with('-')
                || name.contains("..")
                || name.chars().any(|c| c.is_whitespace() || c.is_control())
            {
                return Err(format!("{name:?} is not a usable branch name"));
            }
        }
        let git = Self {
            root: root.to_path_buf(),
            gitdir: root.join(".git"),
            branch: branch.to_string(),
            branch_ref: format!("refs/heads/{branch}"),
            tracking_ref: format!(
                "refs/remotes/{REMOTE_NAME}/{}",
                remote
                    .as_ref()
                    .map_or(branch, |remote| remote.branch.as_str())
            ),
            remote,
        };
        if !git.gitdir.join("HEAD").is_file() {
            let initial = format!("--initial-branch={branch}");
            git.ok(&["init", "--quiet", &initial], None, &[])?;
        }
        Ok(git)
    }

    pub fn gitdir(&self) -> &Path {
        &self.gitdir
    }

    fn command(&self, args: &[&str], env: &[(&str, &str)]) -> Command {
        let mut command = Command::new("git");
        command.args(args).current_dir(&self.root);
        for (name, _) in std::env::vars_os() {
            if name
                .to_str()
                .is_some_and(|name| is_repository_env(name) || IDENTITY_ENV.contains(&name))
            {
                command.env_remove(&name);
            }
        }
        command
            // Discovery stops at the root, so a root whose `.git` is missing
            // never resolves to a repository in a directory above it.
            .env(
                "GIT_CEILING_DIRECTORIES",
                self.root.parent().unwrap_or(Path::new("/")),
            )
            // Read-only commands must not take `index.lock` to refresh the index.
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C")
            .envs(env.iter().copied())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }

    /// Run one `git` process to completion. `cancel` kills it when set.
    fn run_cancellable(
        &self,
        args: &[&str],
        input: Option<&[u8]>,
        env: &[(&str, &str)],
        cancel: Option<&AtomicBool>,
    ) -> Result<Output, Failure> {
        self.execute(self.command(args, env), args, input, cancel)
    }

    /// Run a prepared `git` command to completion. When `cancel` is set, the
    /// process is killed.
    fn execute(
        &self,
        mut command: Command,
        args: &[&str],
        input: Option<&[u8]>,
        cancel: Option<&AtomicBool>,
    ) -> Result<Output, Failure> {
        let label = Self::label(args);
        let mut child = command
            .spawn()
            .map_err(|cause| format!("git {label} could not start: {cause}"))?;
        let mut stdin = child.stdin.take().expect("stdin is piped");
        let mut stdout = child.stdout.take().expect("stdout is piped");
        let mut stderr = child.stderr.take().expect("stderr is piped");
        let (status, out, err) = std::thread::scope(|scope| {
            scope.spawn(move || {
                if let Some(bytes) = input {
                    let _ = stdin.write_all(bytes);
                }
            });
            let out = scope.spawn(move || {
                let mut bytes = Vec::new();
                let _ = stdout.read_to_end(&mut bytes);
                bytes
            });
            let err = scope.spawn(move || {
                let mut bytes = Vec::new();
                let _ = stderr.read_to_end(&mut bytes);
                bytes
            });
            let status = match cancel {
                None => child.wait(),
                Some(cancel) => loop {
                    match child.try_wait() {
                        Ok(Some(status)) => break Ok(status),
                        Ok(None) if cancel.load(Ordering::SeqCst) => {
                            let _ = child.kill();
                            break child.wait();
                        }
                        Ok(None) => std::thread::sleep(Duration::from_millis(15)),
                        Err(cause) => break Err(cause),
                    }
                },
            };
            (
                status,
                out.join().unwrap_or_default(),
                err.join().unwrap_or_default(),
            )
        });
        let status = status.map_err(|cause| format!("git {label} did not finish: {cause}"))?;
        Ok(Output {
            code: status.code(),
            stdout: out,
            stderr: text(&err).trim().to_string(),
        })
    }

    fn run(
        &self,
        args: &[&str],
        input: Option<&[u8]>,
        env: &[(&str, &str)],
    ) -> Result<Output, Failure> {
        self.run_cancellable(args, input, env, None)
    }

    /// The subcommand an argument list runs, for messages: the first argument
    /// that is neither an option nor a `-c` setting.
    fn label<'a>(args: &[&'a str]) -> &'a str {
        let mut skip = false;
        for arg in args {
            if std::mem::take(&mut skip) {
                continue;
            }
            if *arg == "-c" {
                skip = true;
                continue;
            }
            if !arg.starts_with('-') && !arg.contains('=') {
                return arg;
            }
        }
        "command"
    }

    fn failure(args: &[&str], output: &Output) -> Failure {
        let label = Self::label(args);
        if output.stderr.is_empty() {
            match output.code {
                Some(code) => format!("git {label} exited with {code}"),
                None => format!("git {label} was stopped by a signal"),
            }
        } else {
            format!("git {label}: {}", output.stderr)
        }
    }

    fn ok(
        &self,
        args: &[&str],
        input: Option<&[u8]>,
        env: &[(&str, &str)],
    ) -> Result<Vec<u8>, Failure> {
        let output = self.run(args, input, env)?;
        if output.code == Some(0) {
            Ok(output.stdout)
        } else {
            Err(Self::failure(args, &output))
        }
    }

    fn resolve(&self, revision: &str) -> Result<Option<String>, Failure> {
        let output = self.run(&["rev-parse", "--verify", "--quiet", revision], None, &[])?;
        Ok((output.code == Some(0)).then(|| text(&output.stdout).trim().to_string()))
    }

    pub fn read_branch(&self) -> Result<Option<String>, Failure> {
        self.resolve(&format!("{}^{{commit}}", self.branch_ref))
    }

    pub fn read_remote_tracking(&self) -> Result<Option<String>, Failure> {
        self.resolve(&format!("{}^{{commit}}", self.tracking_ref))
    }

    /// Move the branch only if it still names `expected`.
    pub fn cas_branch(&self, expected: Option<&str>, next: &str) -> Result<Cas, Failure> {
        self.move_branch(expected, next, "epicenter: commit")
    }

    /// Move the branch only if it still names `expected`, with `reason` in
    /// its reflog. `Lost` is certain; an error leaves the branch unknown.
    pub fn move_branch(
        &self,
        expected: Option<&str>,
        next: &str,
        reason: &str,
    ) -> Result<Cas, Failure> {
        let args = [
            "update-ref",
            "-m",
            reason,
            &self.branch_ref,
            next,
            expected.unwrap_or(ZERO),
        ];
        let output = self.run(&args, None, &[])?;
        if output.code == Some(0) {
            return Ok(Cas::Moved);
        }
        let actual = self.read_branch()?;
        if actual.as_deref() != expected {
            return Ok(Cas::Lost { actual });
        }
        Err(Self::failure(&args, &output))
    }

    /// Why no commit or incoming update may run now: a wrong or detached
    /// HEAD, a native Git operation in progress, or a merge a person's own Git
    /// began. A merge is in progress while `MERGE_HEAD` exists or the index
    /// holds unmerged stages; this folder neither finishes nor abandons one.
    pub fn blocked(&self) -> Result<Option<String>, Failure> {
        let head = self.run(&["symbolic-ref", "--quiet", "HEAD"], None, &[])?;
        if head.code != Some(0) {
            return Ok(Some("HEAD is detached".to_string()));
        }
        if text(&head.stdout).trim() != self.branch_ref {
            return Ok(Some(format!("HEAD is not on {}", self.branch)));
        }
        for marker in OPERATION_MARKERS {
            if self.gitdir.join(marker).exists() {
                return Ok(Some(format!("a Git operation is in progress ({marker})")));
            }
        }
        if self.gitdir.join("MERGE_HEAD").exists() {
            return Ok(Some(MERGE_IN_PROGRESS.to_string()));
        }
        let unmerged = self.unmerged_paths()?;
        if !unmerged.is_empty() {
            return Ok(Some(format!(
                "{MERGE_IN_PROGRESS} (unmerged: {})",
                unmerged.join(", ")
            )));
        }
        Ok(None)
    }

    /// Commits reachable from `from` that are not reachable from `exclude`.
    fn count_only(&self, from: Option<&str>, exclude: Option<&str>) -> Result<u64, Failure> {
        let Some(from) = from else { return Ok(0) };
        let mut args = vec!["rev-list", "--count", COUNT_LIMIT, from];
        if let Some(exclude) = exclude {
            args.extend(["--not", exclude]);
        }
        let output = self.ok(&args, None, &[])?;
        text(&output)
            .trim()
            .parse()
            .map_err(|_| "git rev-list returned an unexpected count".to_string())
    }

    /// Commits the branch has that the remote lacks, and the reverse.
    pub fn ahead_behind(
        &self,
        head: Option<&str>,
        remote: Option<&str>,
    ) -> Result<(u64, u64), Failure> {
        Ok((
            self.count_only(head, remote)?,
            self.count_only(remote, head)?,
        ))
    }

    fn walk(&self) -> Result<Walked, Failure> {
        let mut walked = Walked {
            special: Vec::new(),
            regular: Vec::new(),
        };
        let mut pending = vec![(self.root.clone(), String::new())];
        while let Some((directory, prefix)) = pending.pop() {
            let shown = if prefix.is_empty() {
                "the folder"
            } else {
                prefix.as_str()
            };
            let entries = match fs::read_dir(&directory) {
                Ok(entries) => entries,
                // A directory removed during enumeration is simply absent.
                Err(cause)
                    if cause.kind() == std::io::ErrorKind::NotFound && !prefix.is_empty() =>
                {
                    continue
                }
                Err(cause) => return Err(format!("cannot enumerate {shown}: {cause}")),
            };
            for entry in entries {
                let entry = entry.map_err(|cause| format!("cannot enumerate {shown}: {cause}"))?;
                let name = entry.file_name();
                let Some(name) = name.to_str() else {
                    walked.special.push((
                        format!("{prefix}{}", name.to_string_lossy()),
                        "not named in valid UTF-8",
                    ));
                    continue;
                };
                if prefix.is_empty() && name == ".git" {
                    continue;
                }
                let path = format!("{prefix}{name}");
                if name.to_lowercase() == ".git" {
                    walked.special.push((path, "nested Git data"));
                    continue;
                }
                let stats = match fs::symlink_metadata(entry.path()) {
                    Ok(stats) => stats,
                    Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(cause) => return Err(format!("cannot inspect {path}: {cause}")),
                };
                let kind = stats.file_type();
                if kind.is_symlink() {
                    walked.special.push((path, "a symbolic link"));
                } else if kind.is_dir() {
                    pending.push((entry.path(), format!("{path}/")));
                } else if !kind.is_file() {
                    walked.special.push((path, "not a regular file"));
                } else {
                    if is_executable(&stats) {
                        walked.special.push((path.clone(), "an executable file"));
                    }
                    walked.regular.push(path);
                }
            }
        }
        walked.regular.sort();
        Ok(walked)
    }

    /// Remove snapshots a stopped process left behind. The caller holds the
    /// folder's cross-process lock, so no live snapshot is in there.
    pub fn clear_snapshots(&self) {
        let scratch = self.gitdir.join("epicenter").join("scratch");
        let Ok(entries) = fs::read_dir(scratch) else {
            return;
        };
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with("capture-") {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }

    /// Enumerate the folder and link every portable file. The caller holds the
    /// file gate, so none of the owner's own batches is seen half applied.
    pub fn snapshot(&self) -> Result<Snapshot, Failure> {
        let walked = self.walk()?;
        let relative = format!(
            ".git/epicenter/scratch/capture-{}-{}",
            std::process::id(),
            SNAPSHOT_SEQUENCE.fetch_add(1, Ordering::SeqCst)
        );
        let snapshot = Snapshot {
            walked,
            directory: self.root.join(&relative),
            relative,
        };
        let failed = |path: &str, cause: std::io::Error| format!("cannot capture {path}: {cause}");
        fs::create_dir_all(&snapshot.directory).map_err(|cause| failed("the folder", cause))?;
        let mut made: BTreeSet<&str> = BTreeSet::new();
        for path in snapshot
            .walked
            .regular
            .iter()
            .filter(|path| is_portable_path(path))
        {
            let link = snapshot.directory.join(path);
            if let Some((parent, _)) = path.rsplit_once('/') {
                if made.insert(parent) {
                    fs::create_dir_all(snapshot.directory.join(parent))
                        .map_err(|cause| failed(path, cause))?;
                }
            }
            let source = self.root.join(path);
            match fs::hard_link(&source, &link) {
                Ok(()) => {}
                // Removed by another program since it was enumerated.
                Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => {}
                // A filesystem without hard links: copy the bytes instead.
                Err(_) => match fs::copy(&source, &link) {
                    Ok(_) => {}
                    Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => {}
                    Err(cause) => return Err(failed(path, cause)),
                },
            }
        }
        Ok(snapshot)
    }

    /// Which candidates the ignore rules exclude. `--no-index` evaluates the
    /// rules alone, including `.git/info/exclude` and the user's excludes
    /// file; the caller keeps tracked files.
    fn ignored(&self, candidates: &[&str]) -> Result<BTreeSet<String>, Failure> {
        if candidates.is_empty() {
            return Ok(BTreeSet::new());
        }
        let args = ["check-ignore", "--no-index", "--stdin", "-z"];
        let input = nul_separated(candidates.iter().copied());
        let output = self.run(&args, Some(&input), &[])?;
        if output.code != Some(0) && output.code != Some(1) {
            return Err(Self::failure(&args, &output));
        }
        Ok(records(&output.stdout).into_iter().collect())
    }

    /// Blob IDs of the snapshot's bytes for the paths still present in it. Git
    /// reads each file in full; no stat cache is consulted and no filter runs.
    /// `write` also stores the blobs the object store lacks.
    fn hash_files(
        &self,
        snapshot: &Snapshot,
        paths: Vec<String>,
        write: bool,
    ) -> Result<BTreeMap<String, String>, Failure> {
        // A file another program removed during the snapshot has no link.
        let paths: Vec<String> = paths
            .into_iter()
            .filter(|path| snapshot.directory.join(path).is_file())
            .collect();
        if paths.is_empty() {
            return Ok(BTreeMap::new());
        }
        // The snapshot directory starts with `.git`, so no line needs quoting.
        let listing: String = paths
            .iter()
            .map(|path| format!("{}/{path}\n", snapshot.relative))
            .collect();
        let mut args = vec!["hash-object", "--no-filters", "--stdin-paths"];
        if write {
            args.insert(1, "-w");
        }
        let output = self.ok(&args, Some(listing.as_bytes()), &[])?;
        let oids: Vec<String> = text(&output).lines().map(str::to_string).collect();
        if oids.len() != paths.len() {
            return Err("git hash-object returned an unexpected number of IDs".to_string());
        }
        Ok(paths.into_iter().zip(oids).collect())
    }

    /// A Git configuration value as this repository sees it, or `None` when
    /// it is unset or empty.
    pub fn configured(&self, key: &str) -> Result<Option<String>, Failure> {
        let output = self.run(&["config", "--get", key], None, &[])?;
        let value = text(&output.stdout).trim().to_string();
        Ok((output.code == Some(0) && !value.is_empty()).then_some(value))
    }

    /// Whether `ancestor` is reachable from `descendant`.
    pub fn is_ancestor(&self, ancestor: &str, descendant: &str) -> Result<bool, Failure> {
        if ancestor == descendant {
            return Ok(true);
        }
        let args = ["merge-base", "--is-ancestor", ancestor, descendant];
        let output = self.run(&args, None, &[])?;
        match output.code {
            Some(0) => Ok(true),
            Some(1) => Ok(false),
            _ => Err(Self::failure(&args, &output)),
        }
    }

    /// The exact bytes of a blob.
    pub fn read_blob(&self, oid: &str) -> Result<Vec<u8>, Failure> {
        self.ok(&["cat-file", "blob", oid], None, &[])
    }

    /// Whether the object store holds `oid` as a commit.
    pub fn has_commit(&self, oid: &str) -> Result<bool, Failure> {
        let object = format!("{oid}^{{commit}}");
        let args = ["cat-file", "-e", &object];
        let output = self.run(&args, None, &[])?;
        match output.code {
            Some(0) => Ok(true),
            Some(1) | Some(128) => Ok(false),
            _ => Err(Self::failure(&args, &output)),
        }
    }

    /// Create every ref in one transaction, each only if it does not exist.
    pub fn create_refs(&self, refs: &[(String, String)]) -> Result<(), Failure> {
        let input: String = refs
            .iter()
            .map(|(name, oid)| format!("create {name} {oid}\n"))
            .collect();
        self.ok(&["update-ref", "--stdin"], Some(input.as_bytes()), &[])?;
        Ok(())
    }

    /// Delete every ref below `prefix`, in one transaction.
    pub fn delete_refs_under(&self, prefix: &str) -> Result<(), Failure> {
        let listed = self.ok(&["for-each-ref", "--format=%(refname)", prefix], None, &[])?;
        let input: String = text(&listed)
            .lines()
            .filter(|name| !name.is_empty())
            .map(|name| format!("delete {name}\n"))
            .collect();
        if input.is_empty() {
            return Ok(());
        }
        self.ok(&["update-ref", "--stdin"], Some(input.as_bytes()), &[])?;
        Ok(())
    }

    /// Every stage-0 index entry as `(mode, oid)` by path. A path in conflict
    /// is listed with the mode `conflict`, so it matches no tree entry.
    pub fn index_entries(&self) -> Result<BTreeMap<String, (String, String)>, Failure> {
        let listing = self.ok(&["ls-files", "--stage", "-z"], None, &[])?;
        let mut entries = BTreeMap::new();
        for record in records(&listing) {
            let Some((meta, path)) = record.split_once('\t') else {
                continue;
            };
            let mut fields = meta.split(' ');
            let (mode, oid, stage) = (
                fields.next().unwrap_or(""),
                fields.next().unwrap_or(""),
                fields.next().unwrap_or(""),
            );
            let entry = if stage == "0" {
                (mode.to_string(), oid.to_string())
            } else {
                ("conflict".to_string(), String::new())
            };
            entries.insert(path.to_string(), entry);
        }
        Ok(entries)
    }

    /// Index paths that differ from `base`'s tree, or from the empty tree.
    pub fn staged_against(&self, base: Option<&str>) -> Result<Vec<String>, Failure> {
        let listing = self.ok(
            &[
                "diff-index",
                "--cached",
                "--name-only",
                "--no-renames",
                "-z",
                base.unwrap_or(EMPTY_TREE),
            ],
            None,
            &[],
        )?;
        Ok(records(&listing))
    }

    /// Blob IDs of the working files at `paths`, without writing anything.
    /// No filter runs; every byte is read.
    pub fn hash_paths(&self, paths: &[String]) -> Result<Vec<String>, Failure> {
        if paths.is_empty() {
            return Ok(Vec::new());
        }
        let listing: String = paths
            .iter()
            .map(|path| format!("{}\n", line_quoted(path)))
            .collect();
        let output = self.ok(
            &["hash-object", "--no-filters", "--stdin-paths"],
            Some(listing.as_bytes()),
            &[],
        )?;
        let oids: Vec<String> = text(&output).lines().map(str::to_string).collect();
        if oids.len() != paths.len() {
            return Err("git hash-object returned an unexpected number of IDs".to_string());
        }
        Ok(oids)
    }

    /// Reset the named index entries to `commit` without changing working files.
    pub fn sync_index(&self, commit: &str, paths: &[String]) -> Result<(), Failure> {
        if paths.is_empty() {
            return Ok(());
        }
        let input = nul_separated(paths.iter().map(String::as_str));
        self.ok(
            &[
                "--literal-pathspecs",
                "reset",
                "--quiet",
                commit,
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
            ],
            Some(&input),
            &[],
        )?;
        Ok(())
    }

    /// The working files that are history source, with their blob IDs, beside
    /// the head's tree. Nothing is written.
    #[allow(clippy::type_complexity)]
    pub fn source_state(
        &self,
        snapshot: &Snapshot,
        head: Option<&str>,
    ) -> Result<
        (
            BTreeMap<String, (String, String)>,
            BTreeMap<String, String>,
            Vec<String>,
        ),
        Failure,
    > {
        let committed = match head {
            Some(head) => self.tree_files(head)?,
            None => BTreeMap::new(),
        };
        let portable: Vec<String> = snapshot
            .walked
            .regular
            .iter()
            .filter(|path| is_portable_path(path))
            .cloned()
            .collect();
        let candidates: Vec<&str> = portable
            .iter()
            .map(String::as_str)
            .filter(|path| !committed.contains_key(*path))
            .collect();
        let ignored = self.ignored(&candidates)?;
        let source: Vec<String> = portable
            .iter()
            .filter(|path| !ignored.contains(*path))
            .cloned()
            .collect();
        let current = self.hash_files(snapshot, source, false)?;
        Ok((committed, current, portable))
    }

    /// Every leaf of a commit's tree as `(mode, oid)` by path.
    pub fn tree_files(&self, commit: &str) -> Result<BTreeMap<String, (String, String)>, Failure> {
        let listing = self.ok(&["ls-tree", "-r", "-z", "--full-tree", commit], None, &[])?;
        let mut files = BTreeMap::new();
        for record in records(&listing) {
            let Some((meta, path)) = record.split_once('\t') else {
                continue;
            };
            let mut fields = meta.split(' ');
            let mode = fields.next().unwrap_or("").to_string();
            let oid = fields.nth(1).unwrap_or("").to_string();
            files.insert(path.to_string(), (mode, oid));
        }
        Ok(files)
    }

    pub fn changes(
        committed: &BTreeMap<String, (String, String)>,
        current: &BTreeMap<String, String>,
    ) -> Vec<PathChange> {
        let paths: BTreeSet<&String> = committed.keys().chain(current.keys()).collect();
        let mut changes = Vec::new();
        for path in paths {
            let kind = match (committed.get(path), current.get(path)) {
                (None, Some(_)) => ChangeKind::Add,
                (Some(_), None) => ChangeKind::Delete,
                (Some((_, before)), Some(after)) if before != after => ChangeKind::Modify,
                _ => continue,
            };
            changes.push(PathChange {
                path: path.clone(),
                kind,
            });
        }
        changes
    }

    /// A read-only observation: which source files differ from the head. It
    /// writes no object, takes no lock, and never touches the index.
    pub fn observe(&self, snapshot: &Snapshot) -> Result<Observed, Failure> {
        let head = self.read_branch()?;
        let (committed, current, _) = self.source_state(snapshot, head.as_deref())?;
        Ok(Observed {
            changes: Self::changes(&committed, &current),
            head,
        })
    }

    /// Trees for every directory of plain files, deepest first.
    fn write_tree(&self, files: &BTreeMap<String, String>) -> Result<String, Failure> {
        let entries: BTreeMap<String, (String, String)> = files
            .iter()
            .map(|(path, oid)| (path.clone(), ("100644".to_string(), oid.clone())))
            .collect();
        self.write_entries_tree(&entries)
    }

    /// Trees for every directory, deepest first, one `mktree --batch` per
    /// depth. Each leaf keeps its own `(mode, oid)`; a submodule's mode names
    /// a commit.
    pub fn write_entries_tree(
        &self,
        files: &BTreeMap<String, (String, String)>,
    ) -> Result<String, Failure> {
        // Directory path ("" is the root) to its `mktree` lines.
        let mut directories: BTreeMap<String, Vec<String>> = BTreeMap::new();
        directories.insert(String::new(), Vec::new());
        for (path, (mode, oid)) in files {
            let (directory, name) = path.rsplit_once('/').unwrap_or(("", path));
            let mut ancestor = String::new();
            for part in directory.split('/').filter(|part| !part.is_empty()) {
                if !ancestor.is_empty() {
                    ancestor.push('/');
                }
                ancestor.push_str(part);
                directories.entry(ancestor.clone()).or_default();
            }
            let kind = if mode == "160000" { "commit" } else { "blob" };
            directories
                .entry(directory.to_string())
                .or_default()
                .push(format!("{mode} {kind} {oid}\t{}", line_quoted(name)));
        }
        let depth = |directory: &str| {
            if directory.is_empty() {
                0
            } else {
                directory.matches('/').count() + 1
            }
        };
        let deepest = directories
            .keys()
            .map(|directory| depth(directory))
            .max()
            .unwrap_or(0);
        for level in (1..=deepest).rev() {
            let batch: Vec<String> = directories
                .keys()
                .filter(|directory| depth(directory) == level)
                .cloned()
                .collect();
            let input: String = batch
                .iter()
                .map(|directory| format!("{}\n\n", directories[directory].join("\n")))
                .collect();
            let output = self.ok(&["mktree", "--batch"], Some(input.as_bytes()), &[])?;
            let oids: Vec<String> = text(&output).lines().map(str::to_string).collect();
            if oids.len() != batch.len() {
                return Err("git mktree returned an unexpected number of trees".to_string());
            }
            for (directory, oid) in batch.iter().zip(oids) {
                let (parent, name) = directory.rsplit_once('/').unwrap_or(("", directory));
                directories
                    .get_mut(parent)
                    .expect("every ancestor directory was inserted")
                    .push(format!("040000 tree {oid}\t{}", line_quoted(name)));
            }
        }
        // An empty root still writes the empty tree so a commit naming it can be pushed.
        let root = format!("{}\n", directories[""].join("\n"));
        let input = if directories[""].is_empty() {
            ""
        } else {
            root.as_str()
        };
        let output = self.ok(&["mktree"], Some(input.as_bytes()), &[])?;
        Ok(text(&output).trim().to_string())
    }

    /// Capture the whole portable folder as a tree on top of `head`, or say
    /// why a plain-file commit cannot represent this repository.
    pub fn capture(&self, snapshot: &Snapshot, head: Option<&str>) -> Result<Capture, Failure> {
        let (committed, source) = match self.survey(snapshot, head)? {
            Ok(surveyed) => surveyed,
            Err(reason) => return Ok(Capture::Blocked(reason)),
        };
        let current = self.hash_files(snapshot, source, true)?;
        Ok(Capture::Captured(Captured {
            tree: self.write_tree(&current)?,
            changes: Self::changes(&committed, &current),
        }))
    }

    /// Why a whole-folder commit or fast-forward cannot represent this
    /// repository faithfully, if it cannot. Nothing is written.
    pub fn checkpoint_problem(
        &self,
        snapshot: &Snapshot,
        head: Option<&str>,
    ) -> Result<Option<String>, Failure> {
        Ok(self.survey(snapshot, head)?.err())
    }

    /// The committed tree and the source paths a whole-folder commit would
    /// record, or the first thing it cannot represent: every file is written
    /// as plain `100644` bytes with no attribute filters, so symbolic links,
    /// executables, submodules, nested Git data, and normalizing attributes
    /// are refused rather than silently rewritten.
    #[allow(clippy::type_complexity)]
    fn survey(
        &self,
        snapshot: &Snapshot,
        head: Option<&str>,
    ) -> Result<Result<(BTreeMap<String, (String, String)>, Vec<String>), String>, Failure> {
        // Tracked modes and paths, in the committed tree and in the index.
        let committed = match head {
            Some(head) => self.tree_files(head)?,
            None => BTreeMap::new(),
        };
        let mut tracked: BTreeSet<String> = BTreeSet::new();
        let staged = self.ok(&["ls-files", "--stage", "-z"], None, &[])?;
        let staged = records(&staged);
        let listed = committed
            .iter()
            .map(|(path, (mode, _))| (path.as_str(), mode.as_str()))
            .chain(staged.iter().filter_map(|record| {
                let (meta, path) = record.split_once('\t')?;
                Some((path, meta.get(..6).unwrap_or(meta)))
            }));
        for (path, mode) in listed {
            tracked.insert(path.to_string());
            if let Some(problem) = path_problem(path) {
                return Ok(Err(format!(
                    "{path:?} cannot be captured: {problem}; {PLAIN_ONLY}"
                )));
            }
            if mode != "100644" {
                let what = match mode {
                    "100755" => "an executable file".to_string(),
                    "120000" => "a symbolic link".to_string(),
                    "160000" => "a submodule".to_string(),
                    other => format!("mode {other}"),
                };
                return Ok(Err(format!("{path} is tracked as {what}; {PLAIN_ONLY}")));
            }
        }

        let autocrlf = self.run(&["config", "--get", "core.autocrlf"], None, &[])?;
        let conversion = text(&autocrlf.stdout).trim().to_lowercase();
        if conversion == "true" || conversion == "input" {
            return Ok(Err(format!(
                "core.autocrlf is {conversion}; commits do not convert line endings"
            )));
        }

        // Working files Git would record differently, and nested Git data.
        let walked = &snapshot.walked;
        let candidates: Vec<&str> = walked
            .special
            .iter()
            .map(|(path, _)| path.as_str())
            .chain(walked.regular.iter().map(String::as_str))
            .filter(|path| !committed.contains_key(*path))
            .collect();
        let ignored = self.ignored(&candidates)?;
        let excluded = |path: &str| ignored.contains(path) && !tracked.contains(path);
        if let Some((path, reason)) = walked.special.iter().find(|(path, _)| !excluded(path)) {
            return Ok(Err(format!("{path} is {reason}; {PLAIN_ONLY}")));
        }

        // Attributes that would normalize or filter the bytes of any source file.
        let mut attributed: BTreeSet<&str> = tracked.iter().map(String::as_str).collect();
        attributed.extend(
            walked
                .regular
                .iter()
                .map(String::as_str)
                .filter(|path| !excluded(path)),
        );
        if let Some((path, attribute)) = self.normalizing_attribute(None, attributed)? {
            return Ok(Err(format!(
                "{path} has the Git attribute {attribute}; commits do not apply attribute filters or conversion"
            )));
        }

        // Source: portable files that are in the committed tree, or untracked
        // and not ignored. A tracked file survives a new ignore rule.
        let source: Vec<String> = walked
            .regular
            .iter()
            .filter(|path| is_portable_path(path))
            .filter(|path| committed.contains_key(*path) || !ignored.contains(*path))
            .cloned()
            .collect();
        Ok(Ok((committed, source)))
    }

    /// The first of `paths` for which an attribute would make Git store or
    /// check out different bytes than the plain file, with that attribute as
    /// `name` or `name=value`.
    ///
    /// `source` names a commit whose own `.gitattributes` files decide,
    /// wherever they sit in its tree; the working tree's are not consulted.
    /// Without it the working tree's decide. Git's own attribute matching is
    /// used either way: nothing here interprets patterns, and nothing looks
    /// at file contents. A Git too old for `--source` fails the check rather
    /// than answering from the wrong place.
    pub fn normalizing_attribute<'a>(
        &self,
        source: Option<&str>,
        paths: impl IntoIterator<Item = &'a str>,
    ) -> Result<Option<(String, String)>, Failure> {
        let input = nul_separated(paths);
        if input.is_empty() {
            return Ok(None);
        }
        let from = source.map(|commit| format!("--source={commit}"));
        let mut args = vec!["check-attr"];
        args.extend(from.as_deref());
        args.extend(["--stdin", "-z"]);
        args.extend(NORMALIZING);
        let attributes = records(&self.ok(&args, Some(&input), &[])?);
        for triple in attributes.chunks(3) {
            let [path, attribute, value] = triple else {
                continue;
            };
            if value != "unspecified" && value != "unset" {
                let shown = if value == "set" {
                    attribute.clone()
                } else {
                    format!("{attribute}={value}")
                };
                return Ok(Some((path.clone(), shown)));
            }
        }
        Ok(None)
    }

    pub fn tree_of(&self, commit: &str) -> Result<String, Failure> {
        self.resolve(&format!("{commit}^{{tree}}"))?
            .ok_or_else(|| format!("{commit} has no tree"))
    }

    /// Write a commit object. It stays unreachable until a ref names it.
    pub fn write_commit(
        &self,
        tree: &str,
        parent: Option<&str>,
        message: &str,
        author: &Author,
    ) -> Result<String, Failure> {
        let parents: Vec<&str> = parent.into_iter().collect();
        self.write_commit_with_parents(tree, &parents, message, author)
    }

    /// Write a commit object with exactly `parents`, in order.
    pub fn write_commit_with_parents(
        &self,
        tree: &str,
        parents: &[&str],
        message: &str,
        author: &Author,
    ) -> Result<String, Failure> {
        let mut args = vec!["commit-tree", "--no-gpg-sign"];
        for parent in parents {
            args.extend(["-p", parent]);
        }
        args.push(tree);
        let mut body = message.as_bytes().to_vec();
        if !body.ends_with(b"\n") {
            body.push(b'\n');
        }
        let output = self.ok(&args, Some(&body), &identity(author))?;
        Ok(text(&output).trim().to_string())
    }

    /// Reset every index entry that differs from `commit`, including
    /// staged-only additions and deletions. Working files are not touched.
    pub fn reconcile_index(&self, commit: &str) -> Result<(), Failure> {
        let differing = self.ok(
            &[
                "diff-index",
                "--cached",
                "--name-only",
                "--no-renames",
                "-z",
                commit,
            ],
            None,
            &[],
        )?;
        if differing.is_empty() {
            return Ok(());
        }
        self.ok(
            &[
                "--literal-pathspecs",
                "reset",
                "--quiet",
                commit,
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
            ],
            Some(&differing),
            &[],
        )?;
        Ok(())
    }

    pub fn index_matches_head(&self) -> Result<bool, Failure> {
        if self.read_branch()?.is_none() {
            let output = self.run(&["ls-files", "--cached", "-z"], None, &[])?;
            return Ok(output.code == Some(0) && output.stdout.is_empty());
        }
        let args = ["diff", "--cached", "--quiet", "--no-ext-diff"];
        let output = self.run(&args, None, &[])?;
        match output.code {
            Some(0) => Ok(true),
            Some(1) => Ok(false),
            _ => Err(Self::failure(&args, &output)),
        }
    }

    pub fn path_status(&self) -> Result<Vec<PathStatus>, Failure> {
        let output = self.ok(
            &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
            None,
            &[],
        )?;
        let listing = text(&output);
        let mut tokens = listing.split('\0');
        let mut result = Vec::new();
        while let Some(token) = tokens.next() {
            let mut characters = token.chars();
            let (Some(index), Some(worktree), Some(_)) =
                (characters.next(), characters.next(), characters.next())
            else {
                continue;
            };
            let path = characters.as_str();
            if path.is_empty() {
                continue;
            }
            // A rename or copy is followed by its source path.
            if index == 'R' || index == 'C' {
                tokens.next();
            }
            result.push(PathStatus {
                path: path.to_string(),
                index: index.to_string(),
                worktree: worktree.to_string(),
            });
        }
        Ok(result)
    }

    /// Stage current contents of `paths`, including deletions; `None` stages everything.
    pub fn stage(&self, paths: Option<&[String]>) -> Result<(), Failure> {
        match paths {
            None => self.ok(&["add", "--all"], None, &[])?,
            Some(paths) => {
                let mut args = vec!["--literal-pathspecs", "add", "--all", "--"];
                args.extend(paths.iter().map(String::as_str));
                self.ok(&args, None, &[])?
            }
        };
        Ok(())
    }

    /// The tree the index names now, by Git's own rules: an unmerged path
    /// fails it, and an intent-to-add entry (`git add -N`) is left out.
    /// `write-tree` runs on a private copy, because on the live index it
    /// rewrites the cached trees: a commit the compare-and-swap refuses then
    /// leaves the index byte for byte as it was.
    fn index_tree(&self) -> Result<String, Failure> {
        let copy = Scratch(self.gitdir.join(format!(
            "index.epicenter-{}-{}",
            std::process::id(),
            SNAPSHOT_SEQUENCE.fetch_add(1, Ordering::SeqCst)
        )));
        match fs::copy(self.gitdir.join("index"), &copy.0) {
            Ok(_) => {}
            // No index is an empty one.
            Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => {}
            Err(cause) => return Err(format!(".git/index could not be copied: {cause}")),
        }
        let index_file = copy
            .0
            .to_str()
            .ok_or_else(|| format!("{} is not a UTF-8 path", copy.0.display()))?;
        // Keep the scratch index from creating an unreferenced shared index.
        let output = self.ok(
            &["-c", "core.splitIndex=false", "write-tree"],
            None,
            &[("GIT_INDEX_FILE", index_file)],
        )?;
        Ok(text(&output).trim().to_string())
    }

    /// Commit the index's tree onto the branch head, pinned before anything
    /// is written. A tree equal to the parent's is `Nothing`. The branch
    /// moves only from that parent, by compare-and-swap, so a commit it
    /// refuses leaves the index and the files as they were. `git commit`
    /// would take whatever `HEAD` names when it runs. Like a whole-folder
    /// commit, no commit hook runs and nothing is signed.
    pub fn commit_index(&self, message: &str, author: &Author) -> Result<IndexCommit, Failure> {
        let parent = self.read_branch()?;
        let tree = self.index_tree()?;
        let parent_tree = match &parent {
            Some(parent) => self.tree_of(parent)?,
            None => EMPTY_TREE.to_string(),
        };
        if tree == parent_tree {
            return Ok(IndexCommit::Nothing);
        }
        let parents: Vec<&str> = parent.as_deref().into_iter().collect();
        let oid = self.write_commit_with_parents(&tree, &parents, message, author)?;
        match self.move_branch(parent.as_deref(), &oid, "epicenter: commit")? {
            Cas::Moved => Ok(IndexCommit::Committed { oid, parent }),
            Cas::Lost { actual } => Ok(IndexCommit::BranchMoved {
                expected: parent,
                actual,
            }),
        }
    }

    // ------------------------------------------------------------------
    // Merges
    // ------------------------------------------------------------------

    /// The best common ancestors of two commits.
    pub fn merge_bases(&self, left: &str, right: &str) -> Result<Vec<String>, Failure> {
        let args = ["merge-base", "--all", left, right];
        let output = self.run(&args, None, &[])?;
        match output.code {
            Some(0) => Ok(text(&output.stdout)
                .lines()
                .filter(|line| !line.is_empty())
                .map(str::to_string)
                .collect()),
            Some(1) if output.stderr.is_empty() => Ok(Vec::new()),
            _ => Err(Self::failure(&args, &output)),
        }
    }

    /// Store exact bytes as a blob; no filter runs.
    pub fn write_blob(&self, bytes: &[u8]) -> Result<String, Failure> {
        let output = self.ok(&["hash-object", "-w", "--stdin"], Some(bytes), &[])?;
        Ok(text(&output).trim().to_string())
    }

    /// Git's own three-way line merge of three blobs, written as a blob, or
    /// `None` when it conflicts. `base` absent is the empty blob.
    pub fn merge_blobs(
        &self,
        base: Option<&str>,
        ours: &str,
        theirs: &str,
    ) -> Result<Option<String>, Failure> {
        let base = match base {
            Some(base) => base.to_string(),
            None => {
                let empty = self.write_blob(b"")?;
                debug_assert_eq!(empty, EMPTY_BLOB);
                empty
            }
        };
        let args = ["merge-file", "--object-id", ours, &base, theirs];
        let output = self.run(&args, None, &[])?;
        match output.code {
            Some(0) => Ok(Some(text(&output.stdout).trim().to_string())),
            Some(1..=127) => Ok(None),
            _ => Err(Self::failure(&args, &output)),
        }
    }

    /// The first of `paths`, in byte order, that `commit`'s own attribute
    /// files give a `merge` attribute other than Git's text merge: unset, as
    /// the `binary` macro does, or a driver.
    pub fn merge_attribute<'a>(
        &self,
        commit: &str,
        paths: impl IntoIterator<Item = &'a str>,
    ) -> Result<Option<(String, String)>, Failure> {
        let mut paths: Vec<&str> = paths.into_iter().collect();
        if paths.is_empty() {
            return Ok(None);
        }
        paths.sort_unstable();
        let source = format!("--source={commit}");
        let args = ["check-attr", &source, "--stdin", "-z", "merge"];
        let attributes = records(&self.ok(&args, Some(&nul_separated(paths)), &[])?);
        for triple in attributes.chunks(3) {
            let [path, _, value] = triple else { continue };
            if value != "unspecified" && value != "set" {
                let shown = if value == "unset" {
                    "-merge".to_string()
                } else {
                    format!("merge={value}")
                };
                return Ok(Some((path.clone(), shown)));
            }
        }
        Ok(None)
    }

    /// Each path the index holds as unmerged stages, once, in index order.
    pub fn unmerged_paths(&self) -> Result<Vec<String>, Failure> {
        let listing = self.ok(&["ls-files", "--unmerged", "-z"], None, &[])?;
        let mut unresolved: Vec<String> = Vec::new();
        for record in records(&listing) {
            if let Some((_, path)) = record.split_once('\t') {
                if unresolved.last().map(String::as_str) != Some(path) {
                    unresolved.push(path.to_string());
                }
            }
        }
        Ok(unresolved)
    }

    /// Every index entry as stage to `(mode, oid)`, by path.
    #[allow(clippy::type_complexity)]
    pub fn index_stages(
        &self,
    ) -> Result<BTreeMap<String, BTreeMap<u8, (String, String)>>, Failure> {
        let listing = self.ok(&["ls-files", "--stage", "-z"], None, &[])?;
        let mut entries: BTreeMap<String, BTreeMap<u8, (String, String)>> = BTreeMap::new();
        for record in records(&listing) {
            let Some((meta, path)) = record.split_once('\t') else {
                continue;
            };
            let mut fields = meta.split(' ');
            let (mode, oid, stage) = (
                fields.next().unwrap_or(""),
                fields.next().unwrap_or(""),
                fields.next().unwrap_or(""),
            );
            entries.entry(path.to_string()).or_default().insert(
                stage.parse().unwrap_or(u8::MAX),
                (mode.to_string(), oid.to_string()),
            );
        }
        Ok(entries)
    }

    pub fn diff(&self, staged: bool, paths: &[String]) -> Result<String, Failure> {
        let mut args = vec!["--literal-pathspecs", "diff", "--no-color", "--no-ext-diff"];
        if staged {
            args.push("--cached");
        }
        args.push("--");
        args.extend(paths.iter().map(String::as_str));
        Ok(text(&self.ok(&args, None, &[])?))
    }

    pub fn log(&self, depth: u32) -> Result<Vec<CommitSummary>, Failure> {
        if self.read_branch()?.is_none() {
            return Ok(Vec::new());
        }
        let count = format!("-n{depth}");
        let output = self.ok(
            &[
                "log",
                &count,
                "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%B%x1e",
                &self.branch_ref,
            ],
            None,
            &[],
        )?;
        let mut commits = Vec::new();
        for record in text(&output).split('\x1e') {
            let record = record.strip_prefix('\n').unwrap_or(record);
            if record.trim().is_empty() {
                continue;
            }
            let mut fields = record.split('\x1f');
            let mut field = || fields.next().unwrap_or("").to_string();
            let (oid, parents, name, email, timestamp, message) =
                (field(), field(), field(), field(), field(), field());
            commits.push(CommitSummary {
                oid,
                parents: parents
                    .split(' ')
                    .filter(|p| !p.is_empty())
                    .map(str::to_string)
                    .collect(),
                message,
                author: CommitAuthor {
                    name,
                    email,
                    timestamp: timestamp.parse().unwrap_or(0),
                },
            });
        }
        Ok(commits)
    }

    /// Push an exact commit to the configured remote branch.
    pub fn push(&self, oid: &str, cancel: &AtomicBool) -> Result<(), Failure> {
        let remote = self.remote.as_ref().ok_or("No remote is configured")?;
        let refspec = format!("{oid}:refs/heads/{}", remote.branch);
        let args = ["push", "--porcelain", remote.url.as_str(), &refspec];
        let output = self.run_cancellable(&args, None, &[], Some(cancel))?;
        if output.code != Some(0) {
            return Err(Self::failure(&args, &output));
        }
        self.ok(&["update-ref", &self.tracking_ref, oid], None, &[])?;
        Ok(())
    }

    /// Fetch the configured remote branch; its commit, or `None` if the remote
    /// has no such branch.
    pub fn fetch(&self, cancel: &AtomicBool) -> Result<Option<String>, Failure> {
        let remote = self.remote.as_ref().ok_or("No remote is configured")?;
        let refspec = format!("+refs/heads/{}:{}", remote.branch, self.tracking_ref);
        let args = ["fetch", "--no-tags", "--quiet", remote.url.as_str(), &refspec];
        let output = self.run_cancellable(&args, None, &[], Some(cancel))?;
        if output.code != Some(0) {
            if output
                .stderr
                .to_lowercase()
                .contains("couldn't find remote ref")
            {
                return Ok(None);
            }
            return Err(Self::failure(&args, &output));
        }
        self.read_remote_tracking()
    }

    /// Record `remote` as `origin`, fetching only its branch into the
    /// tracking ref, as `git remote add` would write it.
    pub fn configure_origin(&self, remote: &Remote) -> Result<(), Failure> {
        self.ok(&["config", "remote.origin.url", &remote.url], None, &[])?;
        let fetch = format!(
            "+refs/heads/{}:refs/remotes/{REMOTE_NAME}/{}",
            remote.branch, remote.branch
        );
        self.ok(&["config", "remote.origin.fetch", &fetch], None, &[])?;
        Ok(())
    }

    /// What moving refs look like from outside: `HEAD`, `packed-refs`, and
    /// every loose ref. Another Git process changing the branch changes this.
    pub fn refs_signature(&self) -> String {
        let stamp = |path: &Path| match fs::metadata(path) {
            Ok(stats) => format!(
                "{}:{:?}",
                stats.len(),
                stats.modified().ok().and_then(|time| time
                    .duration_since(std::time::UNIX_EPOCH)
                    .ok()
                    .map(|elapsed| elapsed.as_nanos()))
            ),
            Err(_) => "absent".to_string(),
        };
        let mut signature = format!(
            "HEAD={:?};packed={};",
            fs::read(self.gitdir.join("HEAD")).unwrap_or_default(),
            stamp(&self.gitdir.join("packed-refs"))
        );
        let mut pending = vec![self.gitdir.join("refs")];
        let mut loose = Vec::new();
        while let Some(directory) = pending.pop() {
            let Ok(entries) = fs::read_dir(&directory) else {
                continue;
            };
            for entry in entries.flatten() {
                match entry.file_type() {
                    Ok(kind) if kind.is_dir() => pending.push(entry.path()),
                    Ok(kind) if kind.is_file() => loose.push(format!(
                        "{}={:?}",
                        entry.path().display(),
                        fs::read(entry.path()).unwrap_or_default()
                    )),
                    _ => {}
                }
            }
        }
        loose.sort();
        signature.push_str(&loose.join(";"));
        signature
    }
}

fn identity(author: &Author) -> [(&'static str, &str); 4] {
    [
        ("GIT_AUTHOR_NAME", author.name.as_str()),
        ("GIT_AUTHOR_EMAIL", author.email.as_str()),
        ("GIT_COMMITTER_NAME", author.name.as_str()),
        ("GIT_COMMITTER_EMAIL", author.email.as_str()),
    ]
}

#[cfg(unix)]
fn is_executable(stats: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    stats.permissions().mode() & 0o111 != 0
}

/// Windows has no executable bit; Git records `100644` there.
#[cfg(not(unix))]
fn is_executable(_stats: &fs::Metadata) -> bool {
    false
}

