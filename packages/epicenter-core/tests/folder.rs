//! Turning sync on for a folder without a `git` program: open or make its
//! repository, find it, record consent, and attach its origin.

mod common;

use common::*;
use epicenter_core::folder::{self, LFS_FILTER};
use epicenter_core::LAST_SEEN;
use git2::Repository;

#[test]
fn open_makes_a_repository_on_main_with_no_commit_and_says_what_it_wrote() {
    let world = World::new();
    let a = world.folder("a");
    write(&a, "notes/a.md", "---\ntitle: A\n---\n");
    let made = folder::open(&a).unwrap();
    assert!(made.initialized);
    assert_eq!(
        made.configured,
        LFS_FILTER.iter().map(|(key, _)| *key).collect::<Vec<_>>()
    );
    assert!(made.repo.head().is_err(), "no commit before the first sync");
    assert_eq!(
        made.repo.find_reference("HEAD").unwrap().symbolic_target(),
        Some("refs/heads/main")
    );
    let again = folder::open(&a).unwrap();
    assert!(!again.initialized);
    assert!(again.configured.is_empty());
}

#[test]
fn open_refuses_a_branch_other_than_main_and_writes_nothing() {
    let world = World::new();
    let a = world.folder("a");
    let repo = Repository::init(&a).unwrap();
    repo.set_head("refs/heads/feature").unwrap();
    let refused = folder::open(&a).err().expect("refused");
    assert!(refused.message.contains("syncs only main"), "{}", refused.message);
    assert!(refused.message.contains("git checkout main"));
    let config = repo.config().unwrap().open_level(git2::ConfigLevel::Local).unwrap();
    assert!(config.get_entry("filter.lfs.process").is_err());
}

#[test]
fn locate_finds_the_enclosing_working_tree_and_its_consent() {
    let world = World::new();
    let a = world.folder("a");
    write(&a, "notes/deep/a.md", "x");
    assert!(folder::locate(&a).unwrap().is_none());
    folder::open(&a).unwrap();
    let found = folder::locate(&a.join("notes/deep")).unwrap().unwrap();
    assert_eq!(found.root, std::fs::canonicalize(&a).unwrap());
    assert!(!found.synced);
    assert_eq!(found.origin, None);

    assert!(folder::set_synced(&a, true).unwrap());
    assert!(!folder::set_synced(&a, true).unwrap());
    assert!(folder::locate(&a).unwrap().unwrap().synced);
    assert!(folder::set_synced(&a, false).unwrap());
    assert!(!folder::set_synced(&a, false).unwrap());
    assert!(!folder::locate(&a).unwrap().unwrap().synced);
}

#[test]
fn locate_does_not_report_a_bare_repository() {
    let world = World::new();
    assert!(folder::locate(&world.remote_path()).unwrap().is_none());
}

#[test]
fn connect_adds_origin_once_and_refuses_another() {
    let world = World::new();
    let a = world.folder("a");
    write(&a, "notes/a.md", "---\ntitle: A\n---\n");
    folder::open(&a).unwrap();
    let url = world.remote().url;
    let repo = Repository::open(&a).unwrap();
    let head = repo.refname_to_id("HEAD").ok();
    assert!(head.is_none());

    assert!(folder::connect(&a, &url).unwrap());
    assert!(!folder::connect(&a, &url).unwrap());
    assert_eq!(folder::locate(&a).unwrap().unwrap().origin, Some(url.clone()));
    let other = folder::connect(&a, "file:///elsewhere.git").err().expect("refused");
    assert!(other.message.contains(&format!("origin is already {url}")));

    // A push URL elsewhere is refused, and so is a round.
    repo.config()
        .unwrap()
        .set_str("remote.origin.pushurl", "file:///elsewhere.git")
        .unwrap();
    assert!(folder::connect(&a, &url).is_err());
    let round = world.sync(&a, "A");
    assert_eq!(round.status, epicenter_core::Status::Stopped);
    assert!(round.message.unwrap().contains("different URL"));
}

#[test]
fn a_new_origin_forgets_the_last_main_seen() {
    let world = World::new();
    let a = world.folder("a");
    write(&a, "notes/a.md", "---\ntitle: A\n---\n");
    world.synced(&a, "A");
    let repo = Repository::open(&a).unwrap();
    assert!(repo.refname_to_id(LAST_SEEN).is_ok());
    repo.remote_delete("origin").unwrap();
    assert!(folder::connect(&a, "file:///another.git").unwrap());
    assert!(repo.refname_to_id(LAST_SEEN).is_err());
}
