//! Legacy reads from Epicenter's retired local blob layout.
//!
//! Native capture no longer publishes here. These reads remain temporarily so
//! the existing transcription and upload commands compile until their owning
//! record-addressed host route lands.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::audio::decode_to_pcm16k_mono;
use crate::recorder::error::RecorderError;

const BLOBS_DIRECTORY: &str = "blobs";
const DATA_FILE: &str = "data";

fn validate_blob_id(id: &str) -> Result<(), RecorderError> {
    let body = id
        .strip_prefix("blob_")
        .ok_or_else(|| RecorderError::failed("blob id must start with 'blob_'"))?;
    if body.len() != 21
        || !body
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
    {
        return Err(RecorderError::failed("blob id has an invalid shape"));
    }
    Ok(())
}

fn blobs_directory(app: &AppHandle) -> Result<PathBuf, RecorderError> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| RecorderError::failed(format!("resolve app data dir: {error}")))?;
    Ok(app_data.join(BLOBS_DIRECTORY))
}

fn blob_data_path(app: &AppHandle, id: &str) -> Result<PathBuf, RecorderError> {
    validate_blob_id(id)?;
    Ok(blobs_directory(app)?.join(id).join(DATA_FILE))
}

/// Decode one legacy local blob to the PCM shape local transcription uses.
pub fn read_blob_samples(app: &AppHandle, id: &str) -> Result<Vec<f32>, RecorderError> {
    let path = blob_data_path(app, id)?;
    let bytes = std::fs::read(&path)
        .map_err(|error| RecorderError::failed(format!("read blob {}: {error}", path.display())))?;
    decode_to_pcm16k_mono(&bytes)
        .map_err(|error| RecorderError::failed(format!("decode blob {}: {error}", path.display())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blob_id_validation_accepts_only_the_public_shape() {
        assert!(validate_blob_id("blob_abcdefghijklmnopqrstu").is_ok());
        assert!(validate_blob_id("abcdefghijklmnopqrstu").is_err());
        assert!(validate_blob_id("blob_ABCDEFGHIJKLMNOPQRSTU").is_err());
        assert!(validate_blob_id("blob_abcdefghijklmnopqrs/u").is_err());
    }
}
