//! The macOS Accessibility-grant watch for auto-paste-at-cursor.
//!
//! Global-shortcut input is `tauri-plugin-global-shortcut` chords on every
//! platform (registered and dispatched by the Rust shell); this module owns no shortcut input
//! (ADR-0117). What survives is a macOS-only keyboard tap kept alive for one
//! reason: auto-paste-at-cursor writes a synthetic Cmd+V through the macOS
//! Accessibility grant, and a stale post-update grant reads as trusted through
//! `AXIsProcessTrusted` yet silently drops the paste. The only reliable way to
//! tell a healthy grant from a stale one is to run a real tap and watch whether
//! it stays alive; the supervisor does exactly that and publishes a
//! `DictationCapability` the paste path (`write_text`) gates on.
//!
//! Layering:
//! - `mac_tap`    the macOS tap (owned CGEventTap); it decodes nothing, it just
//!                lives so its death signals a stale grant
//! - `supervisor` the pure tap-lifecycle decision core (unit-tested)
//! - `event`      the `DictationCapability` value emitted to the FE
//!
//! Off macOS there is no grant to watch (paste needs no permission), so
//! `TapController` is a trivial stub: no tap, no supervisor, capability
//! `Unknown`, and `set_auto_paste_enabled` is a no-op.

pub mod commands;
pub mod event;
#[cfg(target_os = "macos")]
mod mac_tap;
#[cfg(target_os = "macos")]
mod supervisor;

pub use event::{DictationCapability, DictationCapabilityEvent};

use std::sync::{Arc, Mutex};

#[cfg(target_os = "macos")]
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
#[cfg(target_os = "macos")]
use std::time::{Duration, Instant};

#[cfg(target_os = "macos")]
use supervisor::{Control, Effect, Supervisor};

/// Whether this process may currently tap the keyboard: the live macOS
/// Accessibility check (`AXIsProcessTrusted`). This is the supervisor's raw
/// trust input, folded with tap liveness into the `DictationCapability` the
/// paste path reads. Consumers deciding whether a paste can land must read that
/// capability, not this bare probe: a `Broken` grant reads as trusted here but
/// cannot actually paste (see `write_text`).
#[cfg(target_os = "macos")]
fn is_trusted() -> bool {
    // SAFETY: `AXIsProcessTrusted` is an argument-free, thread-safe TCC query
    // with no side effects (unlike the `WithOptions` form, it never prompts).
    unsafe { accessibility_sys::AXIsProcessTrusted() }
}

/// The command-facing handle to the paste grant watch: it owns the current paste
/// capability and forwards the auto-paste intent to the supervisor. The tap
/// thread itself is owned by a supervisor spawned in `new` (macOS only). This
/// struct is constructed in `setup` and managed via `app.manage(...)` so commands
/// reach it with `app.state::<...>()`.
pub struct TapController {
    capability: Arc<Mutex<DictationCapability>>,
    /// Wakes the supervisor when auto-paste toggles, so it can start the tap the
    /// moment paste-at-cursor is enabled and stop it when it is disabled.
    #[cfg(target_os = "macos")]
    control_tx: Sender<Control>,
}

impl TapController {
    pub fn new() -> Self {
        let capability = Arc::new(Mutex::new(DictationCapability::Unknown));
        #[cfg(target_os = "macos")]
        {
            let (control_tx, control_rx) = mpsc::channel();
            spawn_supervisor(capability.clone(), control_tx.clone(), control_rx);
            Self {
                capability,
                control_tx,
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            // No grant to watch off macOS: paste needs no permission there.
            Self { capability }
        }
    }

    /// Tell the supervisor whether auto-paste-at-cursor is enabled. Paste writes
    /// through the macOS Accessibility grant the tap watches, so when it is on the
    /// supervisor holds the tap to track that grant (and surface the notice if it
    /// is missing). Pushed by the FE on launch and on change. A no-op off macOS.
    pub fn set_auto_paste_enabled(&self, enabled: bool) {
        #[cfg(target_os = "macos")]
        let _ = self.control_tx.send(Control::AutoPaste(enabled));
        #[cfg(not(target_os = "macos"))]
        let _ = enabled;
    }

    /// The current paste capability, for the FE's seed on attach.
    pub fn capability(&self) -> DictationCapability {
        self.capability
            .lock()
            .map(|c| *c)
            .unwrap_or(DictationCapability::Unknown)
    }
}

/// Store the new capability, which `get_dictation_capability` answers. The
/// supervisor is the only writer. Nothing is pushed to a page: the event went
/// to a window labelled `whispering`, which no longer exists, and ADR-0555
/// delivers it to the windows of the app that asked instead.
#[cfg(target_os = "macos")]
fn set_capability(cell: &Arc<Mutex<DictationCapability>>, next: DictationCapability) {
    if let Ok(mut current) = cell.lock() {
        *current = next;
    }
}

/// Spawn one Accessibility-grant watcher. Its passive tap runs until a tap break,
/// revoked grant, stale signature, or requested stop, then reports the exit over
/// `control_tx`. It decodes nothing and cannot swallow keystrokes; its liveness
/// is the whole signal. The supervisor serializes spawns, so exactly one watcher
/// is ever live.
#[cfg(target_os = "macos")]
fn spawn_grant_watcher(control_tx: &Sender<Control>) {
    let control_tx = control_tx.clone();
    std::thread::Builder::new()
        .name("accessibility-grant-watcher".into())
        .spawn(move || {
            if let Err(error) = mac_tap::listen() {
                log::error!("Accessibility grant watcher stopped: {error:?}");
            }
            // Hand the exit to the supervisor, which decides what it means
            // (revoked grant vs requested stop vs transient death vs stale
            // signature) and whether to restart.
            let _ = control_tx.send(Control::TapStopped);
        })
        .expect("failed to spawn Accessibility grant watcher thread");
}

#[cfg(target_os = "macos")]
fn spawn_supervisor(
    capability: Arc<Mutex<DictationCapability>>,
    control_tx: Sender<Control>,
    control_rx: std::sync::mpsc::Receiver<Control>,
) {
    std::thread::Builder::new()
        .name("dictation-capability-supervisor".into())
        .spawn(move || run_supervisor(capability, control_tx, control_rx))
        .expect("failed to spawn dictation capability supervisor thread");
}

/// The owning loop around [`Supervisor`]: it performs the I/O the pure decision
/// core cannot. Each turn it waits for a control message (or a bounded timeout),
/// samples `AXIsProcessTrusted`, steps the supervisor, and runs whatever the step
/// returned: spawn or stop the tap, publish the capability, and arm the next
/// wait. The supervisor decides; this loop acts, so exactly one tap is ever live.
///
/// Three facts the design rests on: the tap is only needed when auto-paste wants
/// the grant, `mac_tap` gives a thread-death signal but no positive "alive"
/// signal, and macOS gives no event when Accessibility flips. So the tap is
/// spawned only while wanted AND trusted (an untrusted tap silently drops events,
/// looking alive); its liveness is the death channel; and the grant is sampled by
/// a bounded poll that runs only while we want the tap but cannot run it.
#[cfg(target_os = "macos")]
fn run_supervisor(
    capability: Arc<Mutex<DictationCapability>>,
    control_tx: Sender<Control>,
    control_rx: std::sync::mpsc::Receiver<Control>,
) {
    let mut supervisor = Supervisor::new();
    // Monotonic clock for the restart-reset window; only the delta matters, so a
    // process-relative millisecond count is enough and keeps the core testable.
    let start = Instant::now();

    // Start dormant: auto-paste is off until the FE pushes its state on launch, so
    // the tap does not run and no Accessibility is touched.
    set_capability(&capability, DictationCapability::Inactive);

    // `None` blocks until a control message; `Some(d)` waits at most `d`, after
    // which a `None` control means the wait elapsed (a grant poll or an elapsed
    // restart backoff, told apart by the supervisor's own state).
    let mut next_timeout: Option<Duration> = None;
    loop {
        let control = match next_timeout {
            None => match control_rx.recv() {
                Ok(control) => Some(control),
                Err(_) => return,
            },
            Some(delay) => match control_rx.recv_timeout(delay) {
                Ok(control) => Some(control),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => return,
            },
        };

        let now_ms = start.elapsed().as_millis() as u64;
        let outcome = supervisor.step(control, is_trusted(), now_ms);

        match outcome.effect {
            Some(Effect::SpawnTap) => spawn_grant_watcher(&control_tx),
            Some(Effect::StopTap) => mac_tap::stop(),
            None => {}
        }
        set_capability(&capability, outcome.phase);
        next_timeout = outcome.next_timeout;
    }
}
