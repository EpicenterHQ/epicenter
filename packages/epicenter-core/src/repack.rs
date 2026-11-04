//! Keeping a folder's object store small, which libgit2 cannot do: it has
//! no `gc` and no `repack`. Every round adds packs (one per fetch, one per
//! commit or merge it persists), and a person's own `git` adds loose
//! objects, so without this a folder's `.git/objects` grows a file per
//! round and every object lookup searches every pack.
//!
//! After a round, while it still holds the round lock, the core counts
//! loose objects and packs. Past a threshold it rolls the smallest packs and
//! every loose object into one new pack, geometrically, as
//! `git repack --geometric=2` does: it takes the smallest pack, then each
//! next pack holding fewer than twice the objects taken so far. A large old
//! pack is left alone, so a folder's history is not rewritten each time,
//! and the packs left form a progression whose length grows with the
//! logarithm of the object count.
//!
//! Nothing is deleted until the new pack is written, and only what the new
//! pack's index lists: an old pack only when every object it holds is in
//! the new one, and a loose object only when its id is. Unreachable
//! objects are kept (a person's stash or reflog may name them); pruning is
//! stock `git gc`'s job. Packs marked `.keep` or `.promisor` are left out.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use git2::{Oid, Repository};

use crate::Error;

/// More packs than this, outside `.keep`, starts a repack.
pub const PACK_LIMIT: usize = 8;
/// More loose objects than this starts a repack.
pub const LOOSE_LIMIT: usize = 256;

/// What a repack did.
#[derive(Debug, PartialEq, Eq)]
pub struct Repacked {
    /// Packs rolled into the new one.
    pub packs: usize,
    /// Loose objects moved into it.
    pub loose: usize,
}

struct Pack {
    /// The pack's path without its extension: `.../objects/pack/pack-<hash>`.
    stem: PathBuf,
    ids: Vec<Oid>,
}

/// Roll small packs and loose objects into one pack when they pass the
/// thresholds. Returns None when nothing needed doing.
pub fn repack(repo: &Repository) -> Result<Option<Repacked>, Error> {
    let objects = repo.path().join("objects");
    let pack_dir = objects.join("pack");
    let loose = loose_objects(&objects)?;
    let mut packs = packs(&pack_dir)?;
    if packs.len() <= PACK_LIMIT && loose.len() <= LOOSE_LIMIT {
        return Ok(None);
    }
    packs.sort_by_key(|p| p.ids.len());
    let counts: Vec<usize> = packs.iter().map(|p| p.ids.len()).collect();
    let rolled = &packs[..roll_up(&counts, loose.len())];
    if rolled.len() < 2 && loose.is_empty() {
        return Ok(None);
    }

    let mut builder = repo.packbuilder()?;
    for id in rolled.iter().flat_map(|p| &p.ids).chain(&loose) {
        builder.insert_object(*id, None)?;
    }
    builder.write(&pack_dir, 0o444)?;
    let name = builder
        .name()
        .ok_or_else(|| Error::retry("the new pack has no name".into()))?;
    let written = pack_dir.join(format!("pack-{name}"));
    let held: HashSet<Oid> = read_index(&written.with_extension("idx"))?
        .ok_or_else(|| Error::retry("the new pack's index is not version 2".into()))?
        .into_iter()
        .collect();

    let mut done = Repacked { packs: 0, loose: 0 };
    for pack in rolled {
        if pack.stem == written || !pack.ids.iter().all(|id| held.contains(id)) {
            continue;
        }
        remove_pack(&pack.stem);
        done.packs += 1;
    }
    if done.packs > 0 {
        // A multi-pack index a person's Git wrote may name a removed pack;
        // Git rebuilds it, and reads every pack without it meanwhile.
        let _ = fs::remove_file(pack_dir.join("multi-pack-index"));
    }
    for id in &loose {
        if held.contains(id) && fs::remove_file(loose_path(&objects, id)).is_ok() {
            done.loose += 1;
        }
    }
    Ok(Some(done))
}

/// How many of the smallest packs (`counts`, ascending object counts) to
/// roll up with `loose` objects: the smallest, then each next one holding
/// fewer than twice the objects taken so far.
fn roll_up(counts: &[usize], loose: usize) -> usize {
    let mut taken = loose;
    let mut take = 0;
    while take < counts.len() && (take == 0 || counts[take] < 2 * taken) {
        taken += counts[take];
        take += 1;
    }
    take
}

fn loose_path(objects: &Path, id: &Oid) -> PathBuf {
    let hex = id.to_string();
    objects.join(&hex[..2]).join(&hex[2..])
}

/// Every loose object's id.
fn loose_objects(objects: &Path) -> Result<Vec<Oid>, Error> {
    let mut out = Vec::new();
    for dir in fs::read_dir(objects)? {
        let dir = dir?;
        let prefix = dir.file_name().to_string_lossy().into_owned();
        if prefix.len() != 2 || !prefix.bytes().all(|b| b.is_ascii_hexdigit()) {
            continue;
        }
        for file in fs::read_dir(dir.path())? {
            let rest = file?.file_name().to_string_lossy().into_owned();
            // Temporary files a writer has not renamed yet are not objects.
            if rest.len() == 38 && rest.bytes().all(|b| b.is_ascii_hexdigit()) {
                if let Ok(id) = Oid::from_str(&format!("{prefix}{rest}")) {
                    out.push(id);
                }
            }
        }
    }
    Ok(out)
}

/// Every pack a repack may roll up, with the ids its index lists.
fn packs(pack_dir: &Path) -> Result<Vec<Pack>, Error> {
    let mut out = Vec::new();
    let entries = match fs::read_dir(pack_dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(e.into()),
    };
    for entry in entries {
        let path = entry?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("idx") {
            continue;
        }
        let stem = path.with_extension("");
        let kept = ["keep", "promisor"]
            .iter()
            .any(|ext| stem.with_extension(ext).exists());
        if kept || !stem.with_extension("pack").exists() {
            continue;
        }
        if let Some(ids) = read_index(&path)? {
            out.push(Pack { stem, ids });
        }
    }
    Ok(out)
}

/// The object ids a version 2 pack index lists (SHA-1), or None for any
/// other format, which a repack leaves alone.
fn read_index(path: &Path) -> Result<Option<Vec<Oid>>, Error> {
    let bytes = fs::read(path)?;
    const HEADER: usize = 8;
    const FANOUT: usize = 256 * 4;
    if bytes.len() < HEADER + FANOUT || bytes[..8] != [0xff, b't', b'O', b'c', 0, 0, 0, 2] {
        return Ok(None);
    }
    let last = HEADER + FANOUT - 4;
    let count = u32::from_be_bytes(bytes[last..last + 4].try_into().unwrap()) as usize;
    let start = HEADER + FANOUT;
    let Some(ids) = bytes.get(start..start + count * 20) else {
        return Ok(None);
    };
    ids.chunks(20)
        .map(|raw| Oid::from_bytes(raw).map_err(Error::from))
        .collect::<Result<_, _>>()
        .map(Some)
}

/// Remove a pack's index first, so no reader finds an index without its pack.
fn remove_pack(stem: &Path) {
    for ext in ["idx", "pack", "rev", "bitmap", "mtimes"] {
        let _ = fs::remove_file(stem.with_extension(ext));
    }
}

#[cfg(test)]
mod tests {
    use super::roll_up;

    #[test]
    fn a_large_old_pack_is_not_rolled_up_with_the_small_ones() {
        assert_eq!(roll_up(&[1, 1, 1, 2, 2, 3, 4, 5, 10_000], 0), 8);
    }

    #[test]
    fn packs_of_similar_size_roll_up_together() {
        assert_eq!(roll_up(&[10, 12, 15, 20], 0), 4);
    }

    #[test]
    fn loose_objects_count_toward_what_is_taken() {
        assert_eq!(roll_up(&[5, 400], 300), 2);
        assert_eq!(roll_up(&[5, 400], 0), 1);
    }
}
