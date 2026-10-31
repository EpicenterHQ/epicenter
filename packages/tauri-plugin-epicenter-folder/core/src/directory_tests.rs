//! Canonical directories, and saves through one.
//! Validation preserves existing files and accepts linked parents.

use std::path::Path;

use crate::directory::{Directory, DirectoryError};
use crate::storage::{self, PutOutcome};
use crate::testing::TempDir;

#[test]
fn a_fixed_default_is_created_and_a_chosen_directory_must_exist() {
    let temp = TempDir::new("bind-missing");
    let default = temp.path().join("absent").join("Todos");
    let made = Directory::create(&default).unwrap();
    assert!(default.is_dir());
    assert_eq!(made.root(), default.canonicalize().unwrap());
    assert!(
        std::fs::read_dir(&default).unwrap().next().is_none(),
        "creating initializes nothing; the page engine does"
    );

    let chosen = temp.path().join("gone").join("vault");
    assert_eq!(
        Directory::existing(&chosen).err(),
        Some(DirectoryError::Missing {
            path: chosen.clone()
        })
    );
    assert!(!temp.path().join("gone").exists(), "nothing was created");

    let file = temp.path().join("notes.md");
    std::fs::write(&file, "").unwrap();
    assert!(matches!(
        Directory::existing(&file),
        Err(DirectoryError::Unavailable { .. })
    ));
}

#[cfg(unix)]
#[test]
fn a_directory_that_is_a_link_is_refused_and_a_linked_parent_is_not() {
    let temp = TempDir::new("bind-linked-root");
    let elsewhere = temp.folder("elsewhere");
    let leaf = temp.path().join("leaf");
    std::os::unix::fs::symlink(&elsewhere, &leaf).unwrap();
    for open in [Directory::existing, Directory::create] {
        assert!(matches!(
            open(&leaf),
            Err(DirectoryError::Unavailable { .. })
        ));
    }
    assert!(std::fs::read_dir(&elsewhere).unwrap().next().is_none());

    // The root's parent may be a link a person chose.
    let real = temp.folder("real");
    let alias = temp.path().join("alias");
    std::os::unix::fs::symlink(&real, &alias).unwrap();
    let directory = Directory::create(&alias.join("notes")).unwrap();
    assert!(real.join("notes").is_dir());
    assert_eq!(directory.root(), real.join("notes").canonicalize().unwrap());
}

/// Save through an independently resolved directory, as an admitted writer does.
fn save(root: &Path) -> Result<PutOutcome, storage::StorageError> {
    let directory = Directory::existing(root).unwrap();
    storage::put(
        directory.root(),
        "todos/a.md",
        Some(b"milk"),
        &storage::Expectation::Absent,
    )
    .map(|outcome| match outcome {
        PutOutcome::Landed { .. } => PutOutcome::Landed { stamp: None },
        stale => stale,
    })
}

/// The names directly in `directory`, sorted.
fn names(directory: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

/// A plain directory with no `.git` is opened and saved to, and the save
/// makes nothing in it but the file and `.epicenter` (its empty scratch
/// directory), no `.git`, and nothing beside it.
#[test]
fn a_directory_with_no_git_is_opened_and_saved_to() {
    let temp = TempDir::new("bind-no-git");
    let root = temp.folder("notes");
    assert_eq!(save(&root), Ok(PutOutcome::Landed { stamp: None }));
    assert_eq!(std::fs::read(root.join("todos/a.md")).unwrap(), b"milk");
    assert_eq!(names(&root), [".epicenter", "todos"]);
    assert_eq!(names(&root.join(".epicenter")), ["scratch"]);
    assert_eq!(names(temp.path()), ["notes"]);
    assert!(names(&storage::scratch_directory(&root)).is_empty());
}

/// A linked worktree's or submodule's `.git` file, and a `.git` link, open
/// and save; each stays as it was, and nothing is written through it.
#[test]
fn a_git_file_or_link_is_opened_and_saved_to() {
    let temp = TempDir::new("bind-git-file");
    let worktree = temp.folder("worktree");
    let gitdir = "gitdir: /elsewhere/.git/worktrees/worktree\n";
    std::fs::write(worktree.join(".git"), gitdir).unwrap();
    assert_eq!(save(&worktree), Ok(PutOutcome::Landed { stamp: None }));
    assert_eq!(
        std::fs::read_to_string(worktree.join(".git")).unwrap(),
        gitdir
    );
    assert_eq!(names(&worktree), [".epicenter", ".git", "todos"]);
    #[cfg(unix)]
    {
        let linked = temp.folder("linked");
        let repository = temp.folder("repository");
        std::os::unix::fs::symlink(&repository, linked.join(".git")).unwrap();
        assert_eq!(save(&linked), Ok(PutOutcome::Landed { stamp: None }));
        assert!(std::fs::symlink_metadata(linked.join(".git"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(names(&repository).is_empty());
    }
}

/// Git state that would send `hash-object -w` or `update-ref` elsewhere is
/// the `epicenter` CLI's to refuse before each history operation; the shell
/// runs no Git, so it binds the folder and saves without touching `.git`.
#[cfg(unix)]
#[test]
fn git_state_linked_elsewhere_does_not_block_opening_or_saving() {
    let temp = TempDir::new("bind-linked-state");
    let elsewhere = temp.folder("elsewhere");
    for planted in ["objects", "refs", "logs", "commondir", "epicenter"] {
        let root = temp.folder(&format!("notes-{planted}"));
        std::fs::create_dir_all(root.join(".git")).unwrap();
        let path = root.join(".git").join(planted);
        if planted == "commondir" {
            std::fs::write(&path, "../elsewhere\n").unwrap();
        } else {
            std::os::unix::fs::symlink(&elsewhere, &path).unwrap();
        }
        assert_eq!(
            save(&root),
            Ok(PutOutcome::Landed { stamp: None }),
            "{planted}"
        );
        assert_eq!(names(&root.join(".git")), [planted], "{planted}");
    }
    assert!(names(&elsewhere).is_empty());
}
