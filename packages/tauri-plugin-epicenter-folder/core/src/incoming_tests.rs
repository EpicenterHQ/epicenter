//! An incoming update that stops partway, and its explicit recovery
//! (ADR-0474).
//!
//! Each test makes upstream history with plain Git, fetches it into a folder
//! the owner holds, and starts a fast-forward. A test hook stops the update
//! at a named boundary, the way a process that stopped there would leave it:
//! nothing after it runs and nothing is cleaned up. The test then opens the
//! folder again, as a new process would, and looks at what it reports and
//! what an explicit recovery does. No test claims to model power loss: the
//! boundaries are the update's own steps.
//!
//! Key behaviors:
//! - Stopped before or after its record, any file, the index, the branch, or
//!   the record's removal, an update is reported on opening, never resumed,
//!   and recovered only when asked: completed, cleared, or left alone.
//! - A recovery writes only paths still at their before state and reports
//!   only what it wrote; matching bytes are no receipt.
//! - The pinned target survives a tracking ref that moved and a garbage
//!   collection.
//! - Third bytes, an empty file where a nonempty one is added, a foreign
//!   index entry, a moved branch, a held index or ref lock, and an unreadable
//!   record or index each stop recovery, keep the record, and say why.
//! - With the branch already at the target, recovery clears the record and
//!   leaves later edits alone.
//! - Files become directories and directories files. Directories the before
//!   tree held, emptied now or by an earlier attempt, are removed where a
//!   file must go; any other file or directory there stops the update.
//! - A recovery publishes no clean observation of files it did not look at:
//!   status is observed again, and edits made while pending remain.
//! - A published update whose record cannot be removed is reported, and the
//!   record stays pending until a recovery clears it.
//! - While an update is pending, saves and fetches continue; commits,
//!   automatic commits, staging, and new updates are refused.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::git::Remote;
use crate::history::{
    CommitOutcome, Observation, PendingIncoming, PullError, PullOutcome, RecoverOutcome,
};
use crate::owner::{FolderConfig, FolderOwner};
use crate::testing::{config, eventually, git, overwrite, TempDir};

/// The update most tests make: one file edited, one removed, one added.
const BEFORE: [(&str, &str); 3] = [
    ("edit.md", "before edit"),
    ("gone.md", "to be removed"),
    ("keep.md", "kept"),
];

/// A folder that has fast-forwarded to upstream's first commit, and the plain
/// Git clone where upstream commits are made.
struct Scene {
    _temp: TempDir,
    bare: PathBuf,
    upstream: PathBuf,
    root: PathBuf,
    owner: Option<FolderOwner>,
}

fn put(directory: &Path, path: &str, content: &str) {
    let file = directory.join(path);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(file, content).unwrap();
}

fn open_local(root: &Path, bare: &Path) -> FolderOwner {
    FolderOwner::open(FolderConfig {
        remote: Some(Remote {
            url: bare.display().to_string(),
            branch: "main".to_string(),
        }),
        ..config(root)
    })
    .unwrap()
}

/// Upstream commits `files`; the folder fetches it and, if `pulled`, takes it.
fn scene(label: &str, files: &[(&str, &str)], pulled: bool) -> Scene {
    let temp = TempDir::new(label);
    let bare = temp.folder("remote.git");
    git(
        &bare,
        &["init", "--quiet", "--bare", "--initial-branch=main"],
    );
    let upstream = temp.folder("upstream");
    git(&upstream, &["init", "--quiet", "--initial-branch=main"]);
    git(
        &upstream,
        &["remote", "add", "origin", &bare.display().to_string()],
    );
    for (path, content) in files {
        put(&upstream, path, content);
    }
    git(&upstream, &["add", "--all"]);
    git(&upstream, &["commit", "--quiet", "-m", "first"]);
    git(&upstream, &["push", "--quiet", "origin", "main"]);
    let root = temp.folder("local");
    let owner = open_local(&root, &bare);
    owner.fetch(None).unwrap();
    if pulled {
        assert!(matches!(
            owner.pull_fast_forward(),
            Ok(PullOutcome::FastForwarded { .. })
        ));
    }
    Scene {
        _temp: temp,
        bare,
        upstream,
        root,
        owner: Some(owner),
    }
}

impl Scene {
    fn owner(&self) -> &FolderOwner {
        self.owner.as_ref().unwrap()
    }

    /// Change upstream, commit, push, and fetch it. The fetched commit.
    fn upstream_commit(&self, change: impl FnOnce(&Path)) -> String {
        change(&self.upstream);
        git(&self.upstream, &["add", "--all"]);
        git(&self.upstream, &["commit", "--quiet", "-m", "next"]);
        git(&self.upstream, &["push", "--quiet", "origin", "main"]);
        self.owner().fetch(None).unwrap().oid.unwrap()
    }

    /// The standard update: edit, remove, add.
    fn standard_update(&self) -> String {
        self.upstream_commit(|upstream| {
            put(upstream, "edit.md", "after edit");
            std::fs::remove_file(upstream.join("gone.md")).unwrap();
            put(upstream, "new.md", "new");
        })
    }

    /// Stop the next incoming update the first time it reaches `boundary`.
    fn stop_at(&self, boundary: &'static str) {
        let once = AtomicBool::new(true);
        self.owner().hooks().incoming_boundary = Some(Arc::new(move |name: &str| {
            name == boundary && once.swap(false, Ordering::SeqCst)
        }));
    }

    /// A fast-forward that stops at `boundary`.
    fn pull_stopped_at(&self, boundary: &'static str) {
        self.stop_at(boundary);
        let stopped = self.owner().pull_fast_forward().unwrap_err();
        assert!(
            matches!(&stopped, PullError::Unconfirmed { uncertain, .. } if uncertain == &vec![boundary.to_string()]),
            "{stopped:?}"
        );
    }

    /// Open the folder again, as a new process would.
    fn reopen(&mut self) {
        self.owner.take().unwrap().shutdown();
        self.owner = Some(open_local(&self.root, &self.bare));
    }

    fn read(&self, path: &str) -> Option<String> {
        std::fs::read_to_string(self.root.join(path)).ok()
    }

    fn head(&self) -> String {
        git(&self.root, &["rev-parse", "HEAD"])
    }

    fn pins(&self) -> String {
        git(
            &self.root,
            &["for-each-ref", "--format=%(refname)", "refs/epicenter"],
        )
    }

    fn record(&self) -> bool {
        self.root.join(".git/epicenter/incoming.json").exists()
    }

    /// The folder holds exactly `target`'s files, index, and branch, and no
    /// record or pin.
    fn finished_at(&self, target: &str) {
        assert_eq!(self.head(), target);
        assert_eq!(git(&self.root, &["status", "--porcelain"]), "");
        assert!(!self.record());
        assert_eq!(self.pins(), "");
        assert_eq!(self.owner().snapshot().pending_incoming, None);
    }
}

fn recorded(pending: Option<PendingIncoming>) -> (Option<String>, String) {
    match pending {
        Some(PendingIncoming::Recorded {
            expected_head,
            next_head,
            branch,
            ..
        }) => {
            assert_eq!(branch, "main");
            (expected_head, next_head)
        }
        other => panic!("a recorded update, not {other:?}"),
    }
}

fn changed(outcome: Result<RecoverOutcome, PullError>) -> Vec<String> {
    match outcome {
        Ok(RecoverOutcome::Completed { changed_paths, .. }) => changed_paths,
        other => panic!("a completed recovery, not {other:?}"),
    }
}

fn refused(outcome: Result<RecoverOutcome, PullError>) -> (Vec<String>, String) {
    match outcome {
        Err(PullError::RecoveryRefused { paths, reason, .. }) => (paths, reason),
        other => panic!("a refused recovery, not {other:?}"),
    }
}

// ============================================================================
// Every boundary
// ============================================================================

#[test]
fn an_update_stopped_at_any_boundary_is_reported_on_opening_and_finished_only_when_asked() {
    let all = || ["edit.md", "gone.md", "new.md"].map(String::from).to_vec();
    // Removals come before writes; each `file:` boundary is reached just
    // before that path is written, which is just after the one before it.
    let cases: [(&'static str, Option<Vec<String>>); 7] = [
        ("recorded", Some(all())),
        ("file:gone.md", Some(all())),
        (
            "file:edit.md",
            Some(vec!["edit.md".into(), "new.md".into()]),
        ),
        ("file:new.md", Some(vec!["new.md".into()])),
        // Every file already holds its after bytes: none is written again.
        ("index", Some(Vec::new())),
        ("branch", Some(Vec::new())),
        // The branch already names the target: the record is cleared.
        ("clear", None),
    ];
    for (boundary, expected) in cases {
        let mut scene = scene(
            &format!("boundary-{}", boundary.replace(':', "-")),
            &BEFORE,
            true,
        );
        let from = scene.head();
        let to = scene.standard_update();
        scene.pull_stopped_at(boundary);

        // Opening again reports the update and resumes nothing.
        scene.reopen();
        let (expected_head, next_head) =
            recorded(scene.owner().snapshot().pending_incoming.clone());
        assert_eq!(
            (expected_head, next_head.clone()),
            (Some(from.clone()), to.clone()),
            "{boundary}"
        );
        assert_eq!(
            scene.owner().status().unwrap().head.as_deref(),
            Some(if boundary == "clear" {
                to.as_str()
            } else {
                from.as_str()
            }),
            "{boundary}"
        );
        assert!(scene.record(), "{boundary}");
        assert!(scene.pins().contains("/after"), "{boundary}");

        let outcome = scene.owner().recover_incoming();
        match expected {
            Some(paths) => assert_eq!(changed(outcome), paths, "{boundary}"),
            None => assert!(
                matches!(outcome, Ok(RecoverOutcome::Cleared { .. })),
                "{boundary}: {outcome:?}"
            ),
        }
        scene.finished_at(&to);
        assert_eq!(scene.read("edit.md").as_deref(), Some("after edit"));
        assert_eq!(scene.read("gone.md"), None);
        assert_eq!(scene.read("new.md").as_deref(), Some("new"));
        assert_eq!(scene.read("keep.md").as_deref(), Some("kept"));
        // Nothing is pending: a second recovery has nothing to do.
        assert_eq!(scene.owner().recover_incoming(), Ok(RecoverOutcome::None));
    }
}

#[test]
fn an_update_stopped_before_its_record_left_nothing_and_one_stopped_after_clearing_left_only_pins()
{
    let mut scene = scene("before-record", &BEFORE, true);
    let from = scene.head();
    let to = scene.standard_update();
    scene.pull_stopped_at("record");
    scene.reopen();
    assert_eq!(scene.owner().snapshot().pending_incoming, None);
    assert_eq!(scene.head(), from);
    assert_eq!(scene.read("edit.md").as_deref(), Some("before edit"));
    assert_eq!(scene.pins(), "");
    assert_eq!(scene.owner().recover_incoming(), Ok(RecoverOutcome::None));

    // Stopped between removing its record and releasing its pins: nothing
    // is pending, and the pins are pruned by the next update.
    scene.stop_at("unpin");
    assert!(matches!(
        scene.owner().pull_fast_forward(),
        Ok(PullOutcome::FastForwarded { .. })
    ));
    scene.reopen();
    assert_eq!(scene.owner().snapshot().pending_incoming, None);
    assert_eq!(scene.head(), to);
    assert!(!scene.pins().is_empty());
    assert_eq!(scene.owner().recover_incoming(), Ok(RecoverOutcome::None));
    let next = scene.upstream_commit(|upstream| put(upstream, "later.md", "later"));
    assert!(matches!(
        scene.owner().pull_fast_forward(),
        Ok(PullOutcome::FastForwarded { .. })
    ));
    scene.finished_at(&next);
}

// ============================================================================
// The target
// ============================================================================

#[test]
fn the_pinned_target_survives_a_moved_tracking_ref_and_a_garbage_collection() {
    let mut scene = scene("retained-target", &BEFORE, true);
    let from = scene.head();
    let to = scene.standard_update();
    scene.pull_stopped_at("file:edit.md");
    scene.reopen();

    // Upstream rewrites its history; the fetch moves the tracking ref away
    // from the update's target, and a collection runs.
    git(&scene.upstream, &["reset", "--quiet", "--hard", &from]);
    put(&scene.upstream, "other.md", "a different future");
    git(&scene.upstream, &["add", "--all"]);
    git(&scene.upstream, &["commit", "--quiet", "-m", "rewritten"]);
    git(
        &scene.upstream,
        &["push", "--quiet", "--force", "origin", "main"],
    );
    let moved = scene.owner().fetch(None).unwrap().oid.unwrap();
    assert_ne!(moved, to);
    git(&scene.root, &["reflog", "expire", "--expire=now", "--all"]);
    git(&scene.root, &["gc", "--quiet", "--prune=now"]);

    assert_eq!(
        changed(scene.owner().recover_incoming()),
        vec!["edit.md".to_string(), "new.md".to_string()]
    );
    scene.finished_at(&to);
    assert_eq!(scene.read("other.md"), None);
}

#[test]
fn an_update_into_an_empty_history_records_no_before_commit_and_recovers() {
    let mut scene = scene("empty-history", &[("a.md", "A"), ("dir/b.md", "B")], false);
    let to = git(&scene.root, &["rev-parse", "refs/remotes/origin/main"]);
    scene.pull_stopped_at("file:dir/b.md");
    scene.reopen();
    let (expected_head, next_head) = recorded(scene.owner().snapshot().pending_incoming.clone());
    assert_eq!((expected_head, next_head), (None, to.clone()));
    assert!(!scene.pins().contains("/before"));
    // A commit now would record a tree that is neither empty nor the target.
    assert!(matches!(
        scene.owner().commit(),
        CommitOutcome::Blocked { .. }
    ));
    assert_eq!(
        changed(scene.owner().recover_incoming()),
        vec!["dir/b.md".to_string()]
    );
    scene.finished_at(&to);
    assert_eq!(scene.read("a.md").as_deref(), Some("A"));
}

// ============================================================================
// Refusals
// ============================================================================

#[test]
fn a_path_in_neither_state_stops_recovery_and_keeps_the_record_until_it_is_resolved() {
    let mut scene = scene("third-bytes", &BEFORE, true);
    let to = scene.standard_update();
    scene.pull_stopped_at("file:edit.md");
    scene.reopen();

    // Another program writes bytes that are neither before nor after.
    std::fs::write(scene.root.join("edit.md"), "a third version").unwrap();
    let (paths, reason) = refused(scene.owner().recover_incoming());
    assert_eq!(paths, vec!["edit.md".to_string()]);
    assert!(reason.contains("neither state"), "{reason}");
    assert!(scene.record());
    assert_eq!(scene.read("edit.md").as_deref(), Some("a third version"));
    assert_eq!(scene.read("new.md"), None, "nothing was written");

    // Once the path holds one of its states again, recovery finishes.
    std::fs::write(scene.root.join("edit.md"), "before edit").unwrap();
    assert_eq!(
        changed(scene.owner().recover_incoming()),
        vec!["edit.md".to_string(), "new.md".to_string()]
    );
    scene.finished_at(&to);
}

#[test]
fn an_empty_file_where_the_update_adds_one_is_a_third_state_not_absence() {
    let mut scene = scene("empty-third", &BEFORE, true);
    scene.standard_update();
    scene.pull_stopped_at("file:new.md");
    scene.reopen();
    std::fs::write(scene.root.join("new.md"), "").unwrap();
    let (paths, _) = refused(scene.owner().recover_incoming());
    assert_eq!(paths, vec!["new.md".to_string()]);
    assert_eq!(scene.read("new.md").as_deref(), Some(""));
    assert!(scene.record());
}

#[test]
fn a_foreign_index_entry_a_moved_branch_and_held_locks_stop_recovery_and_keep_the_record() {
    let mut scene = scene("competing", &BEFORE, true);
    let from = scene.head();
    let to = scene.standard_update();
    scene.pull_stopped_at("file:edit.md");
    scene.reopen();

    // Staged by another Git process: a change the update does not make.
    std::fs::write(scene.root.join("keep.md"), "staged elsewhere").unwrap();
    git(&scene.root, &["add", "keep.md"]);
    let (paths, reason) = refused(scene.owner().recover_incoming());
    assert_eq!(paths, vec!["keep.md".to_string()]);
    assert!(reason.contains("staged"), "{reason}");
    git(&scene.root, &["reset", "--quiet", "--", "keep.md"]);
    std::fs::write(scene.root.join("keep.md"), "kept").unwrap();

    // The branch moved by another Git process: neither commit.
    let elsewhere = git(
        &scene.root,
        &[
            "commit-tree",
            "-p",
            &from,
            "-m",
            "elsewhere",
            &format!("{from}^{{tree}}"),
        ],
    );
    git(&scene.root, &["update-ref", "refs/heads/main", &elsewhere]);
    let (_, reason) = refused(scene.owner().recover_incoming());
    assert!(
        reason.contains("neither the update's before nor its after"),
        "{reason}"
    );
    assert!(scene.record());
    git(&scene.root, &["update-ref", "refs/heads/main", &from]);

    // The index is locked when it is to be written: the files are done, the
    // index is not, and the record stays.
    std::fs::write(scene.root.join(".git/index.lock"), "").unwrap();
    let held = scene.owner().recover_incoming();
    assert!(
        matches!(held, Err(PullError::IndexFailed { .. })),
        "{held:?}"
    );
    assert!(scene.record());
    assert_eq!(scene.head(), from, "the branch did not move");
    std::fs::remove_file(scene.root.join(".git/index.lock")).unwrap();

    // The branch is locked when it is to move: its outcome is not claimed.
    std::fs::write(scene.root.join(".git/refs/heads/main.lock"), "").unwrap();
    let held = scene.owner().recover_incoming();
    assert!(
        matches!(&held, Err(PullError::Unconfirmed { uncertain, .. }) if uncertain == &vec![".git/refs/heads/main".to_string()]),
        "{held:?}"
    );
    assert!(scene.record());
    std::fs::remove_file(scene.root.join(".git/refs/heads/main.lock")).unwrap();

    // Each competing change resolved, recovery finishes with nothing left
    // to write.
    assert_eq!(
        changed(scene.owner().recover_incoming()),
        Vec::<String>::new()
    );
    scene.finished_at(&to);
}

#[test]
fn an_unreadable_record_or_index_is_refused_by_name_and_kept() {
    let mut scene = scene("unreadable", &BEFORE, true);
    scene.standard_update();
    scene.pull_stopped_at("file:edit.md");
    scene.reopen();

    let index = scene.root.join(".git/index");
    let saved = std::fs::read(&index).unwrap();
    std::fs::write(&index, "not an index").unwrap();
    let (paths, reason) = refused(scene.owner().recover_incoming());
    assert_eq!(paths, vec![".git/index".to_string()]);
    assert!(reason.starts_with("the index cannot be read"), "{reason}");
    std::fs::write(&index, saved).unwrap();

    let record = scene.root.join(".git/epicenter/incoming.json");
    std::fs::write(&record, "{\"operationId\":\"x\"}").unwrap();
    scene.reopen();
    let reason = "the incoming record has no branch".to_string();
    assert_eq!(
        scene.owner().snapshot().pending_incoming,
        Some(PendingIncoming::Unreadable {
            reason: reason.clone()
        })
    );
    assert_eq!(
        scene.owner().recover_incoming(),
        Err(PullError::RecoveryRefused {
            pending: PendingIncoming::Unreadable {
                reason: reason.clone()
            },
            paths: Vec::new(),
            reason,
        })
    );
    assert!(record.exists(), "an unreadable record is never removed");
    assert!(matches!(
        scene.owner().commit(),
        CommitOutcome::Blocked { .. }
    ));
}

// ============================================================================
// Clearing
// ============================================================================

#[test]
fn a_branch_already_at_the_target_clears_the_record_and_keeps_later_edits() {
    let mut scene = scene("later-edits", &BEFORE, true);
    let to = scene.standard_update();
    scene.pull_stopped_at("clear");
    scene.reopen();
    // Saves continue while the update is pending; this one edits a path the
    // update changed.
    scene
        .owner()
        .apply(&[overwrite("edit.md", "edited after the update")])
        .unwrap();
    assert!(matches!(
        scene.owner().recover_incoming(),
        Ok(RecoverOutcome::Cleared { .. })
    ));
    assert_eq!(scene.head(), to);
    assert_eq!(
        scene.read("edit.md").as_deref(),
        Some("edited after the update"),
        "files are not replayed over later edits"
    );
    assert!(!scene.record());
    assert_eq!(scene.pins(), "");
}

// ============================================================================
// Files and directories
// ============================================================================

#[test]
fn files_become_directories_and_directories_files() {
    let files = [
        ("shape", "a file"),
        ("box/inner.md", "inside"),
        ("box/deep/x.md", "x"),
    ];
    for stop in [None, Some("file:box"), Some("file:shape/inside.md")] {
        let label = format!(
            "transitions-{}",
            stop.unwrap_or("whole").replace([':', '/'], "-")
        );
        let mut scene = scene(&label, &files, true);
        let to = scene.upstream_commit(|upstream| {
            std::fs::remove_file(upstream.join("shape")).unwrap();
            put(upstream, "shape/inside.md", "now a directory");
            std::fs::remove_dir_all(upstream.join("box")).unwrap();
            put(upstream, "box", "now a file");
        });
        match stop {
            None => assert!(matches!(
                scene.owner().pull_fast_forward(),
                Ok(PullOutcome::FastForwarded { .. })
            )),
            Some(boundary) => {
                scene.pull_stopped_at(boundary);
                scene.reopen();
                changed(scene.owner().recover_incoming());
            }
        }
        scene.finished_at(&to);
        assert_eq!(scene.read("box").as_deref(), Some("now a file"));
        assert_eq!(
            scene.read("shape/inside.md").as_deref(),
            Some("now a directory")
        );
    }
}

/// Two nested Git directories that the update replaces with one file.
const NESTED: [(&str, &str); 3] = [
    ("box/a/x.md", "x"),
    ("box/b/y.md", "y"),
    ("keep.md", "kept"),
];

fn nested_to_file(scene: &Scene) -> String {
    scene.upstream_commit(|upstream| {
        std::fs::remove_dir_all(upstream.join("box")).unwrap();
        put(upstream, "box", "now a file");
    })
}

#[test]
fn directories_an_earlier_attempt_emptied_are_still_the_updates_to_remove() {
    // Before the first removal, after it, after both, and after the
    // directories went: each resumes, and `box/a`, left empty by an earlier
    // attempt, is Git's because the before tree held a file in it.
    for boundary in [
        "file:box/a/x.md",
        "file:box/b/y.md",
        "prune:box",
        "file:box",
    ] {
        let label = format!("emptied-{}", boundary.replace([':', '/'], "-"));
        let mut scene = scene(&label, &NESTED, true);
        let to = nested_to_file(&scene);
        scene.pull_stopped_at(boundary);
        scene.reopen();
        let written = changed(scene.owner().recover_incoming());
        assert!(
            written.contains(&"box".to_string()),
            "{boundary}: {written:?}"
        );
        scene.finished_at(&to);
        assert_eq!(
            scene.read("box").as_deref(),
            Some("now a file"),
            "{boundary}"
        );
        assert_eq!(scene.read("keep.md").as_deref(), Some("kept"), "{boundary}");
    }
}

#[test]
fn anything_else_in_a_directory_the_update_must_remove_stops_it_before_it_writes() {
    let mut scene = scene("emptied-foreign", &NESTED, true);
    let to = nested_to_file(&scene);
    scene.pull_stopped_at("file:box/b/y.md");
    scene.reopen();

    // An empty directory no tree names, then a file no tree names, inside
    // directories the update would remove.
    for (foreign, is_file) in [("box/c", false), ("box/a/stray.md", true)] {
        let at = scene.root.join(foreign);
        if is_file {
            std::fs::write(&at, "stray").unwrap();
        } else {
            std::fs::create_dir(&at).unwrap();
        }
        let (paths, reason) = refused(scene.owner().recover_incoming());
        assert_eq!(paths, vec!["box".to_string()], "{foreign}");
        assert!(reason.contains(foreign), "{reason}");
        assert!(scene.record());
        assert_eq!(
            scene.read("box/b/y.md").as_deref(),
            Some("y"),
            "nothing was written"
        );
        assert!(at.exists(), "nothing of someone else's is removed");
        if is_file {
            std::fs::remove_file(&at).unwrap();
        } else {
            std::fs::remove_dir(&at).unwrap();
        }
    }
    assert_eq!(
        changed(scene.owner().recover_incoming()),
        vec!["box".to_string(), "box/b/y.md".to_string()]
    );
    scene.finished_at(&to);
}

#[test]
fn something_in_the_way_of_a_write_is_named_and_nothing_is_written() {
    let scene = scene("in-the-way", &BEFORE, true);
    let from = scene.head();
    scene.upstream_commit(|upstream| put(upstream, "folder/new.md", "new"));
    // An ignored file where the update needs a directory.
    std::fs::write(scene.root.join(".git/info/exclude"), "folder\n").unwrap();
    std::fs::write(scene.root.join("folder"), "ignored, in the way").unwrap();
    let outcome = scene.owner().pull_fast_forward();
    assert!(
        matches!(&outcome, Err(PullError::Collision { paths }) if paths == &vec!["folder/new.md".to_string()]),
        "{outcome:?}"
    );
    assert_eq!(scene.head(), from);
    assert!(!scene.record());
    assert_eq!(scene.pins(), "");
    assert_eq!(scene.read("folder").as_deref(), Some("ignored, in the way"));
}

// ============================================================================
// While pending
// ============================================================================

#[test]
fn while_an_update_is_pending_saves_and_fetches_continue_and_history_waits() {
    let mut scene = scene("pending-work", &BEFORE, true);
    let to = scene.standard_update();
    scene.pull_stopped_at("file:edit.md");

    // Automatic history: a save lands and its commit attempt is refused.
    scene.reopen();
    scene
        .owner()
        .apply(&[overwrite("unrelated.md", "saved while pending")])
        .unwrap();
    eventually("the automatic attempt to settle", || {
        !scene.owner().snapshot().activity.commit.active
    });
    assert_eq!(
        scene.read("unrelated.md").as_deref(),
        Some("saved while pending")
    );
    let blocked = scene.owner().commit();
    assert!(
        matches!(&blocked, CommitOutcome::Blocked { reason } if reason.contains("recover it before committing")),
        "{blocked:?}"
    );
    assert!(matches!(
        scene
            .owner()
            .snapshot()
            .last_commit
            .as_ref()
            .map(|attempt| &attempt.result),
        Some(CommitOutcome::Blocked { .. })
    ));

    // A new update waits; a fetch does not, and does not move the target.
    assert!(matches!(
        scene.owner().pull_fast_forward(),
        Err(PullError::IncomingPending { .. })
    ));
    let later = scene.upstream_commit(|upstream| put(upstream, "later.md", "later"));
    let (_, next_head) = recorded(scene.owner().snapshot().pending_incoming.clone());
    assert_eq!(next_head, to);
    assert_ne!(later, to);

    changed(scene.owner().recover_incoming());
    assert_eq!(scene.head(), to);
    assert!(!scene.record());
    assert_eq!(scene.pins(), "");
    // The unrelated save is still there, uncommitted, for the next commit.
    assert_eq!(
        git(&scene.root, &["status", "--porcelain"]),
        "?? unrelated.md"
    );
}

#[test]
fn a_recovery_observes_status_again_and_keeps_edits_made_while_pending() {
    // Stopped with every file written (recovery writes none), and with one
    // left to write.
    for (boundary, writes) in [("index", false), ("file:new.md", true)] {
        let label = format!("observe-{}", boundary.replace([':', '/'], "-"));
        let mut scene = scene(&label, &BEFORE, true);
        let to = scene.standard_update();
        scene.pull_stopped_at(boundary);
        scene.reopen();
        scene
            .owner()
            .apply(&[overwrite("unrelated.md", "edited while pending")])
            .unwrap();
        let dirty = scene.owner().status().unwrap();
        assert!(dirty
            .changes
            .iter()
            .any(|change| change.path == "unrelated.md"));

        let written = changed(scene.owner().recover_incoming());
        assert_eq!(!written.is_empty(), writes, "{boundary}: {written:?}");
        // Recovery looked only at the update's paths. It publishes no clean
        // observation of the whole folder.
        let after_recovery = scene.owner().snapshot();
        if let Observation::Observed { value, stale, .. } = &after_recovery.files {
            assert!(
                *stale
                    || value
                        .changes
                        .iter()
                        .any(|change| change.path == "unrelated.md"),
                "{boundary}: {value:?}"
            );
        }
        // The status that follows sees the edit, on the update's commit.
        eventually("a fresh status after recovery", || {
            let snapshot = scene.owner().snapshot();
            !snapshot.activity.scan.active
                && matches!(&snapshot.files, Observation::Observed { stale: false, .. })
        });
        let snapshot = scene.owner().snapshot();
        let Observation::Observed { value, .. } = &snapshot.files else {
            panic!("the files are observed again");
        };
        assert_eq!(value.head.as_deref(), Some(to.as_str()), "{boundary}");
        assert!(
            value
                .changes
                .iter()
                .any(|change| change.path == "unrelated.md"),
            "{boundary}: {value:?}"
        );
        assert_eq!(
            scene.read("unrelated.md").as_deref(),
            Some("edited while pending")
        );
        assert_eq!(scene.head(), to);
        assert!(!scene.record());
    }
}

#[cfg(unix)]
#[test]
fn a_published_update_whose_record_cannot_be_removed_is_reported_and_stays_pending() {
    use std::os::unix::fs::PermissionsExt;

    let mut scene = scene("clear-fails", &BEFORE, true);
    let to = scene.standard_update();
    // The record's directory refuses removals when the update is about to
    // clear it.
    let records = scene.root.join(".git/epicenter");
    std::fs::create_dir_all(&records).unwrap();
    let probe = records.join("permission-probe");
    std::fs::write(&probe, b"probe").unwrap();
    std::fs::set_permissions(&records, std::fs::Permissions::from_mode(0o555)).unwrap();
    let refuses_removal = std::fs::remove_file(&probe).is_err();
    std::fs::set_permissions(&records, std::fs::Permissions::from_mode(0o755)).unwrap();
    let _ = std::fs::remove_file(&probe);
    if !refuses_removal {
        eprintln!("permission-fault case skipped: this process can remove files from a read-only directory");
        return;
    }
    let locked = records.clone();
    scene.owner().hooks().incoming_boundary = Some(Arc::new(move |name: &str| {
        if name == "clear" {
            std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).unwrap();
        }
        false
    }));

    // The branch moved, so the fast-forward is reported. Its record is still
    // there, pinned, and reported; commits wait for it.
    let outcome = scene.owner().pull_fast_forward();
    let still_pending = scene.owner().snapshot().pending_incoming.clone();
    let committed = scene.owner().commit();
    std::fs::set_permissions(&records, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(
        matches!(&outcome, Ok(PullOutcome::FastForwarded { to: moved, .. }) if *moved == to),
        "{outcome:?}"
    );
    assert_eq!(scene.head(), to);
    assert!(scene.record());
    assert!(scene.pins().contains("/after"));
    assert_eq!(recorded(still_pending).1, to);
    assert!(
        matches!(committed, CommitOutcome::Blocked { .. }),
        "{committed:?}"
    );

    // A recovery finds the branch at the target and clears it, writing nothing.
    scene.reopen();
    assert!(matches!(
        scene.owner().recover_incoming(),
        Ok(RecoverOutcome::Cleared { .. })
    ));
    scene.finished_at(&to);
}
