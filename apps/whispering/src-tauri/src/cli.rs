//! The desktop program from a terminal, with no window:
//!
//! ```text
//! whispering --transcribe-file talk.m4a [--model <id or name>] [--json]
//! whispering --list-models [--json]
//! ```
//!
//! `--transcribe-file` runs a model on this computer, through the same code
//! as a take in the app (`ModelCache::transcribe_bytes`), over any audio
//! the decoder reads (WAV, MP3, AAC in MP4, Opus in WebM or Ogg), and
//! prints the text. Without `--model` it uses the model chosen in the app
//! (`transcription.local.model` in `settings.json`); when the settings name
//! none that is downloaded, the app's default model, or else the only model
//! downloaded. `--model` is a model's
//! id, its name, or a part of its name that only one downloaded model has.
//! Downloading a model is the app's job.
//!
//! `--json` prints `{"text": ..., "model": ...}`, or on a failure
//! `{"error": {"name": ..., "message": ...}}`. A failure exits 1 and names
//! what went wrong: `NoSpeech`, `ModelMissing`, `Unreadable`, or `Failed`;
//! a command line that cannot be read exits 2.
//!
//! It records nothing, saves nothing, and reads only the one setting. The
//! transcript is the model's own words: `dictionary.txt` and cleanup are
//! the page's, and a server needs the Keychain.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri_plugin_epicenter_transcription::{
    list_models, LocalTranscriptionSettings, ModelCache, ModelInfo, TranscriptionError,
    TranscriptionHints, TranscriptionOutcome,
};

/// The model the app uses until another is chosen: the default of
/// `transcription.local.model` in `src/lib/data/settings.ts`, which a test
/// here reads to keep the two the same.
const DEFAULT_MODEL: &str =
    "handy-computer/parakeet-tdt-0.6b-v3-gguf@main/parakeet-tdt-0.6b-v3-Q4_K_M.gguf";

/// What the command line asked for.
#[derive(Debug, PartialEq)]
pub enum Request {
    Transcribe {
        file: PathBuf,
        model: Option<String>,
        json: bool,
    },
    ListModels {
        json: bool,
    },
}

/// Why nothing was transcribed. `name` is what a caller switches on.
#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "name")]
enum Failure {
    /// The audio was read and held no speech.
    NoSpeech { message: String },
    /// No downloaded model matches, or none is downloaded.
    ModelMissing { message: String },
    /// The file is not there, or is not audio the decoder reads.
    Unreadable { message: String },
    /// The model is there and could not be loaded or run.
    Failed { message: String },
}

impl Failure {
    fn message(&self) -> &str {
        match self {
            Self::NoSpeech { message }
            | Self::ModelMissing { message }
            | Self::Unreadable { message }
            | Self::Failed { message } => message,
        }
    }
}

/// Read `args` (without the program's name). `Ok(None)` when they ask for
/// nothing here, so the app opens as usual.
pub fn parse(args: impl IntoIterator<Item = String>) -> Result<Option<Request>, String> {
    let (mut file, mut model, mut json, mut list) = (None, None, false, false);
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--transcribe-file" => {
                file = Some(args.next().ok_or("--transcribe-file needs a file")?)
            }
            "--model" => model = Some(args.next().ok_or("--model needs a model's id or name")?),
            "--json" => json = true,
            "--list-models" => list = true,
            // What the system passes: at login, and macOS's process serial number.
            crate::autostart::HIDDEN => {}
            system if system.starts_with("-psn_") => {}
            // A flag mistyped must not open the window and leave a script waiting.
            unknown if unknown.starts_with("--") => {
                return Err(format!("{unknown} is not a flag Whispering knows"))
            }
            _ => {}
        }
    }
    Ok(match (file, list) {
        (Some(file), _) => Some(Request::Transcribe {
            file: PathBuf::from(file),
            model,
            json,
        }),
        (None, true) => Some(Request::ListModels { json }),
        (None, false) => None,
    })
}

/// The app's local data directory for the app `identifier`, where Tauri
/// puts it, worked out without starting the app.
fn data_dir(identifier: &str) -> Option<PathBuf> {
    let home = || std::env::var_os("HOME").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = home().map(|home| home.join("Library/Application Support"));
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| home().map(|home| home.join(".local/share")));
    #[cfg(target_os = "windows")]
    let _ = home;
    base.map(|base| base.join(identifier))
}

/// The model the app's settings choose, if `settings.json` in `dir` names one.
fn chosen_model(dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(dir.join("settings.json")).ok()?;
    let settings: serde_json::Value = serde_json::from_str(&text).ok()?;
    Some(
        settings
            .get("transcription.local.model")?
            .as_str()?
            .to_string(),
    )
}

fn names(models: &[&ModelInfo]) -> String {
    models
        .iter()
        .map(|model| format!("  {}", model.name))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The downloaded model to run: the one `wanted` names (by id, by name, or
/// by a part of the name only one downloaded model has, ignoring case), or
/// with nothing wanted, the one the app `chose`, then the app's default,
/// then the only one downloaded.
fn pick<'a>(
    models: &'a [ModelInfo],
    wanted: Option<&str>,
    chose: Option<&str>,
) -> Result<&'a ModelInfo, Failure> {
    let missing = |message: String| Failure::ModelMissing { message };
    let downloaded: Vec<&ModelInfo> = models.iter().filter(|model| model.downloaded).collect();
    if downloaded.is_empty() {
        return Err(missing(
            "No model is downloaded. Open Whispering and download one first.".to_string(),
        ));
    }
    let Some(wanted) = wanted else {
        if let Some(model) = downloaded
            .iter()
            .find(|model| Some(model.id.as_str()) == chose)
        {
            return Ok(model);
        }
        // A fresh install has no settings file, and the app then uses its default.
        if let Some(model) = downloaded.iter().find(|model| model.id == DEFAULT_MODEL) {
            return Ok(model);
        }
        return match downloaded.as_slice() {
            [only] => Ok(only),
            several => Err(missing(format!(
                "More than one model is downloaded; name one with --model:\n{}",
                names(several)
            ))),
        };
    };
    let lower = wanted.to_lowercase();
    if let Some(model) = downloaded
        .iter()
        .find(|model| model.id == wanted || model.name.to_lowercase() == lower)
    {
        return Ok(model);
    }
    let partial: Vec<&ModelInfo> = downloaded
        .iter()
        .copied()
        .filter(|model| model.name.to_lowercase().contains(&lower))
        .collect();
    match partial.as_slice() {
        [model] => Ok(model),
        [] => Err(missing(format!(
            "No downloaded model is named {wanted:?}. Downloaded:\n{}",
            names(&downloaded)
        ))),
        several => Err(missing(format!(
            "{wanted:?} names more than one model:\n{}",
            names(several)
        ))),
    }
}

/// Do what `request` asks for the app `identifier`, and print the result.
/// Answers the exit code.
pub fn run(request: Request, identifier: &str) -> i32 {
    let models = list_models();
    let chose = data_dir(identifier).and_then(|dir| chosen_model(&dir));
    match request {
        Request::ListModels { json } => {
            if json {
                let listed: Vec<_> = models
                    .iter()
                    .map(|model| {
                        serde_json::json!({
                            "id": model.id,
                            "name": model.name,
                            "downloaded": model.downloaded,
                            "selected": Some(model.id.as_str()) == chose.as_deref(),
                        })
                    })
                    .collect();
                println!("{}", serde_json::Value::Array(listed));
            } else {
                for model in &models {
                    let state = match (
                        model.downloaded,
                        Some(model.id.as_str()) == chose.as_deref(),
                    ) {
                        (true, true) => "downloaded, selected",
                        (true, false) => "downloaded",
                        (false, _) => "not downloaded",
                    };
                    println!("{}\t{}\t{state}", model.name, model.id);
                }
            }
            0
        }
        Request::Transcribe { file, model, json } => {
            let transcribed = pick(&models, model.as_deref(), chose.as_deref())
                .and_then(|model| transcribe(&file, model));
            match transcribed {
                Ok((text, model)) if json => {
                    println!("{}", serde_json::json!({ "text": text, "model": model }));
                    0
                }
                Ok((text, _)) => {
                    println!("{text}");
                    0
                }
                Err(failure) => {
                    if json {
                        println!("{}", serde_json::json!({ "error": failure }));
                    } else {
                        eprintln!("{}", failure.message());
                    }
                    1
                }
            }
        }
    }
}

/// The transcript of `file` from `model`, and the model's id.
fn transcribe(file: &Path, model: &ModelInfo) -> Result<(String, String), Failure> {
    let audio = std::fs::read(file).map_err(|error| Failure::Unreadable {
        message: format!("{} could not be read: {error}", file.display()),
    })?;
    let no_speech = || Failure::NoSpeech {
        message: format!("No speech was heard in {}.", file.display()),
    };
    // No settings file: the model is dropped when this process ends.
    let cache = ModelCache::new(LocalTranscriptionSettings::load(PathBuf::new()));
    match cache.transcribe_bytes(model.id.clone(), &audio, TranscriptionHints::default()) {
        Ok(TranscriptionOutcome::Transcribed { text, model_id, .. }) => {
            let text = text.trim();
            if text.is_empty() {
                Err(no_speech())
            } else {
                Ok((text.to_string(), model_id))
            }
        }
        Ok(TranscriptionOutcome::EmptyAudio) => Err(no_speech()),
        Err(TranscriptionError::AudioReadError { message }) => Err(Failure::Unreadable {
            message: format!(
                "{} is not audio Whispering can read: {message}",
                file.display()
            ),
        }),
        Err(TranscriptionError::ModelUnavailable { message }) => {
            Err(Failure::ModelMissing { message })
        }
        Err(
            TranscriptionError::ModelLoadError { message }
            | TranscriptionError::TranscriptionError { message },
        ) => Err(Failure::Failed { message }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(line: &str) -> Vec<String> {
        line.split_whitespace().map(String::from).collect()
    }

    fn model(id: &str, name: &str, downloaded: bool) -> ModelInfo {
        ModelInfo {
            id: id.to_string(),
            name: name.to_string(),
            description: String::new(),
            size_bytes: 0,
            supports_prompt: false,
            supports_language: false,
            recommended: false,
            downloaded,
        }
    }

    fn models() -> [ModelInfo; 3] {
        [
            model("a/parakeet.gguf", "Parakeet TDT 0.6B v3", true),
            model("b/whisper-small.gguf", "Whisper Small", true),
            model("c/whisper-large.gguf", "Whisper Large v3", false),
        ]
    }

    #[test]
    fn with_nothing_asked_the_app_opens() {
        assert_eq!(parse(args("")), Ok(None));
        assert_eq!(parse(args("-psn_0_12345 --json --hidden")), Ok(None));
        assert!(
            parse(args("--transcribe a.wav")).is_err(),
            "a mistyped flag"
        );
    }

    #[test]
    fn a_file_is_a_request_with_or_without_a_model_in_any_order() {
        assert_eq!(
            parse(args("--json --model parakeet --transcribe-file a.wav")),
            Ok(Some(Request::Transcribe {
                file: PathBuf::from("a.wav"),
                model: Some("parakeet".to_string()),
                json: true
            }))
        );
        assert_eq!(
            parse(args("--transcribe-file a.wav")),
            Ok(Some(Request::Transcribe {
                file: PathBuf::from("a.wav"),
                model: None,
                json: false
            }))
        );
        assert_eq!(
            parse(args("--list-models --json")),
            Ok(Some(Request::ListModels { json: true }))
        );
    }

    #[test]
    fn a_flag_with_nothing_after_it_is_refused() {
        assert!(parse(args("--transcribe-file")).is_err());
        assert!(parse(args("--transcribe-file a.wav --model")).is_err());
    }

    #[test]
    fn a_model_is_named_by_id_by_name_or_by_part_of_its_name() {
        let models = models();
        let pick = |wanted| pick(&models, Some(wanted), None).map(|model| model.id.as_str());
        assert_eq!(pick("a/parakeet.gguf"), Ok("a/parakeet.gguf"));
        assert_eq!(pick("whisper small"), Ok("b/whisper-small.gguf"));
        assert_eq!(pick("parakeet"), Ok("a/parakeet.gguf"));
        // Only one Whisper is downloaded, so the part names it.
        assert_eq!(pick("whisper"), Ok("b/whisper-small.gguf"));
        assert!(pick("large").is_err(), "not downloaded");
        assert!(pick("a").is_err(), "more than one");
    }

    #[test]
    fn with_no_model_named_the_apps_choice_runs_or_the_only_one_downloaded() {
        let models = models();
        let id = |chose| pick(&models, None, chose).map(|model| model.id.as_str());
        assert_eq!(id(Some("b/whisper-small.gguf")), Ok("b/whisper-small.gguf"));
        assert!(
            id(Some("c/whisper-large.gguf")).is_err(),
            "chosen, not downloaded"
        );
        assert!(id(None).is_err(), "two are downloaded and none is chosen");
        let mut with_default = self::models();
        with_default[0].id = DEFAULT_MODEL.to_string();
        assert_eq!(
            pick(&with_default, None, Some("c/whisper-large.gguf"))
                .unwrap()
                .id,
            DEFAULT_MODEL,
            "the app's default when its choice is not here"
        );
    }

    #[test]
    fn the_default_model_is_the_one_the_page_defaults_to() {
        let settings = include_str!("../../src/lib/data/settings.ts");
        assert!(
            settings.contains(&format!("'{DEFAULT_MODEL}'")),
            "DEFAULT_MODEL no longer matches `transcription.local.model` in settings.ts"
        );
        let one = [model("a/parakeet.gguf", "Parakeet", true)];
        assert_eq!(pick(&one, None, None).unwrap().id, "a/parakeet.gguf");
        assert!(matches!(
            pick(&[], None, None),
            Err(Failure::ModelMissing { .. })
        ));
    }

    #[test]
    fn the_apps_choice_is_read_from_its_settings() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(chosen_model(dir.path()), None);
        std::fs::write(
            dir.path().join("settings.json"),
            r#"{ "transcription.local.model": "a/parakeet.gguf", "microphone": null }"#,
        )
        .unwrap();
        assert_eq!(chosen_model(dir.path()).as_deref(), Some("a/parakeet.gguf"));
    }
}
