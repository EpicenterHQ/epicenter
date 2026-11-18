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
use tauri::{plugin::TauriPlugin, AppHandle, Manager, Runtime};

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

type OpenSettings<R> = Box<dyn Fn(&AppHandle<R>) -> Result<(), String> + Send + Sync>;

/// Managed command state. Apps install it through `Builder`.
#[doc(hidden)]
pub struct PluginState<R: Runtime> {
    settings_path: PathBuf,
    cache: Mutex<Option<ModelCache>>,
    open_settings: OpenSettings<R>,
}

/// This app's model cache, created on first use with its idle watcher.
/// No Hugging Face download or model load happens here.
#[cfg(test)]
fn model_cache<R: Runtime>(app: &AppHandle<R>) -> Result<ModelCache, String> {
    let state = app
        .try_state::<PluginState<R>>()
        .ok_or("Transcription plugin is not installed")?;
    Ok(state.cache())
}

impl<R: Runtime> PluginState<R> {
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
            get_active_model::<tauri::Wry>,
            set_active_model::<tauri::Wry>,
            get_unload_policy::<tauri::Wry>,
            set_unload_policy::<tauri::Wry>,
            list_inference_models::<tauri::Wry>,
            transcribe_audio::<tauri::Wry>,
            load_model::<tauri::Wry>,
            unload_model::<tauri::Wry>,
            open_model_settings::<tauri::Wry>,
        ])
        .error_handling(tauri_specta::ErrorHandlingMode::DataError)
}

/// The plugin, with the app's own model-settings navigation.
pub struct Builder<R: Runtime> {
    open_settings: OpenSettings<R>,
}

impl<R: Runtime> Default for Builder<R> {
    fn default() -> Self {
        Self {
            open_settings: Box::new(|_| Err("This app has no model settings.".into())),
        }
    }
}

impl<R: Runtime> Builder<R> {
    pub fn new() -> Self {
        Self::default()
    }

    /// What `open_model_settings` does. Without it the command refuses.
    pub fn open_settings(
        mut self,
        callback: impl Fn(&AppHandle<R>) -> Result<(), String> + Send + Sync + 'static,
    ) -> Self {
        self.open_settings = Box::new(callback);
        self
    }

    /// Setup fails when the app's local data directory cannot be resolved.
    pub fn build(self) -> TauriPlugin<R> {
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
                    open_settings: self.open_settings,
                });
                app.manage(download::Downloads::default());
                contract.mount_events(app);
                Ok(())
            })
            .build()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new().build()
}

#[cfg(test)]
mod bindings_tests;

#[cfg(test)]
mod tests;
