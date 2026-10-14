//! Disposable folders and a plain `git` for tests.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Once;
use std::time::Duration;

use crate::files::FileChange;
use crate::git::Author;
use crate::owner::{FolderConfig, FolderOwner};

static NEXT: AtomicU64 = AtomicU64::new(0);
static ENVIRONMENT: Once = Once::new();

/// This machine's Git configuration must not change outcomes.
fn isolate_git() {
    ENVIRONMENT.call_once(|| {
        std::env::set_var("GIT_CONFIG_GLOBAL", "/dev/null");
        std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");
    });
}

pub struct TempDir(PathBuf);

impl TempDir {
    pub fn new(label: &str) -> Self {
        isolate_git();
        let path = std::env::temp_dir().join(format!(
            "epicenter-folder-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("create a temporary directory");
        Self(std::fs::canonicalize(&path).expect("canonical temporary directory"))
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    /// A new empty directory inside this one.
    pub fn folder(&self, name: &str) -> PathBuf {
        let path = self.0.join(name);
        std::fs::create_dir_all(&path).expect("create a folder");
        path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub fn author() -> Author {
    Author {
        name: "Test Author".to_string(),
        email: "test@example.com".to_string(),
    }
}

/// A configuration with event watching and the periodic comparison off, so
/// tests decide when the owner looks for outside changes.
pub fn config(root: &Path) -> FolderConfig {
    FolderConfig {
        watch_events: false,
        watch_interval: None,
        ..FolderConfig::new(root, author())
    }
}

pub fn open(root: &Path) -> FolderOwner {
    FolderOwner::open(config(root)).expect("open the folder")
}

/// Run plain `git` in `root`, as another program would.
pub fn git(root: &Path, args: &[&str]) -> String {
    isolate_git();
    let output = Command::new("git")
        .args(args)
        .current_dir(root)
        .env("GIT_AUTHOR_NAME", "Outside")
        .env("GIT_AUTHOR_EMAIL", "outside@example.com")
        .env("GIT_COMMITTER_NAME", "Outside")
        .env("GIT_COMMITTER_EMAIL", "outside@example.com")
        .output()
        .expect("run git");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

/// Make the next `git commit-tree` run in `root` first move `main` to
/// `target`, as another program acting between a commit's pinned parent and
/// its compare-and-swap would.
///
/// Every `git` this test process starts afterwards, the owner's included,
/// runs through a wrapper first on `PATH`. The wrapper only acts in a
/// repository holding the marker, removes it, and otherwise hands each
/// command to the real `git` unchanged.
#[cfg(unix)]
pub fn move_branch_before_commit_tree(root: &Path, target: &str) {
    use std::os::unix::fs::PermissionsExt;

    static INTERCEPT: Once = Once::new();
    /// Its presence in a repository's `.git` asks the wrapper to act there.
    const MOVE_MARKER: &str = "epicenter-test-move-branch";

    INTERCEPT.call_once(|| {
        let path = std::env::var_os("PATH").unwrap_or_default();
        let real = std::env::split_paths(&path)
            .map(|directory| directory.join("git"))
            .find(|candidate| candidate.is_file())
            .expect("git on PATH");
        let directory =
            std::env::temp_dir().join(format!("epicenter-folder-git-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("create the git wrapper directory");
        let real = real.display();
        let script = format!(
            "#!/bin/sh\n\
             case \" $* \" in\n\
             *\" commit-tree \"*)\n\
             \tif [ -f .git/{MOVE_MARKER} ]; then\n\
             \t\ttarget=$(cat .git/{MOVE_MARKER})\n\
             \t\trm -f .git/{MOVE_MARKER}\n\
             \t\t'{real}' update-ref refs/heads/main \"$target\" || exit 1\n\
             \tfi;;\n\
             esac\n\
             exec '{real}' \"$@\"\n"
        );
        let wrapper = directory.join("git");
        let executable = std::fs::Permissions::from_mode(0o755);
        std::fs::write(&wrapper, script).expect("write the git wrapper");
        std::fs::set_permissions(&wrapper, executable).expect("make the git wrapper executable");
        let mut paths = vec![directory];
        paths.extend(std::env::split_paths(&path));
        let joined = std::env::join_paths(paths).expect("a joinable PATH");
        std::env::set_var("PATH", joined);
    });
    std::fs::write(root.join(".git").join(MOVE_MARKER), target).expect("write the move marker");
}

pub fn create(path: &str, content: &str) -> FileChange {
    FileChange::Create {
        path: path.to_string(),
        bytes: content.as_bytes().to_vec(),
    }
}

pub fn overwrite(path: &str, content: &str) -> FileChange {
    FileChange::Overwrite {
        path: path.to_string(),
        bytes: content.as_bytes().to_vec(),
    }
}

/// A replacement conditional on the hash a read returned.
pub fn replace(path: &str, content: &str, expected_sha256: &str) -> FileChange {
    FileChange::Replace {
        path: path.to_string(),
        bytes: content.as_bytes().to_vec(),
        expected_sha256: Some(expected_sha256.to_string()),
    }
}

/// A replacement of whatever file is at the path; it never creates one.
pub fn replace_existing(path: &str, content: &str) -> FileChange {
    FileChange::Replace {
        path: path.to_string(),
        bytes: content.as_bytes().to_vec(),
        expected_sha256: None,
    }
}

/// Wait for a condition another thread brings about.
pub fn eventually(what: &str, condition: impl Fn() -> bool) {
    for _ in 0..2000 {
        if condition() {
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    panic!("timed out waiting for {what}");
}

/// Every file below `root`, with its bytes, for before-and-after comparisons.
pub fn tree(root: &Path) -> Vec<(String, Vec<u8>)> {
    let mut files = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(&directory)
            .expect("read a directory")
            .flatten()
        {
            let kind = entry.file_type().expect("file type");
            if kind.is_dir() {
                pending.push(entry.path());
            } else if kind.is_file() {
                let relative = entry
                    .path()
                    .strip_prefix(root)
                    .unwrap()
                    .display()
                    .to_string();
                files.push((relative, std::fs::read(entry.path()).expect("read a file")));
            }
        }
    }
    files.sort();
    files
}
