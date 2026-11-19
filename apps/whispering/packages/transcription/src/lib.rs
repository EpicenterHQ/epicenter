//! Native local transcription for a standalone desktop app.
//!
//! `transcribe_audio` takes the audio the page uploads, decoded where it
//! arrives; the page's `localSpeech()` answers every transcription that way.
//! Model settings belong to the installing app and live in its local data
//! directory's `local/`, `app_local_data_dir()/local/local-transcription.json`,
//! where the app keeps what belongs to this computer alone (ADR-0894); model
//! files stay in the shared Hugging Face cache.

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{plugin::TauriPlugin, Manager, Runtime};
#[cfg(test)]
use tauri::AppHandle;

pub mod audio;
mod process;
pub use process::run;
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
/// No Hugging Face download or model load happens here.
#[cfg(test)]
fn model_cache<R: Runtime>(app: &AppHandle<R>) -> Result<ModelCache, String> {
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
            get_unload_policy::<tauri::Wry>,
            set_unload_policy::<tauri::Wry>,
            list_inference_models,
            transcribe_audio::<tauri::Wry>,
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
