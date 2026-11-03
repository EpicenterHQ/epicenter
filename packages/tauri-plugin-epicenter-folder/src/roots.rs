//! The roots an app reaches, by name (ADR-0725).
//!
//! At startup the shell names each root it has, `Root::Data` and
//! `Root::AppData`, with its path and the rule that refuses a location it
//! must never be (`Roots::name`). A page names a root, never a path. Opening
//! a root opens whatever is at its path, following a link there, and makes
//! the folder when nothing is there (ADR-0726); a link whose target is gone
//! is `Disconnected`, and nothing is made. Every storage command names an
//! open root; the shared path rule keeps its relative path inside it.
//!
//! Each open root has one recursive native watch, whose changes go to every
//! page that opened it, each through the latest channel it opened it with.
//! A page that reloads or closes hears nothing more, and an open it started
//! before reloading installs nothing.

use std::collections::HashMap;
use std::fmt;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::{Arc, Mutex, MutexGuard};

use epicenter_folder_core::admission::resolved;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{Manager, Runtime};

use crate::watch::{FolderChanged, FolderWatch};
use crate::Directory;

/// A root an app reaches by name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub enum Root {
    /// The person's files: `<library root>/<name>`, which the app's site
    /// names (ADR-0722), such as `~/Epicenter/whispering`.
    Data,
    /// The operating system's application data directory for this app:
    /// machine-local settings, never synced.
    AppData,
}

impl fmt::Display for Root {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Data => "Data",
            Self::AppData => "AppData",
        })
    }
}

impl FromStr for Root {
    type Err = String;

    fn from_str(name: &str) -> Result<Self, Self::Err> {
        match name {
            "Data" => Ok(Self::Data),
            "AppData" => Ok(Self::AppData),
            other => Err(format!("{other:?} is not a root: Data or AppData")),
        }
    }
}

/// Why a root did not open or cannot be used: what the page is told.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "name")]
pub enum RootError {
    /// The shell named no such root for this app.
    NotNamed { root: Root },
    /// A command named a root the page has not opened.
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

/// One page's way of hearing a root's changes.
type Listener = Box<dyn Fn(FolderChanged) + Send>;

/// Who hears a root's watch, by WebView label.
type Listeners = Arc<Mutex<HashMap<String, Listener>>>;

/// The shell's named roots. Reached with `app.roots()`.
#[derive(Default)]
pub struct Roots {
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    named: HashMap<Root, Named>,
    opened: HashMap<Root, Opened>,
    /// Each WebView's current page, by label: a number no earlier page of
    /// any WebView had (`last_page`).
    pages: HashMap<String, u64>,
    last_page: u64,
    stopped: bool,
}

struct Named {
    path: PathBuf,
    refusal: Refusal,
}

/// A root that opened: the folder its path reached, and its watch once a
/// page asked to hear it.
struct Opened {
    directory: Directory,
    /// Held for the root's life: dropping it stops the watch.
    watch: Option<FolderWatch>,
    listeners: Listeners,
}

impl State {
    fn running(&self) -> Result<(), RootError> {
        if self.stopped {
            Err(RootError::ShuttingDown)
        } else {
            Ok(())
        }
    }

    /// Whether `page` is still the page in the WebView `label`.
    fn current(&self, label: &str, page: u64) -> bool {
        self.pages.get(label) == Some(&page)
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
                root,
                Named {
                    path,
                    refusal: Arc::new(refusal),
                },
            );
            state.opened.remove(&root)
        };
        drop(replaced);
    }

    /// The path the shell named `root` at, as a person reads it: what the
    /// page shows, and what a link to Epicenter names.
    pub fn path(&self, root: Root) -> Result<PathBuf, RootError> {
        let state = self.state();
        state.running()?;
        state
            .named
            .get(&root)
            .map(|named| named.path.clone())
            .ok_or(RootError::NotNamed { root })
    }

    /// Open `root`: whatever is at its path, made when nothing is there.
    /// Each call looks again, so a folder that came back opens and a link
    /// pointed elsewhere is followed. Blocks on the disk.
    pub fn open(&self, root: Root) -> Result<Directory, RootError> {
        let (path, refusal) = {
            let state = self.state();
            state.running()?;
            let named = state.named.get(&root).ok_or(RootError::NotNamed { root })?;
            (named.path.clone(), named.refusal.clone())
        };
        let directory = reach(&path, &*refusal)?;
        let replaced = {
            let mut state = self.state();
            state.running()?;
            match state.opened.get(&root) {
                Some(opened) if opened.directory == directory => None,
                _ => state.opened.insert(
                    root,
                    Opened {
                        directory: directory.clone(),
                        watch: None,
                        listeners: Listeners::default(),
                    },
                ),
            }
        };
        // A replaced watch joins its thread when dropped: never under the lock.
        drop(replaced);
        Ok(directory)
    }

    /// The folder `root` reached when it last opened, cloned for one
    /// command: work already admitted keeps it whatever happens next. A
    /// root whose path, or a folder above it, is now a link whose target is
    /// gone is `Disconnected`, whether or not it opened before, and nothing
    /// is made.
    pub fn opened(&self, root: Root) -> Result<Directory, RootError> {
        let (path, opened) = {
            let state = self.state();
            state.running()?;
            let path = state
                .named
                .get(&root)
                .map(|named| named.path.clone())
                .ok_or(RootError::NotNamed { root })?;
            (
                path,
                state
                    .opened
                    .get(&root)
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
        opened.ok_or(RootError::NotOpen { root })
    }

    /// The current page of the WebView `label`, read before an open blocks.
    pub(crate) fn page(&self, label: &str) -> Result<u64, RootError> {
        let mut state = self.state();
        state.running()?;
        if let Some(page) = state.pages.get(label) {
            return Ok(*page);
        }
        state.last_page += 1;
        let page = state.last_page;
        state.pages.insert(label.to_string(), page);
        Ok(page)
    }

    /// Send `root`'s changes to `report`, the page `page` of the WebView
    /// `label`, in place of that WebView's earlier recipient. The root's one
    /// watch starts the first time a page asks. A page that has gone since
    /// it asked installs nothing.
    pub(crate) fn watch(
        &self,
        root: Root,
        directory: &Directory,
        label: &str,
        page: u64,
        report: impl Fn(FolderChanged) + Send + 'static,
    ) -> Result<(), RootError> {
        let gone = || RootError::Unavailable {
            folder: directory.root().display().to_string(),
            message: "the page that opened it has gone".into(),
        };
        let watched = {
            let state = self.state();
            state.running()?;
            if !state.current(label, page) {
                return Err(gone());
            }
            let opened = state
                .opened
                .get(&root)
                .filter(|opened| opened.directory == *directory)
                .ok_or(RootError::NotOpen { root })?;
            opened.watch.is_some()
        };
        let mut candidate = None;
        if !watched {
            // A recursive watch can walk a large tree as it starts: never
            // under the lock. Until installed below, it reports nothing.
            let listeners = Listeners::default();
            let heard = listeners.clone();
            let watch = FolderWatch::start(directory.root(), move |change| {
                for listener in lock(&heard).values() {
                    listener(change.clone());
                }
            })
            .map_err(|error| RootError::Unavailable {
                folder: directory.root().display().to_string(),
                message: error.to_string(),
            })?;
            candidate = Some((watch, listeners));
        }
        let mut state = self.state();
        state.running()?;
        if !state.current(label, page) {
            drop(state);
            return Err(gone());
        }
        let opened = state
            .opened
            .get_mut(&root)
            .filter(|opened| opened.directory == *directory)
            .ok_or(RootError::NotOpen { root })?;
        if opened.watch.is_none() {
            if let Some((watch, listeners)) = candidate.take() {
                watch.activate();
                opened.watch = Some(watch);
                opened.listeners = listeners;
            }
        }
        let previous = lock(&opened.listeners).insert(label.to_string(), Box::new(report));
        drop(state);
        // A duplicate watch, and the page's previous recipient, go after the lock.
        drop(previous);
        drop(candidate);
        Ok(())
    }

    /// A new page started loading in the WebView `label`: the previous
    /// page's recipients hear nothing more, and its unfinished opens
    /// install nothing.
    pub(crate) fn page_started(&self, label: &str) {
        let listeners = {
            let mut state = self.state();
            state.last_page += 1;
            let page = state.last_page;
            state.pages.insert(label.to_string(), page);
            Self::all_listeners(&state)
        };
        Self::forget(label, listeners);
    }

    /// The WebView `label` is gone: its recipients hear nothing more.
    pub(crate) fn page_gone(&self, label: &str) {
        let listeners = {
            let mut state = self.state();
            state.pages.remove(label);
            Self::all_listeners(&state)
        };
        Self::forget(label, listeners);
    }

    fn all_listeners(state: &State) -> Vec<Listeners> {
        state
            .opened
            .values()
            .map(|opened| opened.listeners.clone())
            .collect()
    }

    /// Remove `label`'s recipient from each root. Each removal waits for a
    /// change being reported, so nothing reaches the page once it returns.
    fn forget(label: &str, listeners: Vec<Listeners>) {
        for heard in listeners {
            let removed = lock(&heard).remove(label);
            drop(removed);
        }
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

/// Open whatever is at `path`, making the folder when nothing is there. A
/// link at `path`, or above it, is followed; one whose target is gone is
/// `Disconnected`, and nothing is made. A location `refusal` names a reason
/// for is refused, both before anything is made and once the folder is
/// there.
fn reach(path: &Path, refusal: &dyn Fn(&Path) -> Option<String>) -> Result<Directory, RootError> {
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
    use std::sync::mpsc;
    use std::time::Duration;

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
            roots.opened(Root::Data),
            Err(RootError::NotOpen { root: Root::Data })
        );
        assert_eq!(roots.open(Root::Data).unwrap().root(), data);
        assert!(data.is_dir());
        fs::write(data.join("a.md"), "kept").unwrap();
        roots.open(Root::Data).unwrap();
        assert_eq!(fs::read_to_string(data.join("a.md")).unwrap(), "kept");
        assert_eq!(
            roots.open(Root::AppData),
            Err(RootError::NotNamed {
                root: Root::AppData
            })
        );
        fs::remove_dir_all(&data).unwrap();
        fs::write(&data, "a file").unwrap();
        assert!(matches!(
            roots.open(Root::Data),
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
            roots.open(Root::Data),
            Err(RootError::Disconnected {
                folder: data.display().to_string(),
                target: drive.display().to_string(),
            })
        );
        assert!(!base.join("Volumes").exists());
        // A command asking for the root hears the same, and makes nothing.
        assert_eq!(
            roots.opened(Root::Data),
            Err(RootError::Disconnected {
                folder: data.display().to_string(),
                target: drive.display().to_string(),
            })
        );
        assert!(!base.join("Volumes").exists());
        // The drive comes back: the same open follows the link.
        fs::create_dir_all(&drive).unwrap();
        fs::write(drive.join("a.md"), "there").unwrap();
        assert_eq!(roots.open(Root::Data).unwrap().root(), drive);
        assert_eq!(roots.path(Root::Data).unwrap(), data);

        // A dangling link above the root is the same.
        let library = base.join("Library Link");
        symlink(base.join("Volumes/Gone"), &library).unwrap();
        roots.name(Root::Data, library.join("notes"), never);
        assert_eq!(
            roots.open(Root::Data),
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
            roots.open(Root::Data),
            Err(RootError::Refused { folder, .. }) if folder == data.display().to_string()
        ));
        // Through a linked parent, the location is still the one refused.
        let alias = base.join("alias");
        symlink(&base, &alias).unwrap();
        roots.name(Root::Data, alias.join("home"), refusal);
        assert!(matches!(
            roots.open(Root::Data),
            Err(RootError::Refused { .. })
        ));
        assert_eq!(fs::read_dir(&home).unwrap().count(), 1);
    }

    #[test]
    fn a_previous_page_cannot_install_a_recipient_and_a_reload_silences_it() {
        let (_temp, base) = base();
        let roots = Roots::default();
        roots.name(Root::Data, base.join("notes"), never);
        let directory = roots.open(Root::Data).unwrap();
        let old = roots.page("main").unwrap();
        roots.page_started("main");
        assert!(roots
            .watch(Root::Data, &directory, "main", old, |_| {})
            .is_err());
        let current = roots.page("main").unwrap();
        let (send, receive) = mpsc::channel();
        roots
            .watch(Root::Data, &directory, "main", current, move |change| {
                let _ = send.send(change);
            })
            .unwrap();
        fs::write(directory.root().join("a.md"), "a").unwrap();
        receive.recv_timeout(Duration::from_secs(5)).unwrap();
        roots.page_started("main");
        while receive.try_recv().is_ok() {}
        fs::write(directory.root().join("b.md"), "b").unwrap();
        assert!(receive.recv_timeout(Duration::from_millis(300)).is_err());
        roots.shutdown();
        assert_eq!(roots.open(Root::Data), Err(RootError::ShuttingDown));
        assert_eq!(roots.opened(Root::Data), Err(RootError::ShuttingDown));
    }

    #[test]
    fn concurrent_opens_install_only_one_watch_and_each_page_hears_it() {
        let (_temp, base) = base();
        let roots = Arc::new(Roots::default());
        roots.name(Root::Data, base.join("notes"), never);
        let directory = roots.open(Root::Data).unwrap();
        let start = Arc::new(std::sync::Barrier::new(4));
        let (send, receive) = mpsc::channel();
        let workers: Vec<_> = (0..4)
            .map(|id| {
                let (roots, directory, start, send) = (
                    roots.clone(),
                    directory.clone(),
                    start.clone(),
                    send.clone(),
                );
                std::thread::spawn(move || {
                    let label = format!("window-{id}");
                    let page = roots.page(&label).unwrap();
                    start.wait();
                    roots
                        .watch(Root::Data, &directory, &label, page, move |_| {
                            let _ = send.send(id);
                        })
                        .unwrap();
                })
            })
            .collect();
        for worker in workers {
            worker.join().unwrap();
        }
        fs::write(directory.root().join("a.md"), "a").unwrap();
        let mut heard = std::collections::BTreeSet::new();
        while heard.len() < 4 {
            heard.insert(receive.recv_timeout(Duration::from_secs(5)).unwrap());
        }
        roots.page_gone("window-0");
        roots.shutdown();
    }
}
