use std::sync::{mpsc, Mutex};

use anyhow::{anyhow, bail, Context, Result};
use tauri::webview::NewWindowResponse;
use tauri::{
    AppHandle, Manager, RunEvent, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent, Wry,
};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_epicenter_folder::FolderExt;
use tauri_plugin_opener::OpenerExt;
use tauri_specta::Event as _;

/// The command list, shared with `build.rs` through `include!`. Only the tests
/// read it from the crate, which is where the drift checks live.
#[cfg(test)]
mod command_names;

pub mod app_data;
mod cli;
mod data_folders;
mod history;
mod installed_apps;
mod scheme;

pub mod audio;

pub mod transcription;
use transcription::{
    delete_model, download_model, get_active_model, get_local_transcription_readiness,
    get_unload_policy, list_inference_models, list_models, prewarm_model, set_active_model,
    set_unload_policy, transcribe_audio_bytes, LocalTranscriptionSettings, ModelCache,
};

pub mod download;
use download::{cancel_download, DownloadManager};

mod delivery;
use delivery::{simulate_enter_keystroke, write_text};

pub mod media;
use media::{pause_playback, resume_playback};

pub mod timing;

mod shell;

#[cfg(desktop)]
pub mod keyboard;

#[cfg(target_os = "macos")]
pub mod overlay;

#[cfg(target_os = "macos")]
pub mod clipboard;

const HOSTED_AUTH_ORIGIN: &str = "https://api.epicenter.so";

/// Epicenter's own windows. Every app is installed and opened with
/// `open_installed_app` (ADR-0552).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BuiltInApp {
    Home,
    Folders,
}

impl BuiltInApp {
    const ALL: [Self; 2] = [Self::Home, Self::Folders];

    const fn id(self) -> &'static str {
        match self {
            Self::Home => "home",
            Self::Folders => "folders",
        }
    }

    const fn path(self) -> &'static str {
        match self {
            Self::Home => "/home/",
            Self::Folders => "/folders/",
        }
    }

    const fn title(self) -> &'static str {
        match self {
            Self::Home => "Epicenter: Settings",
            Self::Folders => "Epicenter: Folders",
        }
    }

    fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|built_in| built_in.id() == id)
    }
}

type DesktopAppHandle = AppHandle<Wry>;

/// A section of Settings an application asked the shell to open, held until
/// Settings is able to claim it. Only the latest survives: two recovery nudges
/// in a row should land the user somewhere once, not queue a backlog.
#[derive(Default)]
struct PendingHomeSection(Mutex<Option<HomeSection>>);

impl PendingHomeSection {
    fn queue(&self, section: HomeSection) {
        *self.0.lock().expect("pending home section lock poisoned") = Some(section);
    }

    fn take(&self) -> Option<HomeSection> {
        self.0
            .lock()
            .expect("pending home section lock poisoned")
            .take()
    }
}

/// The typed command and event contract every Epicenter window and Whispering
/// share.
fn make_specta_builder() -> tauri_specta::Builder<tauri::Wry> {
    tauri_specta::Builder::<tauri::Wry>::new()
        .commands(tauri_specta::collect_commands![
            write_text,
            simulate_enter_keystroke,
            transcribe_audio_bytes,
            list_inference_models,
            prewarm_model,
            get_active_model,
            set_active_model,
            get_local_transcription_readiness,
            open_home,
            take_pending_home_section,
            data_folders::list_data_folders,
            cli::ai_send,
            cli::account_send,
            cli::ai_key_set,
            cli::ai_key_remove,
            cli::ai_key_state,
            cli::auth_login::<tauri::Wry>,
            cli::auth_status,
            cli::auth_logout,
            history::status::<tauri::Wry>,
            history::history::<tauri::Wry>,
            history::save_version::<tauri::Wry>,
            history::sync::<tauri::Wry>,
            history::settle_sync::<tauri::Wry>,
            history::install_git,
            installed_apps::list_installed_apps,
            installed_apps::list_repository_apps,
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
        ])
        .events(tauri_specta::collect_events![
            keyboard::DictationCapabilityEvent,
            HomeSectionPending,
        ])
        .error_handling(tauri_specta::ErrorHandlingMode::DataError)
}

#[cfg(test)]
mod export_bindings {
    use super::*;

    /// Every consumer of this crate's typed command API is generated from
    /// Rust, so none can drift from it.
    ///
    /// Settings and Whispering carry the whole API in one file each. What a
    /// window may actually call is decided by its capability file, not by
    /// which bindings it can import: only `home.json` grants the local-model
    /// administration commands (ADR-0180), and a window whose file does not
    /// grant a command is denied it at the IPC boundary.
    const WHOLE_API: &[&str] = &[
        "../../whispering/src/lib/tauri/bindings.gen.ts",
        "../src/ui/bindings.gen.ts",
    ];

    /// A package that calls a few of the shell's commands gets those alone,
    /// generated from the same functions: `@epicenter/folder`'s desktop
    /// history (`tauri-history.ts`) and Todos' account leaf.
    fn subsets() -> [(&'static str, tauri_specta::Builder<Wry>); 2] {
        let data_errors = |builder: tauri_specta::Builder<Wry>| {
            builder.error_handling(tauri_specta::ErrorHandlingMode::DataError)
        };
        [
            (
                "../../../packages/folder/src/shell/bindings.gen.ts",
                data_errors(tauri_specta::Builder::new().commands(
                    tauri_specta::collect_commands![
                        history::status::<Wry>,
                        history::history::<Wry>,
                        history::save_version::<Wry>,
                        history::sync::<Wry>,
                        history::settle_sync::<Wry>,
                    ],
                )),
            ),
            (
                "../../todos/src/lib/tauri/bindings.gen.ts",
                data_errors(
                    tauri_specta::Builder::new().commands(tauri_specta::collect_commands![
                        cli::auth_status,
                        cli::account_send,
                        open_home,
                    ]),
                ),
            ),
        ]
    }

    #[test]
    fn export_types() {
        let whole = WHOLE_API
            .iter()
            .map(|target| (*target, make_specta_builder()));
        for (target, builder) in whole.chain(subsets()) {
            builder
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
///
/// Without a section it only opens Settings: the Folders window's Settings
/// button (ADR-0537, ADR-0552).
#[tauri::command]
#[specta::specta]
fn open_home(section: Option<HomeSection>, app: DesktopAppHandle) {
    if let Some(section) = section {
        app.state::<PendingHomeSection>().queue(section);
    }
    request_window(&app, BuiltInApp::Home);
    if section.is_some() {
        let _ = HomeSectionPending.emit_to(&app, BuiltInApp::Home.id());
    }
}

/// Claim the pending section intent, if any. Home calls this on mount and
/// whenever it is nudged; taking is destructive, so one intent opens one
/// section exactly once however many nudges arrive.
#[tauri::command]
#[specta::specta]
fn take_pending_home_section(app: DesktopAppHandle) -> Option<HomeSection> {
    app.state::<PendingHomeSection>().take()
}

pub fn run() {
    let specta_builder = make_specta_builder();
    let specta_handler = tauri_specta::Builder::invoke_handler(&specta_builder);
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
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .manage(PendingHomeSection::default())
        .manage(data_folders::DataFolderScopes::default())
        .manage(cli::CliChildren::default())
        .manage(DownloadManager::default());

    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());

    scheme::register(builder)
        // A page that reloads or navigates, and a closed window, end the
        // `epicenter` children that page started (ADR-0559).
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                webview
                    .state::<cli::CliChildren>()
                    .page_ended(webview.label());
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                window
                    .state::<cli::CliChildren>()
                    .page_ended(window.label());
            }
        })
        .invoke_handler(specta_handler)
        .setup(move |app| {
            specta_builder.mount_events(app);

            let desktop_paths = app_data::DesktopPaths::resolve(app.handle())?;
            data_folders::register_epicenter_folder(app.folders(), &desktop_paths.folder_dir)
                .map_err(anyhow::Error::msg)?;
            match data_folders::watch_data_folders(app.handle(), &desktop_paths.folder_dir) {
                Ok(watch) => {
                    app.manage(watch);
                }
                Err(message) => log::warn!("the data folder listing is not watched: {message}"),
            }
            // Git's configuration runs `~/.local/bin/epicenter`; point it
            // at this launch's binary, wherever the app now is (ADR-0566).
            cli::spawn_command_link_refresh(&desktop_paths);
            // An installed app may read `so.epicenter` through a lens, so its
            // declaration is published before any app opens.
            app.manage(cli::spawn_epicenter_folder_declaration(&desktop_paths));
            // Every window's page comes from the scheme, which reads these.
            app.manage(scheme::Roots {
                pages: scheme::pages_dir(app.handle())?,
                builds: desktop_paths.builds_dir(),
            });
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
            app.manage(keyboard::TapController::new());

            shell::create_tray(app.handle())?;

            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                open_deep_links(&handle, &event.urls());
            });

            let current = app.deep_link().get_current()?;
            let mut opened_window = false;
            if let Some(urls) = current {
                for url in &urls {
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
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Epicenter")
        .run(|app, event| {
            if let RunEvent::Reopen { .. } = event {
                request_window(app, BuiltInApp::Folders);
            }
        });
}

fn open_forwarded_deep_links(app: &DesktopAppHandle, arguments: &[String]) {
    let built_ins = apps_from_arguments(arguments);
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
        if let Some(built_in) = parse_app_deep_link(url) {
            request_window(app, built_in);
        }
    }
}

/// Ask for a window without waiting, and log rather than report what the
/// main thread makes of it.
///
/// That is right for the callers that have nobody to answer to (startup, the
/// tray, a deep link, macOS reopen, Settings asked for by the Folders window
/// or an app). It is wrong for `open_installed_app`, where a person clicked
/// and is owed an outcome, so that command waits on the main thread instead.
fn request_window(app: &DesktopAppHandle, built_in: BuiltInApp) {
    let window_app = app.clone();
    let schedule = app.run_on_main_thread(move || {
        if let Err(error) = ensure_window(&window_app, built_in) {
            log::error!("open the {} window: {error:#}", built_in.id());
        }
    });
    if let Err(error) = schedule {
        log::error!("schedule the {} window: {error}", built_in.id());
    }
}

/// Resolve `epicenter://app/<id>` to the built-in app it names, and a bare
/// `epicenter://` to the Folders window, which is what opening Epicenter shows
/// (ADR-0537).
///
/// The segment is `app` because it is the same ID space as `/apps/<id>/`: a
/// person pasting a link names the thing they want, not the frame it arrives
/// in.
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

/// The deployment this build signs in to and sends to, and whether it has
/// the hosted account website.
struct AuthConfiguration {
    base_url: String,
    account_management: bool,
}

/// The deployment's API origin, which the `epicenter` CLI signs in to when
/// the shell runs it (`cli.rs` passes it as `EPICENTER_API_URL`), so the app
/// and the CLI it runs name one deployment (ADR-0326).
pub(crate) fn deployment_origin() -> std::result::Result<String, String> {
    configured_auth_server()
        .map(|config| config.base_url)
        .map_err(|error| format!("{error:#}"))
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
    Ok(AuthConfiguration {
        base_url: url.origin().ascii_serialization(),
        account_management: self_hosted.is_none(),
    })
}

/// Ordinary new-tab account links leave the desktop app's work in place.
/// The host opens only the hosted account destinations in the system browser.
fn is_hosted_account_url(url: &tauri::Url, config: &AuthConfiguration) -> bool {
    config.account_management
        && url.origin().ascii_serialization() == config.base_url
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
            log::warn!("could not open the account website: {error}");
        }
    }
    NewWindowResponse::Deny
}

/// Make sure the one window for this built-in app exists, and reveal it.
///
/// The window label is the app's ID, which is what every capability file in
/// `src-tauri/capabilities/` selects on. One built-in app has one window.
fn ensure_window(app: &DesktopAppHandle, built_in: BuiltInApp) -> Result<()> {
    if let Some(window) = app.get_webview_window(built_in.id()) {
        focus(window);
        return Ok(());
    }

    let url = scheme::url(built_in.path())?;
    let window = create_app_window(app, built_in.id(), built_in.title(), url)?;
    let close_window = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = close_window.hide();
        }
    });
    focus(window);
    Ok(())
}

/// One window on the `epicenter-app` origin (ADR-0561). Navigation stays on
/// the origin; a link that opens a new window reaches the system browser only
/// when it is a hosted account page.
fn create_app_window(
    app: &DesktopAppHandle,
    label: &str,
    title: &str,
    url: tauri::Url,
) -> Result<WebviewWindow<Wry>> {
    let account_opener = app.clone();
    let navigating = label.to_string();
    WebviewWindowBuilder::new(app, label, WebviewUrl::CustomProtocol(url))
        .title(title)
        .inner_size(1100.0, 760.0)
        .min_inner_size(680.0, 480.0)
        .on_navigation(move |url| scheme::is_allowed_navigation(&navigating, url))
        .on_new_window(move |url, _| open_account_website(&account_opener, &url))
        .build()
        .with_context(|| format!("create the {title} WebView"))
}

/// The window label of installed app `id` opened on `folder`: one window per
/// app and folder. A label may hold only letters, digits, `-`, `/`, `:`, and
/// `_`, so the id's dots become `_` (an id has no `_`) and the folder's scope
/// is spelled in hex. Every installed app's window gets the one grant,
/// `capabilities/installed-app.json`, which selects `app:*` (ADR-0570).
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

/// Reload every open window of installed app `id`, on any folder, once its
/// build changed, so a running page never asks the new build for a chunk only
/// the old one had.
pub(crate) fn reload_installed_windows(app: &DesktopAppHandle, id: &str) {
    let own = installed_window_label(id, None);
    let on_folder = format!("{own}:");
    for (label, window) in app.webview_windows() {
        if label == own || label.starts_with(&on_folder) {
            if let Err(error) = window.reload() {
                log::warn!("reload the {label} window: {error}");
            }
        }
    }
}

/// Open installed app `id`, served at `/apps/<id>/`, in its own window, or
/// reveal the one already open on the same folder. With `folder`, a
/// registered scope, the window is permitted into it and the app is handed
/// it as `?folder=<scope>`; an app opens it with `openDataFolder({ id, lens })`
/// (ADR-0538). Every app's window is also permitted into `so.epicenter`,
/// whose `connections` table its AI commands name (ADR-0557, ADR-0570).
/// Approving an app trusts it fully (ADR-0540), so the shell does not check
/// its shape against the folder.
pub(crate) fn open_installed_window(
    app: &DesktopAppHandle,
    id: &str,
    title: &str,
    folder: Option<&str>,
) -> Result<()> {
    let label = installed_window_label(id, folder);
    if let Some(folder) = folder {
        app.folders()
            .permit(folder, &label)
            .map_err(|error| anyhow!("the app cannot open this folder: {error:?}"))?;
    }
    app.folders()
        .permit(data_folders::EPICENTER_FOLDER, &label)
        .map_err(|error| anyhow!("the app cannot open Epicenter's folder: {error:?}"))?;
    let mut url = scheme::url(&format!("/apps/{id}/"))?;
    if let Some(folder) = folder {
        url.query_pairs_mut().append_pair("folder", folder);
    }
    let title = format!("Epicenter: {title}");

    let (sender, receiver) = mpsc::sync_channel(1);
    let window_app = app.clone();
    app.run_on_main_thread(move || {
        let result = match window_app.get_webview_window(&label) {
            Some(window) => {
                focus(window);
                Ok(())
            }
            None => create_app_window(&window_app, &label, &title, url).map(focus),
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

#[cfg(test)]
mod tests {
    use super::*;

    const FOLDERS: &str = include_str!("../capabilities/folders.json");
    const HOME: &str = include_str!("../capabilities/home.json");
    const INSTALLED_APP: &str = include_str!("../capabilities/installed-app.json");

    /// Every capability file, for checks that hold for all of them.
    const ALL_CAPABILITIES: &[&str] = &[FOLDERS, HOME, INSTALLED_APP];

    #[test]
    fn built_in_window_table_has_stable_ids_routes_and_titles() {
        let actual = BuiltInApp::ALL.map(|window| (window.id(), window.path(), window.title()));
        assert_eq!(
            actual,
            [
                ("home", "/home/", "Epicenter: Settings"),
                ("folders", "/folders/", "Epicenter: Folders"),
            ]
        );
    }

    /// The recovery path an application offers must survive Settings not being
    /// there yet. The intent is shell state, so "Settings is absent", "Settings
    /// is still booting", and "Settings is open behind another window" are the
    /// same code path: the intent waits until Settings claims it.
    #[test]
    fn a_pending_home_section_waits_for_home_to_claim_it() {
        let pending = PendingHomeSection::default();
        assert_eq!(pending.take(), None, "nothing pending before anyone asks");
        pending.queue(HomeSection::Transcription);
        assert_eq!(
            pending.take(),
            Some(HomeSection::Transcription),
            "the intent is still there whenever Settings gets around to asking"
        );
    }

    /// Taking is destructive, so however many nudges arrive, one request opens
    /// one section once, and two requests in a row land the user there once.
    #[test]
    fn a_claimed_home_section_is_not_replayed() {
        let pending = PendingHomeSection::default();
        pending.queue(HomeSection::Transcription);
        pending.queue(HomeSection::Transcription);
        assert!(pending.take().is_some());
        assert_eq!(pending.take(), None, "a claimed intent must not fire again");
    }

    /// Every page is served on the `epicenter-app` scheme, which Tauri treats
    /// as local, so no capability names a remote origin (ADR-0561). There is
    /// one file per kind of window, and the build selects each of them; a
    /// development build changes none of it.
    #[test]
    fn one_local_capability_per_kind_of_window() {
        let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
        let mut files: Vec<String> = std::fs::read_dir(&directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        files.sort();
        assert_eq!(files, ["folders.json", "home.json", "installed-app.json"]);

        let mut identifiers = Vec::new();
        for encoded in ALL_CAPABILITIES {
            let capability: serde_json::Value = serde_json::from_str(encoded).unwrap();
            let identifier = capability["identifier"].as_str().unwrap();
            assert_eq!(capability["local"], true, "{identifier}");
            assert!(capability.get("remote").is_none(), "{identifier}");
            identifiers.push(serde_json::json!(identifier));
        }
        let production: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            production["app"]["security"]["capabilities"],
            serde_json::json!(identifiers)
        );
        let development: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.dev.conf.json")).unwrap();
        assert!(development.get("app").is_none());
    }

    /// Every installed app's window gets the one grant (ADR-0570): the
    /// capability selects every label `open_installed_window` makes, for any
    /// app id, with or without a folder, and none of Epicenter's own windows.
    /// It grants the union of what any installed app's page calls: the folder
    /// plugin and its history (ADR-0559), the recorder, which lists and opens
    /// every microphone and asks for access first (ADR-0543, ADR-0571),
    /// opening System Settings' privacy panes (ADR-0555), local
    /// transcription and its readiness (ADR-0180), opening Settings, the AI
    /// commands (ADR-0557), who the app is signed in as, and its account
    /// request (ADR-0549, ADR-0556).
    #[test]
    fn every_installed_app_window_gets_one_grant() {
        let capability: serde_json::Value = serde_json::from_str(INSTALLED_APP).unwrap();
        assert_eq!(capability["windows"], serde_json::json!(["app:*"]));
        for id in [
            "so.epicenter.whispering",
            "so.epicenter.todos",
            "com.example.board",
        ] {
            for folder in [
                None,
                Some(id),
                Some("data:Voice notes"),
                Some("so.epicenter"),
            ] {
                let label = installed_window_label(id, folder);
                assert!(selects(&capability, &label), "{label}");
            }
        }
        for built_in in BuiltInApp::ALL {
            assert!(!selects(&capability, built_in.id()), "{}", built_in.id());
        }
        #[cfg(target_os = "macos")]
        assert!(!selects(&capability, overlay::WINDOW_LABEL));
        assert_eq!(
            capability["permissions"],
            serde_json::json!([
                "epicenter-folder:default",
                "core:event:allow-listen",
                "core:event:allow-unlisten",
                "allow-status",
                "allow-history",
                "allow-save-version",
                "allow-sync",
                "allow-settle-sync",
                "epicenter-recorder:default",
                {
                    "identifier": "opener:allow-open-url",
                    "allow": [{ "url": "x-apple.systempreferences:*" }]
                },
                "allow-list-inference-models",
                "allow-transcribe-audio-bytes",
                "allow-get-local-transcription-readiness",
                "allow-open-home",
                "allow-ai-send",
                "allow-ai-key-set",
                "allow-ai-key-remove",
                "allow-ai-key-state",
                "allow-auth-status",
                "allow-account-send"
            ])
        );

        // It reads and changes only the directory a grant names: no fs plugin
        // is installed, and its Git runs in the `epicenter` CLI.
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert!(
            config["plugins"].get("fs").is_none(),
            "no fs plugin is installed"
        );
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

    /// The AI commands reach Settings, the Folders window, and every
    /// installed app, and no other window (ADR-0557, ADR-0570). Each is one
    /// fixed CLI invocation that never hands a page a saved key.
    #[test]
    fn ai_commands_are_granted_to_settings_folders_and_installed_apps() {
        const AI: [&str; 4] = [
            "allow-ai-send",
            "allow-ai-key-set",
            "allow-ai-key-remove",
            "allow-ai-key-state",
        ];
        for encoded in ALL_CAPABILITIES {
            let capability: serde_json::Value = serde_json::from_str(encoded).unwrap();
            let permissions = capability["permissions"].as_array().unwrap();
            for permission in AI {
                assert!(
                    permissions.contains(&serde_json::json!(permission)),
                    "{} {permission}",
                    capability["identifier"]
                );
            }
        }
    }

    /// An account request and who the app is signed in as reach every
    /// installed app; who it is signed in as also reaches Settings; signing in
    /// and out reaches Settings alone (ADR-0558).
    #[test]
    fn signing_in_and_out_is_granted_to_settings_alone() {
        for encoded in ALL_CAPABILITIES {
            let capability: serde_json::Value = serde_json::from_str(encoded).unwrap();
            let permissions = capability["permissions"].as_array().unwrap();
            let grants = |permission: &str| permissions.contains(&serde_json::json!(permission));
            let identifier = capability["identifier"].as_str().unwrap();
            let settings = *encoded == HOME;
            let installed = *encoded == INSTALLED_APP;
            assert_eq!(grants("allow-account-send"), installed, "{identifier}");
            assert_eq!(
                grants("allow-auth-status"),
                installed || settings,
                "{identifier}"
            );
            for permission in ["allow-auth-login", "allow-auth-logout"] {
                assert_eq!(grants(permission), settings, "{identifier} {permission}");
            }
        }
    }

    #[test]
    fn development_names_only_a_local_deployment() {
        assert_eq!(
            auth_server(None, Some("http://localhost:8787"))
                .unwrap()
                .base_url,
            "http://localhost:8787"
        );
        assert_eq!(
            auth_server(None, None).unwrap().base_url,
            "https://api.epicenter.so"
        );
        assert!(auth_server(None, Some("https://evil.test")).is_err());
    }

    #[test]
    fn native_dashboard_policy_follows_account_management() {
        let mut config = auth_server(Some("https://self.example"), None).unwrap();
        let dashboard = "https://self.example/dashboard".parse().unwrap();
        assert!(!is_hosted_account_url(&dashboard, &config));
        config.account_management = true;
        assert!(is_hosted_account_url(&dashboard, &config));
    }

    #[test]
    fn fixed_self_hosted_origin_wins_and_has_no_account_website() {
        let server = auth_server(
            Some("https://SELF.example:443/"),
            Some("http://localhost:8787"),
        )
        .unwrap();
        assert_eq!(server.base_url, "https://self.example");
        assert!(!server.account_management);
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

    /// The `tauri-plugin-macos-permissions` plugin is gone from this build:
    /// the recorder plugin asks for microphone access through AVFoundation
    /// itself, and the keyboard supervisor watches the Accessibility grant.
    ///
    /// Its `macos-permissions:default` grant handed Whispering twelve unrelated
    /// plugin commands (screen recording, input monitoring, full disk access,
    /// camera) to reach the two it used. A grant naming a plugin this build does
    /// not ship is a silent no-op, so nothing would fail if it were pasted back;
    /// what it would do is describe an authority the app does not have. Every
    /// capability is checked, not just the one that had it.
    #[test]
    fn no_capability_grants_the_deleted_permissions_plugin() {
        for encoded in ALL_CAPABILITIES {
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

    /// Every command a capability grants must exist, and every command the crate
    /// exposes must be declared to the Tauri manifest. These are two hand-kept
    /// lists today, and a grant for a command that does not exist is a silent
    /// no-op rather than an error.
    #[test]
    fn capability_grants_name_only_commands_this_build_has() {
        let declared: std::collections::BTreeSet<&str> =
            crate::command_names::COMMANDS.iter().copied().collect();
        for encoded in ALL_CAPABILITIES {
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
    #[test]
    fn generated_bindings_cover_every_declared_command() {
        for bindings in [
            include_str!("../../../whispering/src/lib/tauri/bindings.gen.ts"),
            include_str!("../../src/ui/bindings.gen.ts"),
        ] {
            for command in crate::command_names::COMMANDS {
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

        let capability: serde_json::Value = serde_json::from_str(HOME).unwrap();
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

        // Applications read readiness and transcribe, and can send the person
        // to Settings to fix it; none administers the model.
        for encoded in ALL_CAPABILITIES {
            let capability: serde_json::Value = serde_json::from_str(encoded).unwrap();
            if capability["windows"] == serde_json::json!(["home"]) {
                continue;
            }
            let permissions = capability["permissions"].as_array().unwrap();
            for permission in ADMINISTRATION {
                assert!(
                    !permissions.contains(&serde_json::json!(permission)),
                    "an application must not administer models: {permission}"
                );
            }
        }
    }

    /// The folder history commands reach the Folders window and every
    /// installed app's windows (`app:*`), and no other window;
    /// each runs only for a folder the window was granted (ADR-0559).
    /// Starting what installs `git` reaches the Folders window alone.
    #[test]
    fn folder_history_is_granted_to_folders_and_installed_apps_alone() {
        const HISTORY: [&str; 5] = [
            "allow-status",
            "allow-history",
            "allow-save-version",
            "allow-sync",
            "allow-settle-sync",
        ];
        for encoded in ALL_CAPABILITIES {
            let capability: serde_json::Value = serde_json::from_str(encoded).unwrap();
            let permissions = capability["permissions"].as_array().unwrap();
            let granted = HISTORY
                .iter()
                .filter(|permission| permissions.contains(&serde_json::json!(permission)))
                .count();
            let windows = &capability["windows"];
            let folders = windows == &serde_json::json!(["folders"]);
            let expected = folders || windows == &serde_json::json!(["app:*"]);
            assert_eq!(
                granted,
                if expected { HISTORY.len() } else { 0 },
                "{}",
                capability["identifier"]
            );
            assert_eq!(
                permissions.contains(&serde_json::json!("allow-install-git")),
                folders,
                "{}",
                capability["identifier"]
            );
        }
    }

    /// Whether `capability` applies to the window labelled `label`, decided as
    /// Tauri decides it: each `windows` entry is a `glob::Pattern` matched
    /// against the label (`tauri::ipc::authority`).
    fn selects(capability: &serde_json::Value, label: &str) -> bool {
        capability["windows"]
            .as_array()
            .unwrap()
            .iter()
            .any(|pattern| {
                glob::Pattern::new(pattern.as_str().unwrap())
                    .unwrap()
                    .matches(label)
            })
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

    /// The Folders window holds the folder plugin, its own listing, a granted
    /// folder's history through the CLI and starting what installs `git`
    /// (ADR-0559), the AI commands
    /// (ADR-0557), installing and opening apps, and opening Settings
    /// (ADR-0537, ADR-0552), and nothing else: it reaches
    /// folders only through scopes the listing registered or permitted it
    /// into, and it administers no model.
    #[test]
    fn the_folders_window_holds_the_folder_plugin_and_its_listing() {
        let capability: serde_json::Value = serde_json::from_str(FOLDERS).unwrap();
        assert_eq!(capability["windows"], serde_json::json!(["folders"]));
        assert_eq!(
            capability["permissions"],
            serde_json::json!([
                "epicenter-folder:default",
                "core:event:allow-listen",
                "core:event:allow-unlisten",
                "allow-list-data-folders",
                "allow-status",
                "allow-history",
                "allow-save-version",
                "allow-sync",
                "allow-settle-sync",
                "allow-install-git",
                "allow-ai-send",
                "allow-ai-key-set",
                "allow-ai-key-remove",
                "allow-ai-key-state",
                "allow-list-installed-apps",
                "allow-list-repository-apps",
                "allow-install-app",
                "allow-approve-app",
                "allow-update-app",
                "allow-open-installed-app",
                "allow-open-home"
            ]),
            "folders"
        );
        for encoded in ALL_CAPABILITIES
            .iter()
            .filter(|encoded| **encoded != FOLDERS)
        {
            let capability: serde_json::Value = serde_json::from_str(encoded).unwrap();
            for permission in capability["permissions"].as_array().unwrap() {
                // A scoped grant is an object; its identifier is what is named.
                let permission = permission
                    .as_str()
                    .or_else(|| permission["identifier"].as_str())
                    .unwrap();
                assert_ne!(
                    permission, "allow-list-data-folders",
                    "the listing belongs to the Folders window alone"
                );
                assert!(
                    !permission.ends_with("-app"),
                    "installing and opening apps belong to the Folders window alone: {permission}"
                );
            }
        }
    }

    #[test]
    fn deep_links_accept_only_the_closed_built_in_app_table() {
        for (url, expected) in [
            ("epicenter://app/home", BuiltInApp::Home),
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
            // Installed apps are opened from the Folders window, not by link.
            "epicenter://app/todos",
            "epicenter://app/so.epicenter.todos",
            "epicenter://app/whispering",
            "epicenter://app/so.epicenter.whispering",
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
    fn forwarded_arguments_extract_valid_unique_app_links() {
        let arguments = [
            "/Applications/Epicenter.app/Contents/MacOS/Epicenter",
            "epicenter://app/home",
            "epicenter://app/unknown",
            "epicenter://app/todos",
            "epicenter://app/home",
            "epicenter://app/whispering",
            "epicenter://",
        ]
        .map(String::from);
        assert_eq!(
            apps_from_arguments(&arguments),
            vec![BuiltInApp::Home, BuiltInApp::Folders]
        );
    }
}
