//! Test support: a stand-in for `settle`, folders, and a bare remote.

#![allow(dead_code)]

pub mod http;

use std::fs;
use std::path::{Path, PathBuf};

use epicenter_core::{
    sync_round, LfsEndpoint, NoteInput, NoteMerge, Options, Remote, Round, Status,
};
use git2::Repository;

/// `REPOSITORY_ATTRIBUTES` from `packages/definition/src/contract/storage.ts`.
pub const ATTRIBUTES: &str = "# BEGIN epicenter (managed by Epicenter; edit outside this block)
# Notes merge by Epicenter's rules; every other file except hidden paths is Git LFS.
* filter=lfs diff=lfs merge=lfs -text
*.[mM][dD] !filter !diff merge=epicenter text
.* !filter !diff !merge !text
.*/** !filter !diff !merge !text
**/.*/** !filter !diff !merge !text
# END epicenter
";

/// A stand-in for `settle`, small enough to read in a test: front matter
/// `key: value` lines merge by key (incoming, the later arrival, wins a key
/// both sides set); the body takes the side that changed it, or keeps
/// current's and appends one conflict block. Porting the real `settle` is a
/// later step.
pub struct StandIn;

fn split(text: &str) -> (Vec<(String, String)>, String) {
    if let Some(rest) = text.strip_prefix("---\n") {
        if let Some(end) = rest.find("\n---\n") {
            let keys = rest[..end]
                .lines()
                .filter_map(|l| {
                    l.split_once(": ")
                        .map(|(k, v)| (k.to_string(), v.to_string()))
                })
                .collect();
            return (keys, rest[end + 5..].to_string());
        }
    }
    (vec![], text.to_string())
}

impl NoteMerge for StandIn {
    fn settle(&self, n: &NoteInput) -> Result<String, String> {
        let (base_keys, base_body) = n.base.map(split).unwrap_or_default();
        let (cur_keys, cur_body) = split(n.current);
        let (inc_keys, inc_body) = split(n.incoming);
        let get = |keys: &[(String, String)], k: &str| {
            keys.iter().find(|(x, _)| x == k).map(|(_, v)| v.clone())
        };
        let mut keys = cur_keys.clone();
        for (k, v) in &inc_keys {
            if get(&base_keys, k).as_deref() == Some(v) {
                continue;
            }
            match keys.iter_mut().find(|(x, _)| x == k) {
                Some(slot) => slot.1 = v.clone(),
                None => keys.push((k.clone(), v.clone())),
            }
        }
        let body = if n.base.is_some() && inc_body == base_body {
            cur_body
        } else if n.base.is_some() && cur_body == base_body || cur_body == inc_body {
            inc_body
        } else {
            format!(
                "{cur_body}<<<<<<< {} {}\n{inc_body}>>>>>>> {} {}\n",
                n.current_party.author,
                n.current_party.time,
                n.incoming_party.author,
                n.incoming_party.time
            )
        };
        let header: String = keys.iter().map(|(k, v)| format!("{k}: {v}\n")).collect();
        Ok(if header.is_empty() {
            body
        } else {
            format!("---\n{header}---\n{body}")
        })
    }
}

pub struct World {
    pub dir: tempfile::TempDir,
}

impl World {
    pub fn new() -> World {
        let world = World {
            dir: tempfile::tempdir().unwrap(),
        };
        Repository::init_bare(world.remote_path()).unwrap();
        world
    }
    pub fn remote_path(&self) -> PathBuf {
        self.dir.path().join("remote.git")
    }
    pub fn lfs_store(&self) -> PathBuf {
        self.dir.path().join("lfs-store")
    }
    pub fn folder(&self, name: &str) -> PathBuf {
        let path = self.dir.path().join(name);
        fs::create_dir_all(&path).unwrap();
        path
    }
    pub fn remote(&self) -> Remote {
        Remote {
            url: format!("file://{}", self.remote_path().display()),
            token: None,
            lfs: Some(LfsEndpoint::Dir(self.lfs_store())),
        }
    }
    pub fn sync(&self, folder: &Path, machine: &str) -> Round {
        let round = sync_round(
            folder,
            &Options {
                remote: Some(self.remote()),
                machine: machine.into(),
                merge: &StandIn,
            },
        );
        eprintln!(
            "{machine}: {:?} {:?} {}",
            round.status,
            round.message,
            round.notes.join("; ")
        );
        round
    }
    pub fn synced(&self, folder: &Path, machine: &str) -> Round {
        let round = self.sync(folder, machine);
        assert_eq!(round.status, Status::Synced, "{:?}", round.message);
        round
    }
    pub fn remote_repo(&self) -> Repository {
        Repository::open_bare(self.remote_path()).unwrap()
    }
}

pub fn write(folder: &Path, path: &str, bytes: impl AsRef<[u8]>) {
    let full = folder.join(path);
    fs::create_dir_all(full.parent().unwrap()).unwrap();
    fs::write(full, bytes).unwrap();
}

pub fn read(folder: &Path, path: &str) -> String {
    fs::read_to_string(folder.join(path)).unwrap()
}

/// The blob at `path` on the remote's `main`.
pub fn remote_blob(world: &World, path: &str) -> Option<Vec<u8>> {
    let repo = world.remote_repo();
    let tree = repo
        .find_reference("refs/heads/main")
        .ok()?
        .peel_to_tree()
        .ok()?;
    let entry = tree.get_path(Path::new(path)).ok()?;
    let bytes = repo.find_blob(entry.id()).ok()?.content().to_vec();
    Some(bytes)
}
