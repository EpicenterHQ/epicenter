//! The roots an app reaches, by name (ADR-0725).
//!
//! At startup the shell names each root it has, `Root::Data` and
//! `Root::AppData`, with its path and the rule that refuses a location it
//! must never be (`Roots::name`). The Epicenter app names the Epicenter
//! folder instead of a Data root (`Roots::name_epicenter`, ADR-0813), and
//! each real directory directly in it is a root of its own,
//! `Root::Folder(name)`; a link there is listed as outside the Epicenter
//! folder and never opened as one of its folders (ADR-0825). Its own records
//! are `Root::Epicenter` (ADR-0822). A standalone app names the Epicenter
//! folder only to read its Data root's record (`Roots::name_library`). A
//! page names a root, never a path. Opening a named root opens whatever is
//! at its path, following a link there, and makes the folder when nothing is
//! there (ADR-0726); a link whose target is gone is `Disconnected`, and
//! nothing is made. Every storage command names an open root; the shared
//! path rule keeps its relative path inside it.
//!
//! Each open root has one recursive native watch. Its changes are app events;
//! pages subscribe before opening a root.

use std::collections::HashMap;
use std::fmt;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::{Arc, Mutex, MutexGuard};

use epicenter_folder_core::admission::{is_reserved_directory, resolved};
use epicenter_folder_core::paths::readable_path_problem;
use epicenter_folder_core::state;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{Manager, Runtime};

use crate::watch::{FolderChanged, FolderWatch};
use crate::Directory;

/// A root an app reaches by name.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub enum Root {
    /// The person's files: `<library root>/<name>`, which the app's site
    /// names (ADR-0722), such as `~/Epicenter/whispering`.
    Data,
    /// The operating system's application data directory for this app:
    /// machine-local settings, never synced.
    AppData,
    /// The real directory `name` directly inside the Epicenter folder, which
    /// the Epicenter app names (`Roots::name_epicenter`): one of the
    /// person's folders. A link there is not one (ADR-0825).
    Folder(String),
    /// The Epicenter folder's own records and caches, `.epicenter` at its
    /// root (`synced/<folder-id>.json`, `hashes/<key>.json`, ADR-0822),
    /// which exists only where the shell named the Epicenter folder
    /// (`Roots::name_epicenter`). Opening it makes it.
    Epicenter,
}

impl fmt::Display for Root {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Data => formatter.write_str("Data"),
            Self::AppData => formatter.write_str("AppData"),
            Self::Folder(name) => formatter.write_str(name),
            Self::Epicenter => formatter.write_str("Epicenter"),
        }
    }
}

/// The prefix of a folder root in a raw request's `root` header.
const FOLDER_HEADER: &str = "Folder/";

impl Root {
    /// The root as a raw request's `root` header spells it: `Data`,
    /// `AppData`, `Epicenter`, or `Folder/<name>` (`FromStr` reads it back).
    pub fn header(&self) -> String {
        match self {
            Self::Folder(name) => format!("{FOLDER_HEADER}{name}"),
            other => other.to_string(),
        }
    }
}

impl FromStr for Root {
    type Err = String;

    fn from_str(name: &str) -> Result<Self, Self::Err> {
        match name {
            "Data" => Ok(Self::Data),
            "AppData" => Ok(Self::AppData),
            "Epicenter" => Ok(Self::Epicenter),
            other => match other.strip_prefix(FOLDER_HEADER) {
                Some(folder) if !folder.is_empty() => Ok(Self::Folder(folder.to_string())),
                _ => Err(format!(
                    "{other:?} is not a root: Data, AppData, Epicenter, or Folder/<name>"
                )),
            },
        }
    }
}

/// Why `name` cannot be a folder's name in the Epicenter folder: one plain
/// segment, not hidden, that the shared path rule reads. `None` when it can.
pub fn folder_name_problem(name: &str) -> Option<&'static str> {
    if name.contains('/') {
        return Some("a folder's name is one segment, without a slash");
    }
    if name.starts_with('.') {
        return Some("a hidden name is not a folder");
    }
    readable_path_problem(name)
}

/// Why a root did not open or cannot be used: what the page is told.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "name")]
pub enum RootError {
    /// A raw request used a root name the shell does not recognize.
    Invalid { root: String },
    /// The shell named no such root for this app.
    NotNamed { root: Root },
    /// A command named a root the app has not opened.
    NotOpen { root: Root },
    /// The root's path, or a folder above it, is a link whose target is not
    /// there, as on a drive that is not connected. Nothing was made.
    Disconnected { folder: String, target: String },
    /// The root's location is one it must never be (the shell's rule):
    /// why, in one line.
    Refused { folder: String, reason: String },
    /// The root could not be reached or made.
    Unavailable { folder: String, message: String },
    /// The shell is shutting its roots down.
    ShuttingDown,
}

impl fmt::Display for RootError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid { root } => write!(
                formatter,
                "{root:?} is not a root: Data, AppData, Epicenter, or Folder/<name>"
            ),
            Self::NotNamed { root } => write!(formatter, "This app has no {root} folder."),
            Self::NotOpen { root } => write!(formatter, "The {root} folder is not open."),
            Self::Disconnected { folder, target } => {
                write!(formatter, "{folder} links to {target}, which is not there.")
            }
            Self::Refused { reason, .. } => formatter.write_str(reason),
            Self::Unavailable { folder, message } => write!(formatter, "{folder}: {message}"),
            Self::ShuttingDown => formatter.write_str("The folders are shutting down."),
        }
    }
}

impl std::error::Error for RootError {}

/// Why a location can never be a root, in one line, or `None`. It is asked
/// with the location the root's path resolves to.
type Refusal = Arc<dyn Fn(&Path) -> Option<String> + Send + Sync>;

/// The shell's named roots. Reached with `app.roots()`.
#[derive(Default)]
pub struct Roots {
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    named: HashMap<Root, Named>,
    /// The Epicenter folder, whose directories are `Root::Folder` roots.
    epicenter: Option<Named>,
    /// The Epicenter folder a standalone app reads its record in
    /// (`Roots::name_library`), whose directories are not roots.
    library: Option<PathBuf>,
    /// Told each time a root opens (`Roots::on_open`).
    listeners: Vec<OnOpen>,
    opened: HashMap<Root, Opened>,
    stopped: bool,
}

/// Told the root that opened and the folder it reached.
type OnOpen = Arc<dyn Fn(&Root, &Directory) + Send + Sync>;

#[derive(Clone)]
struct Named {
    path: PathBuf,
    refusal: Refusal,
}

impl State {
    /// Where `root` is and what refuses its location: a named root, or a
    /// directory of the Epicenter folder, which may not be inside a `.git`
    /// or `.epicenter`.
    fn named(&self, root: &Root) -> Result<Named, RootError> {
        if *root == Root::Epicenter {
            return self.records();
        }
        let Root::Folder(name) = root else {
            return self.named.get(root).cloned().ok_or(RootError::NotNamed {
                root: root.clone(),
            });
        };
        let epicenter = self.epicenter.as_ref().ok_or(RootError::NotNamed {
            root: root.clone(),
        })?;
        let path = epicenter.path.join(name);

        if let Some(problem) = folder_name_problem(name) {
            return Err(RootError::Refused {
                folder: path.display().to_string(),
                reason: format!("{name:?} is not a folder's name: {problem}."),
            });
        }
        let outer = epicenter.refusal.clone();
        Ok(Named {
            path,
            refusal: Arc::new(move |location: &Path| {
                if is_reserved_directory(location) {
                    return Some(format!(
                        "{} is inside a .git or {} folder, so it cannot be a folder.",
                        location.display(),
                        epicenter_folder_core::state::DIRECTORY
                    ));
                }
                outer(location)
            }),
        })
    }
}

impl State {
    /// Where the Epicenter folder's own records are, `.epicenter` at its
    /// root, refused only when that is a link: Epicenter's records are never
    /// kept through one. The rule for a folder's location is not asked: this
    /// is not a folder, and it is inside `.epicenter` by definition.
    fn records(&self) -> Result<Named, RootError> {
        let epicenter = self.epicenter.as_ref().ok_or(RootError::NotNamed {
            root: Root::Epicenter,
        })?;
        let path = state::directory(&epicenter.path);
        let records = path.clone();
        Ok(Named {
            path,
            refusal: Arc::new(move |_: &Path| {
                fs::symlink_metadata(&records)
                    .is_ok_and(|metadata| metadata.file_type().is_symlink())
                    .then(|| {
                        format!(
                            "{} is a link, so Epicenter keeps no records through it.",
                            records.display()
                        )
                    })
            }),
        })
    }
}

/// A root that opened: the folder its path reached and its native watch.
struct Opened {
    directory: Directory,
    /// Held for the root's life: dropping it stops the watch.
    watch: Option<FolderWatch>,
}

impl State {
    fn running(&self) -> Result<(), RootError> {
        if self.stopped {
            Err(RootError::ShuttingDown)
        } else {
            Ok(())
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Roots {
    fn state(&self) -> MutexGuard<'_, State> {
        lock(&self.state)
    }

    /// Name `root` at `path`, refusing any location `refusal` names a reason
    /// for. The shell names its roots at startup, before a page asks.
    pub fn name(
        &self,
        root: Root,
        path: PathBuf,
        refusal: impl Fn(&Path) -> Option<String> + Send + Sync + 'static,
    ) {
        let replaced = {
            let mut state = self.state();
            state.named.insert(
                root.clone(),
                Named {
                    path,
                    refusal: Arc::new(refusal),
                },
            );
            state.opened.remove(&root)
        };
        drop(replaced);
    }

    /// Name the Epicenter folder at `path` (ADR-0813): each directory
    /// directly inside it is the root `Root::Folder(<its name>)`, refused
    /// at any location `refusal` names a reason for, as a named root's is.
    pub fn name_epicenter(
        &self,
        path: PathBuf,
        refusal: impl Fn(&Path) -> Option<String> + Send + Sync + 'static,
    ) {
        let replaced: Vec<Opened> = {
            let mut state = self.state();
            state.epicenter = Some(Named {
                path,
                refusal: Arc::new(refusal),
            });
            let folders: Vec<Root> = state
                .opened
                .keys()
                .filter(|root| matches!(root, Root::Folder(_) | Root::Epicenter))
                .cloned()
                .collect();
            folders
                .iter()
                .filter_map(|root| state.opened.remove(root))
                .collect()
        };
        drop(replaced);
    }

    /// Name the Epicenter folder at `path` for a standalone app, which reads
    /// the record matching its Data root there (`data_record`) and nothing
    /// else: its directories are not roots, and it has no `Root::Epicenter`.
    pub fn name_library(&self, path: PathBuf) {
        self.state().library = Some(path);
    }

    /// The Epicenter folder whose records this app reads: the one it named
    /// (`name_epicenter`), or a standalone app's (`name_library`).
    pub fn library(&self) -> Result<PathBuf, RootError> {
        let state = self.state();
        state.running()?;
        let named = state.epicenter.as_ref().map(|named| named.path.clone());
        named
            .or_else(|| state.library.clone())
            .ok_or(RootError::NotNamed {
                root: Root::Epicenter,
            })
    }

    /// Tell `listener` each time a root opens, with the folder it reached,
    /// after it opened and outside the roots' lock. A standalone shell
    /// remembers its Data root's identity this way.
    pub fn on_open(&self, listener: impl Fn(&Root, &Directory) + Send + Sync + 'static) {
        self.state().listeners.push(Arc::new(listener));
    }

    /// The path the shell named `root` at, as a person reads it: what the
    /// page shows, and what a link to Epicenter names.
    pub fn path(&self, root: &Root) -> Result<PathBuf, RootError> {
        let state = self.state();
        state.running()?;
        state.named(root).map(|named| named.path)
    }

    /// Open `root`: whatever is at its path, made when nothing is there.
    /// Each call looks again, so a folder that came back opens and a link
    /// pointed elsewhere is followed. A folder of the Epicenter folder is a
    /// real directory, never a link (ADR-0825). Blocks on the disk.
    pub fn open(&self, root: &Root) -> Result<Directory, RootError> {
        let Named { path, refusal } = {
            let state = self.state();
            state.running()?;
            state.named(root)?
        };
        if matches!(root, Root::Folder(_))
            && fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Err(RootError::Refused {
                folder: path.display().to_string(),
                reason: format!(
                    "{} is a link to a folder outside the Epicenter folder, which Epicenter does not sync.",
                    path.display()
                ),
            });
        }
        // Opening a folder of the Epicenter folder that went away does not
        // bring it back.
        let make = !matches!(root, Root::Folder(_));
        let directory = reach(&path, &*refusal, make)?;
        let replaced = {
            let mut state = self.state();
            state.running()?;
            match state.opened.get(root) {
                Some(opened) if opened.directory == directory => None,
                _ => state.opened.insert(
                    root.clone(),
                    Opened {
                        directory: directory.clone(),
                        watch: None,
                    },
                ),
            }
        };
        // A replaced watch joins its thread when dropped: never under the lock.
        drop(replaced);
        let listeners = self.state().listeners.clone();
        for listener in listeners {
            listener(root, &directory);
        }
        Ok(directory)
    }

    /// The folder `root` reached when it last opened, cloned for one
    /// command: work already admitted keeps it whatever happens next. A
    /// root whose path, or a folder above it, is now a link whose target is
    /// gone is `Disconnected`, whether or not it opened before, and nothing
    /// is made.
    pub fn opened(&self, root: &Root) -> Result<Directory, RootError> {
        let (path, opened) = {
            let state = self.state();
            state.running()?;
            let path = state.named(root)?.path;
            (
                path,
                state
                    .opened
                    .get(root)
                    .map(|opened| opened.directory.clone()),
            )
        };
        // Looked at outside the lock: it asks the disk.
        if let Some(target) = dangling_target(&path) {
            return Err(RootError::Disconnected {
                folder: path.display().to_string(),
                target: target.display().to_string(),
            });
        }
        opened.ok_or(RootError::NotOpen { root: root.clone() })
    }

    /// Start `root`'s one watch and report its changes to the app.
    pub(crate) fn watch(
        &self,
        root: &Root,
        directory: &Directory,
        report: impl Fn(FolderChanged) + Send + 'static,
    ) -> Result<(), RootError> {
        let watched = {
            let state = self.state();
            state.running()?;
            let opened = state
                .opened
                .get(root)
                .filter(|opened| opened.directory == *directory)
                .ok_or(RootError::NotOpen { root: root.clone() })?;
            opened.watch.is_some()
        };
        let mut candidate = None;
        if !watched {
            // A recursive watch can walk a large tree as it starts: never
            // under the lock. Until installed below, it reports nothing.
            let watch = FolderWatch::start(directory.root(), report).map_err(|error| {
                RootError::Unavailable {
                    folder: directory.root().display().to_string(),
                    message: error.to_string(),
                }
            })?;
            candidate = Some(watch);
        }
        let mut state = self.state();
        state.running()?;
        let opened = state
            .opened
            .get_mut(root)
            .filter(|opened| opened.directory == *directory)
            .ok_or(RootError::NotOpen { root: root.clone() })?;
        if opened.watch.is_none() {
            if let Some(watch) = candidate.take() {
                watch.activate();
                opened.watch = Some(watch);
            }
        }
        drop(state);
        // A duplicate watch goes after the lock.
        drop(candidate);
        Ok(())
    }

    /// Refuse new opens and commands without waiting for admitted work
    /// (ADR-0542), and stop every watch.
    pub fn shutdown(&self) {
        let opened = {
            let mut state = self.state();
            state.stopped = true;
            std::mem::take(&mut state.opened)
        };
        drop(opened);
    }
}

/// Open whatever is at `path`, making the folder when nothing is there and
/// `make` says so. A link at `path`, or above it, is followed; one whose
/// target is gone is `Disconnected`, and nothing is made. A location
/// `refusal` names a reason for is refused, both before anything is made and
/// once the folder is there.
fn reach(
    path: &Path,
    refusal: &dyn Fn(&Path) -> Option<String>,
    make: bool,
) -> Result<Directory, RootError> {
    let folder = path.display().to_string();
    if let Some(target) = dangling_target(path) {
        return Err(RootError::Disconnected {
            folder,
            target: target.display().to_string(),
        });
    }
    let unavailable = |message: String| RootError::Unavailable {
        folder: folder.clone(),
        message,
    };
    let refused = |location: &Path| {
        refusal(location).map(|reason| RootError::Refused {
            folder: folder.clone(),
            reason,
        })
    };
    if let Some(refused) = refused(&resolved(path)) {
        return Err(refused);
    }
    match fs::metadata(path) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => return Err(unavailable("this is a file, not a folder".into())),
        Err(cause) if cause.kind() == ErrorKind::NotFound && !make => {
            return Err(unavailable("this folder is not there".into()))
        }
        Err(cause) if cause.kind() == ErrorKind::NotFound => {
            fs::create_dir_all(path)
                .map_err(|cause| unavailable(format!("the folder could not be made: {cause}")))?;
        }
        Err(cause) => return Err(unavailable(cause.to_string())),
    }
    let location = dunce::canonicalize(path).map_err(|cause| unavailable(cause.to_string()))?;
    if let Some(refused) = refused(&location) {
        return Err(refused);
    }
    Directory::existing(&location).map_err(|error| unavailable(error.to_string()))
}

/// Where `path` would be when it, or a folder above it, is a link whose
/// target is not there; `None` when every link on the way resolves.
fn dangling_target(path: &Path) -> Option<PathBuf> {
    path.ancestors().find_map(|link| {
        let is_link = fs::symlink_metadata(link).is_ok_and(|meta| meta.file_type().is_symlink());
        if !is_link || link.exists() {
            return None;
        }
        let target = fs::read_link(link).ok()?;
        // A relative target is read from the folder holding the link.
        let target = match link.parent() {
            Some(parent) => parent.join(target),
            None => target,
        };
        let rest = path.strip_prefix(link).ok()?;
        Some(if rest.as_os_str().is_empty() {
            target
        } else {
            target.join(rest)
        })
    })
}

/// `app.roots()`, from anything that reaches the app.
pub trait RootsExt<R: Runtime>: Manager<R> {
    fn roots(&self) -> &Roots {
        self.state::<Roots>().inner()
    }
}

impl<R: Runtime, T: Manager<R>> RootsExt<R> for T {}

#[cfg(test)]
mod tests {
    use super::*;

    fn never(_: &Path) -> Option<String> {
        None
    }

    fn base() -> (tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(temp.path()).unwrap();
        (temp, base)
    }

    #[test]
    fn a_missing_root_is_made_and_an_existing_one_is_left_as_it_is() {
        let (_temp, base) = base();
        let roots = Roots::default();
        let data = base.join("Epicenter/notes");
        roots.name(Root::Data, data.clone(), never);
        assert_eq!(
            roots.opened(&Root::Data),
            Err(RootError::NotOpen { root: Root::Data })
        );
        assert_eq!(roots.open(&Root::Data).unwrap().root(), data);
        assert!(data.is_dir());
        fs::write(data.join("a.md"), "kept").unwrap();
        roots.open(&Root::Data).unwrap();
        assert_eq!(fs::read_to_string(data.join("a.md")).unwrap(), "kept");
        assert_eq!(
            roots.open(&Root::AppData),
            Err(RootError::NotNamed {
                root: Root::AppData
            })
        );
        fs::remove_dir_all(&data).unwrap();
        fs::write(&data, "a file").unwrap();
        assert!(matches!(
            roots.open(&Root::Data),
            Err(RootError::Unavailable { .. })
        ));
    }

    #[cfg(unix)]
    #[test]
    fn a_link_is_followed_and_a_dangling_one_makes_nothing() {
        use std::os::unix::fs::symlink;

        let (_temp, base) = base();
        let roots = Roots::default();
        let data = base.join("Epicenter/notes");
        fs::create_dir_all(data.parent().unwrap()).unwrap();
        let drive = base.join("Volumes/Archive/notes");
        symlink(&drive, &data).unwrap();
        roots.name(Root::Data, data.clone(), never);
        assert_eq!(
            roots.open(&Root::Data),
            Err(RootError::Disconnected {
                folder: data.display().to_string(),
                target: drive.display().to_string(),
            })
        );
        assert!(!base.join("Volumes").exists());
        // A command asking for the root hears the same, and makes nothing.
        assert_eq!(
            roots.opened(&Root::Data),
            Err(RootError::Disconnected {
                folder: data.display().to_string(),
                target: drive.display().to_string(),
            })
        );
        assert!(!base.join("Volumes").exists());
        // The drive comes back: the same open follows the link.
        fs::create_dir_all(&drive).unwrap();
        fs::write(drive.join("a.md"), "there").unwrap();
        assert_eq!(roots.open(&Root::Data).unwrap().root(), drive);
        assert_eq!(roots.path(&Root::Data).unwrap(), data);

        // A dangling link above the root is the same.
        let library = base.join("Library Link");
        symlink(base.join("Volumes/Gone"), &library).unwrap();
        roots.name(Root::Data, library.join("notes"), never);
        assert_eq!(
            roots.open(&Root::Data),
            Err(RootError::Disconnected {
                folder: library.join("notes").display().to_string(),
                target: base.join("Volumes/Gone/notes").display().to_string(),
            })
        );
        assert!(!base.join("Volumes/Gone").exists());
    }

    #[cfg(unix)]
    #[test]
    fn the_refusal_is_asked_with_the_resolved_location_and_nothing_is_made() {
        use std::os::unix::fs::symlink;

        let (_temp, base) = base();
        let home = base.join("home");
        fs::create_dir_all(&home).unwrap();
        let roots = Roots::default();
        let refused_home = home.clone();
        let refusal = move |location: &Path| {
            refused_home
                .starts_with(location)
                .then(|| format!("{} is your home folder or holds it.", location.display()))
        };
        let data = home.join("Epicenter/notes");
        fs::create_dir_all(data.parent().unwrap()).unwrap();
        symlink(&home, &data).unwrap();
        roots.name(Root::Data, data.clone(), refusal.clone());
        assert!(matches!(
            roots.open(&Root::Data),
            Err(RootError::Refused { folder, .. }) if folder == data.display().to_string()
        ));
        // Through a linked parent, the location is still the one refused.
        let alias = base.join("alias");
        symlink(&base, &alias).unwrap();
        roots.name(Root::Data, alias.join("home"), refusal);
        assert!(matches!(
            roots.open(&Root::Data),
            Err(RootError::Refused { .. })
        ));
        assert_eq!(fs::read_dir(&home).unwrap().count(), 1);
    }

    #[test]
    fn a_root_reads_back_from_its_header() {
        for root in [
            Root::Data,
            Root::AppData,
            Root::Epicenter,
            Root::Folder("Notes and things".into()),
            Root::Folder("Epicenter".into()),
        ] {
            assert_eq!(root.header().parse::<Root>().unwrap(), root);
        }
        assert!("Folder/".parse::<Root>().is_err());
        assert!("Elsewhere".parse::<Root>().is_err());
        assert_eq!(
            serde_json::to_value(Root::Folder("notes".into())).unwrap(),
            serde_json::json!({ "Folder": "notes" })
        );
        assert_eq!(
            serde_json::to_value(Root::Epicenter).unwrap(),
            serde_json::json!("Epicenter")
        );
    }

    /// The Epicenter folder's own records are a root only where the shell
    /// named the Epicenter folder. Opening it makes `.epicenter` and its
    /// parent, though the rule for a folder's location refuses anything in
    /// `.epicenter`; a link there is refused.
    #[test]
    fn the_epicenter_folders_records_open_where_it_is_named() {
        let (_temp, base) = base();
        let roots = Roots::default();
        assert_eq!(
            roots.open(&Root::Epicenter),
            Err(RootError::NotNamed {
                root: Root::Epicenter
            })
        );
        let epicenter = base.join("Epicenter");
        roots.name_epicenter(epicenter.clone(), |location| {
            is_reserved_directory(location).then(|| "a folder's rule".to_string())
        });
        let records = epicenter.join(".epicenter");
        assert_eq!(roots.open(&Root::Epicenter).unwrap().root(), records);
        assert!(records.is_dir());
        assert_eq!(roots.path(&Root::Epicenter).unwrap(), records);
        #[cfg(unix)]
        {
            fs::remove_dir(&records).unwrap();
            let elsewhere = base.join("elsewhere");
            fs::create_dir(&elsewhere).unwrap();
            std::os::unix::fs::symlink(&elsewhere, &records).unwrap();
            assert!(matches!(
                roots.open(&Root::Epicenter),
                Err(RootError::Refused { .. })
            ));
        }
        // A standalone app's Epicenter folder is no root.
        let standalone = Roots::default();
        standalone.name_library(epicenter.clone());
        assert_eq!(standalone.library().unwrap(), epicenter);
        assert!(matches!(
            standalone.open(&Root::Epicenter),
            Err(RootError::NotNamed { .. })
        ));
        assert!(matches!(
            standalone.open(&Root::Folder("Notes".into())),
            Err(RootError::NotNamed { .. })
        ));
    }

    /// A listener hears each root that opens, with the folder it reached.
    #[test]
    fn a_listener_hears_each_root_that_opens() {
        let (_temp, base) = base();
        let roots = Roots::default();
        let heard = Arc::new(Mutex::new(Vec::new()));
        let hearing = heard.clone();
        roots.on_open(move |root, directory| {
            lock(&hearing).push((root.clone(), directory.root().to_path_buf()));
        });
        roots.name(Root::Data, base.join("notes"), never);
        roots.open(&Root::Data).unwrap();
        roots.open(&Root::Data).unwrap();
        assert_eq!(
            *lock(&heard),
            [
                (Root::Data, base.join("notes")),
                (Root::Data, base.join("notes"))
            ]
        );
        assert!(roots.open(&Root::AppData).is_err());
        assert_eq!(lock(&heard).len(), 2);
    }

    /// Each real directory of the Epicenter folder opens as a root of its
    /// own, and a link never does (ADR-0825).
    #[cfg(unix)]
    #[test]
    fn each_folder_of_the_epicenter_folder_opens_as_a_root() {
        use std::os::unix::fs::symlink;

        let (_temp, base) = base();
        let roots = Roots::default();
        let epicenter = base.join("Epicenter");
        roots.name_epicenter(epicenter.clone(), never);
        fs::create_dir_all(epicenter.join("Notes")).unwrap();
        let elsewhere = base.join("Drive/Recipes");
        fs::create_dir_all(&elsewhere).unwrap();
        symlink(&elsewhere, epicenter.join("Recipes")).unwrap();
        symlink(&base, epicenter.join("Everything")).unwrap();

        // A real directory is its root; a link is refused, and nothing is read through it.
        let root = Root::Folder("Notes".into());
        assert_eq!(roots.open(&root).unwrap().root(), epicenter.join("Notes"));
        assert_eq!(roots.opened(&root).unwrap().root(), epicenter.join("Notes"));
        let linked = Root::Folder("Recipes".into());
        assert!(matches!(
            roots.open(&linked),
            Err(RootError::Refused { reason, .. }) if reason.contains("outside the Epicenter folder")
        ));
        assert_eq!(roots.path(&linked).unwrap(), epicenter.join("Recipes"));
        // One that is not there is not made by opening it.
        let missing = Root::Folder("Missing".into());
        assert!(matches!(
            roots.open(&missing),
            Err(RootError::Unavailable { .. })
        ));
        assert!(!epicenter.join("Missing").exists());
        // A name that leaves the folder is refused before the disk is asked.
        for name in ["../Drive", "a/b", ".epicenter", ""] {
            assert!(
                matches!(
                    roots.open(&Root::Folder(name.into())),
                    Err(RootError::Refused { .. })
                ),
                "{name:?}"
            );
        }
        assert!(matches!(
            roots.open(&Root::Folder("Everything".into())),
            Err(RootError::Refused { .. })
        ));
    }
}
