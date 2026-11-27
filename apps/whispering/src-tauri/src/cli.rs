//! Transcribe a file from a terminal, with no window:
//!
//! ```text
//! whispering --transcribe-file talk.wav --model parakeet [--json]
//! ```
//!
//! It runs the same model, through the same code, as a take in the app
//! (`ModelCache::transcribe_bytes`), and prints the text. `--model` is a
//! model's id, its name, or part of its name, among the models already
//! downloaded; downloading one is the app's job. `--json` prints
//! `{"text": ..., "model": ...}`. A failure prints why on standard error
//! and exits 1.
//!
//! It reads nothing of the app's: not `settings.json`, the dictionary, or a
//! server. The transcript is the model's own words.

use std::path::PathBuf;

use tauri_plugin_epicenter_transcription::{
    list_models, LocalTranscriptionSettings, ModelCache, ModelInfo, TranscriptionHints,
    TranscriptionOutcome,
};

/// What the command line asked for.
#[derive(Debug, PartialEq)]
pub struct Request {
    file: PathBuf,
    model: String,
    json: bool,
}

/// Read `args` (without the program's name). `Ok(None)` when they do not
/// ask for a transcription, so the app opens as usual.
pub fn parse(args: impl IntoIterator<Item = String>) -> Result<Option<Request>, String> {
    let (mut file, mut model, mut json) = (None, None, false);
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--transcribe-file" => file = Some(args.next().ok_or("--transcribe-file needs a file")?),
            "--model" => model = Some(args.next().ok_or("--model needs a model's name")?),
            "--json" => json = true,
            // Anything else is the system's own (macOS passes some at launch).
            _ => {}
        }
    }
    let Some(file) = file else {
        return Ok(None);
    };
    Ok(Some(Request {
        file: PathBuf::from(file),
        model: model.ok_or("--transcribe-file needs --model <name>")?,
        json,
    }))
}

/// The downloaded model `wanted` names: by id, by name, or by a part of the
/// name that only one downloaded model has, ignoring case.
fn pick<'a>(models: &'a [ModelInfo], wanted: &str) -> Result<&'a ModelInfo, String> {
    let downloaded: Vec<&ModelInfo> = models.iter().filter(|model| model.downloaded).collect();
    let lower = wanted.to_lowercase();
    let exact = downloaded
        .iter()
        .find(|model| model.id == wanted || model.name.to_lowercase() == lower);
    if let Some(model) = exact {
        return Ok(model);
    }
    let partial: Vec<&&ModelInfo> = downloaded
        .iter()
        .filter(|model| model.name.to_lowercase().contains(&lower))
        .collect();
    let names = |models: &[&ModelInfo]| {
        models
            .iter()
            .map(|model| format!("  {}", model.name))
            .collect::<Vec<_>>()
            .join("\n")
    };
    match partial.as_slice() {
        [model] => Ok(model),
        [] if downloaded.is_empty() => {
            Err("No model is downloaded. Open Whispering and download one first.".to_string())
        }
        [] => Err(format!(
            "No downloaded model is named {wanted:?}. Downloaded:\n{}",
            names(&downloaded)
        )),
        several => Err(format!(
            "{wanted:?} names more than one model:\n{}",
            names(&several.iter().map(|model| **model).collect::<Vec<_>>())
        )),
    }
}

/// Transcribe as `request` asks and print the result. Answers the exit code.
pub fn run(request: Request) -> i32 {
    match transcribe(&request) {
        Ok((text, model)) => {
            if request.json {
                println!("{}", serde_json::json!({ "text": text, "model": model }));
            } else {
                println!("{text}");
            }
            0
        }
        Err(message) => {
            eprintln!("{message}");
            1
        }
    }
}

/// The transcript of the request's file, and the id of the model that made it.
fn transcribe(request: &Request) -> Result<(String, String), String> {
    let models = list_models();
    let model = pick(&models, &request.model)?;
    let audio = std::fs::read(&request.file)
        .map_err(|error| format!("{} could not be read: {error}", request.file.display()))?;
    // No settings file: the model is dropped when this process ends.
    let cache = ModelCache::new(LocalTranscriptionSettings::load(PathBuf::new()));
    match cache.transcribe_bytes(model.id.clone(), &audio, TranscriptionHints::default()) {
        Ok(TranscriptionOutcome::Transcribed { text, model_id, .. }) => {
            Ok((text.trim().to_string(), model_id))
        }
        Ok(TranscriptionOutcome::EmptyAudio) => Ok((String::new(), model.id.clone())),
        Err(error) => Err(error.to_string()),
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

    #[test]
    fn without_a_file_to_transcribe_the_app_opens() {
        assert_eq!(parse(args("")), Ok(None));
        assert_eq!(parse(args("-psn_0_12345 --json")), Ok(None));
    }

    #[test]
    fn a_file_and_a_model_are_a_request_in_any_order() {
        let request = parse(args("--json --model parakeet --transcribe-file a.wav"))
            .unwrap()
            .unwrap();
        assert_eq!(
            request,
            Request {
                file: PathBuf::from("a.wav"),
                model: "parakeet".to_string(),
                json: true
            }
        );
    }

    #[test]
    fn a_file_with_no_model_is_refused() {
        assert!(parse(args("--transcribe-file a.wav")).is_err());
        assert!(parse(args("--transcribe-file")).is_err());
    }

    #[test]
    fn a_model_is_named_by_id_by_name_or_by_part_of_its_name() {
        let models = [
            model("a/parakeet.gguf", "Parakeet TDT 0.6B v3", true),
            model("b/whisper-small.gguf", "Whisper Small", true),
            model("c/whisper-large.gguf", "Whisper Large v3", false),
        ];
        assert_eq!(pick(&models, "a/parakeet.gguf").unwrap().id, "a/parakeet.gguf");
        assert_eq!(pick(&models, "whisper small").unwrap().id, "b/whisper-small.gguf");
        assert_eq!(pick(&models, "parakeet").unwrap().id, "a/parakeet.gguf");
        // Only one Whisper is downloaded, so the part names it.
        assert_eq!(pick(&models, "whisper").unwrap().id, "b/whisper-small.gguf");
        assert!(pick(&models, "large").is_err(), "not downloaded");
        assert!(pick(&models, "a").is_err(), "more than one");
    }
}
