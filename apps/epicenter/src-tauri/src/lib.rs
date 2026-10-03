use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
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
use tauri_specta::Event as _;

/// The command list, shared with `build.rs` through `include!`. Only the tests
/// read it from the crate, which is where the drift checks live.
#[cfg(test)]
mod command_names;

pub mod app_data;

pub mod audio;
use audio::encode_recording_for_upload;

pub mod recorder;
use recorder::commands::{
    cancel_recording, cancel_recording_owned_by, current_recording, enumerate_recording_devices,
    start_recording, stop_recording,
};
use recorder::recorder::Recorder;

pub mod transcription;
use transcription::{
    delete_model, download_model, get_active_model, get_local_transcription_readiness,
    get_unload_policy, list_models, prewarm_model, set_active_model, set_unload_policy,
    transcribe_recording, LocalTranscriptionSettings, ModelCache,
};

pub mod command;
use command::{
    get_microphone_permission, open_accessibility_settings, request_accessibility_permission,
    request_microphone_permission,
};

pub mod download;
use download::{cancel_download, DownloadManager};

mod delivery;
use delivery::{simulate_copy_keystroke, simulate_enter_keystroke, write_text};

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

/// Reserved label prefix for derived-catalog app windows (ADR-0153). One
/// capability glob (`app-*`) grants every such window the first trusted-app
/// authority slice, so no host-internal window label may ever start with it.
const APP_WINDOW_PREFIX: &str = "app-";
#[cfg(any(not(debug_assertions), test))]
const PRODUCTION_PORT: u16 = 39_130;
#[cfg(any(debug_assertions, test))]
const DEVELOPMENT_PORT: u16 = 39_131;
const PROTOCOL_VERSION: u8 = 2;
const HOSTED_AUTH_ORIGIN: &str = "https://api.epicenter.so";
const READY_TIMEOUT: Duration = Duration::from_secs(15);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BuiltInApp {
    Home,
    Whispering,
    Honeycrisp,
    Mail,
    Books,
}

impl BuiltInApp {
    const ALL: [Self; 5] = [
        Self::Home,
        Self::Whispering,
        Self::Honeycrisp,
        Self::Mail,
        Self::Books,
    ];

    /// Whether Home lists this app as one a person can open (ADR-0189).
    ///
    /// Every variant here is an app in the product model; this says only which
    /// ones Home offers. Home is absent because you are already looking at it,
    /// not because it is above the others (ADR-0209). Books is a
    /// release-bundled placeholder document with nothing behind it to open.
    /// All stay reserved IDs the catalog refuses to admit, so "not launchable"
    /// never means "free for someone else to claim".
    const fn is_launchable(self) -> bool {
        matches!(self, Self::Whispering | Self::Honeycrisp | Self::Mail)
    }

    const fn id(self) -> &'static str {
        match self {
            Self::Home => "home",
            Self::Whispering => "whispering",
            Self::Honeycrisp => "honeycrisp",
            Self::Mail => "mail",
            Self::Books => "books",
        }
    }

    const fn path(self) -> &'static str {
        match self {
            Self::Home => "/apps/home/",
            Self::Whispering => "/apps/whispering/",
            Self::Honeycrisp => "/apps/honeycrisp/",
            Self::Mail => "/apps/mail/",
            Self::Books => "/apps/books/",
        }
    }

    const fn title(self) -> &'static str {
        match self {
            Self::Home => "Epicenter: Home",
            Self::Whispering => "Epicenter: Whispering",
            Self::Honeycrisp => "Epicenter: Honeycrisp",
            Self::Mail => "Epicenter: Mail",
            Self::Books => "Epicenter: Books",
        }
    }

    fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|built_in| built_in.id() == id)
    }
}

type DesktopAppHandle = AppHandle<Wry>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BootFrame<'a> {
    r#type: &'static str,
    protocol_version: u8,
    token: &'a str,
    port: u16,
    auth_cell: Option<&'a str>,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadyFrame {
    r#type: String,
    protocol_version: u8,
    port: u16,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
enum BunToRustAuthFrame {
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
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "appId")]
        app_id: String,
        #[serde(rename = "accountId")]
        account_id: String,
        value: String,
    },
    GetAppSecret {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "appId")]
        app_id: String,
        #[serde(rename = "accountId")]
        account_id: String,
    },
    DeleteAppSecret {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "appId")]
        app_id: String,
        #[serde(rename = "accountId")]
        account_id: String,
    },
    Relaunch {},
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum RustToBunAuthFrame<'a> {
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
    OauthCallback {
        url: &'a str,
    },
}

struct ManagedChild {
    generation: u64,
    child: Child,
    stdin: Option<ChildStdin>,
}

struct HostState {
    port: std::result::Result<u16, String>,
    next_generation: AtomicU64,
    process: Mutex<Option<ManagedChild>>,
    active_token: Mutex<Option<String>>,
    pending_apps: Mutex<Vec<BuiltInApp>>,
    pending_oauth_callback: Mutex<Option<String>>,
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
            pending_oauth_callback: Mutex::new(None),
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

    fn queue_oauth_callback(&self, url: String) {
        *self
            .pending_oauth_callback
            .lock()
            .expect("pending OAuth callback lock poisoned") = Some(url);
    }

    fn take_oauth_callback(&self) -> Option<String> {
        self.pending_oauth_callback
            .lock()
            .expect("pending OAuth callback lock poisoned")
            .take()
    }

    fn activate(&self, token: &str) {
        *self
            .active_token
            .lock()
            .expect("active token lock poisoned") = Some(token.to_string());
    }

    fn deactivate(&self) {
        *self
            .active_token
            .lock()
            .expect("active token lock poisoned") = None;
    }

    fn active_token(&self) -> Option<String> {
        self.active_token
            .lock()
            .expect("active token lock poisoned")
            .clone()
    }

    fn token_is_active(&self, token: &str) -> bool {
        self.active_token
            .lock()
            .expect("active token lock poisoned")
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

/// The typed Whispering command and event contract. The raw audio response,
/// Epicenter host-status command, and host-owned `launch_application` remain on Tauri's
/// handwritten handler because they are outside this generated Whispering
/// binding API.
fn make_specta_builder() -> tauri_specta::Builder<tauri::Wry> {
    tauri_specta::Builder::<tauri::Wry>::new()
        .commands(tauri_specta::collect_commands![
            write_text,
            simulate_enter_keystroke,
            simulate_copy_keystroke,
            enumerate_recording_devices,
            start_recording,
            stop_recording,
            cancel_recording,
            current_recording,
            transcribe_recording,
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
            recorder::ended::RecordingEndedEvent,
        ])
        .error_handling(tauri_specta::ErrorHandlingMode::Result)
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

/// How Home's window for one application is created. The two arms differ in
/// window label, capability file, and how Bun serves the document, and none of
/// that is a distinction a person makes, so it is resolved here from the ID
/// rather than by the caller (ADR-0189).
///
/// `Admitted` says how the window is built, not that the ID is admitted. Rust
/// keeps no catalog: the immutable generation and its membership are Bun's
/// alone (ADR-0179), and nothing here can or should re-derive them.
enum Application {
    /// A compiled application with its own stable window label and enumerated
    /// capabilities.
    Compiled(BuiltInApp),
    /// Anything else: opened in an `app-` window pointed at `/apps/<id>/`.
    Admitted(String),
}

/// Launch one application Home lists: reveal and focus its window, creating it
/// the first time. Calling again focuses rather than duplicating, and Home is
/// never hidden to do it.
///
/// Windows are deliberate (ADR-0209). One window that switched between
/// applications would union every capability file onto one label, because a
/// label is what native authority is granted to; separate windows are what keep
/// `home`, `whispering`, and `app-*` meaning different things. From here the OS
/// is the switcher.
///
/// This is Home's verb, not an app-facing one. It deliberately does not reuse
/// the `openApp(appId)` name ADR-0181 reserves for the portable handle, because
/// that operation targets a catalog member only and must not become a way for
/// one application to reveal another.
///
/// # Who decides an ID is real
///
/// Not this function. Rust validates the ID's *shape* and resolves it against
/// its own compiled app table; it never asks whether a folder was admitted,
/// because the catalog is one immutable generation owned by Bun (ADR-0179) and
/// a second copy in Rust would be a second answer. What keeps a made-up ID from
/// arriving is that Home only offers IDs from the authenticated list Bun serves.
///
/// An ID that shape-checks but names no member still cannot reach anything: it
/// opens an `app-` window at `/apps/<id>/`, which is a URL Rust derived itself
/// (the frontend never supplies one), and Bun answers it 404. That is a
/// contained dead end, not a privilege.
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
    let Some(application) = parse_application_id(&app_id) else {
        return Err(format!(
            "app id must match [a-z0-9-]+ and must not name a built-in app Home does not offer: {app_id}"
        ));
    };
    // Unlike the tray, deep links, and startup, a user-invoked launch does not
    // queue itself for a future host generation: the person is waiting, and a
    // window that appears after the next restart is not what they asked for.
    let Some(token) = state.active_token() else {
        return Err("the Epicenter host is not ready".to_string());
    };
    let port = state.port().map_err(|error| format!("{error:#}"))?;

    launch_on_main_thread(&app, application, port, &token).map_err(|error| format!("{error:#}"))
}

/// Create or reveal the window on the main thread and report what happened.
///
/// Mirrors `create_windows_on_main_thread`: hand the work over, wait for the
/// one result. The sender lives in the closure, so an event loop that shuts
/// down before running it drops the sender and this returns an error rather
/// than waiting forever.
fn launch_on_main_thread(
    app: &DesktopAppHandle,
    application: Application,
    port: u16,
    token: &str,
) -> Result<()> {
    let (sender, receiver) = mpsc::sync_channel(1);
    let window_app = app.clone();
    let token = token.to_string();
    app.run_on_main_thread(move || {
        let result = if window_app.state::<HostState>().token_is_active(&token) {
            match application {
                Application::Compiled(built_in) => {
                    ensure_window(&window_app, built_in, port, &token, true)
                }
                Application::Admitted(id) => ensure_app_window(&window_app, &id, port, &token),
            }
        } else {
            // The host restarted between the click and the main thread reaching
            // this: every window from the old generation is being torn down, so
            // opening one now would create a window against a dead token.
            Err(anyhow!(
                "the Epicenter host restarted before the window opened"
            ))
        };
        let _ = sender.send(result);
    })
    .context("schedule the application window on the main thread")?;
    receiver
        .recv()
        .context("the main thread stopped before opening the window")?
}

/// Accept the ID shapes this command can act on, resolved against the compiled
/// app table.
///
/// The grammar mirrors `APP_ID_PATTERN` in `@epicenter/constants`: lowercase
/// alphanumerics, `-`, and `.`, beginning and ending alphanumeric. Dots are here
/// because an admitted app's ID is the reverse-domain workspace ID it declares
/// (ADR-0210); bare labels stay legal for the compiled apps. The
/// first and last character are constrained for the same reason the TypeScript
/// side constrains them: an ID names a directory, and `.` or `..` would name one
/// outside it.
///
/// This is a shape check, not a membership check. A reserved built-in app Home
/// does not offer (Home itself, a placeholder) and an ID with characters no ID
/// may contain are the same refusal, because Home offers neither.
fn parse_application_id(id: &str) -> Option<Application> {
    let is_inner = |byte: u8| {
        byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-' || byte == b'.'
    };
    let is_edge = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
    let bytes = id.as_bytes();
    let matches_pattern = match (bytes.first(), bytes.last()) {
        (Some(&first), Some(&last)) => {
            is_edge(first) && is_edge(last) && bytes.iter().all(|&byte| is_inner(byte))
        }
        _ => false,
    };
    if !matches_pattern {
        return None;
    }
    match BuiltInApp::from_id(id) {
        Some(built_in) if built_in.is_launchable() => Some(Application::Compiled(built_in)),
        Some(_) => None,
        None => Some(Application::Admitted(id.to_string())),
    }
}

/// The Tauri handle for one application's window.
///
/// A window label admits alphanumerics, `-`, `/`, `:`, and `_`, and no `.`, and
/// Tauri enforces that with an assertion rather than an error, so a workspace
/// ID with dots would panic the host. Mapping `.` to `_` is a bijection and not
/// an escape: an app ID's whole alphabet is `[a-z0-9-.]`, so `_` cannot occur in
/// one and no two IDs can produce one label.
///
/// This is the only place Tauri's label grammar reaches. A window label is
/// Tauri's handle for a window, not Epicenter's name for an application
/// (ADR-0210).
fn app_window_label(id: &str) -> String {
    format!("{APP_WINDOW_PREFIX}{}", id.replace('.', "_"))
}

fn ensure_app_window(app: &DesktopAppHandle, id: &str, port: u16, token: &str) -> Result<()> {
    let label = app_window_label(id);
    if let Some(window) = app.get_webview_window(&label) {
        focus(window);
        return Ok(());
    }

    let origin = origin(port);
    let url: tauri::Url = format!("{origin}/apps/{id}/").parse()?;
    let initialization_script = initialization_script(&origin, token)?;
    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .title(format!("Epicenter: {id}"))
        .inner_size(1100.0, 760.0)
        .min_inner_size(680.0, 480.0)
        .initialization_script(initialization_script)
        .on_navigation(move |url| is_allowed_navigation(url, port))
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .build()
        .with_context(|| format!("create the {id} app WebView"))?;
    release_host_resources_on_destroy(&window);
    focus(window);
    Ok(())
}

/// Release the host resources a window owns once it is destroyed.
///
/// Only destruction, never hide or navigation: a hidden window still owns its
/// recording (push-to-talk from the tray depends on that), and reload keeps the
/// same label, which is exactly why `current_recording` exists. A destroyed
/// window can no longer stop or cancel anything, so its recording would hold
/// the one host recorder until the process exits.
///
/// Built-in windows are hidden rather than destroyed when the user closes them,
/// so this fires for them only on a host restart teardown. App windows have no
/// close interception and are destroyed on close, which is the live path.
fn release_host_resources_on_destroy(window: &WebviewWindow<Wry>) {
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            cancel_recording_owned_by(&app, &label);
        }
    });
}

pub fn run() {
    let port = configured_port();
    let specta_builder = make_specta_builder();
    let specta_handler = tauri_specta::Builder::invoke_handler(&specta_builder);
    let native_handler = tauri::generate_handler![encode_recording_for_upload, launch_application]
        as fn(tauri::ipc::Invoke<tauri::Wry>) -> bool;
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
        .manage(GlobalShortcutRegistry::default())
        .manage(Mutex::new(Recorder::new()))
        .manage(DownloadManager::default());

    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());

    builder
        .invoke_handler(move |invoke| {
            if matches!(
                invoke.message.command(),
                "encode_recording_for_upload" | "launch_application"
            ) {
                native_handler(invoke)
            } else {
                specta_handler(invoke)
            }
        })
        .setup(move |app| {
            specta_builder.mount_events(app);

            // A recording that was still capturing when a previous launch died
            // left a partial WAV in the recorder's private staging. It is not a
            // blob and never will be one, so it is deleted here and nothing
            // else happens: no promotion, no repair, no notice. Owned by the
            // recorder rather than by blob-store startup because `.staging/rust`
            // is the recorder's alone (`packages/blobs` stages its own uploads
            // under `.staging/bun` and cleans them per operation).
            crate::recorder::blob::delete_stale_staging(app.handle());

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
                    if let Some(callback) = parse_oauth_callback(url) {
                        queue_or_send_oauth_callback(app.handle(), callback);
                    }
                    if let Some(built_in) = parse_app_deep_link(url) {
                        request_window(app.handle(), built_in);
                        opened_window = true;
                    }
                }
            }
            if !opened_window {
                request_window(app.handle(), BuiltInApp::Home);
            }
            request_start(app.handle().clone(), None);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Epicenter")
        .run(|app, event| match event {
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => request_window(app, BuiltInApp::Home),
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
        if let Some(callback) = parse_oauth_callback(&url) {
            queue_or_send_oauth_callback(app, callback);
        }
    }
    if built_ins.is_empty() {
        request_window(app, BuiltInApp::Home);
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
        if let Some(callback) = parse_oauth_callback(url) {
            queue_or_send_oauth_callback(app, callback);
        }
        if let Some(built_in) = parse_app_deep_link(url) {
            request_window(app, built_in);
        }
    }
}

fn parse_oauth_callback(url: &tauri::Url) -> Option<String> {
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

fn queue_or_send_oauth_callback(app: &DesktopAppHandle, url: String) {
    let state = app.state::<HostState>();
    let generation = state
        .process
        .lock()
        .expect("host state lock poisoned")
        .as_ref()
        .map(|process| process.generation);
    let Some(generation) = generation else {
        state.queue_oauth_callback(url);
        return;
    };
    if let Err(error) = send_auth_frame(
        &state,
        generation,
        &RustToBunAuthFrame::OauthCallback { url: &url },
    ) {
        state.queue_oauth_callback(url);
        append_parent_log(app, &format!("deliver OAuth callback: {error:#}"));
    }
}

/// Ask for a window without waiting: queue it when the host is not ready yet,
/// and log rather than report what the main thread makes of it.
///
/// That is right for the callers that have nobody to answer to (startup, the
/// tray, a deep link, macOS reopen, an app asking for a section of Home). It is
/// wrong for `launch_application`, where a person clicked and is owed an
/// outcome, so that command waits on the main thread instead.
fn request_window(app: &DesktopAppHandle, built_in: BuiltInApp) {
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

/// Resolve `epicenter://app/<id>` to the built-in app it names.
///
/// The segment is `app` because it is the same ID space as `/apps/<id>/` and
/// the list Home shows: a person pasting a link names the thing they want, not
/// the frame it arrives in. `epicenter://auth/...` stays disjoint by segment,
/// and an admitted app's dotted ID cannot collide with these bare labels
/// (ADR-0210), so widening this to the catalog later needs no new grammar.
fn parse_app_deep_link(url: &tauri::Url) -> Option<BuiltInApp> {
    if url.scheme() != "epicenter"
        || url.host_str() != Some("app")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
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
        *process = Some(ManagedChild {
            generation,
            child,
            stdin: Some(stdin),
        });
    }

    if let Some(callback) = state.take_oauth_callback() {
        send_auth_frame(
            &state,
            generation,
            &RustToBunAuthFrame::OauthCallback { url: &callback },
        )
        .context("deliver the queued OAuth callback")?;
    }

    state.activate(&token);
    let mut built_ins = state.take_pending_apps();
    if built_ins.is_empty() {
        built_ins.push(BuiltInApp::Home);
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

    // The Bun host resolves the Epicenter data root itself, from the one
    // TypeScript function that owns that path (ADR-0201). Do not pass one from
    // here: a Rust-computed root leaves the desktop and every CLI as two
    // implementations of a directory they have to agree on exactly, and it
    // swallows the ambient `EPICENTER_DATA_DIR` that the host and the
    // recorder's `crate::app_data` both honour.
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
    let auth_cell = read_auth_cell().context("read the desktop auth cell")?;
    let frame = boot_frame_json(&token, port, auth_cell.as_deref())?;

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
            bail!("Bun did not emit its v2 ready frame within 15 seconds");
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
        let event = match stdout.read_line(&mut line) {
            Ok(0) => Err("Bun closed stdout after readiness".to_string()),
            Ok(_) if !line.ends_with('\n') => {
                Err("Bun closed stdout during an auth frame".to_string())
            }
            Ok(_) => {
                serde_json::from_str::<BunToRustAuthFrame>(line.trim_end_matches(['\r', '\n']))
                    .map_err(|error| format!("Bun emitted an invalid auth frame: {error}"))
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
                    if let Err(error) = handle_auth_frame(&app, generation, frame) {
                        fail_generation(
                            &app,
                            generation,
                            format!("handle Bun auth frame: {error:#}"),
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

fn handle_auth_frame(
    app: &DesktopAppHandle,
    generation: u64,
    frame: BunToRustAuthFrame,
) -> Result<()> {
    match frame {
        BunToRustAuthFrame::StoreAuth {
            request_id,
            serialized,
        } => {
            let result = write_auth_cell(serialized);
            send_native_result(app, generation, &request_id, result)
        }
        BunToRustAuthFrame::OpenAuthUrl { request_id, url } => {
            let result = validate_hosted_auth_url(&url).and_then(|()| {
                app.opener()
                    .open_url(url, None::<String>)
                    .map_err(Into::into)
            });
            send_native_result(app, generation, &request_id, result)
        }
        BunToRustAuthFrame::PutAppSecret {
            request_id,
            app_id,
            account_id,
            value,
        } => {
            let result = write_app_secret(&app_id, &account_id, &value);
            send_native_result(app, generation, &request_id, result)
        }
        BunToRustAuthFrame::GetAppSecret {
            request_id,
            app_id,
            account_id,
        } => {
            if request_id.is_empty() {
                bail!("native requestId must be non-empty");
            }
            let state = app.state::<HostState>();
            match read_app_secret(&app_id, &account_id) {
                Ok(value) => send_auth_frame(
                    &state,
                    generation,
                    &RustToBunAuthFrame::NativeValue {
                        request_id: &request_id,
                        status: "ok",
                        value: value.as_deref(),
                    },
                ),
                Err(error) => {
                    let message = error.to_string();
                    send_auth_frame(
                        &state,
                        generation,
                        &RustToBunAuthFrame::NativeResult {
                            request_id: &request_id,
                            status: "error",
                            message: Some(&message),
                        },
                    )
                }
            }
        }
        BunToRustAuthFrame::DeleteAppSecret {
            request_id,
            app_id,
            account_id,
        } => {
            let result = delete_app_secret(&app_id, &account_id);
            send_native_result(app, generation, &request_id, result)
        }
        BunToRustAuthFrame::Relaunch {} => app.restart(),
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
        Ok(()) => send_auth_frame(
            &state,
            generation,
            &RustToBunAuthFrame::NativeResult {
                request_id,
                status: "ok",
                message: None,
            },
        ),
        Err(error) => {
            let message = error.to_string();
            send_auth_frame(
                &state,
                generation,
                &RustToBunAuthFrame::NativeResult {
                    request_id,
                    status: "error",
                    message: Some(&message),
                },
            )
        }
    }
}

fn send_auth_frame(
    state: &HostState,
    generation: u64,
    frame: &RustToBunAuthFrame<'_>,
) -> Result<()> {
    let line = serde_json::to_string(frame).context("serialize the native auth frame")?;
    let mut process = state.process.lock().expect("host state lock poisoned");
    let process = process
        .as_mut()
        .filter(|process| process.generation == generation)
        .context("the target Bun generation is no longer active")?;
    let stdin = process
        .stdin
        .as_mut()
        .context("the target Bun generation has no command pipe")?;
    writeln!(stdin, "{line}").and_then(|()| stdin.flush())?;
    Ok(())
}

fn validate_hosted_auth_url(value: &str) -> Result<()> {
    let url = tauri::Url::parse(value).context("parse the hosted authorization URL")?;
    if url.scheme() != "https"
        || url.host_str() != Some("api.epicenter.so")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || !url.path().starts_with("/auth/")
    {
        bail!("authorization URL must stay under {HOSTED_AUTH_ORIGIN}/auth/");
    }
    Ok(())
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
            Ok(Some(_)) => return,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            Ok(None) | Err(_) => break,
        }
    }
    let _ = process.child.kill();
    let _ = process.child.wait();
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
            #[cfg(target_os = "macos")]
            create_recording_overlay(&app, port, &token)?;

            ensure_window(&app, BuiltInApp::Whispering, port, &token, false)?;

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
    let initialization_script = initialization_script(&origin, token)?;
    let window = WebviewWindowBuilder::new(app, built_in.id(), WebviewUrl::External(url))
        .title(built_in.title())
        .inner_size(1100.0, 760.0)
        .min_inner_size(680.0, 480.0)
        .visible(reveal)
        .initialization_script(initialization_script)
        .on_navigation(move |url| is_allowed_navigation(url, port))
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .build()
        .with_context(|| format!("create the {} WebView", built_in.title()))?;

    let close_window = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = close_window.hide();
        }
    });
    release_host_resources_on_destroy(&window);
    if reveal {
        focus(window);
    }
    Ok(())
}

fn focus<R: Runtime>(window: WebviewWindow<R>) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

fn invalidate_windows(app: &DesktopAppHandle) {
    let (sender, receiver) = mpsc::sync_channel(1);
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        for built_in in BuiltInApp::ALL {
            if let Some(window) = app.get_webview_window(built_in.id()) {
                if window.destroy().is_err() {
                    let _ = window.hide();
                }
            }
        }
        // Derived-catalog app windows carry the dead host's launch token in
        // their initialization script, so a restart must tear them down too.
        for (label, window) in app.webview_windows() {
            if label.starts_with(APP_WINDOW_PREFIX) && window.destroy().is_err() {
                let _ = window.hide();
            }
        }
        #[cfg(target_os = "macos")]
        if let Some(window) = app.get_webview_window(overlay::WINDOW_LABEL) {
            if window.destroy().is_err() {
                let _ = window.hide();
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

fn boot_frame_json(token: &str, port: u16, auth_cell: Option<&str>) -> Result<String> {
    serde_json::to_string(&BootFrame {
        r#type: "boot",
        protocol_version: PROTOCOL_VERSION,
        token,
        port,
        auth_cell,
    })
    .context("serialize the Bun boot frame")
}

fn read_ready_frame(reader: &mut impl BufRead, expected_port: u16) -> Result<()> {
    let mut line = String::new();
    let count = reader
        .read_line(&mut line)
        .context("read the Bun readiness frame")?;
    if count == 0 {
        bail!("Bun exited without emitting its v2 ready frame");
    }
    if !line.ends_with('\n') {
        bail!("Bun closed stdout before completing its v2 ready frame");
    }

    let line = line.trim_end_matches(['\r', '\n']);
    let frame: ReadyFrame =
        serde_json::from_str(line).context("Bun stdout was not one strict v2 ready frame")?;
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
    fn production_port_is_stable() {
        assert_eq!(PRODUCTION_PORT, 39_130);
    }

    #[test]
    fn parses_only_the_expected_v2_ready_frame() {
        read_ready_frame(
            &mut Cursor::new(b"{\"type\":\"ready\",\"protocolVersion\":2,\"port\":39130}\n"),
            PRODUCTION_PORT,
        )
        .unwrap();

        for invalid in [
            "preamble\n",
            "{\"type\":\"ready\",\"protocolVersion\":1,\"port\":39130}\n",
            "{\"type\":\"ready\",\"protocolVersion\":2,\"port\":39131}\n",
            "{\"type\":\"ready\",\"protocolVersion\":2,\"port\":39130,\"extra\":true}\n",
            "{\"type\":\"ready\",\"protocolVersion\":2,\"port\":39130}",
        ] {
            assert!(read_ready_frame(&mut Cursor::new(invalid), PRODUCTION_PORT).is_err());
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
                ("home", "/apps/home/", "Epicenter: Home"),
                ("whispering", "/apps/whispering/", "Epicenter: Whispering"),
                ("honeycrisp", "/apps/honeycrisp/", "Epicenter: Honeycrisp"),
                ("mail", "/apps/mail/", "Epicenter: Mail"),
                ("books", "/apps/books/", "Epicenter: Books"),
            ]
        );
    }

    /// Home lists exactly the applications this table calls launchable, so the
    /// two must not drift: an ID Home can show has to be one this verb opens,
    /// and an ID it cannot show has to be one this verb refuses. The Bun side
    /// asserts the same list against `applications.ts`.
    #[test]
    fn compiled_applications_are_the_release_built_spas() {
        let launchable: Vec<&str> = BuiltInApp::ALL
            .into_iter()
            .filter(|window| window.is_launchable())
            .map(BuiltInApp::id)
            .collect();
        assert_eq!(launchable, ["whispering", "honeycrisp", "mail"]);
    }

    #[test]
    fn one_verb_opens_compiled_and_admitted_applications_alike() {
        assert!(matches!(
            parse_application_id("whispering"),
            Some(Application::Compiled(BuiltInApp::Whispering))
        ));
        assert!(matches!(
            parse_application_id("honeycrisp"),
            Some(Application::Compiled(BuiltInApp::Honeycrisp))
        ));
        assert!(matches!(
            parse_application_id("mail"),
            Some(Application::Compiled(BuiltInApp::Mail))
        ));

        // Every well-formed non-reserved ID resolves to the app-window path,
        // including ones no generation ever admitted. That is the ownership
        // boundary, not an oversight: the catalog is Bun's (ADR-0179), Home
        // only offers IDs from the list Bun served it, and an ID that names no
        // member opens a window Bun answers with 404. Re-deriving membership
        // here would be a second catalog with a second answer.
        for accepted in [
            "hello-http",
            "a",
            "notes2",
            "x-y-z",
            "0-a",
            // An admitted app's id is its reverse-domain data id, so dots are
            // part of the grammar rather than a hole in it (ADR-0210).
            "so.epicenter.local-mail",
            "hello.http",
            "never-admitted",
        ] {
            assert!(
                matches!(parse_application_id(accepted), Some(Application::Admitted(id)) if id == accepted),
                "expected {accepted:?} to resolve to the app-window path"
            );
        }

        for denied in [
            "",
            "Hello",
            "hello_http",
            "hello/http",
            "..",
            "hello http",
            "héllo",
            // An edge must be alphanumeric. `appDataDir` joins an id onto the
            // one data root, so a grammar admitting a `.` or `-` edge would
            // hand a caller a path out of it (`packages/constants/src/app-id.ts`).
            "0-",
            "-zero",
            ".hidden",
            "trailing.",
            // Reserved windows Home does not list: the shell itself, and a
            // placeholder document with nothing behind it to open.
            "home",
            "books",
        ] {
            assert!(
                parse_application_id(denied).is_none(),
                "expected {denied:?} rejected"
            );
        }
    }

    #[test]
    fn app_window_labels_are_reserved_and_never_collide_with_host_windows() {
        assert_eq!(app_window_label("hello-http"), "app-hello-http");

        let mut host_labels: Vec<&str> = BuiltInApp::ALL.map(BuiltInApp::id).to_vec();
        host_labels.push("recording-overlay");
        for label in host_labels {
            assert!(
                !label.starts_with(APP_WINDOW_PREFIX),
                "host window label {label:?} must not match the app-* capability glob"
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
                serde_json::json!(["app-*", "whispering"]),
                "the trusted-app HTTP slice must cover catalog apps and transitional Whispering"
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
    /// Two commands are deliberately outside the generated API: they ride
    /// Tauri's handwritten handler because their shapes are not `specta::Type`
    /// (raw bytes) or are host-owned rather than part of the app contract.
    #[test]
    fn generated_bindings_cover_every_declared_command() {
        const HANDWRITTEN: &[&str] = &["encode_recording_for_upload", "launch_application"];
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
            // It still transcribes, still reads advisory readiness so it can warn
            // before capture, and can still send the user to Home to fix it.
            for permission in [
                "allow-transcribe-recording",
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
        "start_recording",
        "stop_recording",
        "cancel_recording",
        "current_recording",
        "transcribe_recording",
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
    /// This is API admission, not a sandbox. ADR-0179 is explicit that an
    /// admitted app already holds the shared origin, the session, and the
    /// Epicenter application's own device grants; what an equality check buys
    /// is that the *product* boundary stays a decision. A permission pasted in
    /// to unblock something fails here rather than quietly widening what every
    /// installed app can do.
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

    /// Subscribing to an ending is half a lifecycle. A window granted `listen`
    /// but not `unlisten` leaks a host listener every time an app unsubscribes,
    /// and the leak is invisible because unsubscribing has no outcome to fail.
    #[test]
    fn app_windows_can_both_subscribe_and_unsubscribe() {
        for encoded in APP_WINDOW_CAPABILITIES {
            let capability: serde_json::Value = serde_json::from_str(encoded).unwrap();
            let permissions = capability["permissions"].as_array().unwrap();
            for permission in ["core:event:allow-listen", "core:event:allow-unlisten"] {
                assert!(
                    permissions.contains(&serde_json::json!(permission)),
                    "an app window observing recordings needs {permission}"
                );
            }
        }
    }

    /// The seven commands must exist, or the grant above is a silent no-op and
    /// the public client invokes into nothing.
    ///
    /// That the *client* invokes exactly these seven, with exactly the
    /// arguments they deserialize, is proved in
    /// `src/app-client-parity.test.ts`, where the capability, the generated
    /// bindings, and the client are all ordinary values and both sides can be
    /// driven through one fake IPC. This test used to parse the client's
    /// TypeScript as text from here, which was weaker (it compared source
    /// spelling, not what was sent) and fragile enough to pass or fail on how
    /// the bindings happened to be formatted.
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

    /// The one event an app window subscribes to has to be one the host emits.
    #[test]
    fn the_host_still_emits_the_recording_ended_event() {
        // Either quote style, for the same reason the binding freshness check
        // above accepts both: specta emits double quotes and the repo formatter
        // rewrites them to single.
        const BINDINGS: &str = include_str!("../../src/ui/bindings.gen.ts");
        assert!(
            BINDINGS.contains("'recording-ended-event'")
                || BINDINGS.contains("\"recording-ended-event\""),
            "the host no longer emits the event @epicenter/app subscribes to"
        );
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
            (
                include_str!("../tauri.dev.conf.json"),
                "mail-gmail-authorization-development",
            ),
            (
                include_str!("../tauri.conf.json"),
                "mail-gmail-authorization-production",
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

    /// Home lists what can be launched, so Home is the window that launches it
    /// (ADR-0189). Granting the verb more widely would let an application open
    /// another application without the user ever choosing it, which is a
    /// product decision nobody made.
    #[test]
    fn only_home_can_launch_an_application() {
        for encoded in [
            include_str!("../capabilities/home-launch-application-development.json"),
            include_str!("../capabilities/home-launch-application-production.json"),
        ] {
            let capability: serde_json::Value = serde_json::from_str(encoded).unwrap();
            assert_eq!(
                capability["windows"],
                serde_json::json!(["home"]),
                "the launch verb belongs to the Home window alone"
            );
            let permissions = capability["permissions"].as_array().unwrap();
            assert!(permissions.contains(&serde_json::json!("allow-launch-application")));
        }
    }

    /// Google refuses a custom URI scheme for a Desktop OAuth client, so Local
    /// Mail's consent screen has to open in the person's own browser and return
    /// to the host's loopback socket. Opening it is the only native verb the
    /// Mail window holds, and it is scoped to the one endpoint that verb exists
    /// for: this is a grant nobody may widen into a general "open any link"
    /// power for an app window without deciding to.
    #[test]
    fn only_the_mail_window_may_open_google_and_only_google() {
        for encoded in [
            include_str!("../capabilities/mail-gmail-authorization-development.json"),
            include_str!("../capabilities/mail-gmail-authorization-production.json"),
        ] {
            let capability: serde_json::Value = serde_json::from_str(encoded).unwrap();
            assert_eq!(
                capability["windows"],
                serde_json::json!(["mail"]),
                "the Gmail consent grant belongs to the Mail window alone"
            );
            assert_eq!(
                capability["permissions"],
                serde_json::json!([{
                    "identifier": "opener:allow-open-url",
                    "allow": [{ "url": "https://accounts.google.com/*" }]
                }]),
                "opening Google is the whole grant, and Google is its whole scope"
            );
        }
    }

    /// The Mail window's grant is its own capability rather than a line in the
    /// shared app slice, so no other window inherits it.
    #[test]
    fn no_app_window_inherits_the_gmail_consent_grant() {
        for encoded in APP_WINDOW_CAPABILITIES {
            assert!(
                !encoded.contains("opener:"),
                "the shared app slice must not carry an opener grant"
            );
        }
    }

    /// ADR-0181 keeps `openHome(section)` and `openApp(appId)` apart because a
    /// built-in window and an admitted member have different identity and
    /// authority rules. Home's launch verb crosses that line by design, which is
    /// exactly why no app window may hold it: an admitted app must not be able
    /// to reveal a compiled window, and reusing the reserved `open_app` name
    /// for this would have made that the default the day a `shell` namespace
    /// shipped.
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
            ("epicenter://app/mail", BuiltInApp::Mail),
            ("epicenter://app/books", BuiltInApp::Books),
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
            "https://app/home",
        ] {
            assert_eq!(parse_app_deep_link(&denied.parse().unwrap()), None);
        }
    }

    #[test]
    fn oauth_deep_links_accept_only_the_exact_callback_route() {
        for url in [
            "epicenter://auth/callback?code=code&state=state",
            "epicenter://auth/callback?error=access_denied&state=state",
        ] {
            assert_eq!(
                parse_oauth_callback(&url.parse().unwrap()),
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
            assert_eq!(parse_oauth_callback(&denied.parse().unwrap()), None);
        }
    }

    #[test]
    fn system_browser_accepts_only_hosted_auth_urls() {
        for allowed in [
            "https://api.epicenter.so/auth/oauth2/authorize?client_id=desktop",
            "https://api.epicenter.so/auth/sign-in",
        ] {
            validate_hosted_auth_url(allowed).unwrap();
        }
        for denied in [
            "http://api.epicenter.so/auth/sign-in",
            "https://api.epicenter.so.evil.test/auth/sign-in",
            "https://api.epicenter.so/not-auth",
            "https://user@api.epicenter.so/auth/sign-in",
            "https://api.epicenter.so/auth/sign-in#fragment",
        ] {
            assert!(validate_hosted_auth_url(denied).is_err());
        }
    }

    #[test]
    fn bun_auth_frames_are_closed_and_exact() {
        assert_eq!(
            serde_json::from_str::<BunToRustAuthFrame>(
                "{\"type\":\"store-auth\",\"requestId\":\"one\",\"serialized\":null}"
            )
            .unwrap(),
            BunToRustAuthFrame::StoreAuth {
                request_id: "one".to_string(),
                serialized: None,
            }
        );
        assert!(serde_json::from_str::<BunToRustAuthFrame>(
            "{\"type\":\"execute\",\"command\":\"shell\"}"
        )
        .is_err());
        assert!(serde_json::from_str::<BunToRustAuthFrame>(
            "{\"type\":\"relaunch\",\"extra\":true}"
        )
        .is_err());
    }

    #[test]
    fn forwarded_arguments_extract_valid_unique_app_links() {
        let arguments = [
            "/Applications/Epicenter.app/Contents/MacOS/Epicenter",
            "epicenter://app/mail",
            "epicenter://app/unknown",
            "epicenter://app/mail",
            "epicenter://app/books",
        ]
        .map(String::from);
        assert_eq!(
            apps_from_arguments(&arguments),
            vec![BuiltInApp::Mail, BuiltInApp::Books]
        );
    }

    #[test]
    fn boot_frame_is_strict_v2_and_carries_the_opaque_auth_cell() {
        let token = URL_SAFE_NO_PAD.encode([7_u8; 32]);
        let json = boot_frame_json(&token, PRODUCTION_PORT, Some("opaque")).unwrap();
        assert_eq!(
            json,
            format!(
                "{{\"type\":\"boot\",\"protocolVersion\":2,\"token\":\"{token}\",\"port\":39130,\"authCell\":\"opaque\"}}"
            )
        );
        assert!(!token.contains('='));
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
