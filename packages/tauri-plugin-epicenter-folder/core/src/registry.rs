//! Which window may use which folder.
//!
//! The shell registers scopes: a scope ID, the folder's directory, and the
//! labels of the windows that may edit it. `permit` adds a window to a registered
//! scope later. A page names only the scope ID. It never supplies a root or
//! an author, so a compromised page cannot point the folder somewhere else.
//!
//! Each permitted window's page runs `@epicenter/folder`'s engine over the
//! directory. Every `grant` checks the directory, and each permitted window
//! receives the same canonical root. Each file change a page asks for
//! holds a `PageWork` while it runs; `shutdown` refuses new ones and waits
//! for none. Quitting is immediate (ADR-0542): every save is an atomic
//! rename, so a quit leaves each file whole. The folder's Git runs in the
//! `epicenter` CLI, which the shell starts for a page (ADR-0559), over the
//! root `granted_root` names.
//!
//! Several windows may edit one folder because the shell, not the page,
//! decides every publish. Each publishing rename and removal checks its path
//! against the page's expectation and changes it under one mutex per
//! canonical root, held here and shared by every window and every scope of
//! the folder (`PageWork::publishing`). So a save through the shell is never
//! overtaken between its check and its rename by another save through the
//! shell, whichever window, scope, engine, or origin made either. Another
//! process, a second Epicenter shell or a Bun process such as the
//! `epicenter` CLI, takes turns with it under the folder's save lock
//! (`lock::SaveLock`), held with the mutex across each check and change
//! (ADR-0562, ADR-0568).
//!
//! A folder is an application's own (`FolderKind::Application`), whose
//! directory the shell chose and creates, or a data folder a person made
//! (`FolderKind::Data`), which the shell opens only as it finds it.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;
use specta::Type;

use crate::lock::{SaveLock, SAVE_LOCK_WAIT};
use crate::root::{prepare_directory, resolve_root, verify_layout, PrepareError};

/// Whose directory a folder is, which decides what the shell may do to it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FolderKind {
    /// An application's own folder, at a directory the shell chose. The
    /// first grant creates the directory when it is missing, and the page's
    /// engine gives it a repository of its own wherever it is, as the Bun
    /// `openFolder` does.
    Application,
    /// A data folder: a directory a person made, which the shell opens only
    /// as it finds it. A missing one is refused `Missing`, never created.
    Data,
}

/// One folder as the shell registers it. Everything else (the remote, the
/// author, the branch, what is tracked) is the repository's, read by the
/// page's engine and the `epicenter` CLI.
#[derive(Debug, Clone)]
pub struct FolderConfig {
    /// The folder's directory, chosen by the shell or found by it.
    pub root: PathBuf,
    pub kind: FolderKind,
}

impl FolderConfig {
    /// An application's own folder, whose directory the first grant creates
    /// when it is missing.
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            kind: FolderKind::Application,
        }
    }

    /// A data folder a person made, granted only while its directory exists.
    pub fn data(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            kind: FolderKind::Data,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ScopeConfig {
    /// The only thing a page names.
    pub scope: String,
    pub folder: FolderConfig,
    /// The labels of the windows that may edit this scope; at least one.
    /// `Registry::permit` adds more once the scope is registered.
    pub windows: Vec<String>,
}

/// Why a window was not given a folder, or a change for it was not
/// admitted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "name")]
pub enum GrantError {
    /// The shell registered no folder under this scope.
    UnknownScope { scope: String },
    /// The scope exists, but is not registered for this window.
    WindowNotPermitted { scope: String, window: String },
    /// The registered directory is missing. The shell creates a fixed
    /// application folder only on its first grant.
    Missing { root: String },
    /// The folder could not be prepared or reached.
    Unavailable { message: String },
    /// The shell is shutting its folders down.
    ShuttingDown,
}

struct Scope {
    config: ScopeConfig,
    /// Once granted: the canonical root.
    granted: Option<PathBuf>,
}

/// What a scope's window is given: where its folder is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Granted {
    /// The canonical root, as an absolute path.
    pub root: String,
}

/// One admitted page change; dropping it ends it.
pub struct PageWork {
    /// The canonical root the work was admitted for.
    root: PathBuf,
    /// The publishing mutex of that root.
    publishing: Arc<Mutex<()>>,
}

/// A held turn to check and change a root's files: its publishing mutex,
/// for this shell's windows, then its save lock, for other processes.
/// Dropping it releases both.
pub struct Publishing<'a> {
    // Fields drop in order: the save lock before the mutex.
    _save: SaveLock,
    _turn: MutexGuard<'a, ()>,
}

impl PageWork {
    /// Hold the root's publishing mutex, then its save lock (`SaveLock`): a
    /// rename or removal that checks its path and then changes it holds both
    /// across the two, so no other change through the shell on the same
    /// root, and no save by the Bun host in another process, lands in
    /// between. Refused, changing nothing, when another process holds the
    /// save lock for longer than `SAVE_LOCK_WAIT`.
    pub fn publishing(&self) -> Result<Publishing<'_>, String> {
        let turn = self
            .publishing
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let save = SaveLock::acquire(&self.root, SAVE_LOCK_WAIT)?;
        Ok(Publishing {
            _save: save,
            _turn: turn,
        })
    }
}

#[derive(Default)]
pub struct Registry {
    scopes: Mutex<BTreeMap<String, Scope>>,
    fenced: AtomicBool,
    /// One publishing mutex per canonical root, shared by every scope and
    /// window of it.
    publishing: Mutex<BTreeMap<PathBuf, Arc<Mutex<()>>>>,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    fn scopes(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, Scope>> {
        self.scopes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Register a scope. Trusted shell code calls this once it has resolved
    /// its paths; afterward only its windows change, through `permit`.
    pub fn register(&self, config: ScopeConfig) -> Result<(), String> {
        if self.fenced.load(Ordering::SeqCst) {
            return Err("the folder registry is shutting down".to_string());
        }
        if config.scope.trim().is_empty() {
            return Err("a folder scope needs a nonempty ID".to_string());
        }
        if config.windows.is_empty() {
            return Err(format!(
                "the folder scope '{}' needs at least one window",
                config.scope
            ));
        }
        let mut scopes = self.scopes();
        if scopes.contains_key(&config.scope) {
            return Err(format!(
                "the folder scope '{}' is already registered",
                config.scope
            ));
        }
        scopes.insert(
            config.scope.clone(),
            Scope {
                config,
                granted: None,
            },
        );
        Ok(())
    }

    /// Let `window` edit the registered `scope` too. Trusted shell code calls
    /// this, as it does `register`; a window already permitted stays so. The
    /// window shares the scope's one root and lock, and each of its saves is
    /// checked and published under the root's mutex like any other window's.
    pub fn permit(&self, scope: &str, window: &str) -> Result<(), GrantError> {
        let mut scopes = self.scopes();
        if self.fenced.load(Ordering::SeqCst) {
            return Err(GrantError::ShuttingDown);
        }
        let Some(entry) = scopes.get_mut(scope) else {
            return Err(GrantError::UnknownScope {
                scope: scope.to_string(),
            });
        };
        let windows = &mut entry.config.windows;
        if !windows.iter().any(|permitted| permitted == window) {
            windows.push(window.to_string());
        }
        Ok(())
    }

    /// The labels of the windows permitted into `scope`, registered or
    /// permitted later; none for a scope that is not registered.
    pub fn windows(&self, scope: &str) -> Vec<String> {
        self.scopes()
            .get(scope)
            .map(|entry| entry.config.windows.clone())
            .unwrap_or_default()
    }

    /// The registered scope `scope`, if `window` is one of its windows.
    fn permitted<'a>(
        scopes: &'a mut BTreeMap<String, Scope>,
        scope: &str,
        window: &str,
    ) -> Result<&'a mut Scope, GrantError> {
        let Some(entry) = scopes.get_mut(scope) else {
            return Err(GrantError::UnknownScope {
                scope: scope.to_string(),
            });
        };
        if !entry.config.windows.iter().any(|permitted| permitted == window) {
            return Err(GrantError::WindowNotPermitted {
                scope: scope.to_string(),
                window: window.to_string(),
            });
        }
        Ok(entry)
    }

    /// Give `window` the directory of `scope`. The first grant creates a
    /// missing application folder. Every grant refuses a missing data folder
    /// and checks for a linked root or Git state that would send writes
    /// elsewhere. Later grants keep the original canonical root.
    pub fn grant(&self, scope: &str, window: &str) -> Result<Granted, GrantError> {
        let mut scopes = self.scopes();
        if self.fenced.load(Ordering::SeqCst) {
            return Err(GrantError::ShuttingDown);
        }
        let entry = Self::permitted(&mut scopes, scope, window)?;
        let folder = &entry.config.folder;
        let unavailable = |message: String| GrantError::Unavailable { message };
        prepare_directory(
            &folder.root,
            entry.granted.is_none() && folder.kind == FolderKind::Application,
        )
        .map_err(|error| match error {
            PrepareError::Missing => GrantError::Missing {
                root: folder.root.display().to_string(),
            },
            PrepareError::Failed(message) => unavailable(message),
        })?;
        let root = resolve_root(&folder.root).map_err(unavailable)?;
        verify_layout(&root).map_err(unavailable)?;
        if let Some(granted) = &entry.granted {
            if granted != &root {
                return Err(unavailable(format!(
                    "The registered folder '{}' now resolves to a different directory",
                    folder.root.display()
                )));
            }
        } else {
            entry.granted = Some(root);
        }
        let root = entry.granted.as_ref().expect("the scope was just granted");
        Ok(Granted {
            root: root.to_string_lossy().into_owned(),
        })
    }

    /// Admit one page change for `window`'s grant of `scope`:
    /// its canonical root, and the `PageWork` to hold until it ends. Refused
    /// once `shutdown` has begun.
    pub fn admit_page_work(
        &self,
        scope: &str,
        window: &str,
    ) -> Result<(PathBuf, PageWork), GrantError> {
        let root = self.granted_root(scope, window)?;
        let publishing = Arc::clone(
            self.publishing
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .entry(root.clone())
                .or_default(),
        );
        Ok((
            root.clone(),
            PageWork { root, publishing },
        ))
    }

    /// The canonical root of `scope`, already granted, if `window` is one of
    /// its windows: where that window's changes and Git commands run.
    pub fn granted_root(&self, scope: &str, window: &str) -> Result<PathBuf, GrantError> {
        let mut scopes = self.scopes();
        if self.fenced.load(Ordering::SeqCst) {
            return Err(GrantError::ShuttingDown);
        }
        let entry = Self::permitted(&mut scopes, scope, window)?;
        entry.granted.clone().ok_or_else(|| GrantError::Unavailable {
            message: format!("the folder scope '{scope}' has not been granted yet"),
        })
    }

    /// Fence new grants and page work. Work already running is not waited
    /// for: the process is ending, and each save is an atomic rename
    /// (ADR-0542).
    pub fn shutdown(&self) {
        self.fenced.store(true, Ordering::SeqCst);
    }
}
