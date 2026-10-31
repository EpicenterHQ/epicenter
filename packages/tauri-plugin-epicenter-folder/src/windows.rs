//! One native window per application and canonical directory. Shells choose
//! the directory and configure Tauri's builder; this module owns construction.

use std::fmt;
use std::path::Path;
use std::sync::mpsc;

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::{BindError, Directory, Folders, WindowError};

pub trait FolderExt<R: Runtime>: Manager<R> {
    fn folders(&self) -> &Folders {
        self.state::<Folders>().inner()
    }

    /// Open one application on one admitted directory. Opening it again
    /// reveals the existing window without running `configure` again.
    ///
    /// The callback configures Tauri's actual builder; this operation binds
    /// before configuration, builds, rolls back failures, and reveals the
    /// window. Directory creation and admission remain the caller's policy.
    /// `configure` runs on the main thread and must preserve the supplied
    /// builder's identity. It must not reopen this pair or wait for a worker
    /// that opens a window. Call from setup or a blocking worker, not an
    /// async executor thread.
    fn open_folder_window<F>(
        &self,
        application: &str,
        directory: Directory,
        url: WebviewUrl,
        configure: F,
    ) -> Result<WebviewWindow<R>, OpenWindowError>
    where
        F: for<'a> FnOnce(
                WebviewWindowBuilder<'a, R, AppHandle<R>>,
            ) -> tauri::Result<WebviewWindowBuilder<'a, R, AppHandle<R>>>
            + Send
            + 'static,
    {
        self.open_folder_window_granting(application, directory, Vec::new(), url, configure)
    }

    /// `open_folder_window`, also granting `grants`: roots the page may name
    /// by their exact paths beside the window's own directory, such as the
    /// app's configuration directory. They are fixed with the binding and
    /// never watched. The window's identity is still its own directory.
    fn open_folder_window_granting<F>(
        &self,
        application: &str,
        directory: Directory,
        grants: Vec<Directory>,
        url: WebviewUrl,
        configure: F,
    ) -> Result<WebviewWindow<R>, OpenWindowError>
    where
        F: for<'a> FnOnce(
                WebviewWindowBuilder<'a, R, AppHandle<R>>,
            ) -> tauri::Result<WebviewWindowBuilder<'a, R, AppHandle<R>>>
            + Send
            + 'static,
    {
        let label = folder_window_label(application, directory.root());
        let app = self.app_handle().clone();
        let on_main = app.clone();
        let (send, receive) = mpsc::sync_channel(1);
        // Tauri runs this inline when already on its main thread, including
        // during setup. Lookup, reservation, and build are one main-thread act.
        app.run_on_main_thread(move || {
            let result = (|| {
                let bound = match on_main.folders().bound(&label) {
                    Ok(bound) => Some(bound),
                    Err(WindowError::NotBound) => None,
                    Err(error) => return Err(OpenWindowError::Folder(error)),
                };
                if let Some(window) = on_main.get_webview_window(&label) {
                    if bound.as_ref() != Some(&directory) {
                        return Err(OpenWindowError::Collision { label });
                    }
                    reveal(&window)?;
                    return Ok(window);
                }
                let window = on_main.folders().bind_while_building_granting(
                    &label,
                    directory,
                    grants,
                    || {
                        let builder = WebviewWindowBuilder::new(&on_main, &label, url);
                        let builder = configure(builder)?;
                        Ok::<_, OpenWindowError>(builder.visible(false).build()?)
                    },
                )?;
                // A presentation failure must retain a live window's binding.
                // A later open can try revealing it again.
                reveal(&window)?;
                Ok(window)
            })();
            let _ = send.send(result);
        })?;
        receive
            .recv()
            .map_err(|_| OpenWindowError::MainThreadStopped)?
    }
}

impl<R: Runtime, T: Manager<R>> FolderExt<R> for T {}

/// The label that `open_folder_window` will reserve before building its WebView.
pub fn folder_window_label(application: &str, root: &Path) -> String {
    let digest = Sha256::digest(root.as_os_str().as_encoded_bytes());
    let hex: String = digest[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("{application}:{hex}")
}

fn reveal<R: Runtime>(window: &WebviewWindow<R>) -> tauri::Result<()> {
    window.unminimize()?;
    window.show()?;
    window.set_focus()
}

#[derive(Debug)]
pub enum OpenWindowError {
    Bind(BindError),
    Folder(WindowError),
    Collision { label: String },
    Native(tauri::Error),
    MainThreadStopped,
}

impl fmt::Display for OpenWindowError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Bind(error) => error.fmt(f),
            Self::Folder(error) => error.fmt(f),
            Self::Collision { label } => write!(
                f,
                "The window '{label}' already exists without the requested directory binding."
            ),
            Self::Native(error) => error.fmt(f),
            Self::MainThreadStopped => {
                f.write_str("The main thread stopped before opening the folder window.")
            }
        }
    }
}

impl std::error::Error for OpenWindowError {}
impl From<BindError> for OpenWindowError {
    fn from(error: BindError) -> Self {
        Self::Bind(error)
    }
}
impl From<tauri::Error> for OpenWindowError {
    fn from(error: tauri::Error) -> Self {
        Self::Native(error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};

    struct Fixture {
        app: tauri::App<MockRuntime>,
        root: tempfile::TempDir,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.app.folders().shutdown();
        }
    }
    fn fixture() -> Fixture {
        Fixture {
            app: mock_builder()
                .plugin(crate::init())
                .build(mock_context(noop_assets()))
                .unwrap(),
            root: tempfile::tempdir().unwrap(),
        }
    }
    fn directory(fixture: &Fixture, path: &str) -> Directory {
        Directory::create(&fixture.root.path().join(path)).unwrap()
    }

    #[test]
    fn identity_is_the_application_and_canonical_root_with_one_configuration_per_window() {
        let fixture = fixture();
        let first = directory(&fixture, "home/Notes");
        let other = directory(&fixture, "work/Notes");
        let configured = Arc::new(AtomicUsize::new(0));
        let count = configured.clone();
        let window = fixture
            .app
            .open_folder_window("todos", first.clone(), Default::default(), move |builder| {
                count.fetch_add(1, Ordering::SeqCst);
                Ok(builder.title("Original"))
            })
            .unwrap();
        let again = Directory::existing(&first.root().join("../Notes")).unwrap();
        let count = configured.clone();
        let reused = fixture
            .app
            .open_folder_window("todos", again, Default::default(), move |builder| {
                count.fetch_add(1, Ordering::SeqCst);
                Ok(builder.title("Replacement"))
            })
            .unwrap();
        assert_eq!(window.label(), reused.label());
        assert_eq!(configured.load(Ordering::SeqCst), 1);
        let capture = fixture
            .app
            .open_folder_window("capture", first.clone(), Default::default(), |builder| {
                Ok(builder)
            })
            .unwrap();
        let work = fixture
            .app
            .open_folder_window("todos", other, Default::default(), |builder| Ok(builder))
            .unwrap();
        assert_ne!(window.label(), capture.label());
        assert_ne!(window.label(), work.label());
        assert_eq!(fixture.app.webview_windows().len(), 3);
        assert_eq!(fixture.app.folders().bound(window.label()).unwrap(), first);
        assert_eq!(window.label().len(), "todos:".len() + 32);
        assert!(!window.label().contains("Notes"));
    }

    #[test]
    fn equal_labels_in_separate_runtimes_do_not_collide() {
        let first = fixture();
        let second = fixture();
        let root = directory(&first, "Todos");
        let a = first
            .app
            .open_folder_window("todos", root.clone(), Default::default(), |builder| {
                Ok(builder)
            })
            .unwrap();
        let b = second
            .app
            .open_folder_window("todos", root, Default::default(), |builder| Ok(builder))
            .unwrap();
        assert_eq!(a.label(), b.label());
        assert_eq!(first.app.webview_windows().len(), 1);
        assert_eq!(second.app.webview_windows().len(), 1);
    }

    #[test]
    fn a_live_label_without_the_matching_directory_is_never_adopted() {
        for bind_other_root in [false, true] {
            let fixture = fixture();
            let root = directory(&fixture, "Todos");
            let key = folder_window_label("todos", root.root());
            let original = WebviewWindowBuilder::new(&fixture.app, &key, Default::default())
                .title("Unrelated")
                .build()
                .unwrap();
            if bind_other_root {
                fixture
                    .app
                    .folders()
                    .bind(&key, directory(&fixture, "Other"))
                    .unwrap();
            }
            let result = fixture
                .app
                .open_folder_window("todos", root, Default::default(), |_| {
                    panic!("a colliding window must not be configured")
                });
            assert!(matches!(result, Err(OpenWindowError::Collision { .. })));
            assert_eq!(original.label(), key);
            assert_eq!(fixture.app.webview_windows().len(), 1);
            if bind_other_root {
                assert_eq!(
                    fixture.app.folders().bound(&key).unwrap(),
                    directory(&fixture, "Other")
                );
            } else {
                assert!(fixture.app.folders().bound(&key).is_err());
            }
        }
    }

    #[test]
    fn configure_and_native_build_failures_release_the_reservation() {
        let fixture = fixture();
        let root = directory(&fixture, "Todos");
        let key = folder_window_label("todos", root.root());
        let handle = fixture.app.handle().clone();
        let expected = root.clone();
        let checking = key.clone();
        let failed =
            fixture
                .app
                .open_folder_window("todos", root.clone(), Default::default(), move |_| {
                    assert_eq!(handle.folders().bound(&checking).unwrap(), expected);
                    Err(tauri::Error::WindowNotFound)
                });
        assert!(matches!(failed, Err(OpenWindowError::Native(_))));
        assert!(fixture.app.folders().bound(&key).is_err());
        assert!(fixture.app.webview_windows().is_empty());
        let invalid = folder_window_label("invalid?", root.root());
        assert!(fixture
            .app
            .open_folder_window("invalid?", root.clone(), Default::default(), |builder| Ok(
                builder
            ))
            .is_err());
        assert!(fixture.app.folders().bound(&invalid).is_err());
        assert!(fixture.app.webview_windows().is_empty());
        fixture
            .app
            .open_folder_window("todos", root, Default::default(), |builder| Ok(builder))
            .unwrap();
        assert!(fixture.app.folders().bound(&key).is_ok());
    }

    #[test]
    fn shutdown_refuses_reuse_as_well_as_new_windows() {
        let fixture = fixture();
        let root = directory(&fixture, "Todos");
        fixture
            .app
            .open_folder_window("todos", root.clone(), Default::default(), |builder| {
                Ok(builder)
            })
            .unwrap();
        fixture.app.folders().shutdown();
        for app in ["todos", "capture"] {
            let result =
                fixture
                    .app
                    .open_folder_window(app, root.clone(), Default::default(), |_| {
                        panic!("configuration after shutdown")
                    });
            assert!(matches!(
                result,
                Err(OpenWindowError::Folder(WindowError::ShuttingDown))
            ));
        }
        assert_eq!(fixture.app.webview_windows().len(), 1);
    }
}
