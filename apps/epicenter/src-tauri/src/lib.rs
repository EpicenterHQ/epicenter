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

pub mod audio;
use audio::encode_recording_for_upload;

pub mod recorder;
use recorder::commands::{
    acknowledge_recording_capture, cancel_recording, close_recording_session,
    enumerate_recording_devices, get_current_recording_id, init_recording_session, start_recording,
    stop_recording,
};
use recorder::recorder::Recorder;

pub mod transcription;
use transcription::{
    delete_model, download_model, list_models, prewarm_model, set_unload_policy,
    transcribe_recording, ModelCache,
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
use keyring_storage::{read_auth_cell, write_auth_cell};

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

const PRODUCT_NAME: &str = "Epicenter";
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
enum Surface {
    Home,
    Whispering,
    Mail,
    Books,
}

impl Surface {
    const ALL: [Self; 4] = [Self::Home, Self::Whispering, Self::Mail, Self::Books];

    const fn id(self) -> &'static str {
        match self {
            Self::Home => "home",
            Self::Whispering => "whispering",
            Self::Mail => "mail",
            Self::Books => "books",
        }
    }

    const fn path(self) -> &'static str {
        match self {
            Self::Home => "/apps/home/",
            Self::Whispering => "/apps/whispering/",
            Self::Mail => "/apps/mail/",
            Self::Books => "/apps/books/",
        }
    }

    const fn title(self) -> &'static str {
        match self {
            Self::Home => "Epicenter: Home",
            Self::Whispering => "Epicenter: Whispering",
            Self::Mail => "Epicenter: Mail",
            Self::Books => "Epicenter: Books",
        }
    }

    fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|surface| surface.id() == id)
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
    OauthCallback {
        url: &'a str,
    },
}

#[derive(Debug, Serialize)]
struct RuntimeInfo {
    product: &'static str,
    origin: String,
}

struct ManagedChild {
    generation: u64,
    child: Child,
    stdin: Option<ChildStdin>,
}

pub struct HostState {
    port: std::result::Result<u16, String>,
    next_generation: AtomicU64,
    process: Mutex<Option<ManagedChild>>,
    active_token: Mutex<Option<String>>,
    pending_surfaces: Mutex<Vec<Surface>>,
    pending_oauth_callback: Mutex<Option<String>>,
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
            pending_surfaces: Mutex::new(Vec::new()),
            pending_oauth_callback: Mutex::new(None),
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

    fn queue_surface(&self, surface: Surface) {
        let mut pending = self
            .pending_surfaces
            .lock()
            .expect("pending surface lock poisoned");
        if !pending.contains(&surface) {
            pending.push(surface);
        }
    }

    fn take_pending_surfaces(&self) -> Vec<Surface> {
        std::mem::take(
            &mut *self
                .pending_surfaces
                .lock()
                .expect("pending surface lock poisoned"),
        )
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
/// Epicenter host-status command, and host-owned `open_app` remain on Tauri's
/// handwritten handler because they are outside this generated Whispering
/// binding surface.
fn make_specta_builder() -> tauri_specta::Builder<tauri::Wry> {
    tauri_specta::Builder::<tauri::Wry>::new()
        .commands(tauri_specta::collect_commands![
            write_text,
            simulate_enter_keystroke,
            simulate_copy_keystroke,
            get_current_recording_id,
            enumerate_recording_devices,
            init_recording_session,
            close_recording_session,
            start_recording,
            stop_recording,
            acknowledge_recording_capture,
            cancel_recording,
            transcribe_recording,
            prewarm_model,
            open_accessibility_settings,
            request_accessibility_permission,
            get_microphone_permission,
            request_microphone_permission,
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
        ])
        .error_handling(tauri_specta::ErrorHandlingMode::Result)
}

#[cfg(test)]
mod export_bindings {
    #[test]
    fn export_types() {
        super::make_specta_builder()
            .export(
                specta_typescript::Typescript::default(),
                "../../whispering/src/lib/tauri/bindings.gen.ts",
            )
            .expect("failed to export bindings");
    }
}

#[tauri::command]
fn get_runtime_info(state: State<'_, HostState>) -> std::result::Result<RuntimeInfo, String> {
    let port = state.port().map_err(|error| format!("{error:#}"))?;
    Ok(RuntimeInfo {
        product: PRODUCT_NAME,
        origin: origin(port),
    })
}

/// Open one derived-catalog app window. Rust validates the ID and derives the
/// URL and label itself; the frontend never supplies a URL (ADR-0153). An
/// unknown-but-valid ID opens a window that Bun answers with 404, which is the
/// honest state of a catalog member that disappeared since the last restart.
#[tauri::command]
fn open_app(
    app: DesktopAppHandle,
    state: State<'_, HostState>,
    app_id: String,
) -> std::result::Result<(), String> {
    let Some(id) = parse_app_id(&app_id) else {
        return Err(format!(
            "app id must match [a-z0-9-]+ and not name a built-in surface: {app_id}"
        ));
    };
    let Some(token) = state.active_token() else {
        return Err("the Epicenter host is not ready".to_string());
    };
    let port = state.port().map_err(|error| format!("{error:#}"))?;

    let id = id.to_string();
    app.clone()
        .run_on_main_thread(move || {
            if !app.state::<HostState>().token_is_active(&token) {
                return;
            }
            if let Err(error) = ensure_app_window(&app, &id, port, &token) {
                append_parent_log(&app, &format!("open {id} app window: {error:#}"));
            }
        })
        .map_err(|error| format!("schedule the {app_id} app window: {error}"))
}

/// Accept exactly the derived-catalog ID contract: `[a-z0-9-]+`, excluding the
/// built-in surface IDs, which keep their own labels and enumerated
/// capabilities until they migrate into the catalog.
fn parse_app_id(id: &str) -> Option<&str> {
    let matches_pattern = !id.is_empty()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
    if !matches_pattern || Surface::from_id(id).is_some() {
        return None;
    }
    Some(id)
}

fn app_window_label(id: &str) -> String {
    format!("{APP_WINDOW_PREFIX}{id}")
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
    focus(window);
    Ok(())
}

pub fn run() {
    let port = configured_port();
    let specta_builder = make_specta_builder();
    let specta_handler = tauri_specta::Builder::invoke_handler(&specta_builder);
    let native_handler =
        tauri::generate_handler![get_runtime_info, encode_recording_for_upload, open_app]
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
        .plugin(tauri_plugin_macos_permissions::init())
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
                "get_runtime_info" | "encode_recording_for_upload" | "open_app"
            ) {
                native_handler(invoke)
            } else {
                specta_handler(invoke)
            }
        })
        .setup(move |app| {
            specta_builder.mount_events(app);

            {
                let recorder_state = app.state::<Mutex<Recorder>>();
                let mut recorder = recorder_state
                    .lock()
                    .map_err(|error| anyhow!("lock recorder during recovery: {error}"))?;
                recorder
                    .recover_pending_capture(app.handle())
                    .map_err(|error| anyhow!("recover pending native recording: {error}"))?;
            }

            let cache = ModelCache::new();
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
            let mut opened_surface = false;
            if let Some(urls) = current {
                for url in &urls {
                    if let Some(callback) = parse_oauth_callback(url) {
                        queue_or_send_oauth_callback(app.handle(), callback);
                    }
                    if let Some(surface) = parse_surface_deep_link(url) {
                        request_surface(app.handle(), surface);
                        opened_surface = true;
                    }
                }
            }
            if !opened_surface {
                request_surface(app.handle(), Surface::Home);
            }
            request_start(app.handle().clone(), None);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Epicenter")
        .run(|app, event| match event {
            RunEvent::Reopen { .. } => request_surface(app, Surface::Home),
            RunEvent::Exit => shutdown_host(app),
            _ => {}
        });
}

fn open_forwarded_deep_links(app: &DesktopAppHandle, arguments: &[String]) {
    let surfaces = surfaces_from_arguments(arguments);
    for argument in arguments {
        let Ok(url) = tauri::Url::parse(argument) else {
            continue;
        };
        if let Some(callback) = parse_oauth_callback(&url) {
            queue_or_send_oauth_callback(app, callback);
        }
    }
    if surfaces.is_empty() {
        request_surface(app, Surface::Home);
    } else {
        for surface in surfaces {
            request_surface(app, surface);
        }
    }
}

fn surfaces_from_arguments(arguments: &[String]) -> Vec<Surface> {
    let mut surfaces = Vec::new();
    for argument in arguments {
        let Ok(url) = tauri::Url::parse(argument) else {
            continue;
        };
        let Some(surface) = parse_surface_deep_link(&url) else {
            continue;
        };
        if !surfaces.contains(&surface) {
            surfaces.push(surface);
        }
    }
    surfaces
}

fn open_deep_links(app: &DesktopAppHandle, urls: &[tauri::Url]) {
    for url in urls {
        if let Some(callback) = parse_oauth_callback(url) {
            queue_or_send_oauth_callback(app, callback);
        }
        if let Some(surface) = parse_surface_deep_link(url) {
            request_surface(app, surface);
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

fn request_surface(app: &DesktopAppHandle, surface: Surface) {
    let state = app.state::<HostState>();
    let Some(token) = state.active_token() else {
        state.queue_surface(surface);
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
        if let Err(error) = ensure_surface(&window_app, surface, port, &token, true) {
            append_parent_log(
                &window_app,
                &format!("open {} surface: {error:#}", surface.id()),
            );
        }
    });
    if let Err(error) = schedule {
        append_parent_log(app, &format!("schedule {} surface: {error}", surface.id()));
    }
}

fn parse_surface_deep_link(url: &tauri::Url) -> Option<Surface> {
    if url.scheme() != "epicenter"
        || url.host_str() != Some("surface")
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
    Surface::from_id(id)
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
            invalidate_surfaces(&app);
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
    let mut surfaces = state.take_pending_surfaces();
    if surfaces.is_empty() {
        surfaces.push(Surface::Home);
    }
    if let Err(error) = create_surfaces_on_main_thread(app, port, &token, surfaces) {
        state.deactivate();
        if let Some(child) = take_generation(&state, generation) {
            stop_child(child);
        }
        invalidate_surfaces(app);
        return Err(error);
    }

    monitor_host(app.clone(), generation, stdout);
    Ok(())
}

fn launch_host(app: &DesktopAppHandle, port: u16) -> Result<LaunchedHost> {
    let log = open_log_file(app)?;
    let app_data_dir = app.path().app_data_dir()?;

    let mut command = host_command(app)?;
    command
        .env("EPICENTER_DATA_DIR", &app_data_dir)
        .env("EPICENTER_APPS_DIST", apps_dist(app)?)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(log.try_clone()?));

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
    invalidate_surfaces(app);
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

fn create_surfaces_on_main_thread(
    app: &DesktopAppHandle,
    port: u16,
    token: &str,
    surfaces: Vec<Surface>,
) -> Result<()> {
    let (sender, receiver) = mpsc::sync_channel(1);
    let app = app.clone();
    let token = token.to_string();
    app.clone().run_on_main_thread(move || {
        let result = (|| {
            #[cfg(target_os = "macos")]
            create_recording_overlay(&app, port, &token)?;

            ensure_surface(&app, Surface::Whispering, port, &token, false)?;

            surfaces
                .into_iter()
                .try_for_each(|surface| ensure_surface(&app, surface, port, &token, true))
        })();
        let _ = sender.send(result);
    })?;
    receiver
        .recv()
        .context("the main thread stopped before creating Epicenter surfaces")?
}

#[cfg(target_os = "macos")]
fn create_recording_overlay(app: &DesktopAppHandle, port: u16, token: &str) -> Result<()> {
    let origin = origin(port);
    let url: tauri::Url = format!("{origin}/apps/whispering/recording-overlay/").parse()?;
    let initialization_script = initialization_script(&origin, token)?;
    overlay::create_recording_overlay(app, url, initialization_script, port)
        .context("create the Whispering recording overlay")
}

fn ensure_surface(
    app: &DesktopAppHandle,
    surface: Surface,
    port: u16,
    token: &str,
    reveal: bool,
) -> Result<()> {
    if let Some(window) = app.get_webview_window(surface.id()) {
        if reveal {
            focus(window);
        }
        return Ok(());
    }

    let origin = origin(port);
    let url: tauri::Url = format!("{origin}{}", surface.path()).parse()?;
    let initialization_script = initialization_script(&origin, token)?;
    let window = WebviewWindowBuilder::new(app, surface.id(), WebviewUrl::External(url))
        .title(surface.title())
        .inner_size(1100.0, 760.0)
        .min_inner_size(680.0, 480.0)
        .visible(reveal)
        .initialization_script(initialization_script)
        .on_navigation(move |url| is_allowed_navigation(url, port))
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .build()
        .with_context(|| format!("create the {} WebView", surface.title()))?;

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

fn focus<R: Runtime>(window: WebviewWindow<R>) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

fn invalidate_surfaces(app: &DesktopAppHandle) {
    let (sender, receiver) = mpsc::sync_channel(1);
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        for surface in Surface::ALL {
            if let Some(window) = app.get_webview_window(surface.id()) {
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
            .message(format!(
                "Epicenter could not start its application host.\n\n{message}\n\nNo application window was opened."
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
    fn surface_table_has_stable_ids_routes_and_titles() {
        let actual = Surface::ALL.map(|surface| (surface.id(), surface.path(), surface.title()));
        assert_eq!(
            actual,
            [
                ("home", "/apps/home/", "Epicenter: Home"),
                ("whispering", "/apps/whispering/", "Epicenter: Whispering"),
                ("mail", "/apps/mail/", "Epicenter: Mail"),
                ("books", "/apps/books/", "Epicenter: Books"),
            ]
        );
    }

    #[test]
    fn trusted_application_capabilities_follow_the_surface_table() {
        let expected = Surface::ALL.map(Surface::id);
        for encoded in [
            include_str!("../capabilities/trusted-epicenter-apps-development.json"),
            include_str!("../capabilities/trusted-epicenter-apps-production.json"),
        ] {
            let capability: serde_json::Value = serde_json::from_str(encoded).unwrap();
            let windows = capability["windows"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_str().unwrap())
                .collect::<Vec<_>>();
            assert_eq!(windows, expected);
        }
    }

    #[test]
    fn app_ids_accept_only_the_catalog_contract_outside_built_in_surfaces() {
        for accepted in ["hello-http", "a", "notes2", "x-y-z", "0-"] {
            assert_eq!(parse_app_id(accepted), Some(accepted));
        }

        for denied in [
            "",
            "Hello",
            "hello_http",
            "hello.http",
            "hello/http",
            "..",
            "hello http",
            "héllo",
            // Built-in surfaces keep their own labels and capabilities until
            // they migrate into the derived catalog.
            "home",
            "whispering",
            "mail",
            "books",
        ] {
            assert_eq!(parse_app_id(denied), None, "expected {denied:?} rejected");
        }
    }

    #[test]
    fn app_window_labels_are_reserved_and_never_collide_with_host_windows() {
        assert_eq!(app_window_label("hello-http"), "app-hello-http");

        let mut host_labels: Vec<&str> = Surface::ALL.map(Surface::id).to_vec();
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

    #[test]
    fn built_in_surface_capabilities_expose_open_app_to_the_home_window() {
        for encoded in [
            include_str!("../capabilities/trusted-epicenter-apps-development.json"),
            include_str!("../capabilities/trusted-epicenter-apps-production.json"),
        ] {
            let capability: serde_json::Value = serde_json::from_str(encoded).unwrap();
            let windows = capability["windows"].as_array().unwrap();
            assert!(
                windows.contains(&serde_json::json!("home")),
                "the home window must hold the surface capability to invoke open_app"
            );
            let permissions = capability["permissions"].as_array().unwrap();
            assert!(permissions.contains(&serde_json::json!("allow-open-app")));
        }
    }

    #[test]
    fn deep_links_accept_only_the_closed_surface_route_table() {
        for (url, expected) in [
            ("epicenter://surface/home", Surface::Home),
            ("epicenter://surface/whispering", Surface::Whispering),
            ("epicenter://surface/mail", Surface::Mail),
            ("epicenter://surface/books", Surface::Books),
        ] {
            assert_eq!(
                parse_surface_deep_link(&url.parse().unwrap()),
                Some(expected)
            );
        }

        for denied in [
            "epicenter://surface/unknown",
            "epicenter://surface/home/",
            "epicenter://surface/home/extra",
            "epicenter://surface/home?mode=other",
            "epicenter://surface/home#other",
            "epicenter://user@surface/home",
            "epicenter://user:secret@surface/home",
            "epicenter://other/query",
            "https://surface/home",
        ] {
            assert_eq!(parse_surface_deep_link(&denied.parse().unwrap()), None);
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
    fn forwarded_arguments_extract_valid_unique_surface_links() {
        let arguments = [
            "/Applications/Epicenter.app/Contents/MacOS/Epicenter",
            "epicenter://surface/mail",
            "epicenter://surface/unknown",
            "epicenter://surface/mail",
            "epicenter://surface/books",
        ]
        .map(String::from);
        assert_eq!(
            surfaces_from_arguments(&arguments),
            vec![Surface::Mail, Surface::Books]
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
