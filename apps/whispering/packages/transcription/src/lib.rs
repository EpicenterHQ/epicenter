//! Native local transcription for a standalone desktop app.
//!
//! The page administers models through the plugin's commands: list, download,
//! remove, and show in the file manager. Transcription has no command. The
//! installing app reads the audio in a command of its own and transcribes
//! through `model_cache(app)?.transcribe_bytes(..)`, so the page never
//! carries audio. The unload policy belongs to the installing app and lives
//! in its local data directory's `local/`,
//! `app_local_data_dir()/local/local-transcription.json`, where the app keeps
//! what belongs to this computer alone; model files stay in the shared
//! Hugging Face cache.

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{plugin::TauriPlugin, AppHandle, Manager, Runtime};

pub mod audio;
mod process;
pub use process::{exit, run};
#[cfg(test)]
mod command_names;
#[cfg(test)]
use command_names::COMMANDS;
mod download;
pub mod transcription;
pub use download::DownloadProgress;
pub use transcription::*;

/// The settings file's name, in `local/` in the app's local data directory.
pub(crate) const SETTINGS_FILE: &str = "local-transcription.json";

/// The directory in the app's local data directory that holds the settings
/// file: this computer's own, never in Whispering's folder.
pub(crate) const SETTINGS_DIR: &str = "local";

/// Managed command state, which `init` installs.
#[doc(hidden)]
pub struct PluginState {
    settings_path: PathBuf,
    cache: Mutex<Option<ModelCache>>,
}

/// This app's model cache, created on first use with its idle watcher.
/// No Hugging Face download or model load happens here. A host command
/// that reads audio itself transcribes through it (`transcribe_bytes`).
pub fn model_cache<R: Runtime>(app: &AppHandle<R>) -> Result<ModelCache, String> {
    let state = app
        .try_state::<PluginState>()
        .ok_or("Transcription plugin is not installed")?;
    Ok(state.cache())
}

impl PluginState {
    fn cache(&self) -> ModelCache {
        let mut cache = self
            .cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        cache
            .get_or_insert_with(|| {
                let initialized =
                    ModelCache::new(LocalTranscriptionSettings::load(self.settings_path.clone()));
                initialized.start_idle_watcher();
                initialized
            })
            .clone()
    }
}

fn specta_builder<R: Runtime>() -> tauri_specta::Builder<R> {
    tauri_specta::Builder::<R>::new()
        .plugin_name("epicenter-transcription")
        .commands(tauri_specta::collect_commands![
            list_models,
            download_model,
            remove_model::<tauri::Wry>,
            reveal_model::<tauri::Wry>,
        ])
        .error_handling(tauri_specta::ErrorHandlingMode::DataError)
}

/// The plugin. Setup fails when the app's local data directory cannot be
/// resolved.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    let contract = specta_builder::<R>();
    tauri::plugin::Builder::new("epicenter-transcription")
        .invoke_handler(contract.invoke_handler())
        .setup(move |app, _| {
            app.manage(PluginState {
                settings_path: app
                    .path()
                    .app_local_data_dir()?
                    .join(SETTINGS_DIR)
                    .join(SETTINGS_FILE),
                cache: Mutex::new(None),
            });
            app.manage(download::Downloads::default());
            contract.mount_events(app);
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod bindings_tests;

#[cfg(test)]
mod tests;
