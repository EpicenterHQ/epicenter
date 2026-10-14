//! Which window may use which folder.
//!
//! The shell registers scopes: a scope ID, the folder's root and history
//! policy, and the window labels allowed to use it. A page names only the
//! scope ID. It never supplies a root, an author, a remote, or a policy, so a
//! compromised page cannot point the owner somewhere else.
//!
//! The registry opens a scope's owner on first attach, after taking the
//! cross-process lock for the canonical root, and keeps it until `shutdown`.
//! Detaching a window drops that window's session and nothing else: the owner,
//! the work it already admitted, and every other window's session carry on.
//!
//! A scope whose folder sets `page_engine` has no owner. `grant` takes the
//! same cross-process lock on first use and hands the window the canonical
//! root; the page runs `@epicenter/folder`'s engine over it. The lock is held
//! until `shutdown`, so no other process opens the folder meanwhile. Each
//! file change or `git` run the page asks for holds a `PageWork` while it
//! runs; `shutdown` refuses new ones and waits a bounded time for those
//! running, so a quit never cuts a rename or a `git` run short.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde::Serialize;
use specta::Type;

use crate::files::{resolve_root, verify_layout};
use crate::lock::{LockError, RootLock};
use crate::owner::{FolderConfig, FolderOwner};

#[derive(Debug, Clone)]
pub struct ScopeConfig {
    /// The only thing a page names.
    pub scope: String,
    pub folder: FolderConfig,
    /// Labels of the windows that may attach to this scope.
    pub windows: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "name")]
pub enum AttachError {
    /// The shell registered no folder under this scope.
    UnknownScope { scope: String },
    /// The scope exists, but this window is not one of its windows.
    WindowNotPermitted { scope: String, window: String },
    /// Another process holds the folder.
    Busy { root: String },
    /// The folder could not be locked or opened.
    Unavailable { message: String },
    /// The shell is shutting its folders down.
    ShuttingDown,
    /// The page was built against another version of the command contract.
    Incompatible { host: u32, page: u32 },
    /// A grant named a scope the shell's owner opens: attach to it instead.
    UsesOwner { scope: String },
    /// An attach named a scope the page's own engine opens: grant it instead.
    UsesPageEngine { scope: String },
}

struct Opened {
    owner: FolderOwner,
    /// Held for as long as the owner exists; dropped after it has drained.
    lock: RootLock,
}

struct Scope {
    config: ScopeConfig,
    opened: Option<Opened>,
    /// For a page-engine scope: its canonical root and the lock held for it.
    granted: Option<(std::path::PathBuf, RootLock)>,
}

/// What a page-engine scope's window is given: where its folder is, and the
/// shell's fallbacks for what the repository does not configure.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Granted {
    /// The canonical root, as an absolute path.
    pub root: String,
    pub branch: String,
    pub author_name: String,
    pub author_email: String,
}

/// One window's use of one scope.
pub struct Session {
    scope: String,
    window: String,
    owner: FolderOwner,
}

impl Session {
    pub fn scope(&self) -> &str {
        &self.scope
    }

    pub fn window(&self) -> &str {
        &self.window
    }

    /// The owner, for the window this session was attached from and no other.
    pub fn authorize(&self, window: &str) -> Result<&FolderOwner, String> {
        if window == self.window {
            Ok(&self.owner)
        } else {
            Err(format!(
                "this folder session belongs to the window '{}', not '{window}'",
                self.window
            ))
        }
    }
}

/// How long `shutdown` waits for page work already running.
const PAGE_WORK_GRACE: Duration = Duration::from_secs(10);

/// The page-engine changes and `git` runs in progress.
#[derive(Default)]
struct Running {
    count: Mutex<usize>,
    settled: Condvar,
}

/// One admitted page change or `git` run; dropping it ends it.
pub struct PageWork(Arc<Running>);

impl Drop for PageWork {
    fn drop(&mut self) {
        let mut count = self.0.count.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        *count -= 1;
        if *count == 0 {
            self.0.settled.notify_all();
        }
    }
}

#[derive(Default)]
pub struct Registry {
    scopes: Mutex<BTreeMap<String, Scope>>,
    fenced: AtomicBool,
    running: Arc<Running>,
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
    /// its paths; a scope's configuration never changes afterward.
    pub fn register(&self, config: ScopeConfig) -> Result<(), String> {
        if self.fenced.load(Ordering::SeqCst) {
            return Err("the folder registry is shutting down".to_string());
        }
        if config.scope.trim().is_empty() {
            return Err("a folder scope needs a nonempty ID".to_string());
        }
        // One live editor per page-engine folder: its engine coordinates only
        // the page that opened it, so a second window would edit the same
        // files with no shared view of them.
        if config.folder.page_engine && config.windows.len() != 1 {
            return Err(format!(
                "the page-engine folder scope '{}' must name exactly one window",
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
                opened: None,
                granted: None,
            },
        );
        Ok(())
    }

    /// Attach `window` to `scope`, opening the folder if this is its first use.
    pub fn attach(&self, scope: &str, window: &str) -> Result<Session, AttachError> {
        let mut scopes = self.scopes();
        if self.fenced.load(Ordering::SeqCst) {
            return Err(AttachError::ShuttingDown);
        }
        let Some(entry) = scopes.get_mut(scope) else {
            return Err(AttachError::UnknownScope {
                scope: scope.to_string(),
            });
        };
        if !entry
            .config
            .windows
            .iter()
            .any(|permitted| permitted == window)
        {
            return Err(AttachError::WindowNotPermitted {
                scope: scope.to_string(),
                window: window.to_string(),
            });
        }
        if entry.config.folder.page_engine {
            return Err(AttachError::UsesPageEngine {
                scope: scope.to_string(),
            });
        }
        if entry.opened.is_none() {
            let unavailable = |message: String| AttachError::Unavailable { message };
            // Lock the canonical directory before Git is initialized there.
            let root = resolve_root(&entry.config.folder.root).map_err(unavailable)?;
            let lock = RootLock::acquire(&root).map_err(|error| match error {
                LockError::Busy { root } => AttachError::Busy {
                    root: root.display().to_string(),
                },
                LockError::Failed { message } => unavailable(message),
            })?;
            let owner = FolderOwner::open(FolderConfig {
                root,
                ..entry.config.folder.clone()
            })
            .map_err(unavailable)?;
            entry.opened = Some(Opened { owner, lock });
        }
        let opened = entry.opened.as_ref().expect("the scope was just opened");
        Ok(Session {
            scope: scope.to_string(),
            window: window.to_string(),
            owner: opened.owner.clone(),
        })
    }

    /// Give `window` the directory of a page-engine `scope`. The first grant
    /// creates the directory if it is missing, refuses a directory that is a
    /// link or a `.git` or scratch directory linked elsewhere, and takes the
    /// folder's cross-process lock;
    /// later grants, from any permitted window, return the same root.
    pub fn grant(&self, scope: &str, window: &str) -> Result<Granted, AttachError> {
        let mut scopes = self.scopes();
        if self.fenced.load(Ordering::SeqCst) {
            return Err(AttachError::ShuttingDown);
        }
        let Some(entry) = scopes.get_mut(scope) else {
            return Err(AttachError::UnknownScope {
                scope: scope.to_string(),
            });
        };
        if !entry.config.windows.iter().any(|permitted| permitted == window) {
            return Err(AttachError::WindowNotPermitted {
                scope: scope.to_string(),
                window: window.to_string(),
            });
        }
        let folder = &entry.config.folder;
        if !folder.page_engine {
            return Err(AttachError::UsesOwner {
                scope: scope.to_string(),
            });
        }
        if entry.granted.is_none() {
            let unavailable = |message: String| AttachError::Unavailable { message };
            prepare_directory(&folder.root).map_err(unavailable)?;
            let root = resolve_root(&folder.root).map_err(unavailable)?;
            let lock = RootLock::acquire(&root).map_err(|error| match error {
                LockError::Busy { root } => AttachError::Busy {
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
    ) -> Result<(std::path::PathBuf, PageWork), AttachError> {
        let root = self.granted_root(scope, window)?;
        let mut count = self.running.count.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.fenced.load(Ordering::SeqCst) {
            return Err(AttachError::ShuttingDown);
        }
        *count += 1;
        Ok((root, PageWork(Arc::clone(&self.running))))
    }

    /// The canonical root of a page-engine `scope` already granted to a
    /// window that may use it: where that window's Git commands run.
    pub fn granted_root(&self, scope: &str, window: &str) -> Result<std::path::PathBuf, AttachError> {
        let scopes = self.scopes();
        if self.fenced.load(Ordering::SeqCst) {
            return Err(AttachError::ShuttingDown);
        }
        let Some(entry) = scopes.get(scope) else {
            return Err(AttachError::UnknownScope {
                scope: scope.to_string(),
            });
        };
        if !entry.config.windows.iter().any(|permitted| permitted == window) {
            return Err(AttachError::WindowNotPermitted {
                scope: scope.to_string(),
                window: window.to_string(),
            });
        }
        match &entry.granted {
            Some((root, _)) => Ok(root.clone()),
            None if entry.config.folder.page_engine => Err(AttachError::Unavailable {
                message: format!("the folder scope '{scope}' has not been granted yet"),
            }),
            None => Err(AttachError::UsesOwner {
                scope: scope.to_string(),
            }),
        }
    }

    /// Fence new attaches, grants, and page work; wait up to ten seconds for
    /// page work already running; drain every owner; then release every
    /// folder's cross-process lock. A page-engine folder's pages settle their
    /// own work before they approve the quit; the wait covers a change or a
    /// `git` run still in flight when they did.
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
        let (opened, granted): (Vec<Opened>, Vec<RootLock>) = {
            let mut scopes = self.scopes();
            let opened = scopes
                .values_mut()
                .filter_map(|scope| scope.opened.take())
                .collect();
            let granted = scopes
                .values_mut()
                .filter_map(|scope| scope.granted.take().map(|(_, lock)| lock))
                .collect();
            (opened, granted)
        };
        for Opened { owner, lock } in opened {
            owner.shutdown();
            drop(lock);
        }
        drop(granted);
    }
}

/// Make `root` exist as a real directory. Its parent may be a link a person
/// chose and is created when missing; `root` itself must be a directory, not
/// a link to one, so the folder never resolves outside where the shell put it.
fn prepare_directory(root: &std::path::Path) -> Result<(), String> {
    let failed = |cause: std::io::Error| {
        format!("The folder directory '{}' could not be created: {cause}", root.display())
    };
    if let Some(parent) = root.parent() {
        std::fs::create_dir_all(parent).map_err(failed)?;
    }
    match std::fs::create_dir(root) {
        Ok(()) => {}
        Err(cause) if cause.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(cause) => return Err(failed(cause)),
    }
    let kind = std::fs::symlink_metadata(root).map_err(failed)?.file_type();
    if kind.is_symlink() || !kind.is_dir() {
        return Err(format!(
            "The folder directory '{}' is a link or not a directory, so it was not opened",
            root.display()
        ));
    }
    Ok(())
}
