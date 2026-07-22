//! Durable native recording capture staging.
//!
//! Rust owns this directory and its opaque identifiers. A completed stop writes
//! and fsyncs one WAV, atomically renames it into the staging root, then returns
//! only the coordinate the Bun record owner needs for later admission.

use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::recorder::error::RecorderError;

const CAPTURE_DIRECTORY: &str = "recording-captures";
const CAPTURE_PREFIX: &str = "capture_";
const CAPTURE_RANDOM_BYTES: usize = 16;
const CAPTURE_HEX_LENGTH: usize = CAPTURE_RANDOM_BYTES * 2;
const WAV_EXTENSION: &str = "wav";
const WAV_RATE: u32 = 16_000;
const WAV_CHANNELS: u16 = 1;

/// Opaque coordinate for a durable WAV awaiting record-owner admission.
#[derive(Clone, Debug, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StagedRecordingCapture {
    pub capture_id: String,
    pub byte_length: u32,
}

pub fn stage_capture(
    app: &AppHandle,
    samples: &[f32],
) -> Result<StagedRecordingCapture, RecorderError> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| RecorderError::failed(format!("resolve app data dir: {error}")))?;
    stage_capture_in(&app_data.join(CAPTURE_DIRECTORY), samples)
}

fn stage_capture_in(root: &Path, samples: &[f32]) -> Result<StagedRecordingCapture, RecorderError> {
    std::fs::create_dir_all(root).map_err(|error| {
        RecorderError::failed(format!(
            "create recording capture directory {}: {error}",
            root.display()
        ))
    })?;
    let parent = root.parent().ok_or_else(|| {
        RecorderError::failed("recording capture directory must have an app-owned parent")
    })?;
    sync_directory(parent)?;

    for _ in 0..4 {
        let capture_id = generate_capture_id()?;
        let final_path = capture_path(root, &capture_id)?;
        if final_path.exists() {
            continue;
        }

        return stage_capture_at(root, capture_id, samples);
    }

    Err(RecorderError::failed(
        "could not allocate a unique recording capture id",
    ))
}

fn stage_capture_at(
    root: &Path,
    capture_id: String,
    samples: &[f32],
) -> Result<StagedRecordingCapture, RecorderError> {
    let final_path = capture_path(root, &capture_id)?;
    let temporary_path = root.join(format!(".{capture_id}.tmp"));

    let result = (|| {
        let byte_length = write_pcm_as_wav(&temporary_path, samples)?;
        std::fs::rename(&temporary_path, &final_path).map_err(|error| {
            RecorderError::failed(format!(
                "finalize recording capture {}: {error}",
                final_path.display()
            ))
        })?;
        sync_directory(root)?;
        Ok(StagedRecordingCapture {
            capture_id,
            byte_length,
        })
    })();

    if result.is_err() {
        let _ = std::fs::remove_file(&temporary_path);
        let _ = std::fs::remove_file(&final_path);
        let _ = sync_directory(root);
    }

    result
}

/// Resolve an app-owned capture coordinate without allowing path traversal.
pub(crate) fn capture_path(root: &Path, capture_id: &str) -> Result<PathBuf, RecorderError> {
    validate_capture_id(capture_id)?;
    Ok(root.join(capture_id).with_extension(WAV_EXTENSION))
}

fn validate_capture_id(capture_id: &str) -> Result<(), RecorderError> {
    let body = capture_id
        .strip_prefix(CAPTURE_PREFIX)
        .ok_or_else(|| RecorderError::failed("capture id has an invalid shape"))?;
    if body.len() != CAPTURE_HEX_LENGTH
        || !body
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(RecorderError::failed("capture id has an invalid shape"));
    }
    Ok(())
}

fn generate_capture_id() -> Result<String, RecorderError> {
    let mut bytes = [0_u8; CAPTURE_RANDOM_BYTES];
    getrandom::fill(&mut bytes).map_err(|error| {
        RecorderError::failed(format!("generate recording capture id: {error}"))
    })?;

    let mut id = String::with_capacity(CAPTURE_PREFIX.len() + CAPTURE_HEX_LENGTH);
    id.push_str(CAPTURE_PREFIX);
    for byte in bytes {
        use std::fmt::Write as _;
        write!(id, "{byte:02x}").expect("writing to a String is infallible");
    }
    validate_capture_id(&id)?;
    Ok(id)
}

fn write_pcm_as_wav(path: &Path, samples: &[f32]) -> Result<u32, RecorderError> {
    let bits_per_sample: u16 = 32;
    let bytes_per_sample: u32 = (bits_per_sample / 8) as u32;
    let sample_count = u32::try_from(samples.len())
        .map_err(|_| RecorderError::failed("wav sample count overflow"))?;
    let data_size = sample_count
        .checked_mul(bytes_per_sample)
        .ok_or_else(|| RecorderError::failed("wav data size overflow"))?;
    let byte_length = 44u32
        .checked_add(data_size)
        .ok_or_else(|| RecorderError::failed("wav file size overflow"))?;
    let riff_size = byte_length - 8;
    let file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|error| {
            RecorderError::failed(format!(
                "open recording capture {}: {error}",
                path.display()
            ))
        })?;
    let mut writer = BufWriter::new(file);
    writer.write_all(b"RIFF").map_err(io_error(path))?;
    writer
        .write_all(&riff_size.to_le_bytes())
        .map_err(io_error(path))?;
    writer.write_all(b"WAVEfmt ").map_err(io_error(path))?;
    writer
        .write_all(&16u32.to_le_bytes())
        .map_err(io_error(path))?;
    writer
        .write_all(&3u16.to_le_bytes())
        .map_err(io_error(path))?;
    writer
        .write_all(&WAV_CHANNELS.to_le_bytes())
        .map_err(io_error(path))?;
    writer
        .write_all(&WAV_RATE.to_le_bytes())
        .map_err(io_error(path))?;
    let byte_rate = WAV_RATE * WAV_CHANNELS as u32 * bytes_per_sample;
    writer
        .write_all(&byte_rate.to_le_bytes())
        .map_err(io_error(path))?;
    let block_align = WAV_CHANNELS * bytes_per_sample as u16;
    writer
        .write_all(&block_align.to_le_bytes())
        .map_err(io_error(path))?;
    writer
        .write_all(&bits_per_sample.to_le_bytes())
        .map_err(io_error(path))?;
    writer.write_all(b"data").map_err(io_error(path))?;
    writer
        .write_all(&data_size.to_le_bytes())
        .map_err(io_error(path))?;
    for sample in samples {
        writer
            .write_all(&sample.to_le_bytes())
            .map_err(io_error(path))?;
    }
    let file = writer
        .into_inner()
        .map_err(|error| RecorderError::failed(format!("flush wav {}: {error}", path.display())))?;
    file.sync_all()
        .map_err(|error| RecorderError::failed(format!("sync wav {}: {error}", path.display())))?;
    Ok(byte_length)
}

fn io_error(path: &Path) -> impl Fn(std::io::Error) -> RecorderError + '_ {
    move |error| RecorderError::failed(format!("write wav {}: {error}", path.display()))
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), RecorderError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| {
            RecorderError::failed(format!(
                "sync recording capture directory {}: {error}",
                path.display()
            ))
        })
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), RecorderError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALID_CAPTURE_ID: &str = "capture_0123456789abcdef0123456789abcdef";

    #[test]
    fn capture_id_validation_rejects_non_opaque_paths() {
        assert!(validate_capture_id(VALID_CAPTURE_ID).is_ok());
        assert!(validate_capture_id("0123456789abcdef0123456789abcdef").is_err());
        assert!(validate_capture_id("capture_0123456789ABCDEF0123456789ABCDEF").is_err());
        assert!(validate_capture_id("capture_0123456789abcdef/123456789abcdef").is_err());
        assert!(validate_capture_id("capture_../0123456789abcdef0123456789").is_err());
    }

    #[test]
    fn staged_capture_is_complete_and_has_no_temporary_artifact() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join(CAPTURE_DIRECTORY);
        std::fs::create_dir(&root).unwrap();
        let samples = [0.25, -0.5, 1.0];

        let capture = stage_capture_at(&root, VALID_CAPTURE_ID.to_string(), &samples).unwrap();
        let path = capture_path(&root, &capture.capture_id).unwrap();
        let bytes = std::fs::read(&path).unwrap();

        assert_eq!(capture.capture_id, VALID_CAPTURE_ID);
        assert_eq!(capture.byte_length, 44 + samples.len() as u32 * 4);
        assert_eq!(bytes.len(), capture.byte_length as usize);
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");
        assert!(!root.join(format!(".{VALID_CAPTURE_ID}.tmp")).exists());
    }

    #[test]
    fn generated_capture_ids_resolve_inside_the_staging_root() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join(CAPTURE_DIRECTORY);
        let capture = stage_capture_in(&root, &[0.0]).unwrap();
        let path = capture_path(&root, &capture.capture_id).unwrap();

        assert_eq!(path.parent(), Some(root.as_path()));
        assert!(path.is_file());
    }
}
