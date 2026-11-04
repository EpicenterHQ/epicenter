//! Where two histories meet, by ADR-0734's rule: a note (`*.md`) merges by
//! `settle` (supplied by the host as a `NoteMerge`), every other file is
//! kept whole with the later write winning (ADR-0771), this computer's,
//! which arrives after the remote's, and an edit beats a delete. The version
//! that lost stays in history.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use git2::{
    Delta, Index, IndexEntry, MergeOptions, Oid, Repository, Tree, TreeWalkMode, TreeWalkResult,
};

use crate::worktree::{bare_entry, Entries};
use crate::{Error, NoteInput, NoteMerge, Party};

const CONTROL_FILES: [&str; 3] = [".gitignore", ".gitattributes", ".lfsconfig"];

pub fn is_note(path: &str) -> bool {
    path.len() >= 3 && path[path.len() - 3..].eq_ignore_ascii_case(".md")
}

pub fn is_control(path: &str) -> bool {
    CONTROL_FILES.contains(&path.rsplit('/').next().unwrap_or(path))
}

fn text(repo: &Repository, id: Oid) -> Result<String, Error> {
    let blob = repo.find_blob(id)?;
    String::from_utf8(blob.content().to_vec())
        .map_err(|_| Error::stopped("a note is not UTF-8 text".into()))
}

/// Every blob in `tree`, by path.
pub fn entries(tree: &Tree) -> Result<Entries, Error> {
    let mut out = HashMap::new();
    let mut submodule = None;
    tree.walk(TreeWalkMode::PreOrder, |dir, entry| {
        match entry.kind() {
            Some(git2::ObjectType::Blob) => {
                out.insert(
                    format!("{dir}{}", entry.name().unwrap_or_default()),
                    (entry.id(), entry.filemode() as u32),
                );
            }
            Some(git2::ObjectType::Commit) => {
                submodule = Some(format!("{dir}{}", entry.name().unwrap_or_default()))
            }
            _ => {}
        }
        TreeWalkResult::Ok
    })?;
    if let Some(path) = submodule {
        return Err(Error::stopped(format!(
            "{path} is a Git submodule; sync only supports files."
        )));
    }
    Ok(out)
}

pub struct Settler<'a> {
    pub repo: &'a Repository,
    pub merge: &'a dyn NoteMerge,
    /// The side already on the server (`origin/main`).
    pub current: Party,
    /// This machine's side, arriving after it.
    pub incoming: Party,
}

impl Settler<'_> {
    fn settle(
        &self,
        path: &str,
        base: Option<Oid>,
        current: Oid,
        incoming: Oid,
    ) -> Result<Oid, Error> {
        let base = base.map(|b| text(self.repo, b)).transpose()?;
        let current = text(self.repo, current)?;
        let incoming = text(self.repo, incoming)?;
        let merged = self
            .merge
            .settle(&NoteInput {
                path,
                base: base.as_deref(),
                current: &current,
                incoming: &incoming,
                current_party: &self.current,
                incoming_party: &self.incoming,
            })
            .map_err(|e| Error::stopped(format!("settle failed for {path}: {e}")))?;
        Ok(self.repo.blob(merged.as_bytes())?)
    }
}

/// The tree of an ordinary three-way merge of `ours` (local `main`) with
/// `theirs` (`origin/main`): libgit2's tree merge for structure and renames,
/// then every note both sides changed re-merged by `settle`, and every
/// conflict libgit2 leaves settled by ADR-0734's rule.
pub fn three_way(
    s: &Settler,
    base: &Tree,
    ours: &Tree,
    theirs: &Tree,
    notes: &mut Vec<String>,
) -> Result<Oid, Error> {
    let repo = s.repo;
    let mut opts = MergeOptions::new();
    opts.find_renames(true);
    let mut index = repo.merge_trees(base, ours, theirs, Some(&opts))?;
    let base_entries = entries(base)?;

    let conflicts: Vec<_> = index.conflicts()?.collect::<Result<_, _>>()?;
    let mut conflicted = HashSet::new();
    let mut left = Vec::new();
    for c in conflicts {
        let path_of = |e: &Option<IndexEntry>| {
            e.as_ref()
                .map(|e| String::from_utf8_lossy(&e.path).into_owned())
        };
        let path = path_of(&c.our)
            .or(path_of(&c.their))
            .or(path_of(&c.ancestor))
            .unwrap_or_default();
        conflicted.insert(path.clone());
        if is_control(&path) {
            left.push(path);
            continue;
        }
        index.conflict_remove(Path::new(&path))?;
        match (&c.ancestor, &c.our, &c.their) {
            (_, Some(o), Some(t)) if is_note(&path) => {
                let base_id = c.ancestor.as_ref().map(|a| a.id);
                let id = s.settle(&path, base_id, t.id, o.id)?;
                index.add(&bare_entry(&path, id, o.mode))?;
                notes.push(format!("{path}: settled (libgit2 left a conflict)"));
            }
            (_, Some(o), Some(_)) => {
                index.add(&bare_entry(&path, o.id, o.mode))?;
                notes.push(format!(
                    "{path}: kept this computer's version, the later write"
                ));
            }
            (Some(_), Some(o), None) => {
                index.add(&bare_entry(&path, o.id, o.mode))?;
                notes.push(format!("edit beats delete: kept {path} (local edit)"));
            }
            (Some(_), None, Some(t)) => {
                index.add(&bare_entry(&path, t.id, t.mode))?;
                notes.push(format!("edit beats delete: kept {path} (remote edit)"));
            }
            _ => left.push(path),
        }
    }
    if !left.is_empty() {
        return Err(Error::stopped(format!(
            "the merge left conflicts Epicenter does not settle: {}. Merge them yourself (git merge origin/main, resolve, git commit), then sync again.",
            left.join(", ")
        )));
    }

    // Notes both sides changed that libgit2 merged by line on its own: the
    // CLI's merge driver runs for these too, so settle decides them.
    let changed = |to: &Tree| -> Result<HashMap<String, Oid>, Error> {
        let diff = repo.diff_tree_to_tree(Some(base), Some(to), None)?;
        Ok(diff
            .deltas()
            .filter(|d| matches!(d.status(), Delta::Added | Delta::Modified))
            .filter_map(|d| {
                Some((
                    d.new_file().path()?.to_string_lossy().into_owned(),
                    d.new_file().id(),
                ))
            })
            .collect())
    };
    let (ours_changed, theirs_changed) = (changed(ours)?, changed(theirs)?);
    for (path, o) in &ours_changed {
        let Some(t) = theirs_changed.get(path) else {
            continue;
        };
        if o == t || !is_note(path) || conflicted.contains(path) {
            continue;
        }
        let base_id = base_entries.get(path).map(|(id, _)| *id);
        let id = s.settle(path, base_id, *t, *o)?;
        let mode = index
            .get_path(Path::new(path), 0)
            .map(|e| e.mode)
            .unwrap_or(0o100644);
        index.add(&bare_entry(path, id, mode))?;
        notes.push(format!("{path}: settled"));
    }
    Ok(index.write_tree_to(repo)?)
}

/// ADR-0735's first contact: the remote's tree with this folder's files on
/// top. A file only the remote has stays; a file only here is added; a file
/// on both sides merges (a note by `settle` with no base; any other file is
/// kept whole, this computer's version winning as the later write).
pub fn first_contact_tree(
    s: &Settler,
    remote: &Tree,
    local: &Entries,
    notes: &mut Vec<String>,
) -> Result<(Oid, Entries), Error> {
    let repo = s.repo;
    let theirs = entries(remote)?;
    for path in local.keys() {
        if theirs
            .keys()
            .any(|o| o.starts_with(&format!("{path}/")) || path.starts_with(&format!("{o}/")))
        {
            return Err(Error::stopped(format!(
                "{path} is a file on this computer and a directory on the remote, or the reverse. Resolve the paths before syncing."
            )));
        }
    }
    let mut index = Index::new()?;
    index.read_tree(remote)?;
    let mut final_local = HashMap::new();
    let mut paths: Vec<_> = local.keys().collect();
    paths.sort();
    let (mut added, mut merged, mut replaced) = (0, 0, 0);
    for path in paths {
        let (ours, mode) = local[path];
        match theirs.get(path) {
            Some((t, _)) if *t == ours => {
                final_local.insert(path.clone(), (ours, mode));
            }
            None => {
                index.add(&bare_entry(path, ours, mode))?;
                final_local.insert(path.clone(), (ours, mode));
                added += 1;
            }
            Some(_) if is_control(path) => {
                return Err(Error::stopped(format!(
                    "{path} differs on this computer and the remote. Resolve this Git control file before syncing."
                )));
            }
            Some((t, _)) if is_note(path) => {
                let id = s.settle(path, None, *t, ours)?;
                index.add(&bare_entry(path, id, mode))?;
                notes.push(format!("{path}: settled two additions"));
                merged += 1;
            }
            Some(_) => {
                index.add(&bare_entry(path, ours, mode))?;
                final_local.insert(path.clone(), (ours, mode));
                notes.push(format!(
                    "{path}: kept this computer's version, the later write"
                ));
                replaced += 1;
            }
        }
    }
    notes.push(format!(
        "first contact: {} from the remote, {added} added here, {merged} notes merged, {replaced} files replaced",
        theirs.len()
    ));
    Ok((index.write_tree_to(repo)?, final_local))
}
