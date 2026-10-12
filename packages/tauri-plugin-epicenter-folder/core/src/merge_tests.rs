//! Merging incoming history in the native owner.
//!
//! Each test makes upstream history with plain Git, fetches it into a folder
//! the owner holds, and merges. The repository is checked with plain Git as
//! another program would see it: files, the index, every ref, the merge
//! state files, and commit parents.
//!
//! Key behaviors:
//! - A clean divergence records one commit with the original local head and
//!   the pinned fetched head as parents; root `kv.json` merges by key.
//! - A conflict writes no file, index entry, ref, or merge state. Asked for
//!   `versions`, the refusal carries each conflicted file's exact committed
//!   bytes on both sides, once per path and none for a shape conflict, while
//!   the snapshot records the conflicts without bytes.
//! - Histories with no common commit are refused, writing nothing, unless the
//!   caller consents to unrelated histories; the merge then keeps both roots
//!   as its parents. Several merge bases are refused even with consent.
//! - A merge a person's own Git began, or the unmerged stages it left, blocks
//!   whole-folder commits, staged commits, and incoming updates, which write
//!   nothing.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::files::FileChange;
use crate::git::Remote;
use crate::history::{
    CommitOutcome, ConflictVersion, DeletedBy, GitError, MergeConflict, MergeError, MergeOutcome,
    MergePolicy, PullError, PullOutcome,
};
use crate::owner::{FolderConfig, FolderOwner};
use crate::testing::{config, git, overwrite, TempDir};

/// Only one merge base and no bytes: the default.
const REFUSE: MergePolicy = MergePolicy {
    allow_unrelated_histories: false,
    versions: false,
};

struct Scene {
    _temp: TempDir,
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

/// Upstream commits `base`; the folder fast-forwards to it.
fn scene(label: &str, base: &[(&str, &str)]) -> Scene {
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
    for (path, content) in base {
        put(&upstream, path, content);
    }
    git(&upstream, &["add", "--all"]);
    git(&upstream, &["commit", "--quiet", "-m", "base"]);
    git(&upstream, &["push", "--quiet", "origin", "main"]);
    let root = temp.folder("local");
    let owner = open_local(&root, &bare);
    owner.fetch(None).unwrap();
    assert!(matches!(
        owner.pull_fast_forward(),
        Ok(PullOutcome::FastForwarded { .. })
    ));
    Scene {
        _temp: temp,
        upstream,
        root,
        owner: Some(owner),
    }
}

impl Scene {
    fn owner(&self) -> &FolderOwner {
        self.owner.as_ref().unwrap()
    }

    /// Upstream changes, commits, and pushes; the folder fetches it.
    fn theirs(&self, change: impl FnOnce(&Path)) -> String {
        change(&self.upstream);
        git(&self.upstream, &["add", "--all"]);
        git(&self.upstream, &["commit", "--quiet", "-m", "theirs"]);
        git(&self.upstream, &["push", "--quiet", "origin", "main"]);
        self.owner().fetch(None).unwrap().oid.unwrap()
    }

    /// The folder saves `files` and commits them as its own history.
    fn ours(&self, files: &[(&str, &str)]) -> String {
        let changes: Vec<_> = files
            .iter()
            .map(|(path, content)| overwrite(path, content))
            .collect();
        self.owner().apply(&changes).unwrap();
        match self.owner().commit() {
            CommitOutcome::Committed { oid, .. } => oid,
            other => panic!("expected a commit, got {other:?}"),
        }
    }

    fn read(&self, path: &str) -> String {
        std::fs::read_to_string(self.root.join(path)).unwrap()
    }

    fn git(&self, args: &[&str]) -> String {
        git(&self.root, args)
    }

    fn head(&self) -> String {
        self.git(&["rev-parse", "main"])
    }

    fn parents(&self, commit: &str) -> String {
        self.git(&["log", "-1", "--format=%P", commit])
    }

    /// Everything a refused merge must leave: files, the index's bytes, every
    /// ref, and the merge state.
    #[allow(clippy::type_complexity)]
    fn untouched(
        &self,
    ) -> (
        Vec<(String, Vec<u8>)>,
        Vec<u8>,
        String,
        Vec<Option<Vec<u8>>>,
    ) {
        let files = crate::testing::tree(&self.root)
            .into_iter()
            .filter(|(path, _)| !path.starts_with(".git/"))
            .collect();
        (
            files,
            std::fs::read(self.root.join(".git/index")).unwrap(),
            self.git(&["show-ref"]),
            ["MERGE_HEAD", "MERGE_MSG", "ORIG_HEAD"]
                .iter()
                .map(|name| std::fs::read(self.root.join(".git").join(name)).ok())
                .collect(),
        )
    }

    /// The person's own Git merges the fetched head and stops on its
    /// conflict, as `git merge` does.
    fn merge_outside(&self) {
        let output = Command::new("git")
            .args(["merge", "--no-edit", "origin/main"])
            .current_dir(&self.root)
            .env("GIT_AUTHOR_NAME", "Outside")
            .env("GIT_AUTHOR_EMAIL", "outside@example.com")
            .env("GIT_COMMITTER_NAME", "Outside")
            .env("GIT_COMMITTER_EMAIL", "outside@example.com")
            .output()
            .unwrap();
        assert_eq!(
            output.status.code(),
            Some(1),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

/// The remote's history and the folder's own first commit share no commit.
/// Returns the folder's root commit and the fetched one, also a root.
fn unrelated(
    label: &str,
    ours: &[(&str, &str)],
    theirs: &[(&str, &str)],
) -> (Scene, String, String) {
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
    for (path, content) in theirs {
        put(&upstream, path, content);
    }
    git(&upstream, &["add", "--all"]);
    git(&upstream, &["commit", "--quiet", "-m", "their root"]);
    git(&upstream, &["push", "--quiet", "origin", "main"]);
    let root = temp.folder("local");
    let scene = Scene {
        _temp: temp,
        owner: Some(open_local(&root, &bare)),
        upstream,
        root,
    };
    let ours = scene.ours(ours);
    let theirs = scene.owner().fetch(None).unwrap().oid.unwrap();
    (scene, ours, theirs)
}

fn red_green(label: &str) -> (Scene, String, String, String) {
    let scene = scene(
        label,
        &[("notes/color.txt", "blue\n"), ("keep.md", "keep\n")],
    );
    let base = scene.head();
    let theirs = scene.theirs(|upstream| {
        put(upstream, "notes/color.txt", "green\n");
        put(upstream, "theirs.md", "theirs\n");
    });
    let ours = scene.ours(&[("notes/color.txt", "red\n"), ("ours.md", "ours\n")]);
    (scene, base, ours, theirs)
}

#[test]
fn a_clean_divergence_records_both_original_parents_and_merges_kv_by_key() {
    let scene = scene(
        "merge-clean",
        &[
            ("kv.json", "{\"theme\":\"light\",\"lang\":\"en\"}"),
            ("notes.md", "one\ntwo\nthree\nfour\nfive\n"),
        ],
    );
    let theirs = scene.theirs(|upstream| {
        put(
            upstream,
            "kv.json",
            "{ \"lang\": \"zh\", \"theme\": \"light\" }",
        );
        put(upstream, "notes.md", "one\ntwo\nthree\nfour\nFIVE\n");
    });
    let ours = scene.ours(&[
        ("kv.json", "{\"theme\":\"dark\",\"lang\":\"en\"}"),
        ("notes.md", "ONE\ntwo\nthree\nfour\nfive\n"),
    ]);

    let merged = scene.owner().merge_incoming(REFUSE).unwrap();

    let MergeOutcome::Merged {
        from,
        to,
        fetched,
        changed_paths,
    } = merged
    else {
        panic!("expected a merge, got {merged:?}");
    };
    assert_eq!(
        (from.as_str(), fetched.as_str()),
        (ours.as_str(), theirs.as_str())
    );
    assert_eq!(changed_paths, vec!["kv.json", "notes.md"]);
    assert_eq!(scene.head(), to);
    assert_eq!(scene.parents(&to), format!("{ours} {theirs}"));
    assert_eq!(
        scene.read("kv.json"),
        "{\n  \"lang\": \"zh\",\n  \"theme\": \"dark\"\n}\n"
    );
    assert_eq!(scene.read("notes.md"), "ONE\ntwo\nthree\nfour\nFIVE\n");
    assert_eq!(scene.git(&["status", "--porcelain"]), "");
    let snapshot = scene.owner().snapshot();
    assert!(snapshot.pending_incoming.is_none());
    assert!(matches!(
        snapshot.last_merge.as_ref().map(|attempt| &attempt.result),
        Some(crate::history::Settled::Ok {
            value: MergeOutcome::Merged { .. }
        })
    ));
}

#[test]
fn by_default_a_conflict_writes_no_file_index_entry_or_ref() {
    let (scene, _, ours, _) = red_green("merge-refuse");
    let before = scene.untouched();

    let refused = scene.owner().merge_incoming(REFUSE).unwrap_err();

    assert_eq!(
        refused,
        MergeError::Conflicted {
            conflicts: vec![MergeConflict::Content {
                path: "notes/color.txt".to_string()
            }],
            versions: None,
        }
    );
    assert_eq!(scene.untouched(), before);
    assert_eq!(scene.head(), ours);
}

#[test]
fn a_merge_begun_with_git_outside_epicenter_blocks_history_work_and_writes_nothing() {
    const BLOCKED: &str =
        "a Git merge is in progress; finish or abort it with Git outside Epicenter";
    let (scene, _, ours, _) = red_green("merge-outside");
    scene.merge_outside();
    assert!(scene.root.join(".git/MERGE_HEAD").exists());

    // First with `MERGE_HEAD`, then with only the unmerged stages the merge
    // leaves once `MERGE_HEAD` goes.
    for stages_only in [false, true] {
        if stages_only {
            std::fs::remove_file(scene.root.join(".git/MERGE_HEAD")).unwrap();
        }
        let before = scene.untouched();
        let blocked = |reason: &str| {
            reason.starts_with(BLOCKED) && (!stages_only || reason.contains("notes/color.txt"))
        };

        assert!(matches!(
            scene.owner().commit(),
            CommitOutcome::Blocked { reason } if blocked(&reason)
        ));
        assert!(matches!(
            scene.owner().commit_staged("Commit over it"),
            Err(GitError::Failed { cause, .. }) if blocked(&cause)
        ));
        assert!(matches!(
            scene.owner().pull_fast_forward(),
            Err(PullError::Blocked { reason }) if blocked(&reason)
        ));
        assert!(matches!(
            scene.owner().merge_incoming(REFUSE),
            Err(MergeError::Pull {
                error: PullError::Blocked { reason }
            }) if blocked(&reason)
        ));

        assert_eq!(scene.untouched(), before);
        assert_eq!(scene.head(), ours);
        assert_eq!(scene.git(&["ls-files", "-u"]).lines().count(), 3);
    }
}

#[test]
fn unrelated_histories_need_consent_and_then_keep_both_roots() {
    let (scene, ours, theirs) = unrelated(
        "merge-unrelated",
        &[("ours.md", "ours\n"), ("kv.json", "{\"theme\":\"dark\"}")],
        &[("theirs.md", "theirs\n"), ("kv.json", "{\"lang\":\"zh\"}")],
    );
    let before = scene.untouched();

    // Without consent nothing is written, whatever else the policy asks.
    for policy in [
        REFUSE,
        MergePolicy {
            versions: true,
            ..REFUSE
        },
    ] {
        assert_eq!(
            scene.owner().merge_incoming(policy),
            Err(MergeError::UnsupportedHistory {
                head: ours.clone(),
                fetched: theirs.clone(),
                bases: 0,
            }),
            "{policy:?}"
        );
        assert_eq!(scene.untouched(), before);
    }

    let merged = scene
        .owner()
        .merge_incoming(MergePolicy {
            allow_unrelated_histories: true,
            ..REFUSE
        })
        .unwrap();

    let MergeOutcome::Merged {
        from, to, fetched, ..
    } = merged
    else {
        panic!("expected a merge, got {merged:?}");
    };
    assert_eq!(
        (from.as_str(), fetched.as_str()),
        (ours.as_str(), theirs.as_str())
    );
    assert_eq!(scene.head(), to);
    assert_eq!(scene.parents(&to), format!("{ours} {theirs}"));
    // Both roots stay in the branch's history.
    let mut roots: Vec<String> = scene
        .git(&["rev-list", "--max-parents=0", &to])
        .lines()
        .map(str::to_string)
        .collect();
    roots.sort();
    let mut expected = vec![ours, theirs];
    expected.sort();
    assert_eq!(roots, expected);
    assert_eq!(scene.read("ours.md"), "ours\n");
    assert_eq!(scene.read("theirs.md"), "theirs\n");
    // Root kv.json merges by key against no base.
    assert_eq!(
        scene.read("kv.json"),
        "{\n  \"lang\": \"zh\",\n  \"theme\": \"dark\"\n}\n"
    );
    assert_eq!(scene.git(&["status", "--porcelain"]), "");
}

#[test]
fn several_merge_bases_are_refused_even_with_consent_to_unrelated_histories() {
    let scene = scene("merge-criss-cross", &[("a.md", "a\n")]);
    scene.theirs(|upstream| put(upstream, "b.md", "b\n"));
    let ours = scene.ours(&[("c.md", "c\n")]);
    // The folder merges theirs, and upstream merges ours on its own: each
    // side has a merge the other lacks, so both original commits are bases.
    let local = match scene.owner().merge_incoming(REFUSE).unwrap() {
        MergeOutcome::Merged { to, .. } => to,
        other => panic!("expected a merge, got {other:?}"),
    };
    git(
        &scene.upstream,
        &[
            "fetch",
            "--quiet",
            &scene.root.display().to_string(),
            "main",
        ],
    );
    git(
        &scene.upstream,
        &["merge", "--quiet", "--no-ff", "--no-edit", &ours],
    );
    git(&scene.upstream, &["push", "--quiet", "origin", "main"]);
    let fetched = scene.owner().fetch(None).unwrap().oid.unwrap();
    let before = scene.untouched();

    for policy in [
        REFUSE,
        MergePolicy {
            allow_unrelated_histories: true,
            ..REFUSE
        },
    ] {
        assert_eq!(
            scene.owner().merge_incoming(policy),
            Err(MergeError::UnsupportedHistory {
                head: local.clone(),
                fetched: fetched.clone(),
                bases: 2,
            }),
            "{policy:?}"
        );
        assert_eq!(scene.untouched(), before);
    }
}

#[test]
fn a_refused_conflict_carries_each_files_committed_bytes_and_writes_nothing() {
    const OURS_BIN: &[u8] = &[0, 255, 1, 2, b'\r'];
    const THEIRS_BIN: &[u8] = &[0, 254, 9];
    const OURS_KV: &str = "{\"a\":2,\"b\":2}";
    const THEIRS_KV: &str = "{\"a\":3,\"b\":3}";
    let scene = scene(
        "merge-versions",
        &[
            ("bin.dat", "start\n"),
            ("gone.md", "keep me\n"),
            ("kv.json", "{\"a\":1,\"b\":1}"),
        ],
    );
    let theirs = scene.theirs(|upstream| {
        std::fs::write(upstream.join("bin.dat"), THEIRS_BIN).unwrap();
        put(upstream, "gone.md", "changed\n");
        put(upstream, "kv.json", THEIRS_KV);
        put(upstream, "shape/inner.md", "inner\n");
    });
    scene
        .owner()
        .apply(&[
            FileChange::Overwrite {
                path: "bin.dat".to_string(),
                bytes: OURS_BIN.to_vec(),
            },
            FileChange::Remove {
                path: "gone.md".to_string(),
                expected_sha256: None,
            },
            overwrite("kv.json", OURS_KV),
            overwrite("shape", "a file\n"),
        ])
        .unwrap();
    let ours = match scene.owner().commit() {
        CommitOutcome::Committed { oid, .. } => oid,
        other => panic!("expected a commit, got {other:?}"),
    };
    let before = scene.untouched();
    let key = |key: &str, base: &str, ours: &str, theirs: &str| MergeConflict::KvKey {
        path: "kv.json".to_string(),
        key: key.to_string(),
        base: Some(base.to_string()),
        ours: Some(ours.to_string()),
        theirs: Some(theirs.to_string()),
    };
    let conflicts = vec![
        MergeConflict::Binary {
            path: "bin.dat".to_string(),
        },
        MergeConflict::Deleted {
            path: "gone.md".to_string(),
            deleted_by: DeletedBy::Ours,
        },
        key("a", "1", "2", "3"),
        key("b", "1", "2", "3"),
        MergeConflict::Shape {
            path: "shape".to_string(),
        },
    ];

    let refused = scene
        .owner()
        .merge_incoming(MergePolicy {
            versions: true,
            ..REFUSE
        })
        .unwrap_err();

    // One version per conflicted path, kv.json once for its two keys, the
    // exact committed bytes of each side, and nothing for the shape conflict.
    assert_eq!(
        refused,
        MergeError::Conflicted {
            conflicts: conflicts.clone(),
            versions: Some(vec![
                ConflictVersion {
                    path: "bin.dat".to_string(),
                    ours: Some(OURS_BIN.to_vec()),
                    theirs: Some(THEIRS_BIN.to_vec()),
                },
                ConflictVersion {
                    path: "gone.md".to_string(),
                    ours: None,
                    theirs: Some(b"changed\n".to_vec()),
                },
                ConflictVersion {
                    path: "kv.json".to_string(),
                    ours: Some(OURS_KV.as_bytes().to_vec()),
                    theirs: Some(THEIRS_KV.as_bytes().to_vec()),
                },
            ]),
        }
    );
    assert_eq!(scene.untouched(), before);
    assert_eq!(scene.head(), ours);
    assert_eq!(
        scene.git(&["rev-parse", "refs/remotes/origin/main"]),
        theirs
    );
    // The snapshot every window receives names the conflicts, not the bytes.
    assert_eq!(
        scene
            .owner()
            .snapshot()
            .last_merge
            .as_ref()
            .map(|attempt| &attempt.result),
        Some(&crate::history::Settled::Err {
            error: MergeError::Conflicted {
                conflicts: conflicts.clone(),
                versions: None,
            }
        })
    );
    // Without `versions`, the same refusal carries none.
    assert_eq!(
        scene.owner().merge_incoming(REFUSE),
        Err(MergeError::Conflicted {
            conflicts,
            versions: None,
        })
    );
    assert_eq!(scene.untouched(), before);
}
