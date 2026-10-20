//! The desktop's one detector of changes made outside the page (ADR-0548):
//! a watcher on each granted root that tells the scope's windows which
//! paths may have changed.
//!
//! A root is watched from its first grant until `Folders::shutdown`, with
//! the operating system's recommended watcher (FSEvents on macOS), and its
//! events are debounced for `DEBOUNCE`. Each batch becomes one
//! `epicenter-folder://changed` event, `FolderChanged`, sent to every window
//! permitted into the scope and to no other:
//!
//! - a path outside `.git` is reported as itself, relative to the root with
//!   `/`, once per batch;
//! - paths inside `.git` are ignored. Its objects, refs, index, logs, and an
//!   older shell's staged files change no Folder read;
//!   A save stages beside the root, outside the watch, so its staged file
//!   is never reported, only the path it is renamed to;
//! - `paths: null` means anything may have changed: when watching begins,
//!   when the operating system reports it dropped events or must rescan
//!   (notify's `Flag::Rescan`, FSEvents' `MustScanSubDirs`), when a watch
//!   error arrives, when the root itself changes, and after the computer
//!   wakes from sleep (`keep_time`).
//!
//! The watch never follows a link: notify is configured not to, and no file
//! ID cache walks the tree, so nothing outside the root is read or watched. A
//! path an event names outside the root is ignored.
//!
//! The events carry no content. A page that hears one rereads through the
//! plugin's reads; a missed event costs a delay, never data, because the
//! files are the record. The page's own writes are seen too; at most that
//! rereads a file whose content did not change.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, SystemTime};

use notify::{EventKind, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer_opt, DebounceEventResult, Debouncer, NoCache};
use serde::Serialize;
use specta::Type;

/// The Tauri event a window listens to, emitted to each permitted window.
pub const FOLDER_CHANGED_EVENT: &str = "epicenter-folder://changed";

/// What may have changed in a granted folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct FolderChanged {
    /// The scope whose folder changed.
    pub scope: String,
    /// The changed paths, relative to the root with `/` and sorted, or
    /// `null` when anything may have changed.
    pub paths: Option<Vec<String>>,
}

/// How long the watcher waits for a burst of events to settle.
const DEBOUNCE: Duration = Duration::from_millis(50);

/// How often the clock is read to notice that the computer slept.
const CLOCK_TICK: Duration = Duration::from_secs(5);

/// How far past `CLOCK_TICK` the wall clock must move between two readings
/// to count as a sleep.
const SLEEP_GAP: Duration = Duration::from_secs(30);

/// Delivers one batch for a scope: `Some(paths)`, or `None` for everything.
pub(crate) type Report = Arc<dyn Fn(Option<Vec<String>>) + Send + Sync>;

/// What one batch of events reports.
#[derive(Debug, PartialEq, Eq)]
enum Batch {
    Nothing,
    Paths(Vec<String>),
    Everything,
}

/// What one path an event names means to the page.
#[derive(Debug, PartialEq, Eq)]
enum Seen {
    /// A path outside `.git`, relative to the root with `/`.
    Path(String),
    /// The root itself, or a name that is not text: anything may have
    /// changed.
    Everything,
    /// Outside the root, or inside `.git`.
    Nothing,
}

fn seen(root: &Path, path: &Path) -> Seen {
    let Ok(relative) = path.strip_prefix(root) else {
        return Seen::Nothing;
    };
    let mut names = Vec::new();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Seen::Nothing;
        };
        let Some(name) = name.to_str() else {
            return Seen::Everything;
        };
        names.push(name);
    }
    match names.as_slice() {
        [] => Seen::Everything,
        [".git", ..] => Seen::Nothing,
        _ => Seen::Path(names.join("/")),
    }
}

fn batch<'a>(root: &Path, events: impl IntoIterator<Item = &'a notify::Event>) -> Batch {
    let mut paths = BTreeSet::new();
    for event in events {
        if event.need_rescan() {
            return Batch::Everything;
        }
        // Opening and reading a file changes nothing.
        if matches!(event.kind, EventKind::Access(_)) {
            continue;
        }
        for path in &event.paths {
            match seen(root, path) {
                Seen::Path(path) => {
                    paths.insert(path);
                }
                Seen::Everything => return Batch::Everything,
                Seen::Nothing => {}
            }
        }
    }
    if paths.is_empty() {
        Batch::Nothing
    } else {
        Batch::Paths(paths.into_iter().collect())
    }
}

/// One watcher per granted scope, and the clock that notices a sleep.
#[derive(Default)]
pub(crate) struct Watchers {
    shared: Arc<Shared>,
}

#[derive(Default)]
struct Shared {
    state: Mutex<State>,
    /// Wakes the clock when the watchers stop.
    stopping: Condvar,
}

#[derive(Default)]
struct State {
    watching: BTreeMap<String, Watching>,
    stopped: bool,
    clock_started: bool,
}

struct Watching {
    /// Dropping it stops the watch.
    _debouncer: Debouncer<RecommendedWatcher, NoCache>,
    report: Report,
}

impl Shared {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl Watchers {
    /// Watch `root`, the canonical root `scope` was granted, unless it is
    /// watched already or the watchers have stopped. Once watching begins,
    /// `report` hears everything once, then each batch.
    pub(crate) fn watch(&self, scope: &str, root: &Path, report: Report) -> Result<(), String> {
        let mut state = self.shared.state();
        if state.stopped || state.watching.contains_key(scope) {
            return Ok(());
        }
        let debouncer = start(root, Arc::clone(&report))?;
        state.watching.insert(
            scope.to_string(),
            Watching {
                _debouncer: debouncer,
                report: Arc::clone(&report),
            },
        );
        if !state.clock_started {
            state.clock_started = true;
            let shared = Arc::clone(&self.shared);
            // Without the clock a sleep goes unreported; the watch still works.
            let _ = std::thread::Builder::new()
                .name("epicenter-folder-clock".to_string())
                .spawn(move || keep_time(&shared));
        }
        drop(state);
        report(None);
        Ok(())
    }

    /// Stop every watch and the clock. Nothing is watched afterward.
    pub(crate) fn shutdown(&self) {
        let watching = {
            let mut state = self.shared.state();
            state.stopped = true;
            std::mem::take(&mut state.watching)
        };
        self.shared.stopping.notify_all();
        drop(watching);
    }
}

/// Watch `root` and everything beneath it, without following links.
fn start(root: &Path, report: Report) -> Result<Debouncer<RecommendedWatcher, NoCache>, String> {
    let watched = root.to_path_buf();
    let mut debouncer = new_debouncer_opt::<_, RecommendedWatcher, NoCache>(
        DEBOUNCE,
        None,
        move |result: DebounceEventResult| {
            let found = match result {
                Ok(events) => batch(&watched, events.iter().map(|debounced| &debounced.event)),
                // Some events could not be delivered.
                Err(_) => Batch::Everything,
            };
            match found {
                Batch::Nothing => {}
                Batch::Paths(paths) => report(Some(paths)),
                Batch::Everything => report(None),
            }
        },
        NoCache,
        notify::Config::default().with_follow_symlinks(false),
    )
    .map_err(|cause| format!("'{}' could not be watched: {cause}", root.display()))?;
    debouncer
        .watch(root, RecursiveMode::Recursive)
        .map_err(|cause| format!("'{}' could not be watched: {cause}", root.display()))?;
    Ok(debouncer)
}

/// Read the wall clock every `CLOCK_TICK` until the watchers stop, and
/// report everything for every watched scope when it jumped: the computer
/// slept between two readings, and a watcher may have missed what changed
/// meanwhile, on a network volume or while its event stream was suspended.
/// A wall clock set by hand reads the same, and costs one reread.
fn keep_time(shared: &Shared) {
    let mut last = SystemTime::now();
    let mut state = shared.state();
    loop {
        if state.stopped {
            return;
        }
        state = shared
            .stopping
            .wait_timeout(state, CLOCK_TICK)
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .0;
        if state.stopped {
            return;
        }
        let now = SystemTime::now();
        let slept = woke(last, now);
        last = now;
        if slept {
            let reports: Vec<Report> = state
                .watching
                .values()
                .map(|watching| Arc::clone(&watching.report))
                .collect();
            drop(state);
            for report in reports {
                report(None);
            }
            state = shared.state();
        }
    }
}

/// Whether the wall clock moved from `last` to `now` by far more than the
/// clock's tick, or backward.
fn woke(last: SystemTime, now: SystemTime) -> bool {
    match now.duration_since(last) {
        Ok(elapsed) => elapsed > CLOCK_TICK + SLEEP_GAP,
        Err(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use notify::event::{AccessKind, CreateKind, Flag, ModifyKind, RemoveKind, RenameMode};
    use notify::Event;

    use super::*;

    fn root() -> PathBuf {
        PathBuf::from("/folders/notes")
    }

    fn event(kind: EventKind, paths: &[&str]) -> Event {
        paths
            .iter()
            .fold(Event::new(kind), |event, path| event.add_path(root().join(path)))
    }

    fn paths(found: &[&str]) -> Batch {
        Batch::Paths(found.iter().map(|path| path.to_string()).collect())
    }

    #[test]
    fn paths_outside_git_are_reported_once_each_relative_to_the_root() {
        let events = [
            event(EventKind::Create(CreateKind::File), &["todos/b.md"]),
            event(EventKind::Modify(ModifyKind::Any), &["todos/a.md"]),
            event(EventKind::Modify(ModifyKind::Any), &["todos/a.md"]),
            event(
                EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
                &["todos/c.md", "todos/d.md"],
            ),
            event(EventKind::Remove(RemoveKind::File), &[".obsidian/workspace.json"]),
        ];
        assert_eq!(
            batch(&root(), &events),
            paths(&[".obsidian/workspace.json", "todos/a.md", "todos/b.md", "todos/c.md", "todos/d.md"])
        );
    }

    #[test]
    fn paths_inside_git_are_ignored() {
        for path in [
            ".git",
            ".git/HEAD",
            ".git/packed-refs",
            ".git/refs/heads/main",
            ".git/refs/remotes/origin/main",
            ".git/objects/ab/cdef",
            ".git/index",
            ".git/index.lock",
            ".git/index.tmp-1",
            ".git/logs/HEAD",
            ".git/logs/refs/heads/main",
            ".git/HEAD.lock",
            ".git/refs/heads/main.lock",
            ".git/epicenter/scratch/staged-1",
            ".git/epicenter/scratch",
            ".git/config",
            ".git/FETCH_HEAD",
        ] {
            let events = [event(EventKind::Modify(ModifyKind::Any), &[path])];
            assert_eq!(batch(&root(), &events), Batch::Nothing, "{path}");
        }
    }

    #[test]
    fn a_rescan_the_root_itself_or_an_untextual_name_reports_everything() {
        let rescan = Event::new(EventKind::Other).set_flag(Flag::Rescan);
        let events = [event(EventKind::Modify(ModifyKind::Any), &["a.md"]), rescan];
        assert_eq!(batch(&root(), &events), Batch::Everything);
        let events = [event(EventKind::Remove(RemoveKind::Folder), &[""])];
        assert_eq!(batch(&root(), &events), Batch::Everything);
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStrExt;
            let name = std::ffi::OsStr::from_bytes(b"caf\xe9.md");
            let events = [Event::new(EventKind::Create(CreateKind::File)).add_path(root().join(name))];
            assert_eq!(batch(&root(), &events), Batch::Everything);
        }
    }

    #[test]
    fn reads_and_paths_outside_the_root_report_nothing() {
        let events = [
            event(EventKind::Access(AccessKind::Any), &["todos/a.md"]),
            Event::new(EventKind::Modify(ModifyKind::Any)).add_path(PathBuf::from("/folders/other/a.md")),
            Event::new(EventKind::Modify(ModifyKind::Any)).add_path(PathBuf::from("/folders/notes2/a.md")),
            Event::new(EventKind::Create(CreateKind::File))
                .add_path(PathBuf::from("/folders/.notes.epicenter-scratch/staged-1")),
        ];
        assert_eq!(batch(&root(), &events), Batch::Nothing);
    }

    /// A save renames its staged file from the scratch directory beside the
    /// root over its path: only the path is reported.
    #[test]
    fn a_save_renamed_in_from_beside_the_root_reports_only_its_path() {
        let events = [Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
            .add_path(PathBuf::from("/folders/.notes.epicenter-scratch/staged-1"))
            .add_path(root().join("todos/a.md"))];
        assert_eq!(batch(&root(), &events), paths(&["todos/a.md"]));
    }

    #[test]
    fn only_a_jump_of_the_wall_clock_counts_as_a_sleep() {
        let last = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        assert!(!woke(last, last + CLOCK_TICK));
        assert!(!woke(last, last + CLOCK_TICK + Duration::from_secs(1)));
        assert!(woke(last, last + CLOCK_TICK + SLEEP_GAP + Duration::from_secs(1)));
        assert!(woke(last, last + Duration::from_secs(3_600)));
        assert!(woke(last, last - Duration::from_secs(60)));
    }
}
