//! A binding's filesystem watch. Notifications carry scope, never file content.

use std::collections::BTreeSet;
use std::path::{Component, Path};
use std::sync::{Arc, Mutex};

use epicenter_folder_core::paths::readable_path_problem;
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use specta::Type;

/// Paths whose stored content may differ, or any path when scope is unknown.
#[derive(Debug, Clone, Serialize, Deserialize, Type, tauri_specta::Event)]
#[tauri_specta(event_name = "folder-changed")]
pub struct FolderChanged {
    pub paths: Option<Vec<String>>,
}

pub(crate) struct FolderWatch {
    _watcher: RecommendedWatcher,
    active: Arc<Mutex<bool>>,
}

impl FolderWatch {
    pub(crate) fn start(
        root: &Path,
        report: impl Fn(FolderChanged) + Send + 'static,
    ) -> notify::Result<Self> {
        let directory = root.to_path_buf();
        // Construction may recursively walk the filesystem before the binding
        // can install this watch. A duplicate or retired candidate emits nothing.
        let active = Arc::new(Mutex::new(false));
        let listening = active.clone();
        let mut watcher = RecommendedWatcher::new(
            move |event| {
                let active = listening.lock().unwrap_or_else(|error| error.into_inner());
                if !*active {
                    return;
                }
                if let Some(change) = observation(&directory, event) {
                    report(change);
                }
            },
            Config::default().with_follow_symlinks(false),
        )?;
        watcher.watch(root, RecursiveMode::Recursive)?;
        Ok(Self {
            _watcher: watcher,
            active,
        })
    }

    pub(crate) fn activate(&self) {
        *self
            .active
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = true;
    }

    /// Wait for a callback already emitting, then prevent every later emission.
    /// Call outside Folders' lock; reporting may synchronously invoke listeners.
    pub(crate) fn stop(&self) {
        *self
            .active
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = false;
    }
}

impl Drop for FolderWatch {
    fn drop(&mut self) {
        self.stop();
    }
}

fn observation(root: &Path, event: notify::Result<Event>) -> Option<FolderChanged> {
    let Ok(event) = event else {
        return Some(FolderChanged { paths: None });
    };
    if event.need_rescan() {
        return Some(FolderChanged { paths: None });
    }
    // Reading in response to a hint must not generate another hint.
    if matches!(event.kind, EventKind::Access(kind)
        if !matches!(kind, notify::event::AccessKind::Close(notify::event::AccessMode::Write)))
    {
        return None;
    }
    if event.paths.is_empty() {
        return Some(FolderChanged { paths: None });
    }
    let mut paths = BTreeSet::new();
    for absolute in event.paths {
        let Ok(relative) = absolute.strip_prefix(root) else {
            return Some(FolderChanged { paths: None });
        };
        let mut parts = Vec::new();
        for component in relative.components() {
            let Component::Normal(name) = component else {
                return Some(FolderChanged { paths: None });
            };
            let Some(name) = name.to_str() else {
                return Some(FolderChanged { paths: None });
            };
            parts.push(name);
        }
        if parts.iter().any(|name| name.eq_ignore_ascii_case(".git")) {
            continue;
        }
        let path = parts.join("/");
        if readable_path_problem(&path).is_some() {
            return Some(FolderChanged { paths: None });
        }
        paths.insert(path);
    }
    if paths.is_empty() {
        None
    } else {
        Some(FolderChanged {
            paths: Some(paths.into_iter().collect()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{AccessKind, AccessMode, Flag, ModifyKind, RenameMode};

    #[test]
    fn hints_keep_both_rename_paths_and_directory_scope() {
        let root = Path::new("/folder");
        let event = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
            .add_path(root.join("notes"))
            .add_path(root.join("archive"));
        assert_eq!(
            observation(root, Ok(event)).unwrap().paths,
            Some(vec!["archive".into(), "notes".into()])
        );
    }

    #[test]
    fn uncertainty_rescans_and_read_events_do_not_loop() {
        let root = Path::new("/folder");
        for event in [
            Event::new(EventKind::Other).set_flag(Flag::Rescan),
            Event::new(EventKind::Any),
            Event::new(EventKind::Any).add_path(root.to_path_buf()),
            Event::new(EventKind::Any).add_path("/elsewhere/a.md".into()),
        ] {
            assert_eq!(observation(root, Ok(event)).unwrap().paths, None);
        }
        assert_eq!(
            observation(root, Err(notify::Error::generic("overflow")))
                .unwrap()
                .paths,
            None
        );
        for kind in [
            AccessKind::Read,
            AccessKind::Open(AccessMode::Any),
            AccessKind::Close(AccessMode::Read),
            AccessKind::Any,
            AccessKind::Other,
        ] {
            assert!(observation(
                root,
                Ok(Event::new(EventKind::Access(kind)).add_path(root.join("notes/a.md")))
            )
            .is_none());
        }
        assert_eq!(
            observation(
                root,
                Ok(
                    Event::new(EventKind::Access(AccessKind::Close(AccessMode::Write)))
                        .add_path(root.join("notes/a.md"))
                )
            )
            .unwrap()
            .paths,
            Some(vec!["notes/a.md".into()])
        );
        assert!(observation(
            root,
            Ok(Event::new(EventKind::Any).add_path(root.join(".git/index")))
        )
        .is_none());
    }
}
