//! The core's output read by stock `git` and `git-lfs` (ADR-0751: a round
//! that leaves `git status` dirty or fails `git fsck` is a bug), with only
//! the configuration the core writes: no `-c` settings, no global config.

mod common;

use std::path::Path;
use std::process::Command;
use std::time::{Duration, SystemTime};

use common::*;
use epicenter_core::LFS_FILTER;

fn installed(program: &str) -> bool {
    let found = Command::new(program).arg("version").output().is_ok();
    if !found {
        eprintln!("{program} is not installed; skipping");
    }
    found
}

fn git(folder: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(folder)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap()
}

fn seed(world: &World, name: &str) -> std::path::PathBuf {
    let folder = world.folder(name);
    write(&folder, ".gitattributes", ATTRIBUTES);
    write(&folder, "notes/one.md", "---\ntitle: One\n---\nbody\n");
    write(&folder, "photos/cat.png", b"\x89PNG\r\n\x1a\n a cat");
    folder
}

#[test]
fn stock_git_sees_a_clean_folder_after_a_round() {
    if !installed("git") || !installed("git-lfs") {
        return;
    }
    let world = World::new();
    let a = seed(&world, "a");
    world.synced(&a, "A");
    let b = world.folder("b");
    write(&b, "notes/only-b.md", "from b\n");
    world.synced(&b, "B");
    world.synced(&a, "A");
    for folder in [&a, &b] {
        assert_eq!(
            git(folder, &["status", "--porcelain"]),
            "",
            "{}",
            folder.display()
        );
        git(folder, &["fsck", "--no-progress"]);
        assert_eq!(
            git(folder, &["rev-parse", "HEAD"]).trim(),
            git(folder, &["rev-parse", "origin/main"]).trim()
        );
    }
}

#[test]
fn stock_git_cleans_an_lfs_file_it_rechecks() {
    if !installed("git") || !installed("git-lfs") {
        return;
    }
    let world = World::new();
    let a = seed(&world, "a");
    world.synced(&a, "A");
    // A new mtime with the same bytes: Git must re-read the file, and
    // only the LFS clean filter turns its bytes back into the pointer
    // committed. Without the settings Git hashes the raw bytes and reports
    // the file modified.
    let photo = std::fs::File::options()
        .write(true)
        .open(a.join("photos/cat.png"))
        .unwrap();
    photo
        .set_modified(SystemTime::now() + Duration::from_secs(5))
        .unwrap();
    assert_eq!(git(&a, &["status", "--porcelain"]), "");
}

#[test]
fn the_lfs_settings_name_the_command_and_no_path() {
    let world = World::new();
    let a = world.folder("a");
    epicenter_core::open_or_init(&a).unwrap();
    let config = git2::Config::open(&a.join(".git/config")).unwrap();
    for (key, value) in LFS_FILTER {
        assert_eq!(config.get_string(key).unwrap(), value);
        assert!(!value.contains('/'), "{key} = {value}");
    }
}

#[test]
fn a_setting_a_person_chose_stays() {
    let world = World::new();
    let a = world.folder("a");
    let repo = git2::Repository::init(&a).unwrap();
    repo.config()
        .unwrap()
        .set_str("filter.lfs.process", "my-lfs filter-process")
        .unwrap();
    epicenter_core::open_or_init(&a).unwrap();
    let config = git2::Config::open(&a.join(".git/config")).unwrap();
    assert_eq!(
        config.get_string("filter.lfs.process").unwrap(),
        "my-lfs filter-process"
    );
    assert_eq!(
        config.get_string("filter.lfs.clean").unwrap(),
        "git-lfs clean -- %f"
    );
}
