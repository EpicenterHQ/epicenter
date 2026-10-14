//! One file's Git history: its commits, and its text at one of them.
//!
//! The folder engine lists the folder's commits; it has no per-path log and
//! no way to read a file at a commit, so the shell asks `git` itself. Both
//! operations only read.
//!
//! What the page supplies is checked before `git` sees it:
//!
//! - A path must be a literal folder-relative path by the folder's shared
//!   path rule, so it cannot name `.git` or leave the root. It goes after `--`
//!   under `--literal-pathspecs`, or after the commit in `<commit>:<path>`,
//!   so it is never read as an option or a pattern, whatever it starts with.
//! - A commit is 7 to 64 lowercase hexadecimal digits, so it is never a
//!   revision expression, a range, or an option.
//!
//! `git` runs in the root the shell registered, with inherited variables that
//! would point it at another repository removed, and discovery stopped at the
//! root.

use std::fmt;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

use epicenter_folder_core::paths::path_problem;
use serde::Serialize;

use crate::process::capture;

const DEFAULT_DEPTH: u32 = 20;
const MAX_DEPTH: u32 = 200;
const TIMEOUT: Duration = Duration::from_secs(30);
/// A log is at most `MAX_DEPTH` short lines.
const LOG_LIMIT: usize = 1024 * 1024;
/// The largest version of a file the history view shows.
const SHOW_LIMIT: usize = 16 * 1024 * 1024;

/// Inherited variables that would point Git at another repository, index, or
/// object store: the names `git rev-parse --local-env-vars` lists, plus the
/// ref namespace. Without `GIT_CONFIG_COUNT`, numbered configuration
/// variables are not read.
const REPOSITORY_ENV: [&str; 16] = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
    "GIT_PREFIX",
    "GIT_GRAFT_FILE",
    "GIT_SHALLOW_FILE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_REPLACE_REF_BASE",
    "GIT_CONFIG",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileRevision {
    pub oid: String,
    pub subject: String,
    /// Seconds since the Unix epoch.
    pub timestamp: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HistoryError {
    /// The path is not a literal folder-relative path.
    Path(&'static str),
    NotACommitId,
    /// `git` could not start, or refused.
    Git(String),
    /// The version is not UTF-8 text, so it cannot become a draft.
    NotText,
    TooLarge,
}

impl fmt::Display for HistoryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            HistoryError::Path(problem) => formatter.write_str(problem),
            HistoryError::NotACommitId => formatter.write_str("Not a commit id."),
            HistoryError::Git(message) => formatter.write_str(message),
            HistoryError::NotText => formatter.write_str("This version is not text."),
            HistoryError::TooLarge => formatter.write_str("This version is too large to show."),
        }
    }
}

fn is_commit_id(oid: &str) -> bool {
    (7..=64).contains(&oid.len())
        && oid
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn git(root: &Path) -> Command {
    let mut command = Command::new("git");
    command.current_dir(root);
    for name in REPOSITORY_ENV {
        command.env_remove(name);
    }
    command
        // A root whose `.git` is missing never resolves to a repository above it.
        .env(
            "GIT_CEILING_DIRECTORIES",
            root.parent().unwrap_or(Path::new("/")),
        )
        // Reading history must not take `index.lock`.
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C");
    command
}

/// The commits that changed `path`, newest first. `depth` is how many to
/// list: zero means the default, and it never exceeds `MAX_DEPTH`.
pub fn file_log(root: &Path, path: &str, depth: u32) -> Result<Vec<FileRevision>, HistoryError> {
    if let Some(problem) = path_problem(path) {
        return Err(HistoryError::Path(problem));
    }
    let depth = if depth == 0 {
        DEFAULT_DEPTH
    } else {
        depth.min(MAX_DEPTH)
    };
    let captured = capture(
        git(root)
            .arg("--literal-pathspecs")
            .arg("log")
            .arg(format!("-n{depth}"))
            // A signature check would print lines of its own between commits.
            .arg("--no-show-signature")
            .arg("--format=%H%x1f%at%x1f%s")
            .arg("--")
            .arg(path),
        LOG_LIMIT,
        TIMEOUT,
    )
    .map_err(|cause| HistoryError::Git(format!("git log could not start: {cause}")))?;
    if captured.timed_out {
        return Err(HistoryError::Git("git log timed out.".to_string()));
    }
    if captured.truncated {
        return Err(HistoryError::Git(
            "git log output was too large.".to_string(),
        ));
    }
    if captured.code != Some(0) {
        let stderr = String::from_utf8_lossy(&captured.stderr).trim().to_string();
        // Only Git's confirmed empty states mean no history. Corruption and
        // interrupted commands are failures the history view must show.
        let no_repository = stderr.starts_with("fatal: not a git repository")
            && matches!(std::fs::symlink_metadata(root.join(".git")),
                Err(cause) if cause.kind() == std::io::ErrorKind::NotFound);
        if captured.code.is_some()
            && (no_repository
                || (stderr.starts_with("fatal: your current branch '")
                    && stderr.ends_with("does not have any commits yet")))
        {
            return Ok(Vec::new());
        }
        return Err(HistoryError::Git(if stderr.is_empty() {
            "git log did not complete.".to_string()
        } else {
            stderr
        }));
    }
    Ok(String::from_utf8_lossy(&captured.stdout)
        .lines()
        .filter_map(|line| {
            let mut fields = line.splitn(3, '\x1f');
            let oid = fields.next().filter(|oid| is_commit_id(oid))?;
            let timestamp = fields.next()?.parse().ok()?;
            Some(FileRevision {
                oid: oid.to_string(),
                timestamp,
                subject: fields.next().unwrap_or("").to_string(),
            })
        })
        .collect())
}

/// The exact text of `path` as commit `oid` recorded it.
pub fn show(root: &Path, oid: &str, path: &str) -> Result<String, HistoryError> {
    if let Some(problem) = path_problem(path) {
        return Err(HistoryError::Path(problem));
    }
    if !is_commit_id(oid) {
        return Err(HistoryError::NotACommitId);
    }
    // The stored bytes, with no conversion filter and no pager; a directory
    // at that path is refused.
    let captured = capture(
        git(root)
            .arg("cat-file")
            .arg("blob")
            .arg(format!("{oid}:{path}")),
        SHOW_LIMIT,
        TIMEOUT,
    )
    .map_err(|cause| HistoryError::Git(format!("git cat-file could not start: {cause}")))?;
    if captured.truncated {
        return Err(HistoryError::TooLarge);
    }
    if captured.code != Some(0) {
        let stderr = String::from_utf8_lossy(&captured.stderr).trim().to_string();
        return Err(HistoryError::Git(
            if captured.timed_out || stderr.is_empty() {
                "git could not read this version.".to_string()
            } else {
                stderr
            },
        ));
    }
    String::from_utf8(captured.stdout).map_err(|_| HistoryError::NotText)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{git as run_git, repository, temp};

    #[test]
    fn a_file_lists_its_commits_newest_first_and_an_old_version_reads_exactly() {
        let directory = repository("history-log");
        let root = directory.path();
        let revisions = file_log(root, "notes/a.md", 10).unwrap();
        assert_eq!(
            revisions
                .iter()
                .map(|revision| revision.subject.as_str())
                .collect::<Vec<_>>(),
            ["Update notes/a.md", "Add notes/a.md"]
        );
        assert_eq!(revisions[0].oid, run_git(root, &["rev-parse", "HEAD"]));
        assert!(revisions[0].timestamp >= revisions[1].timestamp);
        assert!(revisions[1].timestamp > 1_600_000_000);
        assert_eq!(
            show(root, &revisions[1].oid, "notes/a.md").unwrap(),
            "first\n"
        );
        assert_eq!(
            show(root, &revisions[0].oid, "notes/a.md").unwrap(),
            "second\n"
        );
        // An abbreviated commit is still only a commit.
        assert_eq!(
            show(root, &revisions[1].oid[..12], "notes/a.md").unwrap(),
            "first\n"
        );
    }

    #[test]
    fn only_commits_that_changed_the_file_are_listed() {
        let directory = repository("history-scope");
        let root = directory.path();
        std::fs::write(root.join("notes/b.md"), "other\n").unwrap();
        run_git(root, &["add", "--all"]);
        run_git(root, &["commit", "--quiet", "--message", "Add notes/b.md"]);
        assert_eq!(file_log(root, "notes/a.md", 10).unwrap().len(), 2);
        assert_eq!(file_log(root, "notes/b.md", 10).unwrap().len(), 1);
        assert_eq!(file_log(root, "notes/missing.md", 10).unwrap(), []);
    }

    #[test]
    fn depth_bounds_the_listing_and_zero_means_the_default() {
        let directory = repository("history-depth");
        let root = directory.path();
        assert_eq!(file_log(root, "notes/a.md", 1).unwrap().len(), 1);
        assert_eq!(file_log(root, "notes/a.md", 0).unwrap().len(), 2);
        assert_eq!(file_log(root, "notes/a.md", u32::MAX).unwrap().len(), 2);
    }

    #[test]
    fn a_path_with_pattern_characters_names_one_literal_file() {
        let directory = repository("history-literal");
        let root = directory.path();
        std::fs::write(root.join("notes/[ab].md"), "bracketed\n").unwrap();
        run_git(root, &["add", "--all"]);
        run_git(
            root,
            &["commit", "--quiet", "--message", "Add the bracketed file"],
        );
        // As a pattern this would also match `notes/a.md`.
        let revisions = file_log(root, "notes/[ab].md", 10).unwrap();
        assert_eq!(revisions.len(), 1);
        assert_eq!(revisions[0].subject, "Add the bracketed file");
        assert_eq!(
            show(root, &revisions[0].oid, "notes/[ab].md").unwrap(),
            "bracketed\n"
        );
        // `*` and `:` are names the shared path rule refuses, so a pathspec
        // with magic never reaches `git`.
        assert!(matches!(
            file_log(root, ":(glob)notes/**", 10),
            Err(HistoryError::Path(_))
        ));
    }

    #[test]
    fn a_path_outside_the_folder_or_inside_git_state_is_refused_before_git_runs() {
        // No repository here: a refusal that reached `git` would read differently.
        let directory = temp("history-paths");
        let root = directory.path();
        let oid = "0123456789abcdef0123456789abcdef01234567";
        for path in [
            "../x",
            "/etc/passwd",
            ".git/config",
            "notes/../../x",
            "",
            "a\nb",
            "notes//a.md",
        ] {
            assert!(
                matches!(file_log(root, path, 10), Err(HistoryError::Path(_))),
                "{path:?}"
            );
            assert!(
                matches!(show(root, oid, path), Err(HistoryError::Path(_))),
                "{path:?}"
            );
        }
    }

    #[test]
    fn anything_but_a_hexadecimal_commit_id_is_refused_before_git_runs() {
        let directory = repository("history-oids");
        let root = directory.path();
        for oid in [
            "not-an-oid",
            "HEAD",
            "main",
            "abc123",
            "--output=/tmp/x",
            "-p",
            "0123456789abcdef..HEAD",
            "0123456789ABCDEF",
            "0123456789abcdef^{tree}",
            "",
        ] {
            assert_eq!(
                show(root, oid, "notes/a.md"),
                Err(HistoryError::NotACommitId),
                "{oid:?}"
            );
        }
        assert_eq!(HistoryError::NotACommitId.to_string(), "Not a commit id.");
    }

    #[test]
    fn a_commit_or_path_git_does_not_have_is_an_error_not_empty_text() {
        let directory = repository("history-missing");
        let root = directory.path();
        let head = run_git(root, &["rev-parse", "HEAD"]);
        assert!(matches!(
            show(
                root,
                "0123456789abcdef0123456789abcdef01234567",
                "notes/a.md"
            ),
            Err(HistoryError::Git(_))
        ));
        assert!(matches!(
            show(root, &head, "notes/missing.md"),
            Err(HistoryError::Git(_))
        ));
        // A directory is not a version of a file.
        assert!(matches!(
            show(root, &head, "notes"),
            Err(HistoryError::Git(_))
        ));
    }

    #[test]
    fn a_version_that_is_not_text_is_refused() {
        let directory = repository("history-binary");
        let root = directory.path();
        std::fs::write(root.join("notes/a.md"), [0xff, 0xfe, 0x00, 0x80]).unwrap();
        run_git(
            root,
            &["commit", "--quiet", "--all", "--message", "Make it binary"],
        );
        let head = run_git(root, &["rev-parse", "HEAD"]);
        assert_eq!(show(root, &head, "notes/a.md"), Err(HistoryError::NotText));
    }

    #[test]
    fn a_folder_with_no_repository_or_no_commits_has_no_history() {
        let directory = temp("history-empty");
        let root = directory.path();
        assert_eq!(file_log(root, "notes/a.md", 10).unwrap(), []);
        run_git(root, &["init", "--quiet", "--initial-branch=main"]);
        assert_eq!(file_log(root, "notes/a.md", 10).unwrap(), []);
    }

    #[test]
    fn a_root_without_a_repository_never_reads_one_above_it() {
        let directory = repository("history-ceiling");
        let inner = directory.path().join("notes");
        // `notes` is inside a repository but is not one; as a root it has no history.
        assert_eq!(file_log(&inner, "a.md", 10).unwrap(), []);
        let head = run_git(directory.path(), &["rev-parse", "HEAD"]);
        assert!(matches!(
            show(&inner, &head, "a.md"),
            Err(HistoryError::Git(_))
        ));
    }

    #[test]
    fn a_corrupt_repository_is_a_failure_instead_of_empty_history() {
        let directory = repository("history-corrupt");
        let root = directory.path();
        let head = run_git(root, &["rev-parse", "HEAD"]);
        std::fs::remove_file(root.join(".git/objects").join(&head[..2]).join(&head[2..])).unwrap();
        assert!(matches!(
            file_log(root, "notes/a.md", 10),
            Err(HistoryError::Git(_))
        ));
    }

    #[test]
    fn an_existing_git_directory_with_no_head_is_corrupt_instead_of_absent() {
        let directory = repository("history-head-missing");
        let root = directory.path();
        std::fs::remove_file(root.join(".git/HEAD")).unwrap();
        assert!(matches!(
            file_log(root, "notes/a.md", 10),
            Err(HistoryError::Git(_))
        ));
    }

    #[test]
    fn inherited_repository_variables_are_removed_from_every_git_command() {
        let directory = temp("history-env");
        let command = git(directory.path());
        let changes: Vec<_> = command.get_envs().collect();
        for name in REPOSITORY_ENV {
            assert!(
                changes
                    .iter()
                    .any(|(key, value)| *key == name && value.is_none()),
                "{name} is not removed"
            );
        }
        assert_eq!(command.get_current_dir(), Some(directory.path()));
    }
}
