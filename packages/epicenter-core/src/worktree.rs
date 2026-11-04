//! The working tree and the index, without Git's filters: libgit2 has no
//! LFS filter (and git2-rs exposes no filter registration), so this module
//! is the clean filter on the way in and the smudge filter on the way out.
//!
//! The index is used the way Git uses it: a stat cache. A file whose size,
//! mtime and inode match its index entry keeps the entry's blob without
//! being read, so an unchanged 10,000-item folder is one `stat` per file.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use git2::{AttrCheckFlags, AttrValue, Delta, Index, IndexEntry, IndexTime, Oid, Repository, Tree};

use crate::lfs::{self, Pointer};
use crate::{Error, STATE_DIRECTORY};

/// Whether `.gitattributes` gives `path` the LFS filter (`filter=lfs`).
pub fn stored_with_lfs(repo: &Repository, path: &str) -> Result<bool, Error> {
    let value = repo.get_attr(Path::new(path), "filter", AttrCheckFlags::FILE_THEN_INDEX)?;
    Ok(AttrValue::from_string(value) == AttrValue::String("lfs"))
}

/// Blobs by path relative to the root, with `/`, each with its file mode.
pub type Entries = HashMap<String, (Oid, u32)>;

/// The working tree as the index now holds it.
pub struct Snapshot {
    /// Every committed path and its blob (a pointer for an LFS file).
    pub entries: Entries,
    /// How many files were read and hashed (not served from the stat cache).
    pub hashed: usize,
}

/// Bring `index` up to the working tree: the clean step of `git add -A`,
/// minus `.git`, Epicenter's state directory, and ignored paths.
pub fn snapshot(repo: &Repository, index: &mut Index) -> Result<Snapshot, Error> {
    let root = repo
        .workdir()
        .ok_or_else(|| Error::stopped("the repository has no working tree".into()))?
        .to_path_buf();
    let git_dir = repo.path().to_path_buf();
    let mut files = Vec::new();
    walk(repo, &root, "", &mut files)?;
    let mut seen = HashSet::new();
    let mut entries = HashMap::new();
    let mut hashed = 0;
    for rel in files {
        let full = root.join(&rel);
        let meta = fs::symlink_metadata(&full)?;
        let cached = index
            .get_path(Path::new(&rel), 0)
            .filter(|e| stat_matches(e, &meta));
        let (id, mode) = match cached {
            Some(entry) => (entry.id, entry.mode),
            None => {
                hashed += 1;
                let bytes = fs::read(&full)?;
                let id = if stored_with_lfs(repo, &rel)? {
                    let pointer = lfs::store(&git_dir, &bytes)?;
                    repo.blob(pointer.text().as_bytes())?
                } else {
                    repo.blob(&bytes)?
                };
                let entry = entry_for(&rel, id, &meta);
                index.add(&entry)?;
                (id, entry.mode)
            }
        };
        entries.insert(rel.clone(), (id, mode));
        seen.insert(rel);
    }
    let gone: Vec<Vec<u8>> = index
        .iter()
        .filter(|e| !seen.contains(String::from_utf8_lossy(&e.path).as_ref()))
        .map(|e| e.path)
        .collect();
    for path in gone {
        index.remove_path(Path::new(&String::from_utf8_lossy(&path).into_owned()))?;
    }
    Ok(Snapshot { entries, hashed })
}

fn walk(repo: &Repository, root: &Path, prefix: &str, out: &mut Vec<String>) -> Result<(), Error> {
    for item in fs::read_dir(root.join(prefix))? {
        let item = item?;
        let name = item.file_name().into_string().map_err(|n| {
            Error::stopped(format!("{} is not a UTF-8 file name", n.to_string_lossy()))
        })?;
        if prefix.is_empty() && name == ".git" || name == STATE_DIRECTORY {
            continue;
        }
        let rel = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        let kind = item.file_type()?;
        if kind.is_dir() {
            if !repo.status_should_ignore(Path::new(&format!("{rel}/")))? {
                walk(repo, root, &rel, out)?;
            }
        } else if kind.is_file() && !repo.status_should_ignore(Path::new(&rel))? {
            out.push(rel);
        }
        // Symlinks are left out: the server refuses them (receive.ts).
    }
    Ok(())
}

#[cfg(unix)]
fn stat_matches(entry: &IndexEntry, meta: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    entry.mtime.seconds() == meta.mtime() as i32
        && entry.mtime.nanoseconds() == meta.mtime_nsec() as u32
        && entry.file_size == meta.len() as u32
        && entry.ino == meta.ino() as u32
        && entry.mode == mode_of(meta)
}

#[cfg(not(unix))]
fn stat_matches(_: &IndexEntry, _: &fs::Metadata) -> bool {
    false
}

#[cfg(unix)]
fn mode_of(meta: &fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    if meta.permissions().mode() & 0o111 != 0 {
        0o100755
    } else {
        0o100644
    }
}

#[cfg(not(unix))]
fn mode_of(_: &fs::Metadata) -> u32 {
    0o100644
}

/// An index entry for `path` at `id`, carrying the file's stat data so the
/// next snapshot can trust it without reading the file.
pub fn entry_for(path: &str, id: Oid, meta: &fs::Metadata) -> IndexEntry {
    #[cfg(unix)]
    let (ctime, mtime, dev, ino, uid, gid) = {
        use std::os::unix::fs::MetadataExt;
        (
            IndexTime::new(meta.ctime() as i32, meta.ctime_nsec() as u32),
            IndexTime::new(meta.mtime() as i32, meta.mtime_nsec() as u32),
            meta.dev() as u32,
            meta.ino() as u32,
            meta.uid(),
            meta.gid(),
        )
    };
    #[cfg(not(unix))]
    let (ctime, mtime, dev, ino, uid, gid) =
        (IndexTime::new(0, 0), IndexTime::new(0, 0), 0, 0, 0, 0);
    IndexEntry {
        ctime,
        mtime,
        dev,
        ino,
        mode: mode_of(meta),
        uid,
        gid,
        file_size: meta.len() as u32,
        id,
        flags: path.len().min(0xfff) as u16,
        flags_extended: 0,
        path: path.as_bytes().to_vec(),
    }
}

/// An index entry with no stat data, for a tree being assembled in memory.
pub fn bare_entry(path: &str, id: Oid, mode: u32) -> IndexEntry {
    IndexEntry {
        ctime: IndexTime::new(0, 0),
        mtime: IndexTime::new(0, 0),
        dev: 0,
        ino: 0,
        mode,
        uid: 0,
        gid: 0,
        file_size: 0,
        id,
        flags: path.len().min(0xfff) as u16,
        flags_extended: 0,
        path: path.as_bytes().to_vec(),
    }
}

/// Every LFS pointer that `new` adds or changes against `old` whose object
/// is not in the local store: what a checkout of `new` must download first.
pub fn missing_objects(
    repo: &Repository,
    old: Option<&Tree>,
    new: &Tree,
) -> Result<Vec<Pointer>, Error> {
    let mut out = Vec::new();
    let git_dir = repo.path();
    let diff = repo.diff_tree_to_tree(old, Some(new), None)?;
    for delta in diff.deltas() {
        if !matches!(
            delta.status(),
            Delta::Added | Delta::Modified | Delta::Typechange
        ) {
            continue;
        }
        let blob = repo.find_blob(delta.new_file().id())?;
        if let Some(p) = Pointer::parse(blob.content()) {
            if !lfs::has_local(git_dir, &p) && !out.contains(&p) {
                out.push(p);
            }
        }
    }
    Ok(out)
}

/// Every LFS pointer the commits in `head` that `hide` does not reach add
/// or change: what `git lfs push origin HEAD` would send.
pub fn objects_to_push(
    repo: &Repository,
    head: Oid,
    hide: Option<Oid>,
) -> Result<Vec<Pointer>, Error> {
    let mut walk = repo.revwalk()?;
    walk.push(head)?;
    if let Some(hide) = hide {
        walk.hide(hide)?;
    }
    let mut out = Vec::new();
    for id in walk {
        let commit = repo.find_commit(id?)?;
        let parent = commit.parents().next().map(|p| p.tree()).transpose()?;
        let diff = repo.diff_tree_to_tree(parent.as_ref(), Some(&commit.tree()?), None)?;
        for delta in diff.deltas() {
            if !matches!(
                delta.status(),
                Delta::Added | Delta::Modified | Delta::Typechange
            ) {
                continue;
            }
            let blob = repo.find_blob(delta.new_file().id())?;
            if let Some(p) = Pointer::parse(blob.content()) {
                if lfs::has_local(repo.path(), &p) && !out.contains(&p) {
                    out.push(p);
                }
            }
        }
    }
    Ok(out)
}

/// Make the working tree and `index` hold `new`, changing only what differs
/// from `old` (None: write every file of `new`). LFS pointers are written as
/// their objects' bytes, which must be in the local store. Paths in
/// `already` hold their blob in the working tree and are only re-stat'ed.
pub fn materialize(
    repo: &Repository,
    index: &mut Index,
    old: Option<&Tree>,
    new: &Tree,
    already: &Entries,
) -> Result<usize, Error> {
    let root = repo
        .workdir()
        .ok_or_else(|| Error::stopped("the repository has no working tree".into()))?
        .to_path_buf();
    let diff = repo.diff_tree_to_tree(old, Some(new), None)?;
    let mut written = 0;
    for delta in diff.deltas() {
        let path = match delta.new_file().path().or(delta.old_file().path()) {
            Some(p) => p.to_string_lossy().replace('\\', "/"),
            None => continue,
        };
        let full = root.join(&path);
        match delta.status() {
            Delta::Deleted => {
                match fs::remove_file(&full) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e.into()),
                }
                prune_empty(&root, full.parent());
                index.remove_path(Path::new(&path))?;
            }
            Delta::Added | Delta::Modified | Delta::Typechange => {
                let id = delta.new_file().id();
                let mode = u32::from(delta.new_file().mode());
                if already.get(&path).map(|(oid, _)| *oid) != Some(id) {
                    let blob = repo.find_blob(id)?;
                    let bytes = match Pointer::parse(blob.content()) {
                        Some(p) if stored_with_lfs(repo, &path)? => {
                            lfs::read_local(repo.path(), &p)?
                        }
                        _ => blob.content().to_vec(),
                    };
                    if let Some(dir) = full.parent() {
                        fs::create_dir_all(dir)?;
                    }
                    fs::write(&full, &bytes)?;
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        let bits = if mode == 0o100755 { 0o755 } else { 0o644 };
                        fs::set_permissions(&full, fs::Permissions::from_mode(bits))?;
                    }
                    written += 1;
                }
                index.add(&entry_for(&path, id, &fs::symlink_metadata(&full)?))?;
            }
            _ => {}
        }
    }
    index.write()?;
    Ok(written)
}

fn prune_empty(root: &Path, mut dir: Option<&Path>) {
    while let Some(d) = dir {
        if d == root || fs::remove_dir(d).is_err() {
            return;
        }
        dir = d.parent();
    }
}
