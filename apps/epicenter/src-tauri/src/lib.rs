use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::webview::NewWindowResponse;
use tauri::{
    AppHandle, Manager, RunEvent, Runtime, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent, Wry,
};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_epicenter_folder::FolderExt;
use tauri_specta::Event as _;

/// The command list, shared with `build.rs` through `include!`. Only the tests
/// read it from the crate, which is where the drift checks live.
#[cfg(test)]
mod command_names;

pub mod app_data;
mod data_folders;
mod device_owner;
mod installed_apps;

pub mod audio;

pub mod transcription;
use transcription::{
    delete_model, download_model, get_active_model, get_local_transcription_readiness,
    get_unload_policy, list_inference_models, list_models, prewarm_model, set_active_model,
    set_unload_policy, transcribe_audio_bytes, LocalTranscriptionSettings, ModelCache,
};

pub mod command;
use command::{
    get_microphone_permission, open_accessibility_settings, request_accessibility_permission,
    request_microphone_permission,
};

pub mod download;
use download::{cancel_download, DownloadManager};

mod delivery;
use delivery::{simulate_enter_keystroke, write_text};

mod keyring_storage;
use keyring_storage::{
    delete_app_secret, read_app_secret, read_auth_cell, write_app_secret, write_auth_cell,
};

pub mod media;
use media::{pause_playback, resume_playback};

pub mod timing;

mod shell;
use shell::{
    is_autostart_enabled, replace_global_shortcuts, set_autostart_enabled, GlobalShortcutRegistry,
    GlobalShortcutTriggered,
};

#[cfg(desktop)]
pub mod keyboard;

#[cfg(target_os = "macos")]
pub mod overlay;

#[cfg(target_os = "macos")]
pub mod clipboard;

#[cfg(any(not(debug_assertions), test))]
const PRODUCTION_PORT: u16 = 39_130;
#[cfg(any(debug_assertions, test))]
const DEVELOPMENT_PORT: u16 = 39_131;
const PROTOCOL_VERSION: u8 = 13;
const HOSTED_AUTH_ORIGIN: &str = "https://api.epicenter.so";
const READY_TIMEOUT: Duration = Duration::from_secs(15);
/// How long Bun gets to shut down after its stdin closes before it is killed.
///
/// Longer than Bun's own ten-second shutdown grace (`SHUTDOWN_GRACE_MS` in
/// `src/sidecar-runtime.ts`), so Bun's owners finish their disposal and Bun
/// exits by itself. The kill is the bound for a host that hangs anyway.
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(12);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BuiltInApp {
    Home,
    Whispering,
    Honeycrisp,
    Capture,
    Mail,
    Todos,
    Books,
    Folders,
}

impl BuiltInApp {
    const ALL: [Self; 8] = [
        Self::Home,
        Self::Whispering,
        Self::Honeycrisp,
        Self::Capture,
        Self::Mail,
        Self::Todos,
        Self::Books,
        Self::Folders,
    ];

    /// Whether `launch_application` opens this app's window (ADR-0189).
    ///
    /// Every variant here is an app in the product model; this says only which
    /// ones a person can open from a window. The Folders window opens Todos and
    /// Capture from their folders, every other app from its Apps list, and
    /// Settings (the `home` window) from its Settings button (ADR-0537).
    /// Settings opens Whispering once local transcription is ready. Mail and
    /// Books are release-bundled placeholder documents with nothing behind them
    /// to open. Honeycrisp now ships its own desktop shell, outside this host.
    const fn is_launchable(self) -> bool {
        self.is_hosted()
            && matches!(
                self,
                Self::Home | Self::Whispering | Self::Capture | Self::Todos | Self::Folders
            )
    }

    /// Whether the shell opens this app's window at all, from startup, a
    /// launch, the tray, or a deep link.
    ///
    /// Whispering is built and served but not hosted for now: inside Epicenter
    /// no folder or host of its own is registered for it, so its page can only
    /// report that the desktop app did not start Whispering's host. While it is
    /// not, the shell opens neither its hidden window nor its recording overlay
    /// at startup and offers no tray item for it. Returning `true` for it here,
    /// and listing it in `LAUNCHABLE_APPLICATIONS` in `applications.ts`, offers
    /// it again.
    const fn is_hosted(self) -> bool {
        !matches!(self, Self::Whispering)
    }

    const fn id(self) -> &'static str {
        match self {
            Self::Home => "home",
            Self::Whispering => "whispering",
            Self::Honeycrisp => "honeycrisp",
            Self::Capture => "capture",
            Self::Mail => "mail",
            Self::Todos => "todos",
            Self::Books => "books",
            Self::Folders => "folders",
        }
    }

    const fn path(self) -> &'static str {
        match self {
            Self::Home => "/apps/home/",
            Self::Whispering => "/apps/whispering/",
            Self::Honeycrisp => "/apps/honeycrisp/",
            Self::Capture => "/apps/capture/",
            Self::Mail => "/apps/mail/",
            Self::Todos => "/apps/todos/",
            Self::Books => "/apps/books/",
            Self::Folders => "/apps/folders/",
        }
    }

    const fn title(self) -> &'static str {
        match self {
            Self::Home => "Epicenter: Settings",
            Self::Whispering => "Epicenter: Whispering",
            Self::Honeycrisp => "Epicenter: Honeycrisp",
            Self::Capture => "Epicenter: Capture",
            Self::Mail => "Epicenter: Mail",
            Self::Todos => "Epicenter: Todos",
            Self::Books => "Epicenter: Books",
            Self::Folders => "Epicenter: Folders",
        }
    }

    fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|built_in| built_in.id() == id)
    }
}

type DesktopAppHandle = AppHandle<Wry>;

/// The largest line either side writes on the private native pipe, newline
/// included. Bun holds the same limit (`MAX_NATIVE_FRAME_BYTES`).
const MAX_NATIVE_FRAME_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BootFrame<'a> {
    r#type: &'static str,
    protocol_version: u8,
    token: &'a str,
    port: u16,
    auth_cell: Option<&'a str>,
    auth_server: AuthServer,
    account_management: bool,
    #[serde(flatten)]
    paths: &'a app_data::DesktopPaths,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadyFrame {
    r#type: String,
    protocol_version: u8,
    port: u16,
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
enum BunToRustNativeFrame {
    StoreAuth {
        #[serde(rename = "requestId")]
        request_id: String,
        serialized: Option<String>,
    },
    OpenAuthUrl {
        #[serde(rename = "requestId")]
        request_id: String,
        url: String,
    },
    PutAppSecret {
        account: Option<device_owner::AccountIdentity>,
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "appId")]
        app_id: String,
        label: String,
        value: String,
    },
    GetAppSecret {
        account: Option<device_owner::AccountIdentity>,
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "appId")]
        app_id: String,
        label: String,
    },
    DeleteAppSecret {
        account: Option<device_owner::AccountIdentity>,
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "appId")]
        app_id: String,
        label: String,
    },
    /// Restart for an account change, at once: no window is asked
    /// (ADR-0415, ADR-0542).
    Relaunch {},
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum RustToBunNativeFrame<'a> {
    NativeResult {
        #[serde(rename = "requestId")]
        request_id: &'a str,
        status: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<&'a str>,
    },
    /// A read that found something, or found nothing. Bun reads both as the
    /// answer to one correlated request, on the same `native-result` frame the
    /// void operations use; only a failure carries a message.
    #[serde(rename = "native-result")]
    NativeValue {
        #[serde(rename = "requestId")]
        request_id: &'a str,
        status: &'static str,
        value: Option<&'a str>,
    },
    AuthCallback {
        url: &'a str,
    },
}

struct ManagedChild {
    generation: u64,
    child: Child,
    stdin: Option<mpsc::SyncSender<String>>,
    /// Set when the command pipe to Bun fails; the generation is then terminal.
    writer_failed: Arc<AtomicBool>,
    writer: Option<thread::JoinHandle<()>>,
}

struct HostState {
    port: std::result::Result<u16, String>,
    next_generation: AtomicU64,
    process: Mutex<Option<ManagedChild>>,
    /// The launch token of the Bun generation windows are opened for.
    active_token: Mutex<Option<String>>,
    pending_apps: Mutex<Vec<BuiltInApp>>,
    pending_auth_callback: Mutex<Option<String>>,
    /// A section of Home an application asked the shell to open, held until Home
    /// is able to claim it. Only the latest survives: two recovery nudges in a
    /// row should land the user somewhere once, not queue a backlog.
    pending_home_section: Mutex<Option<HomeSection>>,
    shutting_down: AtomicBool,
    starting: AtomicBool,
}

impl HostState {
    fn new(port: Result<u16>) -> Self {
        Self {
            port: port.map_err(|error| format!("{error:#}")),
            next_generation: AtomicU64::new(1),
            process: Mutex::new(None),
            active_token: Mutex::new(None),
            pending_apps: Mutex::new(Vec::new()),
            pending_auth_callback: Mutex::new(None),
            pending_home_section: Mutex::new(None),
            shutting_down: AtomicBool::new(false),
            starting: AtomicBool::new(false),
        }
    }

    fn port(&self) -> Result<u16> {
        self.port
            .as_ref()
            .copied()
            .map_err(|error| anyhow!(error.clone()))
    }

    fn queue_app(&self, built_in: BuiltInApp) {
        let mut pending = self.pending_apps.lock().expect("pending app lock poisoned");
        if !pending.contains(&built_in) {
            pending.push(built_in);
        }
    }

    fn take_pending_apps(&self) -> Vec<BuiltInApp> {
        std::mem::take(&mut *self.pending_apps.lock().expect("pending app lock poisoned"))
    }

    fn queue_home_section(&self, section: HomeSection) {
        *self
            .pending_home_section
            .lock()
            .expect("pending home section lock poisoned") = Some(section);
    }

    fn take_home_section(&self) -> Option<HomeSection> {
        self.pending_home_section
            .lock()
            .expect("pending home section lock poisoned")
            .take()
    }

    fn queue_auth_callback(&self, url: String) {
        *self
            .pending_auth_callback
            .lock()
            .expect("pending auth callback lock poisoned") = Some(url);
    }

    fn take_auth_callback(&self) -> Option<String> {
        self.pending_auth_callback
            .lock()
            .expect("pending auth callback lock poisoned")
            .take()
    }

    fn activate(&self, token: &str) {
        *self.active_token.lock().expect("active host lock poisoned") = Some(token.to_string());
    }

    fn deactivate(&self) {
        *self.active_token.lock().expect("active host lock poisoned") = None;
    }

    fn active_token(&self) -> Option<String> {
        self.active_token
            .lock()
            .expect("active host lock poisoned")
            .clone()
    }

    fn token_is_active(&self, token: &str) -> bool {
        self.active_token
            .lock()
            .expect("active host lock poisoned")
            .as_deref()
            == Some(token)
    }
}

struct LaunchedHost {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    token: String,
}

enum FailureChoice {
    Retry,
    Quit,
}

/// The typed Whispering command and event contract. The host-owned
/// `launch_application` remains on Tauri's handwritten handler because it is
/// outside this generated Whispering binding API.
fn make_specta_builder() -> tauri_specta::Builder<tauri::Wry> {
    tauri_specta::Builder::<tauri::Wry>::new()
        .commands(tauri_specta::collect_commands![
            write_text,
            simulate_enter_keystroke,
            transcribe_audio_bytes,
            list_inference_models,
            prewarm_model,
            open_accessibility_settings,
            request_accessibility_permission,
            get_microphone_permission,
            request_microphone_permission,
            get_active_model,
            set_active_model,
            get_local_transcription_readiness,
            open_home,
            take_pending_home_section,
            data_folders::list_data_folders,
            installed_apps::list_installed_apps,
            installed_apps::install_app,
            installed_apps::approve_app,
            installed_apps::update_app,
            installed_apps::open_installed_app,
            get_unload_policy,
            set_unload_policy,
            list_models,
            download_model,
            delete_model,
            cancel_download,
            pause_playback,
            resume_playback,
            keyboard::commands::set_auto_paste_enabled,
            keyboard::commands::get_dictation_capability,
            replace_global_shortcuts,
            is_autostart_enabled,
            set_autostart_enabled,
        ])
        .events(tauri_specta::collect_events![
            keyboard::DictationCapabilityEvent,
            GlobalShortcutTriggered,
            HomeSectionPending,
        ])
        .error_handling(tauri_specta::ErrorHandlingMode::DataError)
}

#[cfg(test)]
mod export_bindings {
    /// Both consumers of this crate's typed command API are generated from
    /// the one builder, so neither can drift from Rust.
    ///
    /// Each file carries the whole API because `tauri_specta` exports a
    /// builder, not a slice of one. What a window may actually call is decided
    /// by its capability file, not by which bindings it can import: Home's
    /// `home-model-administration-*` capability grants exactly the local-model
    /// administration commands (ADR-0180), and every other command in Home's
    /// copy is denied at the IPC boundary.
    const TARGETS: &[&str] = &[
        "../../whispering/src/lib/tauri/bindings.gen.ts",
        "../src/ui/bindings.gen.ts",
    ];

    #[test]
    fn export_types() {
        for target in TARGETS {
            super::make_specta_builder()
                .export(specta_typescript::Typescript::default(), target)
                .unwrap_or_else(|error| panic!("failed to export bindings to {target}: {error}"));
        }
    }
}

/// A section of Epicenter Home an application can ask the shell to open.
///
/// A closed set, not a string-addressed destination: Home is a privileged
/// built-in app, so what an application may name inside it is enumerated
/// here rather than parsed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum HomeSection {
    /// Local transcription model administration.
    Transcription,
}

/// A nudge telling an already-running Home to collect any pending section
/// intent. It deliberately carries no section of its own: the intent lives in
/// the host, and Home reads it with `take_pending_home_section`, so an event
/// that arrives twice, late, or not at all cannot produce a different outcome.
#[derive(Clone, Debug, serde::Serialize, specta::Type, tauri_specta::Event)]
pub struct HomeSectionPending;

/// Take the user to the app that can fix an unavailable local transcription
/// route.
///
/// The app shell owns this navigation. The host reports that the route is
/// unavailable, an application decides how to present it, and getting the user
/// to Home is neither of their jobs: an application asks the shell to show a
/// section of Home, and the shell decides how.
///
/// The intent is recorded *before* any window work, which is what makes this
/// safe against the state Home happens to be in. Home may be absent, still
/// booting, hidden, or already open; in every case the intent is waiting when
/// Home next asks for it, and the event below is only an optimization for the
/// already-running case. Emitting the section directly would lose it whenever
/// no listener existed yet, which is exactly the recovery path that matters.
///
/// It mutates no transcription state: it opens a window, and the user chooses.
#[tauri::command]
#[specta::specta]
fn open_home(section: HomeSection, app: DesktopAppHandle) {
    app.state::<HostState>().queue_home_section(section);
    request_window(&app, BuiltInApp::Home);
    let _ = HomeSectionPending.emit_to(&app, BuiltInApp::Home.id());
}

/// Claim the pending section intent, if any. Home calls this on mount and
/// whenever it is nudged; taking is destructive, so one intent opens one
/// section exactly once however many nudges arrive.
#[tauri::command]
#[specta::specta]
fn take_pending_home_section(app: DesktopAppHandle) -> Option<HomeSection> {
    app.state::<HostState>().take_home_section()
}

/// Launch one application the Folders window or Settings offers: reveal and
/// focus its window, creating it the first time. Calling again focuses rather
/// than duplicating, and the window that asked is never hidden to do it.
///
/// Windows are deliberate (ADR-0209). One window that switched between
/// applications would union every capability file onto one label, because a
/// label is what native authority is granted to; separate windows are what keep
/// `home`, `whispering`, and `capture` meaning different things. From here the
/// OS is the switcher.
///
/// This is the verb of the `folders` and `home` windows, not an app-facing
/// one: no application may use it to reveal another.
///
/// # Who decides an ID is real
///
/// The compiled app table. `parse_application_id` resolves the ID against it
/// and refuses anything no window offers, so a page cannot name a window the
/// release does not ship.
///
/// # Why it waits
///
/// Window work happens on the main thread, so this command hands the attempt
/// over and blocks on its outcome rather than reporting that it scheduled
/// something. A caller that gets `Ok` has a window; a caller that gets `Err`
/// has a sentence to show. `#[tauri::command(async)]` is what makes the wait
/// safe: it moves this body off the main thread, which would otherwise be the
/// thread the closure below is waiting for.
#[tauri::command(async)]
fn launch_application(
    app: DesktopAppHandle,
    state: State<'_, HostState>,
    app_id: String,
) -> std::result::Result<(), String> {
    let Some(built_in) = parse_application_id(&app_id) else {
        return Err(format!("app id must name an application Epicenter offers: {app_id}"));
    };
    // Unlike the tray, deep links, and startup, a user-invoked launch does not
    // queue itself for a future host generation: the person is waiting, and a
    // window that appears after the next restart is not what they asked for.
    let Some(token) = state.active_token() else {
        return Err("the Epicenter host is not ready".to_string());
    };
    let port = state.port().map_err(|error| format!("{error:#}"))?;

    launch_on_main_thread(&app, built_in, port, &token, true).map_err(|error| format!("{error:#}"))
}

/// Create or reveal the window on the main thread and report what happened.
///
/// Mirrors `create_windows_on_main_thread`: hand the work over, wait for the
/// one result. The sender lives in the closure, so an event loop that shuts
/// down before running it drops the sender and this returns an error rather
/// than waiting forever.
fn launch_on_main_thread(
    app: &DesktopAppHandle,
    built_in: BuiltInApp,
    port: u16,
    token: &str,
    reveal: bool,
) -> Result<()> {
    let (sender, receiver) = mpsc::sync_channel(1);
    let window_app = app.clone();
    let token = token.to_string();
    app.run_on_main_thread(move || {
        let result = if window_app.state::<HostState>().token_is_active(&token) {
            ensure_window(&window_app, built_in, port, &token, reveal)
        } else {
            Err(anyhow!(HOST_RESTARTED))
        };
        let _ = sender.send(result);
    })
    .context("schedule the application window on the main thread")?;
    receiver
        .recv()
        .context("the main thread stopped before opening the window")?
}

/// Resolve an ID to a compiled application a window offers. A placeholder and
/// an ID no compiled app has are the same refusal, because no window offers
/// either.
fn parse_application_id(id: &str) -> Option<BuiltInApp> {
    BuiltInApp::from_id(id).filter(|built_in| built_in.is_launchable())
}

/// The host restarted between a launch and the main thread reaching it: every
/// window from the old generation is being torn down, so opening one now would
/// create a window against a dead token.
const HOST_RESTARTED: &str = "the Epicenter host restarted before the window opened";

pub fn run() {
    let port = configured_port();
    let specta_builder = make_specta_builder();
    let specta_handler = tauri_specta::Builder::invoke_handler(&specta_builder);
    let native_handler =
        tauri::generate_handler![launch_application] as fn(tauri::ipc::Invoke<tauri::Wry>) -> bool;
    let log_plugin = tauri_plugin_log::Builder::new()
        .level(log::LevelFilter::Info)
        .level_for("epicenter::transcription", log::LevelFilter::Debug)
        .target(tauri_plugin_log::Target::new(
            tauri_plugin_log::TargetKind::Stdout,
        ))
        .target(tauri_plugin_log::Target::new(
            tauri_plugin_log::TargetKind::LogDir {
                file_name: Some("epicenter".to_string()),
            },
        ))
        .build();

    let builder = tauri::Builder::default()
        // This must remain the first plugin: later plugins and setup must only run
        // in the process that owns the application instance.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            open_forwarded_deep_links(app, &args);
        }))
        .plugin(tauri_plugin_epicenter_folder::init())
        .plugin(
            tauri_plugin_epicenter_recorder::Builder::new()
                .on_capturing(shell::set_tray_recording_state)
                .build(),
        )
        .plugin(log_plugin)
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .manage(HostState::new(port))
        .manage(data_folders::DataFolderScopes::default())
        .manage(installed_apps::AppWork::default())
        .manage(GlobalShortcutRegistry::default())
        .manage(DownloadManager::default());

    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());

    builder
        .invoke_handler(move |invoke| {
            if invoke.message.command() == "launch_application" {
                native_handler(invoke)
            } else {
                specta_handler(invoke)
            }
        })
        .setup(move |app| {
            specta_builder.mount_events(app);

            let desktop_paths = app_data::DesktopPaths::resolve(app.handle())?;
            data_folders::register_application_folders(app.folders(), &desktop_paths.folder_dir)
                .map_err(anyhow::Error::msg)?;
            app.manage(desktop_paths);

            // The active local model and the unload policy are device-local host
            // state (ADR-0180), so they live beside the app's own config rather
            // than in any workspace that could carry them to a machine without
            // the model files or a compatible accelerator.
            let settings = LocalTranscriptionSettings::load(
                app.path()
                    .app_config_dir()?
                    .join("local-transcription.json"),
            );
            let cache = ModelCache::new(settings);
            cache.start_idle_watcher();
            app.manage(cache);

            #[cfg(desktop)]
            app.manage(keyboard::TapController::new(app.handle().clone()));

            shell::create_tray(app.handle())?;

            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                open_deep_links(&handle, &event.urls());
            });

            let current = app.deep_link().get_current()?;
            let mut opened_window = false;
            if let Some(urls) = current {
                for url in &urls {
                    if let Some(callback) = parse_auth_callback(url) {
                        queue_or_send_auth_callback(app.handle(), callback);
                    }
                    if let Some(built_in) = parse_app_deep_link(url) {
                        request_window(app.handle(), built_in);
                        opened_window = true;
                    }
                }
            }
            // Epicenter opens to the person's folders (ADR-0537).
            if !opened_window {
                request_window(app.handle(), BuiltInApp::Folders);
            }
            request_start(app.handle().clone(), None);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Epicenter")
        .run(|app, event| match event {
            RunEvent::Reopen { .. } => request_window(app, BuiltInApp::Folders),
            // A host restart destroys every window; Epicenter stays in the
            // tray while they come back (`refuses_exit`).
            RunEvent::ExitRequested { api, code, .. } if refuses_exit(code) => api.prevent_exit(),
            RunEvent::Exit => shutdown_host(app),
            _ => {}
        });
}

fn open_forwarded_deep_links(app: &DesktopAppHandle, arguments: &[String]) {
    let built_ins = apps_from_arguments(arguments);
    for argument in arguments {
        let Ok(url) = tauri::Url::parse(argument) else {
            continue;
        };
        if let Some(callback) = parse_auth_callback(&url) {
            queue_or_send_auth_callback(app, callback);
        }
    }
    if built_ins.is_empty() {
        request_window(app, BuiltInApp::Folders);
    } else {
        for built_in in built_ins {
            request_window(app, built_in);
        }
    }
}

fn apps_from_arguments(arguments: &[String]) -> Vec<BuiltInApp> {
    let mut built_ins = Vec::new();
    for argument in arguments {
        let Ok(url) = tauri::Url::parse(argument) else {
            continue;
        };
        let Some(built_in) = parse_app_deep_link(&url) else {
            continue;
        };
        if !built_ins.contains(&built_in) {
            built_ins.push(built_in);
        }
    }
    built_ins
}

fn open_deep_links(app: &DesktopAppHandle, urls: &[tauri::Url]) {
    for url in urls {
        if let Some(callback) = parse_auth_callback(url) {
            queue_or_send_auth_callback(app, callback);
        }
        if let Some(built_in) = parse_app_deep_link(url) {
            request_window(app, built_in);
        }
    }
}

fn parse_auth_callback(url: &tauri::Url) -> Option<String> {
    if url.scheme() != "epicenter"
        || url.host_str() != Some("auth")
        || url.path() != "/callback"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
        || !(url.query_pairs().any(|(key, _)| key == "code")
            || url.query_pairs().any(|(key, _)| key == "error"))
    {
        return None;
    }
    Some(url.to_string())
}

fn queue_or_send_auth_callback(app: &DesktopAppHandle, url: String) {
    let state = app.state::<HostState>();
    let generation = state
        .process
        .lock()
        .expect("host state lock poisoned")
        .as_ref()
        .map(|process| process.generation);
    let Some(generation) = generation else {
        state.queue_auth_callback(url);
        return;
    };
    if let Err(error) = send_native_frame(
        &state,
        generation,
        &RustToBunNativeFrame::AuthCallback { url: &url },
    ) {
        state.queue_auth_callback(url);
        append_parent_log(app, &format!("deliver auth callback: {error:#}"));
    }
}

/// Ask for a window without waiting: queue it when the host is not ready yet,
/// and log rather than report what the main thread makes of it.
///
/// That is right for the callers that have nobody to answer to (startup, the
/// tray, a deep link, macOS reopen, an app asking for a section of Settings). It is
/// wrong for `launch_application`, where a person clicked and is owed an
/// outcome, so that command waits on the main thread instead.
fn request_window(app: &DesktopAppHandle, built_in: BuiltInApp) {
    if !built_in.is_hosted() {
        return;
    }
    let state = app.state::<HostState>();
    let Some(token) = state.active_token() else {
        state.queue_app(built_in);
        return;
    };
    let Ok(port) = state.port() else {
        return;
    };

    let window_app = app.clone();
    let schedule = app.run_on_main_thread(move || {
        if !window_app.state::<HostState>().token_is_active(&token) {
            return;
        }
        if let Err(error) = ensure_window(&window_app, built_in, port, &token, true) {
            append_parent_log(
                &window_app,
                &format!("open {} window: {error:#}", built_in.id()),
            );
        }
    });
    if let Err(error) = schedule {
        append_parent_log(app, &format!("schedule {} window: {error}", built_in.id()));
    }
}

/// Resolve `epicenter://app/<id>` to the built-in app it names, and a bare
/// `epicenter://` to the Folders window, which is what opening Epicenter shows
/// (ADR-0537).
///
/// The segment is `app` because it is the same ID space as `/apps/<id>/`: a
/// person pasting a link names the thing they want, not the frame it arrives
/// in. `epicenter://auth/...` stays disjoint by segment.
fn parse_app_deep_link(url: &tauri::Url) -> Option<BuiltInApp> {
    if url.scheme() != "epicenter"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    if url.host_str().unwrap_or_default().is_empty() && matches!(url.path(), "" | "/") {
        return Some(BuiltInApp::Folders);
    }
    if url.host_str() != Some("app") {
        return None;
    }

    let id = url.path().strip_prefix('/')?;
    if id.is_empty() || id.contains('/') {
        return None;
    }
    BuiltInApp::from_id(id)
}

fn request_start(app: DesktopAppHandle, initial_error: Option<String>) {
    let state = app.state::<HostState>();
    if state.shutting_down.load(Ordering::Acquire) || state.starting.swap(true, Ordering::AcqRel) {
        return;
    }

    thread::spawn(move || start_until_ready(app, initial_error));
}

fn start_until_ready(app: DesktopAppHandle, mut failure: Option<String>) {
    loop {
        if app
            .state::<HostState>()
            .shutting_down
            .load(Ordering::Acquire)
        {
            app.state::<HostState>()
                .starting
                .store(false, Ordering::Release);
            return;
        }

        if let Some(message) = failure.take() {
            append_parent_log(&app, &message);
            invalidate_windows(&app);
            match show_failure_dialog(&app, &message) {
                FailureChoice::Retry => {}
                FailureChoice::Quit => {
                    app.state::<HostState>()
                        .starting
                        .store(false, Ordering::Release);
                    app.exit(1);
                    return;
                }
            }
        }

        match start_once(&app) {
            Ok(()) => {
                app.state::<HostState>()
                    .starting
                    .store(false, Ordering::Release);
                return;
            }
            Err(error) => failure = Some(format!("{error:#}")),
        }
    }
}

fn start_once(app: &DesktopAppHandle) -> Result<()> {
    let state = app.state::<HostState>();
    let port = state.port()?;
    let launched = launch_host(app, port)?;
    let generation = state.next_generation.fetch_add(1, Ordering::Relaxed);
    let LaunchedHost {
        child,
        stdin,
        stdout,
        token,
    } = launched;

    {
        let mut process = state.process.lock().expect("host state lock poisoned");
        if process.is_some() {
            drop(process);
            stop_starting_child(child, stdin);
            bail!("a Bun host is already managed by Epicenter");
        }
        let (sender, receiver) = mpsc::sync_channel::<String>(64);
        let failed = Arc::new(AtomicBool::new(false));
        let writer_failed = failed.clone();
        let writer = thread::spawn(move || {
            let mut stdin = stdin;
            for line in receiver {
                if writeln!(stdin, "{line}")
                    .and_then(|()| stdin.flush())
                    .is_err()
                {
                    writer_failed.store(true, Ordering::Release);
                    break;
                }
            }
        });
        *process = Some(ManagedChild {
            generation,
            child,
            stdin: Some(sender),
            writer_failed: failed,
            writer: Some(writer),
        });
    }

    if let Some(callback) = state.take_auth_callback() {
        send_native_frame(
            &state,
            generation,
            &RustToBunNativeFrame::AuthCallback { url: &callback },
        )
        .context("deliver the queued auth callback")?;
    }

    state.activate(&token);
    let mut built_ins = state.take_pending_apps();
    if built_ins.is_empty() {
        built_ins.push(BuiltInApp::Folders);
    }
    if let Err(error) = create_windows_on_main_thread(app, port, &token, built_ins) {
        state.deactivate();
        if let Some(child) = take_generation(&state, generation) {
            stop_child(child);
        }
        invalidate_windows(app);
        return Err(error);
    }

    monitor_host(app.clone(), generation, stdout);
    Ok(())
}

fn launch_host(app: &DesktopAppHandle, port: u16) -> Result<LaunchedHost> {
    let log = open_log_file(app)?;

    // The native startup owns paths; the sidecar receives them in its boot frame.
    let mut command = host_command(app)?;
    command
        .env("EPICENTER_APPS_DIST", apps_dist(app)?)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(host_stderr(&log)?);

    let mut child = command
        .spawn()
        .context("spawn the bundled Bun application host")?;
    let mut stdin = child.stdin.take().context("capture Bun stdin")?;
    let stdout = child.stdout.take().context("capture Bun stdout")?;
    let token = launch_token()?;
    let auth_cell =
        read_auth_cell(&app.config().identifier).context("read the desktop auth cell")?;
    let frame = boot_frame_json(
        &token,
        port,
        auth_cell.as_deref(),
        &app.state::<app_data::DesktopPaths>(),
    )?;

    if let Err(error) = writeln!(stdin, "{frame}").and_then(|()| stdin.flush()) {
        stop_starting_child(child, stdin);
        return Err(error).context("send the Bun boot frame");
    }

    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let ready = read_ready_frame(&mut reader, port);
        let _ = sender.send((ready, reader));
    });

    let (ready, stdout) = match receiver.recv_timeout(READY_TIMEOUT) {
        Ok(value) => value,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            stop_starting_child(child, stdin);
            bail!("Bun did not emit its versioned ready frame within 15 seconds");
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            stop_starting_child(child, stdin);
            bail!("the Bun readiness reader stopped before returning a frame");
        }
    };

    if let Err(error) = ready {
        stop_starting_child(child, stdin);
        return Err(error);
    }

    Ok(LaunchedHost {
        child,
        stdin,
        stdout,
        token,
    })
}

#[cfg(debug_assertions)]
fn apps_dist(_app: &DesktopAppHandle) -> Result<PathBuf> {
    Ok(std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .context("Epicenter src-tauri directory has no app parent")?
        .join("dist"))
}

#[cfg(not(debug_assertions))]
fn apps_dist(app: &DesktopAppHandle) -> Result<PathBuf> {
    Ok(app.path().resource_dir()?.join("apps-dist"))
}

/// Where the Bun host's own output goes.
///
/// A release writes it to `host.log`, which is where a person is asked to look
/// when something has already gone wrong. A development run writes it to the
/// terminal that started `tauri dev`, because that is the only place anyone is
/// actually watching: a host that fails in development wrote its reason to a
/// file nobody opened, so every failure looked silent.
#[cfg(debug_assertions)]
fn host_stderr(_log: &File) -> Result<Stdio> {
    Ok(Stdio::inherit())
}

#[cfg(not(debug_assertions))]
fn host_stderr(log: &File) -> Result<Stdio> {
    Ok(Stdio::from(log.try_clone()?))
}

#[cfg(debug_assertions)]
fn host_command(_app: &DesktopAppHandle) -> Result<Command> {
    let app_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .context("Epicenter src-tauri directory has no app parent")?;
    let mut command = Command::new("bun");
    command
        .current_dir(app_dir)
        .arg("run")
        .arg("src/main.ts")
        .arg("--runtime-mode=development");
    Ok(command)
}

#[cfg(not(debug_assertions))]
fn host_command(_app: &DesktopAppHandle) -> Result<Command> {
    let executable = std::env::current_exe().context("resolve the Epicenter executable")?;
    let directory = executable
        .parent()
        .context("the Epicenter executable has no parent directory")?;
    let filename = if cfg!(windows) {
        "epicenter-host.exe"
    } else {
        "epicenter-host"
    };
    let mut command = Command::new(directory.join(filename));
    command.arg("--runtime-mode=production");
    Ok(command)
}

fn monitor_host(app: DesktopAppHandle, generation: u64, mut stdout: BufReader<ChildStdout>) {
    let (stdout_sender, stdout_receiver) = mpsc::sync_channel(1);
    thread::spawn(move || loop {
        let mut line = String::new();
        let event = match (&mut stdout)
            .take((MAX_NATIVE_FRAME_BYTES + 1) as u64)
            .read_line(&mut line)
        {
            Ok(0) => Err("Bun closed stdout after readiness".to_string()),
            Ok(_) if line.len() > MAX_NATIVE_FRAME_BYTES || !line.ends_with('\n') => {
                Err("Bun closed stdout during an native frame".to_string())
            }
            Ok(_) => {
                serde_json::from_str::<BunToRustNativeFrame>(line.trim_end_matches(['\r', '\n']))
                    .map_err(|error| format!("Bun emitted an invalid native frame: {error}"))
            }
            Err(error) => Err(format!("failed to monitor Bun stdout: {error}")),
        };
        let terminal = event.is_err();
        if stdout_sender.send(event).is_err() || terminal {
            return;
        }
    });

    thread::spawn(move || loop {
        if app
            .state::<HostState>()
            .shutting_down
            .load(Ordering::Acquire)
        {
            return;
        }

        if let Ok(event) = stdout_receiver.recv_timeout(Duration::from_millis(150)) {
            match event {
                Ok(frame) => {
                    if let Err(error) = handle_native_frame(&app, generation, frame) {
                        fail_generation(
                            &app,
                            generation,
                            format!("handle Bun native frame: {error:#}"),
                        );
                        return;
                    }
                }
                Err(message) => {
                    fail_generation(&app, generation, message);
                    return;
                }
            }
        }

        let status = {
            let state = app.state::<HostState>();
            let mut process = state.process.lock().expect("host state lock poisoned");
            let Some(process) = process.as_mut() else {
                return;
            };
            if process.generation != generation {
                return;
            }
            if process.writer_failed.load(Ordering::Acquire) {
                // A failed/bounded response pipe is terminal; never strand a request.
                let _ = process.child.kill();
            }
            process.child.try_wait()
        };

        match status {
            Ok(Some(status)) => {
                fail_generation(
                    &app,
                    generation,
                    format!("Bun exited unexpectedly with {status}"),
                );
                return;
            }
            Ok(None) => {}
            Err(error) => {
                fail_generation(
                    &app,
                    generation,
                    format!("failed to inspect the Bun process: {error}"),
                );
                return;
            }
        }
    });
}

fn handle_native_frame(
    app: &DesktopAppHandle,
    generation: u64,
    frame: BunToRustNativeFrame,
) -> Result<()> {
    {
        let state = app.state::<HostState>();
        if state.shutting_down.load(Ordering::Acquire) {
            bail!("Native frame arrived after host shutdown began");
        }
        let process = state.process.lock().expect("host state lock poisoned");
        if !process
            .as_ref()
            .is_some_and(|process| process.generation == generation)
        {
            bail!("Native frame belongs to a retired Bun generation");
        }
    }
    // Dispatch without the process lock: restart delivers Exit, whose cleanup
    // takes this lock before waiting for the Bun child.
    match frame {
        BunToRustNativeFrame::StoreAuth {
            request_id,
            serialized,
        } => {
            let result = write_auth_cell(&app.config().identifier, serialized);
            send_native_result(app, generation, &request_id, result)
        }
        BunToRustNativeFrame::OpenAuthUrl { request_id, url } => {
            let result = configured_auth_server().and_then(|server| {
                validate_auth_url(&url, &server.server)?;
                app.opener()
                    .open_url(url, None::<String>)
                    .map_err(Into::into)
            });
            send_native_result(app, generation, &request_id, result)
        }
        BunToRustNativeFrame::PutAppSecret {
            account,
            request_id,
            app_id,
            label,
            value,
        } => {
            let result = write_app_secret(
                &app.config().identifier,
                &app_id,
                &label,
                &value,
                account.as_ref(),
            );
            send_native_result(app, generation, &request_id, result)
        }
        BunToRustNativeFrame::GetAppSecret {
            account,
            request_id,
            app_id,
            label,
        } => {
            if request_id.is_empty() {
                bail!("native requestId must be non-empty");
            }
            let state = app.state::<HostState>();
            match read_app_secret(&app.config().identifier, &app_id, &label, account.as_ref()) {
                Ok(value) => send_native_frame(
                    &state,
                    generation,
                    &RustToBunNativeFrame::NativeValue {
                        request_id: &request_id,
                        status: "ok",
                        value: value.as_deref(),
                    },
                ),
                Err(error) => {
                    let message = error.to_string();
                    send_native_frame(
                        &state,
                        generation,
                        &RustToBunNativeFrame::NativeResult {
                            request_id: &request_id,
                            status: "error",
                            message: Some(&message),
                        },
                    )
                }
            }
        }
        BunToRustNativeFrame::DeleteAppSecret {
            account,
            request_id,
            app_id,
            label,
        } => {
            let result =
                delete_app_secret(&app.config().identifier, &app_id, &label, account.as_ref());
            send_native_result(app, generation, &request_id, result)
        }
        // `request_restart` delivers ExitRequested and Exit from any thread, so
        // `shutdown_host` stops Bun before the new process starts. `restart`
        // skips both when called on the main thread.
        BunToRustNativeFrame::Relaunch {} => {
            app.request_restart();
            Ok(())
        }
    }
}

fn send_native_result<E: std::fmt::Display>(
    app: &DesktopAppHandle,
    generation: u64,
    request_id: &str,
    result: std::result::Result<(), E>,
) -> Result<()> {
    if request_id.is_empty() {
        bail!("native requestId must be non-empty");
    }
    let state = app.state::<HostState>();
    match result {
        Ok(()) => send_native_frame(
            &state,
            generation,
            &RustToBunNativeFrame::NativeResult {
                request_id,
                status: "ok",
                message: None,
            },
        ),
        Err(error) => {
            let message = error.to_string();
            send_native_frame(
                &state,
                generation,
                &RustToBunNativeFrame::NativeResult {
                    request_id,
                    status: "error",
                    message: Some(&message),
                },
            )
        }
    }
}

fn send_native_frame(
    state: &HostState,
    generation: u64,
    frame: &RustToBunNativeFrame<'_>,
) -> Result<()> {
    let line = serde_json::to_string(frame).context("serialize the native native frame")?;
    let mut process = state.process.lock().expect("host state lock poisoned");
    let process = process
        .as_mut()
        .filter(|process| process.generation == generation)
        .context("the target Bun generation is no longer active")?;
    let stdin = process
        .stdin
        .as_mut()
        .context("the target Bun generation has no command pipe")?;
    if line.len() > MAX_NATIVE_FRAME_BYTES {
        bail!("Native response exceeds frame limit");
    }
    stdin
        .try_send(line)
        .context("native response queue is full or closed")?;
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthServer {
    #[serde(rename = "baseURL")]
    base_url: String,
    authority_id: String,
}

struct AuthConfiguration {
    server: AuthServer,
    account_management: bool,
}

fn configured_auth_server() -> Result<AuthConfiguration> {
    #[cfg(debug_assertions)]
    let development_origin = std::env::var("EPICENTER_API_URL").ok();
    #[cfg(not(debug_assertions))]
    let development_origin: Option<String> = None;
    auth_server(
        option_env!("EPICENTER_SERVER_ORIGIN"),
        development_origin.as_deref(),
    )
}

fn auth_server(self_hosted: Option<&str>, development: Option<&str>) -> Result<AuthConfiguration> {
    let origin = self_hosted.or(development).unwrap_or(HOSTED_AUTH_ORIGIN);
    let url = tauri::Url::parse(origin).context("parse the configured authentication origin")?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!("The configured authentication server must be an HTTP or HTTPS origin");
    }
    if self_hosted.is_none()
        && development.is_some()
        && (url.scheme() != "http"
            || !matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")))
    {
        bail!("EPICENTER_API_URL must be an HTTP loopback origin in development");
    }
    let base_url = url.origin().ascii_serialization();
    let authority_id = if self_hosted.is_some() {
        let hex: String = base_url
            .as_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        format!("instance-{hex}")
    } else {
        "epicenter-api".to_owned()
    };
    Ok(AuthConfiguration {
        server: AuthServer {
            base_url,
            authority_id,
        },
        account_management: self_hosted.is_none(),
    })
}

fn validate_auth_url(value: &str, server: &AuthServer) -> Result<()> {
    let url = tauri::Url::parse(value).context("parse the authorization URL")?;
    if url.origin().ascii_serialization() != server.base_url
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.path() != "/sign-in"
    {
        bail!("authorization URL must be {}/sign-in", server.base_url);
    }
    Ok(())
}

/// Ordinary new-tab account links leave the desktop app's work in place.
/// The host opens only the hosted account destinations in the system browser.
fn is_hosted_account_url(url: &tauri::Url, config: &AuthConfiguration) -> bool {
    config.account_management
        && url.origin().ascii_serialization() == config.server.base_url
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && matches!(
            url.path(),
            "/dashboard" | "/dashboard/usage" | "/dashboard/account"
        )
}

fn open_account_website(app: &DesktopAppHandle, url: &tauri::Url) -> NewWindowResponse<Wry> {
    if configured_auth_server().is_ok_and(|server| is_hosted_account_url(url, &server)) {
        if let Err(error) = app.opener().open_url(url.as_str(), None::<String>) {
            append_parent_log(app, &format!("could not open the account website: {error}"));
        }
    }
    NewWindowResponse::Deny
}

fn fail_generation(app: &DesktopAppHandle, generation: u64, message: String) {
    let state = app.state::<HostState>();
    if state.shutting_down.load(Ordering::Acquire) {
        return;
    }
    let Some(child) = take_generation(&state, generation) else {
        return;
    };
    state.deactivate();
    stop_child(child);
    invalidate_windows(app);
    request_start(app.clone(), Some(message));
}

fn take_generation(state: &HostState, generation: u64) -> Option<ManagedChild> {
    let mut process = state.process.lock().expect("host state lock poisoned");
    if process
        .as_ref()
        .is_some_and(|process| process.generation == generation)
    {
        process.take()
    } else {
        None
    }
}

fn stop_starting_child(mut child: Child, stdin: ChildStdin) {
    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();
}

fn stop_child(mut process: ManagedChild) {
    drop(process.stdin.take());
    let deadline = Instant::now() + SHUTDOWN_TIMEOUT;
    loop {
        match process.child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            Ok(None) | Err(_) => break,
        }
    }
    let _ = process.child.kill();
    let _ = process.child.wait();
    if let Some(writer) = process.writer.take() {
        let _ = writer.join();
    }
}

fn shutdown_host(app: &DesktopAppHandle) {
    let state = app.state::<HostState>();
    state.shutting_down.store(true, Ordering::Release);
    state.deactivate();
    let process = state
        .process
        .lock()
        .expect("host state lock poisoned")
        .take();
    if let Some(process) = process {
        stop_child(process);
    }
}

fn create_windows_on_main_thread(
    app: &DesktopAppHandle,
    port: u16,
    token: &str,
    built_ins: Vec<BuiltInApp>,
) -> Result<()> {
    let (sender, receiver) = mpsc::sync_channel(1);
    let app = app.clone();
    let token = token.to_string();
    app.clone().run_on_main_thread(move || {
        let result = (|| {
            // Whispering's hidden window and its recording overlay, while
            // Epicenter hosts it.
            if BuiltInApp::Whispering.is_hosted() {
                #[cfg(target_os = "macos")]
                create_recording_overlay(&app, port, &token)?;

                ensure_window(&app, BuiltInApp::Whispering, port, &token, false)?;
            }

            built_ins
                .into_iter()
                .try_for_each(|built_in| ensure_window(&app, built_in, port, &token, true))
        })();
        let _ = sender.send(result);
    })?;
    receiver
        .recv()
        .context("the main thread stopped before creating Epicenter windows")?
}

#[cfg(target_os = "macos")]
fn create_recording_overlay(app: &DesktopAppHandle, port: u16, token: &str) -> Result<()> {
    let origin = origin(port);
    let url: tauri::Url = format!("{origin}/apps/whispering/recording-overlay/").parse()?;
    let initialization_script = initialization_script(&origin, token)?;
    overlay::create_recording_overlay(app, url, initialization_script, port)
        .context("create the Whispering recording overlay")
}

/// Make sure the one window for this built-in app exists, and reveal it.
///
/// The window label is the app's ID, which is what every capability file in
/// `src-tauri/capabilities/` selects on. One built-in app has one window here;
/// an app owning a second window (Whispering's recording overlay) creates it
/// separately, under its own label.
fn ensure_window(
    app: &DesktopAppHandle,
    built_in: BuiltInApp,
    port: u16,
    token: &str,
    reveal: bool,
) -> Result<()> {
    if let Some(window) = app.get_webview_window(built_in.id()) {
        if reveal {
            focus(window);
        }
        return Ok(());
    }

    let origin = origin(port);
    let url: tauri::Url = format!("{origin}{}", built_in.path()).parse()?;
    let window = create_app_window(
        app,
        built_in.id(),
        built_in.title(),
        url,
        port,
        token,
        reveal,
    )?;

    let close_window = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = close_window.hide();
        }
    });
    if reveal {
        focus(window);
    }
    Ok(())
}

/// One app window on the active origin: the session bootstrap runs before
/// the page, and navigation stays on the origin.
fn create_app_window(
    app: &DesktopAppHandle,
    label: &str,
    title: &str,
    url: tauri::Url,
    port: u16,
    token: &str,
    visible: bool,
) -> Result<WebviewWindow<Wry>> {
    let initialization_script = initialization_script(&origin(port), token)?;
    let account_opener = app.clone();
    WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title(title)
        .inner_size(1100.0, 760.0)
        .min_inner_size(680.0, 480.0)
        .visible(visible)
        .initialization_script(initialization_script)
        .on_navigation(move |url| is_allowed_navigation(url, port))
        .on_new_window(move |url, _| open_account_website(&account_opener, &url))
        .build()
        .with_context(|| format!("create the {title} WebView"))
}

/// The window label of installed app `id` opened on `folder`: one window per
/// app and folder. A label may hold only letters, digits, `-`, `/`, `:`, and
/// `_`, so the id's dots become `_` (an id has no `_`) and the folder's scope
/// is spelled in hex. The installed-app capability selects `app:*`.
fn installed_window_label(id: &str, folder: Option<&str>) -> String {
    let mut label = format!("{INSTALLED_WINDOW_PREFIX}{}", id.replace('.', "_"));
    if let Some(folder) = folder {
        label.push(':');
        for byte in folder.bytes() {
            label.push_str(&format!("{byte:02x}"));
        }
    }
    label
}

const INSTALLED_WINDOW_PREFIX: &str = "app:";

/// Open installed app `id`, served at `/apps/<id>/` like a compiled app, in
/// its own window, or reveal the one already open on the same folder. With
/// `folder`, a registered scope, the window is permitted into it and the app
/// is handed it as `?folder=<scope>`; an app opens it with
/// `openDataFolder({ id, lens })` (ADR-0538). Approving an app trusts it
/// fully (ADR-0540), so the shell does not check its shape against the
/// folder.
pub(crate) fn open_installed_window(
    app: &DesktopAppHandle,
    id: &str,
    title: &str,
    folder: Option<&str>,
) -> Result<()> {
    let state = app.state::<HostState>();
    let Some(token) = state.active_token() else {
        bail!("the Epicenter host is not ready");
    };
    let port = state.port()?;
    let label = installed_window_label(id, folder);
    if let Some(folder) = folder {
        app.folders()
            .permit(folder, &label)
            .map_err(|error| anyhow!("the app cannot open this folder: {error:?}"))?;
    }
    let mut url: tauri::Url = format!("{}/apps/{id}/", origin(port)).parse()?;
    if let Some(folder) = folder {
        url.query_pairs_mut().append_pair("folder", folder);
    }
    let title = format!("Epicenter: {title}");

    let (sender, receiver) = mpsc::sync_channel(1);
    let window_app = app.clone();
    app.run_on_main_thread(move || {
        let result = if !window_app.state::<HostState>().token_is_active(&token) {
            Err(anyhow!(HOST_RESTARTED))
        } else if let Some(window) = window_app.get_webview_window(&label) {
            focus(window);
            Ok(())
        } else {
            create_app_window(&window_app, &label, &title, url, port, &token, true).map(focus)
        };
        let _ = sender.send(result);
    })
    .context("schedule the app window on the main thread")?;
    receiver
        .recv()
        .context("the main thread stopped before opening the window")?
}

fn focus<R: Runtime>(window: WebviewWindow<R>) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// What a host restart does to one window, by its label.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OnHostStop {
    /// A built-in app's window: destroyed, and opened again once the next
    /// host is ready if a person could see it.
    Reopen(BuiltInApp),
    /// An installed app's window: destroyed. Its app is opened again from the
    /// Folders window.
    Close,
    /// The recording overlay: hidden, never destroyed. It is an `NSPanel`
    /// (`overlay.rs`), and destroying it aborts the process: as wry removes
    /// the panel's `WKWebView`, WebKit's window-visibility observer removes a
    /// key-value observer the panel no longer has registered, AppKit throws an
    /// `NSException`, and the exception unwinds into tao's event loop, which
    /// Rust cannot catch. Converting it back with `Panel::to_window` first does
    /// not prevent it. Its page keeps the stopped host's token until Epicenter
    /// restarts, so hosting Whispering again must hand it the next one.
    Hide,
    /// Not a window of the host's session.
    Keep,
}

fn on_host_stop(label: &str) -> OnHostStop {
    if let Some(built_in) = BuiltInApp::from_id(label) {
        return OnHostStop::Reopen(built_in);
    }
    if label.starts_with(INSTALLED_WINDOW_PREFIX) {
        return OnHostStop::Close;
    }
    #[cfg(target_os = "macos")]
    if label == overlay::WINDOW_LABEL {
        return OnHostStop::Hide;
    }
    OnHostStop::Keep
}

/// Whether Epicenter refuses to exit when asked with `code`. Only a request
/// with no code is refused: Tauri raises one when the last window is
/// destroyed, which a host restart does, and Epicenter stays in the tray while
/// its windows come back (ADR-0542). A quit or a restart carries a code and
/// passes.
fn refuses_exit(code: Option<i32>) -> bool {
    code.is_none()
}

/// Tear down every window of a Bun host that stopped, and queue the ones a
/// person could see to open again once the next host is ready
/// (`on_host_stop`).
///
/// Each window's initialization script carries the stopped host's token, so a
/// reload is not enough: the window is created again, and its page reopens its
/// folder. Work already lives in the folder (ADR-0542); text a person had not
/// submitted is lost, as it is on quit.
fn invalidate_windows(app: &DesktopAppHandle) {
    let (sender, receiver) = mpsc::sync_channel(1);
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        let state = app.state::<HostState>();
        let mut windows: Vec<_> = app.webview_windows().into_iter().collect();
        // Built-in apps reopen in their table's order.
        windows.sort_by_key(|(label, _)| {
            BuiltInApp::ALL
                .iter()
                .position(|built_in| built_in.id() == label)
        });
        for (label, window) in windows {
            match on_host_stop(&label) {
                OnHostStop::Reopen(built_in) => {
                    if window.is_visible().unwrap_or(false) {
                        state.queue_app(built_in);
                    }
                    if window.destroy().is_err() {
                        let _ = window.hide();
                    }
                }
                OnHostStop::Close => {
                    if window.destroy().is_err() {
                        let _ = window.hide();
                    }
                }
                OnHostStop::Hide => {
                    let _ = window.hide();
                }
                OnHostStop::Keep => {}
            }
        }
        let _ = sender.send(());
    });
    let _ = receiver.recv_timeout(Duration::from_secs(2));
}

fn show_failure_dialog(app: &DesktopAppHandle, message: &str) -> FailureChoice {
    loop {
        let result = app
            .dialog()
            // A person reads the first two lines and the buttons; the detail is
            // kept because this is a startup crash, where the one useful thing
            // anybody can do with it is paste it into a report.
            .message(format!(
                "Epicenter could not start.\n\nNo app window was opened. Retry, or reveal the logs if it keeps happening.\n\nDetails: {message}"
            ))
            .title("Epicenter could not start")
            .kind(MessageDialogKind::Error)
            .buttons(MessageDialogButtons::YesNoCancelCustom(
                "Retry".to_string(),
                "Reveal Logs".to_string(),
                "Quit".to_string(),
            ))
            .blocking_show_with_result();

        match result {
            MessageDialogResult::Yes => return FailureChoice::Retry,
            MessageDialogResult::Custom(value) if value == "Retry" => return FailureChoice::Retry,
            MessageDialogResult::No => {
                if let Ok(path) = log_path(app) {
                    let _ = app.opener().reveal_item_in_dir(path);
                }
            }
            MessageDialogResult::Custom(value) if value == "Reveal Logs" => {
                if let Ok(path) = log_path(app) {
                    let _ = app.opener().reveal_item_in_dir(path);
                }
            }
            _ => return FailureChoice::Quit,
        }
    }
}

fn ensure_log_file(app: &DesktopAppHandle) -> Result<()> {
    let path = log_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create Epicenter log directory at {}", parent.display()))?;
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .with_context(|| format!("open Epicenter host log at {}", path.display()))?;
    Ok(())
}

fn open_log_file(app: &DesktopAppHandle) -> Result<File> {
    ensure_log_file(app)?;
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path(app)?)
        .context("open the stable Epicenter host log")
}

fn append_parent_log(app: &DesktopAppHandle, message: &str) {
    if let Ok(mut file) = open_log_file(app) {
        let _ = writeln!(file, "[tauri-host] {message}");
    }
    // The same line on the development terminal, beside the host's own output.
    #[cfg(debug_assertions)]
    eprintln!("[tauri-host] {message}");
}

fn log_path(app: &DesktopAppHandle) -> Result<PathBuf> {
    Ok(app.path().app_log_dir()?.join("host.log"))
}

fn launch_token() -> Result<String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| anyhow!("generate the per-launch credential: {error}"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn boot_frame_json(
    token: &str,
    port: u16,
    auth_cell: Option<&str>,
    paths: &app_data::DesktopPaths,
) -> Result<String> {
    let config = configured_auth_server()?;
    serde_json::to_string(&BootFrame {
        r#type: "boot",
        protocol_version: PROTOCOL_VERSION,
        token,
        port,
        auth_cell,
        auth_server: config.server,
        account_management: config.account_management,
        paths,
    })
    .context("serialize the Bun boot frame")
}

/// Read Bun's one ready frame: the current protocol version, the expected
/// port, and no other field.
fn read_ready_frame(reader: &mut impl BufRead, expected_port: u16) -> Result<()> {
    let mut line = String::new();
    let count = reader
        .read_line(&mut line)
        .context("read the Bun readiness frame")?;
    if count == 0 {
        bail!("Bun exited without emitting its versioned ready frame");
    }
    if !line.ends_with('\n') {
        bail!("Bun closed stdout before completing its versioned ready frame");
    }

    let line = line.trim_end_matches(['\r', '\n']);
    let frame: ReadyFrame = serde_json::from_str(line)
        .context("Bun stdout was not one strict versioned ready frame")?;
    if frame.r#type != "ready" {
        bail!("Bun emitted a frame other than ready");
    }
    if frame.protocol_version != PROTOCOL_VERSION {
        bail!(
            "Bun emitted readiness protocol version {}, expected {}",
            frame.protocol_version,
            PROTOCOL_VERSION
        );
    }
    if frame.port != expected_port {
        bail!(
            "Bun reported ready on port {}, expected {}",
            frame.port,
            expected_port
        );
    }
    Ok(())
}

fn initialization_script(origin: &str, token: &str) -> Result<String> {
    let origin = serde_json::to_string(origin)?;
    let token = serde_json::to_string(token)?;
    Ok(format!(
        r#"(() => {{
  const expectedOrigin = {origin};
  if (window.location.origin !== expectedOrigin) return;
  const sessionReady = fetch('/_epicenter/bootstrap', {{
    method: 'POST',
    credentials: 'include',
    headers: {{ authorization: `Bearer ${{{token}}}` }},
  }}).then((response) => {{
    if (!response.ok) throw new Error(`Epicenter session bootstrap failed (${{response.status}}).`);
  }});
  Object.defineProperty(window, '__EPICENTER_SESSION_READY__', {{
    value: sessionReady,
    enumerable: false,
    configurable: false,
    writable: false,
  }});
}})();"#
    ))
}

pub(crate) fn is_allowed_navigation(url: &tauri::Url, port: u16) -> bool {
    url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(port)
        && url.username().is_empty()
        && url.password().is_none()
}

fn origin(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

#[cfg(debug_assertions)]
fn configured_port() -> Result<u16> {
    development_port(std::env::var_os("EPICENTER_DEV_PORT").as_deref())
}

#[cfg(not(debug_assertions))]
fn configured_port() -> Result<u16> {
    // Keep this branch literal: release builds never inspect any port override.
    Ok(PRODUCTION_PORT)
}

#[cfg(any(debug_assertions, test))]
fn development_port(value: Option<&std::ffi::OsStr>) -> Result<u16> {
    let Some(value) = value else {
        return Ok(DEVELOPMENT_PORT);
    };
    let value = value
        .to_str()
        .context("EPICENTER_DEV_PORT must be valid UTF-8")?;
    let port: u16 = value
        .parse()
        .context("EPICENTER_DEV_PORT must be an integer from 1024 through 65535")?;
    if port < 1_024 {
        bail!("EPICENTER_DEV_PORT must be an integer from 1024 through 65535");
    }
    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;
    use std::io::Cursor;

    #[test]
    fn development_port_defaults_and_validates_override() {
        assert_eq!(development_port(None).unwrap(), DEVELOPMENT_PORT);
        assert_eq!(development_port(Some(OsStr::new("49152"))).unwrap(), 49_152);
        assert!(development_port(Some(OsStr::new("1023"))).is_err());
        assert!(development_port(Some(OsStr::new("65536"))).is_err());
        assert!(development_port(Some(OsStr::new("not-a-port"))).is_err());
    }

    #[test]
    fn development_sign_in_opens_only_the_configured_local_issuer() {
        let server = auth_server(None, Some("http://localhost:8787")).unwrap();
        validate_auth_url("http://localhost:8787/sign-in?state=state", &server.server).unwrap();
        for url in [
            "https://api.epicenter.so/sign-in",
            "http://localhost:8788/sign-in",
            "http://127.0.0.1:8787/sign-in",
            "http://localhost:8787/other",
            "http://user@localhost:8787/sign-in",
            "http://localhost:8787/sign-in#fragment",
        ] {
            assert!(validate_auth_url(url, &server.server).is_err());
        }
        assert!(validate_auth_url(
            "http://localhost:8787/sign-in",
            &auth_server(None, None).unwrap().server
        )
        .is_err());
        assert!(auth_server(None, Some("https://evil.test")).is_err());
    }

    #[test]
    fn production_port_is_stable() {
        assert_eq!(PRODUCTION_PORT, 39_130);
    }

    #[test]
    fn native_dashboard_policy_is_independent_of_server_identity() {
        let mut config = auth_server(Some("https://self.example"), None).unwrap();
        let identity = config.server.authority_id.clone();
        let dashboard = "https://self.example/dashboard".parse().unwrap();
        assert!(!is_hosted_account_url(&dashboard, &config));
        config.account_management = true;
        assert!(is_hosted_account_url(&dashboard, &config));
        validate_auth_url("https://self.example/sign-in", &config.server).unwrap();
        assert_eq!(config.server.authority_id, identity);
    }

    #[test]
    fn fixed_self_hosted_origin_owns_identity_and_browser_allowlist() {
        let server = auth_server(
            Some("https://SELF.example:443/"),
            Some("http://localhost:8787"),
        )
        .unwrap();
        assert_eq!(server.server.base_url, "https://self.example");
        assert_eq!(
            server.server.authority_id,
            "instance-68747470733a2f2f73656c662e6578616d706c65"
        );
        assert!(!server.account_management);
        validate_auth_url("https://self.example/sign-in?state=pending", &server.server).unwrap();
        for url in [
            "https://api.epicenter.so/sign-in",
            "https://self.example.evil.test/sign-in",
            "https://self.example:444/sign-in",
            "https://self.example/dashboard",
            "https://user@self.example/sign-in",
            "https://self.example/sign-in#fragment",
        ] {
            assert!(validate_auth_url(url, &server.server).is_err());
        }
        assert!(!is_hosted_account_url(
            &"https://self.example/dashboard".parse().unwrap(),
            &server
        ));
        for origin in [
            "ftp://self.example",
            "https://self.example/path",
            "https://user@self.example",
            "https://self.example?query",
            "https://self.example#fragment",
            "",
        ] {
            assert!(auth_server(Some(origin), None).is_err());
        }
    }

    fn ready_line(version: u8, port: u16) -> String {
        format!("{{\"type\":\"ready\",\"protocolVersion\":{version},\"port\":{port}}}\n")
    }

    #[test]
    fn parses_only_the_expected_v13_ready_frame() {
        read_ready_frame(&mut Cursor::new(ready_line(13, PRODUCTION_PORT)), PRODUCTION_PORT)
            .unwrap();

        for invalid in [
            "preamble\n".to_string(),
            "".to_string(),
            // The earlier protocols: 11 named installed applications, and 12
            // booted without the cache directory and relaunched only after a
            // departure round.
            ready_line(11, PRODUCTION_PORT),
            "{\"type\":\"ready\",\"protocolVersion\":11,\"port\":39130,\"installedAppIds\":[]}\n".to_string(),
            ready_line(12, PRODUCTION_PORT),
            ready_line(13, 39_131),
            // A field this protocol does not define refuses the frame.
            "{\"type\":\"ready\",\"protocolVersion\":13,\"port\":39130,\"installedAppIds\":[]}\n".to_string(),
            "{\"type\":\"boot\",\"protocolVersion\":13,\"port\":39130}\n".to_string(),
            ready_line(13, PRODUCTION_PORT).trim_end().to_string(),
        ] {
            assert!(
                read_ready_frame(&mut Cursor::new(invalid.as_bytes()), PRODUCTION_PORT).is_err(),
                "{invalid:?}"
            );
        }
    }

    #[test]
    fn navigation_allows_only_the_exact_active_origin_without_credentials() {
        for allowed in [
            "http://127.0.0.1:39130/apps/home/",
            "http://127.0.0.1:39130/another/path?query=ok#fragment",
        ] {
            assert!(is_allowed_navigation(
                &allowed.parse().unwrap(),
                PRODUCTION_PORT
            ));
        }

        for denied in [
            "https://127.0.0.1:39130/apps/home/",
            "http://localhost:39130/apps/home/",
            "http://127.0.0.1:39131/apps/home/",
            "http://user@127.0.0.1:39130/apps/home/",
            "http://user:secret@127.0.0.1:39130/apps/home/",
        ] {
            assert!(!is_allowed_navigation(
                &denied.parse().unwrap(),
                PRODUCTION_PORT
            ));
        }
    }

    #[test]
    fn built_in_window_table_has_stable_ids_routes_and_titles() {
        let actual = BuiltInApp::ALL.map(|window| (window.id(), window.path(), window.title()));
        assert_eq!(
            actual,
            [
                ("home", "/apps/home/", "Epicenter: Settings"),
                ("whispering", "/apps/whispering/", "Epicenter: Whispering"),
                ("honeycrisp", "/apps/honeycrisp/", "Epicenter: Honeycrisp"),
                ("capture", "/apps/capture/", "Epicenter: Capture"),
                ("mail", "/apps/mail/", "Epicenter: Mail"),
                ("todos", "/apps/todos/", "Epicenter: Todos"),
                ("books", "/apps/books/", "Epicenter: Books"),
                ("folders", "/apps/folders/", "Epicenter: Folders"),
            ]
        );
    }

    /// The Folders window lists exactly the compiled applications this table
    /// calls launchable, plus Settings behind its own button, so the two must
    /// not drift: an ID a window can show has to be one this verb opens, and an
    /// ID it cannot show has to be one this verb refuses. The Bun side asserts
    /// the same list against `applications.ts`.
    #[test]
    fn compiled_applications_are_the_release_built_spas() {
        let launchable: Vec<&str> = BuiltInApp::ALL
            .into_iter()
            .filter(|window| window.is_launchable())
            .map(BuiltInApp::id)
            .collect();
        assert_eq!(launchable, ["home", "capture", "todos", "folders"]);
        let unhosted: Vec<&str> = BuiltInApp::ALL
            .into_iter()
            .filter(|window| !window.is_hosted())
            .map(BuiltInApp::id)
            .collect();
        assert_eq!(unhosted, ["whispering"], "only Whispering is not hosted for now");
    }

    /// A Bun host that ends after readiness destroys and reopens the windows
    /// on its session, and Epicenter stays up meanwhile. The recording
    /// overlay is hidden rather than destroyed: destroying its `NSPanel`
    /// aborted the process on 2026-10-15 before the Retry dialog could show.
    #[test]
    fn a_host_restart_reopens_built_in_windows_and_never_destroys_the_overlay() {
        for built_in in BuiltInApp::ALL {
            assert_eq!(on_host_stop(built_in.id()), OnHostStop::Reopen(built_in));
        }
        assert_eq!(
            on_host_stop(&installed_window_label("so.example.board", Some("data:x"))),
            OnHostStop::Close
        );
        #[cfg(target_os = "macos")]
        assert_eq!(on_host_stop(overlay::WINDOW_LABEL), OnHostStop::Hide);
        assert_eq!(on_host_stop("unknown"), OnHostStop::Keep);

        // The last window's destruction asks to exit with no code; a quit or
        // a restart names one.
        assert!(refuses_exit(None));
        assert!(!refuses_exit(Some(0)));
        assert!(!refuses_exit(Some(1)));
        assert!(!refuses_exit(Some(tauri::RESTART_EXIT_CODE)));
    }

    #[test]
    fn launch_opens_only_what_a_window_offers() {
        assert_eq!(parse_application_id("home"), Some(BuiltInApp::Home));
        assert_eq!(parse_application_id("capture"), Some(BuiltInApp::Capture));
        assert_eq!(parse_application_id("todos"), Some(BuiltInApp::Todos));
        assert_eq!(parse_application_id("folders"), Some(BuiltInApp::Folders));

        for denied in [
            "",
            // Not hosted inside Epicenter for now (`is_hosted`).
            "whispering",
            "Whispering",
            "whispering/",
            "../whispering",
            // Honeycrisp ships its own shell; its old host id stays unused.
            "honeycrisp",
            // Placeholder documents with nothing behind them to open.
            "mail",
            "books",
            // No compiled app has this id.
            "hello-http",
            "so.epicenter.local-mail",
        ] {
            assert!(
                parse_application_id(denied).is_none(),
                "expected {denied:?} rejected"
            );
        }
    }

    #[test]
    fn trusted_app_capabilities_grant_the_shared_http_slice() {
        for encoded in [
            include_str!("../capabilities/trusted-app-windows-development.json"),
            include_str!("../capabilities/trusted-app-windows-production.json"),
        ] {
            let capability: serde_json::Value = serde_json::from_str(encoded).unwrap();
            assert_eq!(
                capability["windows"],
                serde_json::json!(["whispering"]),
                "the trusted-app HTTP slice reaches Whispering alone while installed apps are parked"
            );

            let http = capability["permissions"]
                .as_array()
                .unwrap()
                .iter()
                .find(|permission| permission["identifier"] == "http:default")
                .expect("the app capability must scope the HTTP plugin");
            let allowed: Vec<&str> = http["allow"]
                .as_array()
                .unwrap()
                .iter()
                .map(|entry| entry["url"].as_str().unwrap())
                .collect();
            assert_eq!(
                allowed,
                ["http://*", "https://*", "http://*:*", "https://*:*"],
                "the first trusted-app authority slice is unrestricted HTTP(S) egress"
            );
        }
    }

    #[test]
    fn whispering_native_capabilities_do_not_duplicate_trusted_app_http() {
        for encoded in [
            include_str!("../capabilities/trusted-whispering-native-development.json"),
            include_str!("../capabilities/trusted-whispering-native-production.json"),
        ] {
            let capability: serde_json::Value = serde_json::from_str(encoded).unwrap();
            assert!(
                capability["permissions"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|permission| permission["identifier"] != "http:default"),
                "trusted-app HTTP belongs to the shared app capability, not Whispering native"
            );
        }
    }

    /// The `tauri-plugin-macos-permissions` plugin is gone from this build:
    /// `command.rs` owns the two OS permission capabilities Epicenter exposes,
    /// through AVFoundation and the Accessibility API directly.
    ///
    /// Its `macos-permissions:default` grant handed Whispering twelve unrelated
    /// plugin commands (screen recording, input monitoring, full disk access,
    /// camera) to reach the two it used. A grant naming a plugin this build does
    /// not ship is a silent no-op, so nothing would fail if it were pasted back;
    /// what it would do is describe an authority the app does not have. Both
    /// Whispering windows are checked, not just the one that had it.
    #[test]
    fn no_whispering_capability_grants_the_deleted_permissions_plugin() {
        for encoded in [
            include_str!("../capabilities/trusted-whispering-native-development.json"),
            include_str!("../capabilities/trusted-whispering-native-production.json"),
            include_str!("../capabilities/trusted-whispering-overlay-development.json"),
            include_str!("../capabilities/trusted-whispering-overlay-production.json"),
        ] {
            let capability: serde_json::Value = serde_json::from_str(encoded).unwrap();
            for permission in capability["permissions"].as_array().unwrap() {
                // Permissions are either a bare identifier string or an object
                // with a scope; both spell the plugin the same way.
                let identifier = permission
                    .as_str()
                    .or_else(|| permission["identifier"].as_str())
                    .unwrap_or_default();
                assert!(
                    !identifier.starts_with("macos-permissions:"),
                    "{} grants a plugin this build no longer ships",
                    capability["identifier"].as_str().unwrap()
                );
            }
        }
    }

    /// The recovery path an application offers must survive Home not being
    /// there yet. The intent is host state, so "Home is absent", "Home is still
    /// booting", and "Home is open behind another window" are the same code
    /// path: the intent waits until Home claims it.
    #[test]
    fn a_pending_home_section_waits_for_home_to_claim_it() {
        let state = HostState::new(Ok(1));
        assert_eq!(
            state.take_home_section(),
            None,
            "nothing pending before anyone asks"
        );

        // Home absent or mid-boot: nobody is listening, and the intent survives.
        state.queue_home_section(HomeSection::Transcription);
        assert_eq!(
            state.take_home_section(),
            Some(HomeSection::Transcription),
            "the intent is still there whenever Home gets around to asking"
        );
    }

    /// Taking is destructive, so however many nudges arrive, one request opens
    /// one section once. Without this a stale intent would reopen the panel on
    /// some later unrelated mount.
    #[test]
    fn a_claimed_home_section_is_not_replayed() {
        let state = HostState::new(Ok(1));
        state.queue_home_section(HomeSection::Transcription);
        assert!(state.take_home_section().is_some());
        assert_eq!(
            state.take_home_section(),
            None,
            "a claimed intent must not fire again"
        );
    }

    /// Two recovery attempts in a row should land the user somewhere once.
    #[test]
    fn repeated_requests_collapse_to_one_pending_section() {
        let state = HostState::new(Ok(1));
        state.queue_home_section(HomeSection::Transcription);
        state.queue_home_section(HomeSection::Transcription);
        assert!(state.take_home_section().is_some());
        assert_eq!(state.take_home_section(), None);
    }

    /// Every command a capability grants must exist, and every command the crate
    /// exposes must be declared to the Tauri manifest. These are two hand-kept
    /// lists today, and a grant for a command that does not exist is a silent
    /// no-op rather than an error.
    #[test]
    fn capability_grants_name_only_commands_this_build_has() {
        let declared: std::collections::BTreeSet<&str> =
            crate::command_names::COMMANDS.iter().copied().collect();
        for encoded in [
            include_str!("../capabilities/home-model-administration-development.json"),
            include_str!("../capabilities/home-model-administration-production.json"),
            include_str!("../capabilities/trusted-whispering-native-development.json"),
            include_str!("../capabilities/trusted-whispering-native-production.json"),
            include_str!("../capabilities/trusted-app-windows-development.json"),
            include_str!("../capabilities/trusted-app-windows-production.json"),
            include_str!("../capabilities/launch-application-development.json"),
            include_str!("../capabilities/launch-application-production.json"),
            include_str!("../capabilities/folders-development.json"),
            include_str!("../capabilities/folders-production.json"),
            include_str!("../capabilities/installed-app-windows-development.json"),
            include_str!("../capabilities/installed-app-windows-production.json"),
        ] {
            let capability: serde_json::Value = serde_json::from_str(encoded).unwrap();
            for permission in capability["permissions"].as_array().unwrap() {
                let Some(name) = permission.as_str() else {
                    continue;
                };
                // Only app-owned grants are checked here; plugin and core
                // permissions (`core:`, `dialog:`, ...) belong to their plugins.
                let Some(command) = name.strip_prefix("allow-") else {
                    continue;
                };
                if name.contains(':') {
                    continue;
                }
                let command = command.replace('-', "_");
                assert!(
                    declared.contains(command.as_str()),
                    "{name} grants a command this build does not declare: {command}"
                );
            }
        }
    }

    /// The generated bindings are a committed artifact, so they can go stale
    /// against the command list without anything failing to compile.
    ///
    /// `launch_application` is deliberately outside the generated API: it rides
    /// Tauri's handwritten handler because it is host-owned rather than part of
    /// the app contract.
    #[test]
    fn generated_bindings_cover_every_declared_command() {
        const HANDWRITTEN: &[&str] = &["launch_application"];
        for bindings in [
            include_str!("../../../whispering/src/lib/tauri/bindings.gen.ts"),
            include_str!("../../src/ui/bindings.gen.ts"),
        ] {
            for command in crate::command_names::COMMANDS {
                if HANDWRITTEN.contains(command) {
                    continue;
                }
                // Either quote style: specta emits double quotes and the repo
                // formatter rewrites them to single, so both are "fresh".
                assert!(
                    bindings.contains(&format!("'{command}'"))
                        || bindings.contains(&format!("\"{command}\"")),
                    "regenerate bindings: {command} is missing"
                );
            }
        }
    }

    /// Model administration is routed to Home and to no application window
    /// (ADR-0180). This is wiring, not a sandbox: an app window runs as
    /// Epicenter. What it proves is that the ownership the record describes is
    /// the ownership the build actually wires, so "Whispering cannot pick a
    /// model" does not quietly become false the next time a permission is
    /// pasted into the wrong file.
    #[test]
    fn model_administration_is_routed_to_home_and_away_from_applications() {
        // `get_active_model` is in this list: model *identity* is administration
        // data. An application reads readiness, which answers "can the route run
        // and what does it accept" without naming a model (ADR-0180).
        const ADMINISTRATION: &[&str] = &[
            "allow-list-models",
            "allow-download-model",
            "allow-cancel-download",
            "allow-delete-model",
            "allow-get-active-model",
            "allow-set-active-model",
            "allow-get-unload-policy",
            "allow-set-unload-policy",
        ];

        for encoded in [
            include_str!("../capabilities/home-model-administration-development.json"),
            include_str!("../capabilities/home-model-administration-production.json"),
        ] {
            let capability: serde_json::Value = serde_json::from_str(encoded).unwrap();
            assert_eq!(
                capability["windows"].as_array().unwrap(),
                &vec![serde_json::json!("home")],
                "model administration belongs to Home alone"
            );
            let permissions = capability["permissions"].as_array().unwrap();
            for permission in ADMINISTRATION {
                assert!(
                    permissions.contains(&serde_json::json!(permission)),
                    "Home must be able to invoke {permission}"
                );
            }
        }

        for encoded in [
            include_str!("../capabilities/trusted-whispering-native-development.json"),
            include_str!("../capabilities/trusted-whispering-native-production.json"),
        ] {
            let capability: serde_json::Value = serde_json::from_str(encoded).unwrap();
            let permissions = capability["permissions"].as_array().unwrap();
            for permission in ADMINISTRATION {
                assert!(
                    !permissions.contains(&serde_json::json!(permission)),
                    "an application must not administer models: {permission}"
                );
            }
            // It still prewarms, still reads advisory readiness so it can warn
            // before capture, and can still send the user to Home to fix it.
            for permission in [
                "allow-prewarm-model",
                "allow-get-local-transcription-readiness",
                "allow-open-home",
            ] {
                assert!(
                    permissions.contains(&serde_json::json!(permission)),
                    "Whispering must keep {permission}"
                );
            }
        }

        // Catalog apps transcribe through the same public client, so the same
        // separation has to hold for the window class that did not exist when
        // ADR-0180 was written.
        for encoded in APP_WINDOW_CAPABILITIES {
            let capability: serde_json::Value = serde_json::from_str(encoded).unwrap();
            let permissions = capability["permissions"].as_array().unwrap();
            for permission in ADMINISTRATION {
                assert!(
                    !permissions.contains(&serde_json::json!(permission)),
                    "an app window must not administer models: {permission}"
                );
            }
        }
    }

    /// Both variants of the one capability that says what an app window may
    /// reach natively.
    const APP_WINDOW_CAPABILITIES: &[&str] = &[
        include_str!("../capabilities/trusted-app-windows-development.json"),
        include_str!("../capabilities/trusted-app-windows-production.json"),
    ];

    /// The operations `@epicenter/app` exposes, and therefore the complete set
    /// of this crate's commands an app window is granted.
    const PUBLIC_CLIENT_COMMANDS: &[&str] = &[
        "transcribe_audio_bytes",
        "list_inference_models",
        "prewarm_model",
        "get_local_transcription_readiness",
    ];

    /// Every bare `allow-<command>` grant in a capability, as command names.
    ///
    /// Plugin and core grants (`core:event:allow-listen`, the scoped
    /// `http:default` object) are not this crate's commands and are checked
    /// where they are relevant instead.
    fn granted_app_commands(encoded: &str) -> std::collections::BTreeSet<String> {
        let capability: serde_json::Value = serde_json::from_str(encoded).unwrap();
        capability["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|permission| permission.as_str())
            .filter(|name| !name.contains(':'))
            .filter_map(|name| name.strip_prefix("allow-"))
            .map(|command| command.replace('-', "_"))
            .collect()
    }

    /// An app window's native command API is the public client's API, exactly:
    /// nothing the client cannot call, and nothing it can call that the window
    /// was not granted.
    ///
    /// This is API wiring, not a sandbox. An app window already holds the
    /// shared origin, the session, and the Epicenter application's own device
    /// grants (ADR-0179); what an equality check buys is that the *product*
    /// boundary stays a decision. A permission pasted in to unblock something
    /// fails here rather than quietly widening what an app window can do.
    #[test]
    fn app_windows_reach_exactly_the_public_client_api() {
        let expected: std::collections::BTreeSet<String> = PUBLIC_CLIENT_COMMANDS
            .iter()
            .map(|command| command.to_string())
            .collect();
        for encoded in APP_WINDOW_CAPABILITIES {
            assert_eq!(
                granted_app_commands(encoded),
                expected,
                "the app-window capability must grant the public client's API and nothing else"
            );
        }
    }

    /// The granted commands must exist, or the grant above is a silent no-op
    /// and an app window invokes into nothing.
    #[test]
    fn the_public_client_api_is_commands_this_build_declares() {
        let declared: std::collections::BTreeSet<&str> =
            crate::command_names::COMMANDS.iter().copied().collect();
        for command in PUBLIC_CLIENT_COMMANDS {
            assert!(
                declared.contains(command),
                "the app-window grant names {command}, which this build does not declare"
            );
        }
    }

    #[test]
    fn each_build_selects_the_home_model_administration_capability() {
        for (encoded, capability) in [
            (
                include_str!("../tauri.dev.conf.json"),
                "home-model-administration-development",
            ),
            (
                include_str!("../tauri.conf.json"),
                "home-model-administration-production",
            ),
            (include_str!("../tauri.dev.conf.json"), "folders-development"),
            (include_str!("../tauri.conf.json"), "folders-production"),
            (
                include_str!("../tauri.dev.conf.json"),
                "installed-app-windows-development",
            ),
            (
                include_str!("../tauri.conf.json"),
                "installed-app-windows-production",
            ),
        ] {
            let config: serde_json::Value = serde_json::from_str(encoded).unwrap();
            let selected = config["app"]["security"]["capabilities"]
                .as_array()
                .unwrap();
            assert!(
                selected.contains(&serde_json::json!(capability)),
                "{capability} exists but this build does not select it"
            );
        }
    }

    /// A development build and an installed one can be running at the same time
    /// on one machine, and they own separate config, data, and log directories.
    /// Telling them apart has to be possible from the Dock, the menu bar, and
    /// the window title, not only from a bundle identifier nobody reads.
    #[test]
    fn development_and_production_builds_are_distinguishable() {
        let development: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.dev.conf.json")).unwrap();
        let production: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();

        assert_eq!(production["productName"], "Epicenter");
        assert_eq!(development["productName"], "Epicenter Dev");
        assert_ne!(production["identifier"], development["identifier"]);
    }

    /// The Folders window lists what can be launched, and Settings offers
    /// Whispering once local transcription is ready while Whispering is
    /// hosted, so those two windows are
    /// the ones that launch (ADR-0189, ADR-0537). Granting the verb more widely
    /// would let an application open another application without the user ever
    /// choosing it, which is a product decision nobody made.
    #[test]
    fn only_the_folders_window_and_settings_can_launch_an_application() {
        for encoded in [
            include_str!("../capabilities/launch-application-development.json"),
            include_str!("../capabilities/launch-application-production.json"),
        ] {
            let capability: serde_json::Value = serde_json::from_str(encoded).unwrap();
            assert_eq!(
                capability["windows"],
                serde_json::json!(["folders", "home"]),
                "the launch verb belongs to the Folders window and Settings alone"
            );
            assert_eq!(
                capability["permissions"],
                serde_json::json!(["allow-launch-application"]),
            );
        }
    }

    /// What every window that opens a folder holds: the folder plugin, and
    /// listening for its change event, `epicenter-folder://changed`.
    const FOLDER_WINDOW: [&str; 3] = [
        "epicenter-folder:default",
        "core:event:allow-listen",
        "core:event:allow-unlisten",
    ];

    /// Todos' and Capture's windows hold the folder plugin alone, and hear
    /// its change event: it reads and changes only the directory a grant
    /// names. They hold no fs or HTTP grant; Git transfers run in the `git`
    /// the shell starts.
    #[test]
    fn folder_windows_hold_only_the_folder_plugin() {
        for encoded in [
            include_str!("../capabilities/todos-folder-development.json"),
            include_str!("../capabilities/todos-folder-production.json"),
            include_str!("../capabilities/capture-folder-development.json"),
            include_str!("../capabilities/capture-folder-production.json"),
        ] {
            let capability: serde_json::Value = serde_json::from_str(encoded).unwrap();
            assert_eq!(
                capability["permissions"],
                serde_json::json!(FOLDER_WINDOW),
                "{encoded}"
            );
        }
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert!(config["plugins"].get("fs").is_none(), "no fs plugin is installed");
    }

    /// The Folders window holds the folder plugin and its own listing, beside
    /// the launch verb it shares with Settings, and nothing else: it reaches
    /// folders only through scopes the listing registered or permitted it into,
    /// and it administers no model.
    #[test]
    fn the_folders_window_holds_the_folder_plugin_and_its_listing() {
        for encoded in [
            include_str!("../capabilities/folders-development.json"),
            include_str!("../capabilities/folders-production.json"),
        ] {
            let capability: serde_json::Value = serde_json::from_str(encoded).unwrap();
            assert_eq!(capability["windows"], serde_json::json!(["folders"]));
            assert_eq!(
                capability["permissions"],
                serde_json::json!([
                    "epicenter-folder:default",
                    "core:event:allow-listen",
                    "core:event:allow-unlisten",
                    "allow-list-data-folders",
                    "allow-list-installed-apps",
                    "allow-install-app",
                    "allow-approve-app",
                    "allow-update-app",
                    "allow-open-installed-app"
                ]),
                "{encoded}"
            );
        }
        for encoded in [
            include_str!("../capabilities/trusted-app-windows-development.json"),
            include_str!("../capabilities/trusted-app-windows-production.json"),
            include_str!("../capabilities/trusted-whispering-native-development.json"),
            include_str!("../capabilities/trusted-whispering-native-production.json"),
            include_str!("../capabilities/home-model-administration-development.json"),
            include_str!("../capabilities/home-model-administration-production.json"),
            include_str!("../capabilities/launch-application-development.json"),
            include_str!("../capabilities/launch-application-production.json"),
            include_str!("../capabilities/capture-folder-development.json"),
            include_str!("../capabilities/capture-folder-production.json"),
            include_str!("../capabilities/todos-folder-development.json"),
            include_str!("../capabilities/todos-folder-production.json"),
            include_str!("../capabilities/installed-app-windows-development.json"),
            include_str!("../capabilities/installed-app-windows-production.json"),
        ] {
            assert!(
                !encoded.contains("list-data-folders"),
                "the listing belongs to the Folders window alone"
            );
            assert!(
                !encoded.contains("-app\""),
                "installing and opening apps belong to the Folders window alone"
            );
        }
    }

    /// An installed app's window holds the folder plugin alone, and hears its
    /// change event, under every label `open_installed_window` makes, and
    /// nothing that installs, approves, or launches.
    #[test]
    fn installed_app_windows_hold_only_the_folder_plugin() {
        for encoded in [
            include_str!("../capabilities/installed-app-windows-development.json"),
            include_str!("../capabilities/installed-app-windows-production.json"),
        ] {
            let capability: serde_json::Value = serde_json::from_str(encoded).unwrap();
            assert_eq!(capability["windows"], serde_json::json!(["app:*"]));
            assert_eq!(capability["permissions"], serde_json::json!(FOLDER_WINDOW));
        }
        for (id, folder, label) in [
            ("com.example.board", None, "app:com_example_board"),
            (
                "com.example.board",
                Some("data:My notes"),
                "app:com_example_board:646174613a4d79206e6f746573",
            ),
        ] {
            let made = installed_window_label(id, folder);
            assert_eq!(made, label);
            assert!(made.starts_with(INSTALLED_WINDOW_PREFIX));
            assert!(made
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '/' | ':' | '_')));
        }
        assert_ne!(
            installed_window_label("com.example.board", Some("a")),
            installed_window_label("com.example.board", Some("b"))
        );
    }

    /// The launch verb reveals any compiled window, which is exactly why no
    /// app window may hold it: one application must not be able to reveal
    /// another.
    #[test]
    fn no_app_window_can_launch_an_application() {
        for encoded in APP_WINDOW_CAPABILITIES {
            assert!(
                !granted_app_commands(encoded).contains("launch_application"),
                "an app window must not be able to reveal another application"
            );
        }
    }

    #[test]
    fn deep_links_accept_only_the_closed_built_in_app_table() {
        for (url, expected) in [
            ("epicenter://app/home", BuiltInApp::Home),
            ("epicenter://app/whispering", BuiltInApp::Whispering),
            ("epicenter://app/honeycrisp", BuiltInApp::Honeycrisp),
            ("epicenter://app/capture", BuiltInApp::Capture),
            ("epicenter://app/mail", BuiltInApp::Mail),
            ("epicenter://app/todos", BuiltInApp::Todos),
            ("epicenter://app/books", BuiltInApp::Books),
            ("epicenter://app/folders", BuiltInApp::Folders),
            // A link without a path opens what launching Epicenter opens.
            ("epicenter://", BuiltInApp::Folders),
            ("epicenter:///", BuiltInApp::Folders),
        ] {
            assert_eq!(parse_app_deep_link(&url.parse().unwrap()), Some(expected));
        }

        for denied in [
            // Both retired spellings. Neither is kept as a compatibility alias.
            "epicenter://surface/home",
            "epicenter://window/home",
            "epicenter://app/unknown",
            "epicenter://app/home/",
            "epicenter://app/home/extra",
            "epicenter://app/home?mode=other",
            "epicenter://app/home#other",
            "epicenter://user@app/home",
            "epicenter://user:secret@app/home",
            "epicenter://other/query",
            "epicenter://?mode=other",
            "epicenter:///home",
            "https://app/home",
        ] {
            assert_eq!(parse_app_deep_link(&denied.parse().unwrap()), None);
        }
    }

    #[test]
    fn auth_deep_links_accept_only_the_exact_callback_route() {
        for url in [
            "epicenter://auth/callback?code=code&state=state",
            "epicenter://auth/callback?error=access_denied&state=state",
        ] {
            assert_eq!(
                parse_auth_callback(&url.parse().unwrap()),
                Some(url.to_string())
            );
        }

        for denied in [
            "epicenter://auth/callback",
            "epicenter://auth/callback?state=state",
            "epicenter://auth/callback/extra?code=code",
            "epicenter://auth/callback?code=code#fragment",
            "epicenter://user@auth/callback?code=code",
            "https://api.epicenter.so/auth/callback?code=code",
        ] {
            assert_eq!(parse_auth_callback(&denied.parse().unwrap()), None);
        }
    }

    #[test]
    fn system_browser_accepts_only_hosted_account_destinations() {
        for allowed in [
            "https://api.epicenter.so/dashboard?expectedPrincipal=alice",
            "https://api.epicenter.so/dashboard/usage?expectedPrincipal=alice",
            "https://api.epicenter.so/dashboard/account",
        ] {
            assert!(is_hosted_account_url(
                &allowed.parse().unwrap(),
                &auth_server(None, None).unwrap()
            ));
        }
        for denied in [
            "http://api.epicenter.so/dashboard",
            "https://api.epicenter.so.evil.test/dashboard",
            "https://api.epicenter.so:444/dashboard",
            "https://user@api.epicenter.so/dashboard",
            "https://api.epicenter.so/dashboard#fragment",
            "https://api.epicenter.so/dashboard/other",
            "https://api.epicenter.so/dashboard/usage/extra",
            "https://api.epicenter.so/sign-in",
            "https://api.epicenter.so/auth/sign-out",
            "file:///dashboard",
        ] {
            assert!(!is_hosted_account_url(
                &denied.parse().unwrap(),
                &auth_server(None, None).unwrap()
            ));
        }
    }

    #[test]
    fn system_browser_accepts_only_hosted_auth_urls() {
        for allowed in [
            "https://api.epicenter.so/sign-in?callback=epicenter%3A%2F%2Fauth%2Fcallback&state=state&challenge=challenge",
            "https://api.epicenter.so/sign-in?reauth=1",
        ] {
            validate_auth_url(allowed, &auth_server(None, None).unwrap().server).unwrap();
        }
        for denied in [
            "http://api.epicenter.so/sign-in",
            "https://api.epicenter.so.evil.test/sign-in",
            "https://api.epicenter.so/not-auth",
            "https://api.epicenter.so/sign-in/extra",
            "https://api.epicenter.so/auth/sign-in",
            "https://user@api.epicenter.so/sign-in",
            "https://api.epicenter.so/sign-in#fragment",
            "https://api.epicenter.so:444/sign-in",
        ] {
            assert!(validate_auth_url(denied, &auth_server(None, None).unwrap().server).is_err());
        }
    }

    #[test]
    fn bun_auth_frames_are_closed_and_exact() {
        assert_eq!(
            serde_json::to_value(RustToBunNativeFrame::AuthCallback {
                url: "epicenter://auth/callback?code=code&state=state",
            })
            .unwrap(),
            serde_json::json!({
                "type": "auth-callback",
                "url": "epicenter://auth/callback?code=code&state=state",
            })
        );
        assert_eq!(
            serde_json::from_str::<BunToRustNativeFrame>(
                "{\"type\":\"store-auth\",\"requestId\":\"one\",\"serialized\":null}"
            )
            .unwrap(),
            BunToRustNativeFrame::StoreAuth {
                request_id: "one".to_string(),
                serialized: None,
            }
        );
        assert!(serde_json::from_str::<BunToRustNativeFrame>(
            "{\"type\":\"execute\",\"command\":\"shell\"}"
        )
        .is_err());
        assert!(serde_json::from_str::<BunToRustNativeFrame>(
            "{\"type\":\"relaunch\",\"extra\":true}"
        )
        .is_err());
    }

    /// A relaunch asks nothing first, so its frame carries nothing: no request
    /// to answer and no grant to hold (ADR-0542).
    #[test]
    fn the_relaunch_frame_is_bare() {
        assert_eq!(
            serde_json::from_str::<BunToRustNativeFrame>("{\"type\":\"relaunch\"}").unwrap(),
            BunToRustNativeFrame::Relaunch {}
        );
        for invalid in [
            "{\"type\":\"relaunch\",\"requestId\":\"one\"}",
            "{\"type\":\"prepare-relaunch\",\"requestId\":\"one\"}",
            "{\"type\":\"prepare-cancel\",\"requestId\":\"one\"}",
            "{\"type\":\"relaunch-abort\",\"requestId\":\"one\"}",
        ] {
            assert!(
                serde_json::from_str::<BunToRustNativeFrame>(invalid).is_err(),
                "{invalid}"
            );
        }
    }

    #[test]
    fn forwarded_arguments_extract_valid_unique_app_links() {
        let arguments = [
            "/Applications/Epicenter.app/Contents/MacOS/Epicenter",
            "epicenter://app/mail",
            "epicenter://app/unknown",
            "epicenter://app/mail",
            "epicenter://app/books",
            "epicenter://",
        ]
        .map(String::from);
        assert_eq!(
            apps_from_arguments(&arguments),
            vec![BuiltInApp::Mail, BuiltInApp::Books, BuiltInApp::Folders]
        );
    }

    #[test]
    fn boot_frame_carries_the_native_directories_and_auth_cell() {
        let paths = app_data::DesktopPaths {
            data_dir: std::env::temp_dir().join("so.epicenter.dev"),
            folder_dir: std::env::temp_dir().join("Epicenter Dev"),
            cache_dir: std::env::temp_dir().join("so.epicenter.dev-cache"),
        };
        let json = boot_frame_json("safe_token", PRODUCTION_PORT, Some("opaque"), &paths).unwrap();
        let frame: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(frame["authServer"]["baseURL"].is_string());
        assert!(frame["authServer"].get("baseUrl").is_none());
        assert_eq!(
            frame,
            serde_json::json!({
                "type": "boot", "protocolVersion": 13, "token": "safe_token",
                "port": PRODUCTION_PORT, "authCell": "opaque",
                "authServer": configured_auth_server().unwrap().server,
                "accountManagement": configured_auth_server().unwrap().account_management,
                "dataDir": paths.data_dir, "folderDir": paths.folder_dir,
                "cacheDir": paths.cache_dir,
            })
        );
    }

    #[test]
    fn initialization_script_guards_origin_and_exposes_only_ready_promise() {
        let script = initialization_script("http://127.0.0.1:39130", "safe_token").unwrap();
        assert!(script.contains("window.location.origin !== expectedOrigin"));
        assert!(script.contains("/_epicenter/bootstrap"));
        assert!(script.contains("__EPICENTER_SESSION_READY__"));
        assert!(!script.contains("__EPICENTER_WHISPERING_AUTH_READY__"));
        assert!(!script.contains("__EPICENTER_WHISPERING_AUTH_BOOTSTRAP__"));
        assert!(!script.contains("keyring_read"));
        assert!(!script.contains("localStorage"));
        assert!(!script.contains("sessionStorage"));
    }
}
