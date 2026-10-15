//! Which window may use which folder.
//!
//! The shell registers scopes: a scope ID, the folder's directory and the
//! fallbacks for what its repository does not configure, and the labels of
//! the windows that may edit it. `permit` adds a window to a registered
//! scope later. A page names only the scope ID. It never supplies a root or
//! an author, so a compromised page cannot point the folder somewhere else.
//!
//! Each permitted window's page runs `@epicenter/folder`'s engine over the
//! directory. The first `grant` takes the folder's cross-process lock and
//! every grant, from any permitted window, hands back the same canonical
//! root; the lock is held until `shutdown`, so no other process opens the
//! folder meanwhile. Each file change or `git` run a page asks for holds a
//! `PageWork` while it runs; `shutdown` refuses new ones and waits a bounded
//! time for those running in every window, so a quit never cuts a rename or
//! a `git` run short.
//!
//! Several windows may edit one folder because the shell, not the page,
//! decides every publish. Each publishing rename and removal checks its path
//! against the page's expectation and changes it under one mutex per
//! canonical root, held here and shared by every scope and window on that
//! root (`PageWork::publishing`). So a save through the shell is never
//! overtaken between its check and its rename by another save through the
//! shell, whichever window, engine, or origin made either. Another process
//! would publish outside that mutex, which is what the lock keeps out.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::Duration;

use serde::Serialize;
use specta::Type;

use crate::lock::{LockError, RootLock};
use crate::root::{prepare_directory, resolve_root, verify_layout};

/// Who a version is recorded as when Git's configuration names no one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Author {
    pub name: String,
    pub email: String,
}

/// One folder as the shell registers it. Everything else (the remote, the
/// author Git's configuration names, what is tracked) is the repository's,
/// read by the page's engine.
#[derive(Debug, Clone)]
pub struct FolderConfig {
    /// The folder's directory, chosen by the shell. The first grant creates
    /// it if it is missing.
    pub root: PathBuf,
    /// The fallback author for whichever of `user.name` and `user.email` Git's
    /// configuration does not set.
    pub author: Author,
    /// The local branch history is recorded on.
    pub branch: String,
}

impl FolderConfig {
    pub fn new(root: impl Into<PathBuf>, author: Author) -> Self {
        Self {
            root: root.into(),
            author,
            branch: "main".to_string(),
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

/// Why a window was not given a folder, or a change or `git` run for it was
/// not admitted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "name")]
pub enum GrantError {
    /// The shell registered no folder under this scope.
    UnknownScope { scope: String },
    /// The scope exists, but is not registered for this window.
    WindowNotPermitted { scope: String, window: String },
    /// Another process holds the folder.
    Busy { root: String },
    /// The folder could not be prepared, locked, or reached.
    Unavailable { message: String },
    /// The shell is shutting its folders down.
    ShuttingDown,
}

struct Scope {
    config: ScopeConfig,
    /// Once granted: the canonical root and the lock held for it.
    granted: Option<(PathBuf, RootLock)>,
}

/// What a scope's window is given: where its folder is, and the shell's
/// fallbacks for what the repository does not configure.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Granted {
    /// The canonical root, as an absolute path.
    pub root: String,
    pub branch: String,
    pub author_name: String,
    pub author_email: String,
}

/// How long `shutdown` waits for page work already running.
const PAGE_WORK_GRACE: Duration = Duration::from_secs(10);

/// The page changes and `git` runs in progress.
#[derive(Default)]
struct Running {
    count: Mutex<usize>,
    settled: Condvar,
}

/// One admitted page change or `git` run; dropping it ends it.
pub struct PageWork {
    running: Arc<Running>,
    /// The publishing mutex of the root the work was admitted for.
    publishing: Arc<Mutex<()>>,
}

impl PageWork {
    /// Hold the root's publishing mutex: a rename or removal that checks its
    /// path and then changes it holds this across both, so no other change
    /// through the shell on the same root lands in between.
    pub fn publishing(&self) -> MutexGuard<'_, ()> {
        self.publishing
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl Drop for PageWork {
    fn drop(&mut self) {
        let mut count = self.running.count.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        *count -= 1;
        if *count == 0 {
            self.running.settled.notify_all();
        }
    }
}

#[derive(Default)]
pub struct Registry {
    scopes: Mutex<BTreeMap<String, Scope>>,
    fenced: AtomicBool,
    running: Arc<Running>,
    /// One publishing mutex per canonical root, whichever scopes reach it.
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

    /// Give `window` the directory of `scope`. The first grant, from whichever
    /// permitted window asks first, creates the directory if it is missing,
    /// refuses a directory that is a link or Git state that would send writes
    /// elsewhere (`verify_layout`), and takes the folder's cross-process lock;
    /// every later grant, a reloaded page's or another window's, returns the
    /// same root under the same lock.
    pub fn grant(&self, scope: &str, window: &str) -> Result<Granted, GrantError> {
        let mut scopes = self.scopes();
        if self.fenced.load(Ordering::SeqCst) {
            return Err(GrantError::ShuttingDown);
        }
        let entry = Self::permitted(&mut scopes, scope, window)?;
        let folder = &entry.config.folder;
        if entry.granted.is_none() {
            let unavailable = |message: String| GrantError::Unavailable { message };
            prepare_directory(&folder.root).map_err(unavailable)?;
            let root = resolve_root(&folder.root).map_err(unavailable)?;
            let lock = RootLock::acquire(&root).map_err(|error| match error {
                LockError::Busy { root } => GrantError::Busy {
                    root: root.display().to_string(),
                },
                LockError::Failed { message } => unavailable(message),
            })?;
            verify_layout(&root).map_err(unavailable)?;
            entry.granted = Some((root, lock));
        }
        let (root, _) = entry.granted.as_ref().expect("the scope was just granted");
        Ok(Granted {
            root: root.to_string_lossy().into_owned(),
            branch: folder.branch.clone(),
            author_name: folder.author.name.clone(),
            author_email: folder.author.email.clone(),
        })
    }

    /// Admit one page change or `git` run for `window`'s grant of `scope`:
    /// its canonical root, and the `PageWork` to hold until it ends. Refused
    /// once `shutdown` has begun.
    pub fn admit_page_work(
        &self,
        scope: &str,
        window: &str,
    ) -> Result<(PathBuf, PageWork), GrantError> {
        let root = self.granted_root(scope, window)?;
        let mut count = self.running.count.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.fenced.load(Ordering::SeqCst) {
            return Err(GrantError::ShuttingDown);
        }
        *count += 1;
        let publishing = Arc::clone(
            self.publishing
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .entry(root.clone())
                .or_default(),
        );
        Ok((
            root,
            PageWork {
                running: Arc::clone(&self.running),
                publishing,
            },
        ))
    }

    /// The canonical root of `scope`, already granted, if `window` is one of
    /// its windows: where that window's changes and Git commands run.
    pub fn granted_root(&self, scope: &str, window: &str) -> Result<PathBuf, GrantError> {
        let mut scopes = self.scopes();
        if self.fenced.load(Ordering::SeqCst) {
            return Err(GrantError::ShuttingDown);
        }
        match &Self::permitted(&mut scopes, scope, window)?.granted {
            Some((root, _)) => Ok(root.clone()),
            None => Err(GrantError::Unavailable {
                message: format!("the folder scope '{scope}' has not been granted yet"),
            }),
        }
    }

    /// Fence new grants and page work, wait up to ten seconds for page work
    /// already running, then release every folder's cross-process lock. Pages
    /// settle their own work before they approve a quit; the wait covers a
    /// change or a `git` run still in flight when they did.
    pub fn shutdown(&self) {
        {
            // Fenced under the count's lock, so no work is admitted after the
            // wait below has seen zero.
            let count = self.running.count.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            self.fenced.store(true, Ordering::SeqCst);
            let _ = self
                .running
                .settled
                .wait_timeout_while(count, PAGE_WORK_GRACE, |count| *count > 0);
        }
        let locks: Vec<RootLock> = self
            .scopes()
            .values_mut()
            .filter_map(|scope| scope.granted.take().map(|(_, lock)| lock))
            .collect();
        drop(locks);
    }
}
