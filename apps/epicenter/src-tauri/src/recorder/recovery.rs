//! Durable capture ownership survives both the microphone and the host process.
use super::{
    error::RecorderError,
    recorder::{HostRecording, Result},
};
use crate::blobs::{blobs_directory, BlobDestination, StagedBlob};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordingAttachment {
    pub table_name: String,
    pub row_id: String,
    pub generation: Option<u32>,
}

impl RecordingAttachment {
    pub fn key(&self) -> Result<String> {
        if self.table_name.is_empty()
            || self.table_name.len() > 100
            || !self
                .table_name
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
            || self.row_id.len() != 24
            || !self
                .row_id
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        {
            return Err(RecorderError::failed(
                "invalid recording attachment address",
            ));
        }
        Ok(format!("attachment.{}.{}", self.table_name, self.row_id))
    }
}

#[derive(Serialize, Deserialize)]
pub struct SavedRecording {
    pub recording: HostRecording,
    staging: String,
}

fn failed(error: impl std::fmt::Display) -> RecorderError {
    RecorderError::failed(format!("recording recovery: {error}"))
}

pub fn root(app: &AppHandle, destination: &BlobDestination) -> Result<PathBuf> {
    blobs_directory(
        &app.state::<crate::app_data::DesktopPaths>().data_dir,
        destination,
    )
    .map_err(failed)
}

fn descriptor(root: &Path, id: &str) -> Result<PathBuf> {
    if id.len() != 26
        || !id.starts_with("blob_")
        || !id[5..]
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
    {
        return Err(failed("invalid capture session id"));
    }
    Ok(root.join(".recordings").join(format!("{id}.json")))
}

pub fn save(root: &Path, recording: &HostRecording, staged: &StagedBlob) -> Result<()> {
    let path = descriptor(root, &recording.audio_blob_id)?;
    fs::create_dir_all(path.parent().unwrap()).map_err(failed)?;
    let value = SavedRecording {
        recording: recording.clone(),
        staging: staged
            .directory()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned(),
    };
    let marker = staged.directory().join(".recording-session");
    fs::write(&marker, &recording.audio_blob_id).map_err(failed)?;
    fs::File::open(&marker)
        .and_then(|file| file.sync_all())
        .map_err(failed)?;
    sync_dir(staged.directory())?;
    sync_dir(staged.directory().parent().unwrap())?;
    let temporary = path.with_extension("pending");
    let file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(failed)?;
    serde_json::to_writer(&file, &value).map_err(failed)?;
    file.sync_all().map_err(failed)?;
    fs::rename(temporary, &path).map_err(failed)?;
    sync_dir(path.parent().unwrap())?;
    sync_dir(root)?;
    Ok(())
}

fn sync_dir(path: &Path) -> Result<()> {
    #[cfg(unix)]
    fs::File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(failed)?;
    Ok(())
}

pub fn read(root: &Path, id: &str, destination: &BlobDestination) -> Result<SavedRecording> {
    let value: SavedRecording =
        serde_json::from_slice(&fs::read(descriptor(root, id)?).map_err(failed)?)
            .map_err(failed)?;
    if value.recording.audio_blob_id != id || &value.recording.destination != destination {
        return Err(failed(
            "capture destination does not match its saved descriptor",
        ));
    }
    value.recording.attachment.key()?;
    if value.staging.is_empty()
        || value.staging.contains(['/', '\\'])
        || value.staging == "."
        || value.staging == ".."
    {
        return Err(failed("invalid staging name"));
    }
    Ok(value)
}

pub fn current(root: &Path, destination: &BlobDestination) -> Result<Option<HostRecording>> {
    let entries = match fs::read_dir(root.join(".recordings")) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(failed(error)),
    };
    let mut found = None;
    for entry in entries {
        let entry = entry.map_err(failed)?;
        let name = entry.file_name();
        let Some(id) = name.to_str().and_then(|name| name.strip_suffix(".json")) else {
            continue;
        };
        let mut value = read(root, id, destination)?.recording;
        value.ended_reason = Some(super::ended::EndedReason::StreamFailed);
        if found.is_some() {
            return Err(failed(
                "multiple unresolved captures require explicit resolution",
            ));
        }
        found = Some(value);
    }
    Ok(found)
}

pub fn publish(root: &Path, saved: &SavedRecording) -> Result<(u32, u32)> {
    let key = saved.recording.attachment.key()?;
    let final_path = root.join(&key).join("data");
    let staging = root.join(".staging/rust").join(&saved.staging);
    let published = root.join(&key);
    if published.exists()
        && fs::read_to_string(published.join(".recording-session")).map_err(failed)?
            != saved.recording.audio_blob_id
    {
        return Err(failed("attachment was published by another operation"));
    }
    let data = if final_path.exists() {
        final_path
    } else {
        staging.join("data")
    };
    let reader = hound::WavReader::open(&data).map_err(failed)?;
    let duration = ((reader.duration() as u64 * 1000) / reader.spec().sample_rate as u64) as u32;
    let length = u32::try_from(fs::metadata(&data).map_err(failed)?.len()).map_err(failed)?;
    drop(reader);
    if staging.exists() {
        StagedBlob::recover(root.into(), &key, staging)
            .map_err(failed)?
            .publish("audio/wav")
            .map_err(failed)?;
    } else {
        // Retried completion must verify publication metadata as well as bytes.
        fs::File::open(root.join(&key).join("metadata.json")).map_err(failed)?;
    }
    Ok((duration, length))
}

pub fn acknowledge(root: &Path, id: &str) -> Result<()> {
    match fs::remove_file(descriptor(root, id)?) {
        Ok(()) => sync_dir(&root.join(".recordings")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(failed(error)),
    }
}

pub fn acknowledge_published(root: &Path, id: &str, destination: &BlobDestination) -> Result<()> {
    if !descriptor(root, id)?.try_exists().map_err(failed)? {
        return Ok(());
    }
    let saved = read(root, id, destination)?;
    let published = root.join(saved.recording.attachment.key()?);
    if fs::read_to_string(published.join(".recording-session")).map_err(failed)? != id {
        return Err(failed("cannot acknowledge another operation's attachment"));
    }
    // Acknowledgment must never turn unfinished staging into published audio.
    fs::File::open(published.join("data")).map_err(failed)?;
    fs::File::open(published.join("metadata.json")).map_err(failed)?;
    acknowledge(root, id)
}

/// Cancellation and retirement discard staging and journal ownership only.
/// Published bytes may already belong to a durably completed or restored row,
/// even when its completion acknowledgment never reached this host.
pub fn discard(root: &Path, id: &str, destination: &BlobDestination) -> Result<()> {
    if !descriptor(root, id)?.try_exists().map_err(failed)? {
        return Ok(());
    }
    let saved = read(root, id, destination)?;
    let staging = root.join(".staging/rust").join(&saved.staging);
    match fs::remove_dir_all(staging) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(failed(error)),
    }
    acknowledge(root, id)
}
