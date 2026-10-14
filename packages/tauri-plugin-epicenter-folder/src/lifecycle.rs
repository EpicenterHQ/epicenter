//! Which page of which webview a `git` run belongs to, kept by the plugin.
//!
//! A page names its `git` runs with its own request numbers, so `cancel_git`
//! can stop one. A number must reach only the runs of the page that chose
//! it: not the page a reload replaced, and not a window created later under
//! the same label. Two facts about Tauri shape how:
//!
//! - By the time a plugin hears `Destroyed`, the manager has already forgotten
//!   the window and its webviews (`on_event_loop_event` calls
//!   `manager.on_window_close` first). The webview, and its resource table,
//!   can no longer be reached by label.
//! - A label is not an identity. A window can be destroyed and another
//!   created under the same label while an old `Webview` handle is still
//!   held, by a request the old page sent that is only now delivered.
//!
//! So each actual webview gets its own `Instance`, made when Tauri announces
//! the webview and kept in that webview's own resource table. A handle's
//! clones share its table; a new webview under the same label has a new
//! table and a new instance. Commands and the page-load hook read the
//! instance of the webview they were given, never anything looked up by
//! label. A reload starts the instance's next page; a destroyed window ends
//! every instance recorded for it, which then has no page at all.

use std::sync::{Arc, Mutex, MutexGuard, Weak};

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct InstanceState {
    /// The instance's window was destroyed.
    ended: bool,
    page: u64,
}

/// One actual webview, from its creation to its window's destruction.
pub(crate) struct Instance {
    state: Mutex<InstanceState>,
}

/// One page of one instance.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Page(u64);

impl Page {
    /// The page's number within its webview: a reload is the next one.
    pub(crate) fn number(self) -> u64 {
        self.0
    }
}

impl Instance {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(InstanceState {
                ended: false,
                page: 0,
            }),
        })
    }

    /// The page this webview is on now, unless its window is gone.
    pub fn page(&self) -> Option<Page> {
        let state = lock(&self.state);
        (!state.ended).then_some(Page(state.page))
    }

    /// A page started loading in this webview: the page before it is over.
    pub fn page_started(&self) {
        lock(&self.state).page += 1;
    }

    /// This webview's window was destroyed.
    fn end(&self) {
        lock(&self.state).ended = true;
    }
}

/// The plugin's index of instances by the window that owns them, for the one
/// event that names a window and nothing else.
#[derive(Default)]
pub(crate) struct Lifecycles {
    by_window: Mutex<Vec<(String, Weak<Instance>)>>,
}

impl Lifecycles {
    /// A new instance for a webview Tauri just announced, owned by `window`.
    /// The caller stores it in that webview's own resource table.
    pub fn created(&self, window: &str) -> Arc<Instance> {
        let instance = Instance::new();
        let mut by_window = lock(&self.by_window);
        by_window.retain(|(_, known)| known.strong_count() > 0);
        by_window.push((window.to_string(), Arc::downgrade(&instance)));
        instance
    }

    /// `window` was destroyed. Every instance recorded for it is over. This
    /// needs nothing from Tauri's manager, which has already forgotten them.
    ///
    /// Tauri handles a window's destruction and announces its successor on
    /// the main thread, in that order, so the instances recorded for a label
    /// when its `Destroyed` arrives are the destroyed window's.
    pub fn window_destroyed(&self, window: &str) {
        let gone: Vec<Arc<Instance>> = {
            let mut by_window = lock(&self.by_window);
            let mut gone = Vec::new();
            by_window.retain(|(owner, instance)| {
                if owner != window {
                    return instance.strong_count() > 0;
                }
                gone.extend(instance.upgrade());
                false
            });
            gone
        };
        for instance in gone {
            instance.end();
        }
    }
}
