//! Close each application at its document owner before changing desktop identity.
//! The transaction tracks windows, never application resources. Missing or failed
//! acknowledgments refuse the transition; only a successful close permits destroy.

use std::collections::BTreeSet;
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use tauri::{Emitter, Manager, State, WebviewWindow, WindowEvent, Wry};

use crate::{BuiltInApp, DesktopAppHandle, HostState, APP_WINDOW_PREFIX};

const CLOSE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Default)]
pub struct ApplicationClose {
    transaction: Mutex<Option<Transaction>>,
}

struct Transaction {
    request_id: String,
    closed: bool,
    pending: BTreeSet<String>,
    results: mpsc::Sender<(String, Option<String>)>,
}

impl ApplicationClose {
    pub fn blocks_launch(&self) -> bool {
        self.transaction
            .lock()
            .expect("application close lock poisoned")
            .is_some()
    }

    pub fn abandon(&self) {
        self.transaction
            .lock()
            .expect("application close lock poisoned")
            .take();
    }

    pub fn is_closed(&self) -> bool {
        self.transaction
            .lock()
            .expect("application close lock poisoned")
            .as_ref()
            .is_some_and(|transaction| transaction.closed)
    }

    pub fn resume_closed(&self) -> Result<()> {
        let mut transaction = self
            .transaction
            .lock()
            .expect("application close lock poisoned");
        if transaction
            .as_ref()
            .is_some_and(|transaction| !transaction.closed)
        {
            bail!("Applications have not finished closing.");
        }
        transaction.take();
        Ok(())
    }

    fn complete(&self, request_id: &str, success: bool) {
        let mut transaction = self
            .transaction
            .lock()
            .expect("application close lock poisoned");
        if let Some(current) = transaction
            .as_mut()
            .filter(|current| current.request_id == request_id)
        {
            if success {
                current.closed = true;
            } else {
                transaction.take();
            }
        }
    }

    fn begin(
        &self,
        request_id: &str,
        labels: BTreeSet<String>,
    ) -> Result<mpsc::Receiver<(String, Option<String>)>> {
        let mut transaction = self
            .transaction
            .lock()
            .expect("application close lock poisoned");
        if transaction.is_some() {
            bail!("Applications are already closed or closing.");
        }
        let (results, receiver) = mpsc::channel();
        *transaction = Some(Transaction {
            request_id: request_id.to_owned(),
            closed: false,
            pending: labels,
            results,
        });
        Ok(receiver)
    }

    fn finish(&self, request_id: &str, label: &str, error: Option<String>) -> Result<()> {
        let mut transaction = self
            .transaction
            .lock()
            .expect("application close lock poisoned");
        let Some(transaction) = transaction.as_mut() else {
            bail!("No application close is pending.");
        };
        if transaction.request_id != request_id || !transaction.pending.remove(label) {
            bail!("This window has no pending close for that request.");
        }
        transaction
            .results
            .send((label.to_owned(), error))
            .context("application close is no longer waiting")
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloseRequest {
    request_id: String,
}

#[tauri::command]
pub fn finish_application_close(
    window: WebviewWindow<Wry>,
    state: State<'_, ApplicationClose>,
    request_id: String,
    error: Option<String>,
) -> std::result::Result<(), String> {
    state
        .finish(&request_id, window.label(), error)
        .map_err(|error| error.to_string())
}

fn is_application(label: &str) -> bool {
    label.starts_with(APP_WINDOW_PREFIX)
        || BuiltInApp::from_id(label).is_some_and(BuiltInApp::is_launchable)
}

/// Runs off the event loop and Bun's frame reader. Application cleanup may
/// itself call native operations, so neither of those owners may wait here.
pub fn close_applications(
    app: &DesktopAppHandle,
    generation: u64,
    request_id: String,
) -> Result<()> {
    // Reserve before scheduling. Timeout cancellation removes this exact owner,
    // so a late main-thread callback cannot start closing after we refused.
    let host = app.state::<HostState>();
    let process = host.process.lock().expect("host state lock poisoned");
    if !process
        .as_ref()
        .is_some_and(|process| process.generation == generation)
    {
        bail!("The requesting desktop generation has ended.");
    }
    let results = app
        .state::<ApplicationClose>()
        .begin(&request_id, BTreeSet::new())?;
    drop(process);
    let (sender, receiver) = mpsc::sync_channel(1);
    let main_app = app.clone();
    let completed_id = request_id.clone();
    let scheduled = app.run_on_main_thread(move || {
        let result: Result<_> = (|| {
            let state = main_app.state::<ApplicationClose>();
            let mut transaction = state
                .transaction
                .lock()
                .expect("application close lock poisoned");
            let current = transaction
                .as_mut()
                .filter(|current| current.request_id == request_id)
                .context("Application close was cancelled before it started.")?;
            let windows: Vec<_> = main_app
                .webview_windows()
                .into_iter()
                .filter(|(label, _)| is_application(label))
                .collect();
            current.pending = windows.iter().map(|(label, _)| label.clone()).collect();
            for (label, _) in &windows {
                main_app.emit_to(
                    label.as_str(),
                    "epicenter:close-application",
                    CloseRequest {
                        request_id: request_id.clone(),
                    },
                )?;
            }
            Ok(windows.len())
        })();
        let _ = sender.send(result);
    });
    let result = (|| {
        scheduled?;
        let count = receiver
            .recv_timeout(CLOSE_TIMEOUT)
            .context("The desktop did not begin closing applications.")??;
        let deadline = Instant::now() + CLOSE_TIMEOUT;
        let mut failures = Vec::new();
        for _ in 0..count {
            let (label, error) = results
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .context("An application did not finish closing. The server was not changed.")?;
            if let Some(error) = error {
                failures.push(format!("{label}: {error}"));
            } else if let Err(error) = destroy_closed_window(app, &completed_id, &label, deadline) {
                failures.push(format!("{label}: {error}"));
            }
        }
        if !failures.is_empty() {
            bail!("Could not close applications: {}", failures.join("; "));
        }
        Ok(())
    })();
    app.state::<ApplicationClose>()
        .complete(&completed_id, result.is_ok());
    result
}

fn destroy_closed_window(
    app: &DesktopAppHandle,
    request_id: &str,
    label: &str,
    deadline: Instant,
) -> Result<()> {
    let (sender, receiver) = mpsc::channel();
    let main_app = app.clone();
    let label = label.to_owned();
    let request_id = request_id.to_owned();
    app.run_on_main_thread(move || {
        let state = main_app.state::<ApplicationClose>();
        let transaction = state
            .transaction
            .lock()
            .expect("application close lock poisoned");
        if !transaction
            .as_ref()
            .is_some_and(|current| current.request_id == request_id)
        {
            let _ = sender.send(Err(anyhow!("Application close is no longer active.")));
            return;
        }
        let Some(window) = main_app.get_webview_window(&label) else {
            let _ = sender.send(Ok(()));
            return;
        };
        let destroyed = sender.clone();
        window.on_window_event(move |event| {
            if matches!(event, WindowEvent::Destroyed) {
                let _ = destroyed.send(Ok(()));
            }
        });
        if let Err(error) = window.destroy() {
            let _ = sender.send(Err(anyhow!(error)));
        }
    })?;
    receiver
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .context("A closed application window did not finish closing.")?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_builds_enable_application_close_acknowledgements() {
        for (config, capability) in [
            (
                include_str!("../tauri.conf.json"),
                include_str!("../capabilities/application-close-production.json"),
            ),
            (
                include_str!("../tauri.dev.conf.json"),
                include_str!("../capabilities/application-close-development.json"),
            ),
        ] {
            let config: serde_json::Value = serde_json::from_str(config).unwrap();
            let capability: serde_json::Value = serde_json::from_str(capability).unwrap();
            assert!(
                config["app"]["security"]["capabilities"]
                    .as_array()
                    .unwrap()
                    .contains(&capability["identifier"]),
                "{} must be enabled so application closure can finish",
                capability["identifier"]
            );
            let permissions = capability["permissions"].as_array().unwrap();
            for permission in [
                "core:event:allow-listen",
                "core:event:allow-unlisten",
                "allow-finish-application-close",
            ] {
                assert!(permissions.contains(&serde_json::json!(permission)));
            }
        }
    }

    #[test]
    fn close_requires_the_exact_request_and_native_caller_window() {
        let state = ApplicationClose::default();
        let receiver = state
            .begin("one", ["whispering".into(), "app-notes".into()].into())
            .unwrap();
        assert!(state.blocks_launch());
        assert!(state.finish("wrong", "whispering", None).is_err());
        assert!(state.finish("one", "home", None).is_err());
        state.finish("one", "whispering", None).unwrap();
        assert!(state.finish("one", "whispering", None).is_err());
        assert_eq!(receiver.recv().unwrap(), ("whispering".into(), None));
        state
            .finish("one", "app-notes", Some("save failed".into()))
            .unwrap();
        assert_eq!(
            receiver.recv().unwrap(),
            ("app-notes".into(), Some("save failed".into()))
        );
        assert!(state.blocks_launch());
        state.abandon();
        assert!(!state.blocks_launch());
        assert!(state.finish("one", "app-notes", None).is_err());
    }

    #[test]
    fn a_cancelled_request_cannot_clear_or_acknowledge_a_later_transaction() {
        let state = ApplicationClose::default();
        let _old = state.begin("old", BTreeSet::new()).unwrap();
        state.complete("old", false);
        assert!(!state.blocks_launch());
        let _new = state.begin("new", ["whispering".into()].into()).unwrap();
        state.complete("old", false);
        assert!(state.blocks_launch());
        assert!(state.finish("old", "whispering", None).is_err());
        assert!(state.resume_closed().is_err());
        state.finish("new", "whispering", None).unwrap();
        state.complete("new", true);
        assert!(state.is_closed());
        state.resume_closed().unwrap();
        assert!(!state.blocks_launch());
    }

    #[test]
    fn hidden_application_labels_participate_but_home_and_overlay_do_not() {
        for label in ["whispering", "honeycrisp", "mail", "app-notes"] {
            assert!(is_application(label));
        }
        for label in ["home", "books", "whispering-overlay", "overlay"] {
            assert!(!is_application(label));
        }
    }
}
