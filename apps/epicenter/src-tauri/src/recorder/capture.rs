//! Durable native recording capture staging.
//!
//! Rust owns this directory and its opaque identifiers. A completed stop fsyncs
//! one WAV and its pending manifest, publishes both into the staging root, then
//! returns only the coordinate the Bun record owner needs for later admission.

use std::fs::{File, OpenOptions};
use std::io::{BufReader, BufWriter, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};

use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::recorder::error::RecorderError;

const CAPTURE_DIRECTORY: &str = "recording-captures";
const CAPTURE_PREFIX: &str = "capture_";
const CAPTURE_RANDOM_BYTES: usize = 16;
const CAPTURE_HEX_LENGTH: usize = CAPTURE_RANDOM_BYTES * 2;
const PENDING_MANIFEST: &str = "pending.json";
const PENDING_MANIFEST_TEMP: &str = "pending.tmp";
const MAX_MANIFEST_BYTES: u64 = 4_096;
/// One native recording stays below the record reader's 64 MiB ceiling.
pub(crate) const MAX_RECORDING_CAPTURE_BYTES: u64 = 64 * 1024 * 1024;
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

/// Exact durable coordinate reconstructed after a native-host restart.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PendingRecordingCapture {
    pub(crate) session_id: String,
    pub(crate) capture_id: String,
    pub(crate) byte_length: u32,
}

pub(crate) fn stage_pending_capture(
    app: &AppHandle,
    session_id: &str,
    samples: &[f32],
) -> Result<StagedRecordingCapture, RecorderError> {
    let root = capture_root(app)?;
    stage_pending_capture_in(&root, session_id, samples)
}

pub(crate) fn recover_pending_capture(
    app: &AppHandle,
) -> Result<Option<PendingRecordingCapture>, RecorderError> {
    recover_pending_capture_in(&capture_root(app)?)
}

pub(crate) fn acknowledge_pending_capture(
    app: &AppHandle,
    pending: &PendingRecordingCapture,
) -> Result<(), RecorderError> {
    acknowledge_pending_capture_in(&capture_root(app)?, pending)
}

fn capture_root(app: &AppHandle) -> Result<PathBuf, RecorderError> {
    let app_data = app.path().app_data_dir().map_err(|error| {
        error!("Resolve recording app data directory failed: {error}");
        RecorderError::failed("could not resolve recording storage")
    })?;
    Ok(app_data.join(CAPTURE_DIRECTORY))
}

fn ensure_capture_root(root: &Path) -> Result<(), RecorderError> {
    std::fs::create_dir_all(root)
        .map_err(|error| filesystem_error("create recording capture directory", root, error))?;
    let root_metadata = std::fs::symlink_metadata(root)
        .map_err(|error| filesystem_error("inspect recording capture directory", root, error))?;
    if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
        error!(
            "Recording capture root is not an owned directory: {}",
            root.display()
        );
        return Err(RecorderError::failed(
            "recording storage is not an owned directory",
        ));
    }
    let parent = root.parent().ok_or_else(|| {
        RecorderError::failed("recording capture directory must have an app-owned parent")
    })?;
    sync_directory(parent)?;
    Ok(())
}

fn stage_pending_capture_in(
    root: &Path,
    session_id: &str,
    samples: &[f32],
) -> Result<StagedRecordingCapture, RecorderError> {
    ensure_capture_root(root)?;
    validate_session_id(session_id)?;

    if let Some(pending) = recover_pending_capture_in(root)? {
        if pending.session_id != session_id {
            return Err(RecorderError::failed(
                "another recording capture is awaiting admission",
            ));
        }
        return Ok(pending.capture());
    }

    for _ in 0..4 {
        let capture_id = generate_capture_id()?;
        let final_path = capture_path(root, &capture_id)?;
        if final_path.exists() {
            continue;
        }

        return stage_pending_capture_at(root, capture_id, session_id, samples);
    }

    Err(RecorderError::failed(
        "could not allocate a unique recording capture id",
    ))
}

impl PendingRecordingCapture {
    fn new(session_id: &str, capture: &StagedRecordingCapture) -> Self {
        Self {
            session_id: session_id.to_string(),
            capture_id: capture.capture_id.clone(),
            byte_length: capture.byte_length,
        }
    }

    pub(crate) fn capture(&self) -> StagedRecordingCapture {
        StagedRecordingCapture {
            capture_id: self.capture_id.clone(),
            byte_length: self.byte_length,
        }
    }
}

fn stage_pending_capture_at(
    root: &Path,
    capture_id: String,
    session_id: &str,
    samples: &[f32],
) -> Result<StagedRecordingCapture, RecorderError> {
    let manifest_path = root.join(PENDING_MANIFEST);
    let temporary_manifest_path = root.join(PENDING_MANIFEST_TEMP);
    if manifest_path.exists() || temporary_manifest_path.exists() {
        return Err(RecorderError::failed(
            "another recording capture is awaiting admission",
        ));
    }
    let final_capture_path = capture_path(root, &capture_id)?;
    let temporary_capture_path = root.join(format!(".{capture_id}.tmp"));

    let result = (|| {
        let byte_length = write_pcm_as_wav(&temporary_capture_path, samples)?;
        let capture = StagedRecordingCapture {
            capture_id: capture_id.clone(),
            byte_length,
        };
        let pending = PendingRecordingCapture::new(session_id, &capture);
        write_pending_manifest(&temporary_manifest_path, &pending)?;
        // Make both temporary directory entries durable before publishing
        // either final name. Startup can finish the two renames after a crash.
        sync_directory(root)?;
        std::fs::rename(&temporary_capture_path, &final_capture_path).map_err(|error| {
            filesystem_error("finalize recording capture", &final_capture_path, error)
        })?;
        std::fs::rename(&temporary_manifest_path, &manifest_path).map_err(|error| {
            filesystem_error("publish recording capture manifest", &manifest_path, error)
        })?;
        sync_directory(root)?;
        Ok(capture)
    })();

    if result.is_err() {
        // Once the temporary manifest is durable, startup or a repeated stop
        // can finish the exact publication. Before that point, no durable
        // session coordinate exists and the partial WAV is safe to remove.
        if !temporary_manifest_path.exists() && !manifest_path.exists() {
            cleanup_unpublished_capture(root, &capture_id);
        }
    }
    result
}

fn write_pending_manifest(
    path: &Path,
    pending: &PendingRecordingCapture,
) -> Result<(), RecorderError> {
    let result = (|| {
        let file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(path)
            .map_err(|error| filesystem_error("open recording capture manifest", path, error))?;
        let mut writer = BufWriter::new(file);
        serde_json::to_writer(&mut writer, pending)
            .map_err(|error| filesystem_error("write recording capture manifest", path, error))?;
        writer
            .write_all(b"\n")
            .map_err(|error| filesystem_error("write recording capture manifest", path, error))?;
        let file = writer
            .into_inner()
            .map_err(|error| filesystem_error("flush recording capture manifest", path, error))?;
        file.sync_all()
            .map_err(|error| filesystem_error("sync recording capture manifest", path, error))?;
        Ok(())
    })();

    if result.is_err() {
        let _ = std::fs::remove_file(path);
    }
    result
}

fn recover_pending_capture_in(
    root: &Path,
) -> Result<Option<PendingRecordingCapture>, RecorderError> {
    ensure_capture_root(root)?;
    recover_interrupted_publication(root)?;
    let manifest_path = root.join(PENDING_MANIFEST);
    let pending = match std::fs::symlink_metadata(&manifest_path) {
        Ok(_) => {
            let pending = read_pending_manifest(&manifest_path)?;
            validate_pending_capture(root, &pending)?;
            info!(
                "Recovered pending recording capture: session_id={}, capture_id={}, byte_length={}",
                pending.session_id, pending.capture_id, pending.byte_length
            );
            Some(pending)
        }
        Err(error) if error.kind() == ErrorKind::NotFound => None,
        Err(error) => {
            return Err(filesystem_error(
                "inspect recording capture manifest",
                &manifest_path,
                error,
            ))
        }
    };
    sweep_unreferenced_temporary_captures(
        root,
        pending.as_ref().map(|pending| pending.capture_id.as_str()),
    )?;
    Ok(pending)
}

fn sweep_unreferenced_temporary_captures(
    root: &Path,
    referenced_capture_id: Option<&str>,
) -> Result<(), RecorderError> {
    let entries = std::fs::read_dir(root)
        .map_err(|error| filesystem_error("scan recording capture directory", root, error))?;
    let mut removed_any = false;
    for entry in entries {
        let entry = entry
            .map_err(|error| filesystem_error("read recording capture directory", root, error))?;
        let Some(file_name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Some(capture_id) = temporary_capture_id(&file_name) else {
            continue;
        };
        if referenced_capture_id == Some(capture_id) {
            continue;
        }
        let path = entry.path();
        if !is_owned_temporary_wav(&path) {
            warn!(
                "Refusing to remove unverified recording temporary: {}",
                path.display()
            );
            continue;
        }
        std::fs::remove_file(&path).map_err(|error| {
            filesystem_error("remove orphaned recording temporary", &path, error)
        })?;
        info!("Removed orphaned recording temporary: {}", path.display());
        removed_any = true;
    }
    if removed_any {
        sync_directory(root)?;
    }
    Ok(())
}

fn temporary_capture_id(file_name: &str) -> Option<&str> {
    let capture_id = file_name.strip_prefix('.')?.strip_suffix(".tmp")?;
    validate_capture_id(capture_id).ok()?;
    Some(capture_id)
}

fn is_owned_temporary_wav(path: &Path) -> bool {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() < 44
        || metadata.len() > MAX_RECORDING_CAPTURE_BYTES
    {
        return false;
    }
    let Ok(mut file) = File::open(path) else {
        return false;
    };
    let mut header = [0_u8; 44];
    if file.read_exact(&mut header).is_err() {
        return false;
    }
    let riff_size = u32::from_le_bytes(header[4..8].try_into().expect("fixed header slice"));
    let data_size = u32::from_le_bytes(header[40..44].try_into().expect("fixed header slice"));
    header[0..4] == *b"RIFF"
        && u64::from(riff_size) == metadata.len() - 8
        && header[8..16] == *b"WAVEfmt "
        && header[16..20] == 16_u32.to_le_bytes()
        && header[20..22] == 3_u16.to_le_bytes()
        && header[22..24] == WAV_CHANNELS.to_le_bytes()
        && header[24..28] == WAV_RATE.to_le_bytes()
        && header[28..32] == (WAV_RATE * 4).to_le_bytes()
        && header[32..34] == 4_u16.to_le_bytes()
        && header[34..36] == 32_u16.to_le_bytes()
        && header[36..40] == *b"data"
        && u64::from(data_size) == metadata.len() - 44
}

fn recover_interrupted_publication(root: &Path) -> Result<(), RecorderError> {
    let manifest_path = root.join(PENDING_MANIFEST);
    let temporary_manifest_path = root.join(PENDING_MANIFEST_TEMP);
    if manifest_path.exists() {
        let pending = read_pending_manifest(&manifest_path)?;
        let final_capture_path = capture_path(root, &pending.capture_id)?;
        let temporary_capture_path = root.join(format!(".{}.tmp", pending.capture_id));
        if !final_capture_path.exists() && temporary_capture_path.exists() {
            validate_capture_file(&temporary_capture_path, pending.byte_length)?;
            std::fs::rename(&temporary_capture_path, &final_capture_path).map_err(|error| {
                filesystem_error(
                    "recover recording capture after manifest publication",
                    &final_capture_path,
                    error,
                )
            })?;
            sync_directory(root)?;
        }
        return Ok(());
    }
    if !temporary_manifest_path.exists() {
        return Ok(());
    }

    let pending = read_pending_manifest(&temporary_manifest_path)?;
    validate_session_id(&pending.session_id)?;
    validate_capture_id(&pending.capture_id)?;
    if pending.byte_length < 44 {
        return Err(RecorderError::failed(
            "recording capture manifest has an invalid byte length",
        ));
    }

    let final_capture_path = capture_path(root, &pending.capture_id)?;
    let temporary_capture_path = root.join(format!(".{}.tmp", pending.capture_id));
    if final_capture_path.exists() {
        validate_capture_file(&final_capture_path, pending.byte_length)?;
    } else {
        validate_capture_file(&temporary_capture_path, pending.byte_length)?;
        std::fs::rename(&temporary_capture_path, &final_capture_path).map_err(|error| {
            filesystem_error("recover recording capture", &final_capture_path, error)
        })?;
    }
    std::fs::rename(&temporary_manifest_path, &manifest_path).map_err(|error| {
        filesystem_error("recover recording capture manifest", &manifest_path, error)
    })?;
    sync_directory(root)?;
    info!(
        "Finished interrupted recording capture publication: session_id={}, capture_id={}, byte_length={}",
        pending.session_id, pending.capture_id, pending.byte_length
    );
    Ok(())
}

fn read_pending_manifest(path: &Path) -> Result<PendingRecordingCapture, RecorderError> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| filesystem_error("inspect recording capture manifest", path, error))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        error!(
            "Recording capture manifest is not a regular file: {}",
            path.display()
        );
        return Err(RecorderError::failed(
            "recording capture manifest is not a regular file",
        ));
    }
    if metadata.len() > MAX_MANIFEST_BYTES {
        error!(
            "Recording capture manifest is too large: {} bytes at {}",
            metadata.len(),
            path.display()
        );
        return Err(RecorderError::failed(
            "recording capture manifest is too large",
        ));
    }
    let file = File::open(path)
        .map_err(|error| filesystem_error("open recording capture manifest", path, error))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    BufReader::new(file)
        .take(MAX_MANIFEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| filesystem_error("read recording capture manifest", path, error))?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        error!(
            "Recording capture manifest grew beyond the read limit: {}",
            path.display()
        );
        return Err(RecorderError::failed(
            "recording capture manifest is too large",
        ));
    }
    serde_json::from_slice(&bytes).map_err(|error| {
        error!(
            "Parse recording capture manifest {} failed: {error}",
            path.display()
        );
        RecorderError::failed("recording capture manifest is invalid")
    })
}

fn validate_capture_file(path: &Path, byte_length: u32) -> Result<(), RecorderError> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| filesystem_error("inspect pending recording capture", path, error))?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() != u64::from(byte_length)
    {
        error!(
            "Pending recording capture failed validation: path={}, expected_bytes={}, actual_bytes={}, is_file={}, is_symlink={}",
            path.display(),
            byte_length,
            metadata.len(),
            metadata.is_file(),
            metadata.file_type().is_symlink()
        );
        return Err(RecorderError::failed(
            "pending recording capture failed validation",
        ));
    }
    Ok(())
}

fn validate_pending_capture(
    root: &Path,
    pending: &PendingRecordingCapture,
) -> Result<(), RecorderError> {
    validate_session_id(&pending.session_id)?;
    validate_capture_id(&pending.capture_id)?;
    if pending.byte_length < 44 {
        return Err(RecorderError::failed(
            "recording capture manifest has an invalid byte length",
        ));
    }

    let path = capture_path(root, &pending.capture_id)?;
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            // Exact acknowledgement deletes the WAV before the manifest. A
            // crash between those removals must remain recoverable so the same
            // acknowledgement can finish idempotently after restart.
            warn!(
                "Pending recording capture bytes are already absent: session_id={}, capture_id={}",
                pending.session_id, pending.capture_id
            );
            return Ok(());
        }
        Err(error) => {
            return Err(filesystem_error(
                "inspect pending recording capture",
                &path,
                error,
            ))
        }
    };
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() != u64::from(pending.byte_length)
    {
        error!(
            "Pending recording capture failed validation: path={}, expected_bytes={}, actual_bytes={}, is_file={}, is_symlink={}",
            path.display(),
            pending.byte_length,
            metadata.len(),
            metadata.is_file(),
            metadata.file_type().is_symlink()
        );
        return Err(RecorderError::failed(
            "pending recording capture failed validation",
        ));
    }
    Ok(())
}

fn acknowledge_pending_capture_in(
    root: &Path,
    expected: &PendingRecordingCapture,
) -> Result<(), RecorderError> {
    let recovered = recover_pending_capture_in(root)?;
    match recovered {
        Some(actual) if actual == *expected => {}
        Some(_) => {
            return Err(RecorderError::failed(
                "recording capture acknowledgement did not match the durable capture",
            ))
        }
        None => {
            // remove_file may have succeeded before a directory fsync or IPC
            // response failed. The in-memory exact match remains authoritative
            // for this retry, so syncing the directory completes the boundary.
            sync_directory(root)?;
            return Ok(());
        }
    }

    let manifest_path = root.join(PENDING_MANIFEST);
    let capture_path = capture_path(root, &expected.capture_id)?;
    match std::fs::remove_file(&capture_path) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => {
            return Err(filesystem_error(
                "remove admitted recording capture",
                &capture_path,
                error,
            ))
        }
    }
    // The bytes become replayably absent before the manifest. A crash here
    // leaves the exact coordinate recoverable, and a repeated acknowledgement
    // completes only the remaining manifest removal.
    sync_directory(root)?;
    match std::fs::remove_file(&manifest_path) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => {
            return Err(filesystem_error(
                "remove recording capture manifest",
                &manifest_path,
                error,
            ))
        }
    }
    sync_directory(root)
}

fn cleanup_unpublished_capture(root: &Path, capture_id: &str) {
    let Ok(final_path) = capture_path(root, capture_id) else {
        return;
    };
    let temporary_path = root.join(format!(".{capture_id}.tmp"));
    for path in [temporary_path, final_path] {
        if let Err(error) = std::fs::remove_file(&path) {
            if error.kind() != ErrorKind::NotFound {
                error!(
                    "Clean up unpublished recording capture {} failed: {error}",
                    path.display()
                );
            }
        }
    }
    if let Err(error) = sync_directory(root) {
        error!("Sync failed recording capture cleanup failed: {error}");
    }
}

fn validate_session_id(session_id: &str) -> Result<(), RecorderError> {
    let valid = session_id.len() == 36
        && session_id.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            }
        });
    if !valid {
        return Err(RecorderError::failed(
            "recording session id has an invalid shape",
        ));
    }
    Ok(())
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
    if u64::from(byte_length) > MAX_RECORDING_CAPTURE_BYTES {
        return Err(RecorderError::failed(
            "recording exceeded the native capture size limit",
        ));
    }
    let riff_size = byte_length - 8;
    let file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|error| filesystem_error("open recording capture", path, error))?;
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
        .map_err(|error| filesystem_error("flush recording capture", path, error))?;
    file.sync_all()
        .map_err(|error| filesystem_error("sync recording capture", path, error))?;
    Ok(byte_length)
}

fn io_error(path: &Path) -> impl Fn(std::io::Error) -> RecorderError + '_ {
    move |error| filesystem_error("write recording capture", path, error)
}

fn filesystem_error(
    action: &'static str,
    path: &Path,
    error_value: impl std::fmt::Display,
) -> RecorderError {
    error!("{action} {} failed: {error_value}", path.display());
    RecorderError::failed(format!("{action} failed"))
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), RecorderError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| filesystem_error("sync recording capture directory", path, error))
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), RecorderError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALID_CAPTURE_ID: &str = "capture_0123456789abcdef0123456789abcdef";
    const OTHER_CAPTURE_ID: &str = "capture_fedcba9876543210fedcba9876543210";
    const VALID_SESSION_ID: &str = "01234567-89ab-4cde-8f01-23456789abcd";

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

        let capture = stage_pending_capture_at(
            &root,
            VALID_CAPTURE_ID.to_string(),
            VALID_SESSION_ID,
            &samples,
        )
        .unwrap();
        let path = capture_path(&root, &capture.capture_id).unwrap();
        let bytes = std::fs::read(&path).unwrap();

        assert_eq!(capture.capture_id, VALID_CAPTURE_ID);
        assert_eq!(capture.byte_length, 44 + samples.len() as u32 * 4);
        assert_eq!(bytes.len(), capture.byte_length as usize);
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");
        assert!(!root.join(format!(".{VALID_CAPTURE_ID}.tmp")).exists());
        assert!(!root.join(PENDING_MANIFEST_TEMP).exists());
    }

    #[test]
    fn generated_capture_ids_resolve_inside_the_staging_root() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join(CAPTURE_DIRECTORY);
        let capture = stage_pending_capture_in(&root, VALID_SESSION_ID, &[0.0]).unwrap();
        let path = capture_path(&root, &capture.capture_id).unwrap();

        assert_eq!(path.parent(), Some(root.as_path()));
        assert!(path.is_file());
        assert!(root.join(PENDING_MANIFEST).is_file());
    }

    #[test]
    fn pending_manifest_recovers_exact_coordinate_and_acknowledgement_removes_it() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join(CAPTURE_DIRECTORY);
        let capture = stage_pending_capture_in(&root, VALID_SESSION_ID, &[0.25]).unwrap();

        let pending = recover_pending_capture_in(&root).unwrap().unwrap();
        assert_eq!(pending.session_id, VALID_SESSION_ID);
        assert_eq!(pending.capture(), capture);

        acknowledge_pending_capture_in(&root, &pending).unwrap();
        assert_eq!(recover_pending_capture_in(&root).unwrap(), None);
        // An exact retry after remove/sync is harmless. The Recorder lifecycle
        // is what proves the tuple matched before this helper is called.
        acknowledge_pending_capture_in(&root, &pending).unwrap();
    }

    #[test]
    fn recovery_finishes_publication_interrupted_after_both_files_were_fsynced() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join(CAPTURE_DIRECTORY);
        ensure_capture_root(&root).unwrap();
        let temporary_capture_path = root.join(format!(".{VALID_CAPTURE_ID}.tmp"));
        let byte_length = write_pcm_as_wav(&temporary_capture_path, &[0.25]).unwrap();
        let pending = PendingRecordingCapture {
            session_id: VALID_SESSION_ID.to_string(),
            capture_id: VALID_CAPTURE_ID.to_string(),
            byte_length,
        };
        write_pending_manifest(&root.join(PENDING_MANIFEST_TEMP), &pending).unwrap();
        sync_directory(&root).unwrap();

        let recovered = recover_pending_capture_in(&root).unwrap().unwrap();

        assert_eq!(recovered, pending);
        assert!(capture_path(&root, VALID_CAPTURE_ID).unwrap().is_file());
        assert!(root.join(PENDING_MANIFEST).is_file());
        assert!(!root.join(PENDING_MANIFEST_TEMP).exists());
        assert!(!temporary_capture_path.exists());
    }

    #[test]
    fn recovery_finishes_capture_rename_when_manifest_rename_persisted_first() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join(CAPTURE_DIRECTORY);
        ensure_capture_root(&root).unwrap();
        let temporary_capture_path = root.join(format!(".{VALID_CAPTURE_ID}.tmp"));
        let byte_length = write_pcm_as_wav(&temporary_capture_path, &[0.25]).unwrap();
        let pending = PendingRecordingCapture {
            session_id: VALID_SESSION_ID.to_string(),
            capture_id: VALID_CAPTURE_ID.to_string(),
            byte_length,
        };
        write_pending_manifest(&root.join(PENDING_MANIFEST), &pending).unwrap();
        sync_directory(&root).unwrap();

        let recovered = recover_pending_capture_in(&root).unwrap().unwrap();

        assert_eq!(recovered, pending);
        assert!(capture_path(&root, VALID_CAPTURE_ID).unwrap().is_file());
        assert!(!temporary_capture_path.exists());
    }

    #[test]
    fn recovery_removes_only_valid_unreferenced_owned_temporaries() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join(CAPTURE_DIRECTORY);
        ensure_capture_root(&root).unwrap();
        let orphan = root.join(format!(".{VALID_CAPTURE_ID}.tmp"));
        write_pcm_as_wav(&orphan, &[0.25]).unwrap();
        let invalid_owned_name = root.join(format!(".{OTHER_CAPTURE_ID}.tmp"));
        std::fs::write(&invalid_owned_name, b"not a recorder wav").unwrap();
        let arbitrary = root.join("notes.tmp");
        std::fs::write(&arbitrary, b"keep").unwrap();
        let final_capture = capture_path(&root, OTHER_CAPTURE_ID).unwrap();
        std::fs::write(&final_capture, b"keep final names").unwrap();
        let exact_name_directory = root.join(".capture_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.tmp");
        std::fs::create_dir(&exact_name_directory).unwrap();
        #[cfg(unix)]
        let exact_name_symlink = {
            use std::os::unix::fs::symlink;
            let path = root.join(".capture_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.tmp");
            symlink(&arbitrary, &path).unwrap();
            path
        };

        assert_eq!(recover_pending_capture_in(&root).unwrap(), None);

        assert!(!orphan.exists());
        assert!(invalid_owned_name.exists());
        assert!(arbitrary.exists());
        assert!(final_capture.exists());
        assert!(exact_name_directory.is_dir());
        #[cfg(unix)]
        assert!(std::fs::symlink_metadata(exact_name_symlink)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn recovery_preserves_temporary_wav_referenced_by_manifest() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join(CAPTURE_DIRECTORY);
        ensure_capture_root(&root).unwrap();
        stage_pending_capture_at(
            &root,
            VALID_CAPTURE_ID.to_string(),
            VALID_SESSION_ID,
            &[0.25],
        )
        .unwrap();
        let referenced_temporary = root.join(format!(".{VALID_CAPTURE_ID}.tmp"));
        write_pcm_as_wav(&referenced_temporary, &[0.25]).unwrap();

        let pending = recover_pending_capture_in(&root).unwrap().unwrap();

        assert_eq!(pending.capture_id, VALID_CAPTURE_ID);
        assert!(referenced_temporary.exists());
        assert!(capture_path(&root, VALID_CAPTURE_ID).unwrap().exists());
    }

    #[test]
    fn mismatched_acknowledgement_keeps_durable_manifest() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join(CAPTURE_DIRECTORY);
        stage_pending_capture_in(&root, VALID_SESSION_ID, &[0.25]).unwrap();
        let mut wrong = recover_pending_capture_in(&root).unwrap().unwrap();
        wrong.session_id = "ffffffff-ffff-4fff-8fff-ffffffffffff".to_string();

        let error = acknowledge_pending_capture_in(&root, &wrong).unwrap_err();

        assert_eq!(
            error.to_string(),
            "recording capture acknowledgement did not match the durable capture"
        );
        assert!(recover_pending_capture_in(&root).unwrap().is_some());
    }

    #[test]
    fn recovery_preserves_coordinate_after_record_owner_consumes_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join(CAPTURE_DIRECTORY);
        let capture = stage_pending_capture_in(&root, VALID_SESSION_ID, &[0.25]).unwrap();
        std::fs::remove_file(capture_path(&root, &capture.capture_id).unwrap()).unwrap();
        sync_directory(&root).unwrap();

        let pending = recover_pending_capture_in(&root).unwrap().unwrap();
        assert_eq!(pending.capture(), capture);
    }

    #[test]
    fn recovery_rejects_tampered_capture_without_exposing_native_path() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join(CAPTURE_DIRECTORY);
        let capture = stage_pending_capture_in(&root, VALID_SESSION_ID, &[0.25]).unwrap();
        std::fs::write(capture_path(&root, &capture.capture_id).unwrap(), b"short").unwrap();

        let error = recover_pending_capture_in(&root).unwrap_err();
        assert_eq!(
            error.to_string(),
            "pending recording capture failed validation"
        );
        assert!(!error.to_string().contains(&root.display().to_string()));
    }

    #[test]
    fn filesystem_errors_do_not_expose_native_paths() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join(CAPTURE_DIRECTORY);
        std::fs::create_dir(&root).unwrap();
        let temporary_path = root.join(format!(".{VALID_CAPTURE_ID}.tmp"));
        std::fs::create_dir(&temporary_path).unwrap();

        let error = stage_pending_capture_at(
            &root,
            VALID_CAPTURE_ID.to_string(),
            VALID_SESSION_ID,
            &[0.0],
        )
        .unwrap_err();
        assert!(!error.to_string().contains(&root.display().to_string()));
        assert_eq!(error.to_string(), "open recording capture failed");
    }
}
