//! Transcribes a recording on this computer, with a model the transcription
//! plugin keeps (`tauri-plugin-epicenter-transcription`: transcribe.cpp, and
//! models in the shared Hugging Face cache). The page lists, downloads and
//! removes models through that plugin's own commands; this is the one
//! command that runs one.
//!
//! Like `servers::transcribe`, it takes a recording's id and reads the
//! audio here, so the page never carries it.

use serde::Serialize;
use tauri::{AppHandle, Runtime};
use tauri_plugin_epicenter_transcription::{
    model_cache, TranscriptionError, TranscriptionHints, TranscriptionOutcome,
};

use crate::{files, servers::is_bare_name};

/// Why a recording got no text on this computer. The page switches on
/// `name`; `message` says it for a person.
#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "name")]
pub enum LocalError {
    /// The recording's audio is not there, or could not be read as audio.
    NoAudio { message: String },
    /// The model is not one Whispering knows, or is not downloaded.
    ModelMissing { message: String },
    /// The model is there and could not be loaded or run.
    Failed { message: String },
}

/// The transcript of the recording `id`, from `model` on this computer; an
/// empty string when the audio holds no sound. `prompt` is words to spell as
/// written, and `language` is the language spoken, as a two-letter code;
/// each reaches a model that takes it (Whisper) and is left out for one
/// that does not (Parakeet).
#[tauri::command]
pub async fn transcribe_local<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    model: String,
    prompt: Option<String>,
    language: Option<String>,
) -> Result<String, LocalError> {
    if !is_bare_name(&id) {
        return Err(LocalError::NoAudio {
            message: format!("{id:?} is not a recording"),
        });
    }
    let path = files::recordings_dir(&app)
        .map_err(|message| LocalError::NoAudio { message })?
        .join(format!("{id}.webm"));
    let cache = model_cache(&app).map_err(|message| LocalError::Failed { message })?;
    tauri::async_runtime::spawn_blocking(move || {
        let audio = std::fs::read(&path).map_err(|error| LocalError::NoAudio {
            message: match error.kind() {
                std::io::ErrorKind::NotFound => "This recording's audio is gone.".to_string(),
                _ => format!("This recording's audio could not be read: {error}"),
            },
        })?;
        let hints = TranscriptionHints {
            language,
            initial_prompt: prompt,
        };
        match cache.transcribe_bytes(model, &audio, hints) {
            Ok(TranscriptionOutcome::Transcribed { text, .. }) => Ok(text.trim().to_string()),
            Ok(TranscriptionOutcome::EmptyAudio) => Ok(String::new()),
            Err(TranscriptionError::AudioReadError { message }) => {
                Err(LocalError::NoAudio { message })
            }
            Err(TranscriptionError::ModelUnavailable { message }) => {
                Err(LocalError::ModelMissing { message })
            }
            Err(
                TranscriptionError::ModelLoadError { message }
                | TranscriptionError::TranscriptionError { message },
            ) => Err(LocalError::Failed { message }),
        }
    })
    .await
    // The work stopped without finishing (it panicked).
    .map_err(|error| LocalError::Failed {
        message: format!("Transcription stopped: {error}"),
    })?
}
