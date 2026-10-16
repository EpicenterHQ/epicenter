//! The local GGUF model catalog: the one Rust-owned source of truth for which
//! local models exist, their Hugging Face coordinate, their static capabilities,
//! and their download/cache status.
//!
//! A model is identified by a stable `modelId` string such as
//! `"handy-computer/whisper-small-gguf@main/whisper-small-Q4_K_M.gguf"`. That id
//! is an opaque catalog key, frozen once shipped: the stored active choice and
//! every transcript name it. It is not a coordinate; the `@main` in shipped ids
//! predates pinning and no longer says what is downloaded. Epicenter Home names it when it administers models, and the host
//! stores the active dictation choice. Explicit file inference lists cached IDs
//! and passes the selected ID to `transcribe_audio_bytes`; `prewarm_model` and
//! `ModelCache::transcribe` resolve the active choice. An unknown ID is refused
//! rather than parsed. (Custom drop-in GGUF is a later earned feature, not a
//! compatibility path.)
//!
//! Storage is the shared Hugging Face cache (`~/.cache/huggingface/hub`,
//! overridable by `HF_HOME`), owned by `hf-hub`: downloads stage and resume
//! through it, and a file already in the cache (from this app or any other HF
//! tool) is reused. Epicenter downloads into that cache and never deletes from
//! it: other tools share the cache, so removing files is the user's call, made
//! with Hugging Face's own tools. Rust never stores a path; it resolves the
//! coordinate to a cache path at point of use, so a file removed outside
//! Epicenter reads as not downloaded on the next look.
//!
//! Each model is pinned to a commit and to its file's content hash. Downloads
//! fetch that commit, and presence is decided by the bytes, so another HF tool
//! moving `refs/main`, or fetching the same file at a different commit, never
//! makes a model read as missing.

use super::error::error_chain_message;
use crate::download::{DownloadManager, DownloadProgress};
use hf_hub::api::tokio::{ApiBuilder, Progress};
use hf_hub::{Cache, Repo, RepoType};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::State;
use thiserror::Error;

/// A Hugging Face coordinate: where a model's file is downloaded from and how
/// its presence in the cache is resolved.
struct ModelCoord {
    repo_id: &'static str,
    /// The commit downloads fetch. Pinned so a moving branch cannot change the
    /// bytes Epicenter runs.
    commit: &'static str,
    filename: &'static str,
    /// The file's Git LFS SHA-256, which `hf-hub` uses as the blob name in the
    /// cache. The same bytes fetched at any commit satisfy the model.
    sha256: &'static str,
}

/// One curated catalog entry. Capabilities are static per model (a UI hint for
/// whether to show the prompt/language fields); the runtime independently guards
/// prompt support via `session.model().supports(Feature::InitialPrompt)` at use,
/// so a slightly-off flag can only hide a field, never misfeed the model.
struct CatalogEntry {
    /// The stored model id. Frozen once shipped (see the module docs).
    id: &'static str,
    coord: ModelCoord,
    name: &'static str,
    description: &'static str,
    /// Approximate download size, for the picker's "Download (172 MB)" affordance.
    size_bytes: u64,
    /// Whisper accepts an `initial_prompt`; the Parakeet TDT family does not.
    supports_prompt: bool,
    /// Whether the picker should offer a spoken-language selection for this model.
    supports_language: bool,
    /// The single model the picker builds its first-run default around.
    recommended: bool,
}

/// The curated GGUF catalog. Hand-seeded from the `handy-computer` Hugging Face
/// org (quantizations tested against transcribe.cpp). A build-time generator
/// from the org is deferred until this list is large enough to need it.
///
/// Filenames, sizes, commits, and hashes are the real repo contents (verified
/// against HF on 2026-10-16; each commit was `main` then). The `whisper-small`
/// entry keeps the exact anchor the spike and preview CI proved.
static CATALOG: &[CatalogEntry] = &[
    CatalogEntry {
        id: "handy-computer/whisper-tiny-gguf@main/whisper-tiny-Q8_0.gguf",
        coord: ModelCoord {
            repo_id: "handy-computer/whisper-tiny-gguf",
            commit: "1bd61cda36bbd22c88fc5a33842498a6e1d30f45",
            filename: "whisper-tiny-Q8_0.gguf",
            sha256: "325b9c7997cd1eff81ef709d55766565e71be696130cc3a3d444713798706834",
        },
        name: "Whisper Tiny",
        description: "Fastest, multilingual, basic accuracy",
        size_bytes: 46_000_000,
        supports_prompt: true,
        supports_language: true,
        recommended: false,
    },
    CatalogEntry {
        id: "handy-computer/whisper-small-gguf@main/whisper-small-Q4_K_M.gguf",
        coord: ModelCoord {
            repo_id: "handy-computer/whisper-small-gguf",
            commit: "4afdc7942ecf1997f359deae48a63506b062eac4",
            filename: "whisper-small-Q4_K_M.gguf",
            sha256: "b204d2005a3e5d4fe6153bd61e5e8b32e757ff7b017ac8f61c6f051c2f80e939",
        },
        name: "Whisper Small",
        description: "Fast, multilingual, good accuracy",
        size_bytes: 172_000_000,
        supports_prompt: true,
        supports_language: true,
        recommended: true,
    },
    CatalogEntry {
        id: "handy-computer/parakeet-tdt-0.6b-v3-gguf@main/parakeet-tdt-0.6b-v3-Q4_K_M.gguf",
        coord: ModelCoord {
            repo_id: "handy-computer/parakeet-tdt-0.6b-v3-gguf",
            commit: "d8d8c32cb2017c57e5307767343e97870f8a7f53",
            filename: "parakeet-tdt-0.6b-v3-Q4_K_M.gguf",
            sha256: "b68557be1e3c40207fd7c4bd9d63f1d3316b963f15325bfb0cc16a8bb0ffd181",
        },
        name: "Parakeet TDT 0.6B v3",
        description: "Fast multilingual model with automatic language detection",
        size_bytes: 485_000_000,
        supports_prompt: false,
        supports_language: false,
        recommended: false,
    },
];

impl CatalogEntry {
    fn id(&self) -> String {
        self.id.to_string()
    }

    /// The `hf-hub` repo handle for this entry (a model repo at its pinned commit).
    fn repo(&self) -> Repo {
        Repo::with_revision(
            self.coord.repo_id.to_string(),
            RepoType::Model,
            self.coord.commit.to_string(),
        )
    }

    /// The cache path if this model's file is already present in the shared HF
    /// cache; `None` when it still needs downloading.
    ///
    /// The file at the pinned commit counts, and so does the same file at any
    /// other commit whose bytes are this model's blob. `hf-hub`'s own lookup goes
    /// through `refs/<revision>`, which another tool can move or never write, so
    /// presence is resolved from the snapshots and the blob directly.
    fn cached_path(&self) -> Option<PathBuf> {
        self.cached_path_in(Cache::from_env())
    }

    fn cached_path_in(&self, cache: Cache) -> Option<PathBuf> {
        let cache = cache.repo(self.repo());
        let pinned = cache
            .pointer_path(self.coord.commit)
            .join(self.coord.filename);
        if pinned.is_file() {
            return Some(pinned);
        }
        let blob = std::fs::canonicalize(cache.blob_path(self.coord.sha256)).ok()?;
        let snapshots = cache
            .pointer_path(self.coord.commit)
            .parent()?
            .to_path_buf();
        std::fs::read_dir(snapshots)
            .ok()?
            .flatten()
            .map(|snapshot| snapshot.path().join(self.coord.filename))
            .find(|pointer| std::fs::canonicalize(pointer).ok().as_ref() == Some(&blob))
    }
}

/// Find the catalog entry for a model id, if any.
fn find(model_id: &str) -> Option<&'static CatalogEntry> {
    CATALOG.iter().find(|entry| entry.id() == model_id)
}

/// Resolve a model id to its catalog entry, or the `UnknownModel` error the
/// `download_model`/`reveal_model` commands both return for an id not in the
/// catalog. One place owns that message so the two commands cannot drift.
fn find_or_unknown(model_id: &str) -> Result<&'static CatalogEntry, CatalogError> {
    find(model_id).ok_or_else(|| CatalogError::UnknownModel {
        message: format!("Unknown local model \"{model_id}\"."),
    })
}

/// The on-disk GGUF path for a model that is both in this build's catalog and
/// present on this machine; `None` otherwise.
///
/// The one place `ModelCache::transcribe`/`prewarm_model` turn the active model
/// into a path. Deliberately a plain `Option`: an id outside the catalog and a
/// model that is not downloaded are the same public answer ("the active model
/// cannot run"), and the caller composes the user-facing message so that message
/// never has to name a model. Resolution happens at the point of use, so a file
/// that appears on disk after a failed load works on the very next call, and one
/// deleted behind Epicenter's back is noticed on the very next call too.
pub fn installed_model_path(model_id: &str) -> Option<PathBuf> {
    find(model_id).and_then(CatalogEntry::cached_path)
}

/// The one active local model as **Home** sees it: its exact identity and
/// whether its file is on this machine right now.
///
/// Administration data, not application data (ADR-0180). Home chooses the active
/// model, so Home is told which one it is; an ordinary application never learns
/// model identity and reads `get_local_transcription_readiness` instead. Nothing
/// here reports residency: `installed` is disk presence, and how many models are
/// resident or warm stays host-private.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ActiveModel {
    pub id: String,
    /// The curated display name, so a caller can name the model in an error
    /// without holding a catalog of its own.
    pub name: String,
    /// Whether the model's file is present on this machine. Disk presence, the
    /// same verdict `list_models` renders; never a statement about memory.
    pub installed: bool,
    /// Whether this model accepts an initial prompt, so a caller knows whether
    /// to offer the field at all. The runtime still guards the real decision at
    /// use and reports what it applied, so a stale hint can only hide a field,
    /// never misfeed the model.
    pub supports_prompt: bool,
    /// Whether this model takes a spoken-language hint.
    pub supports_language: bool,
}

/// Describe a stored model id against the catalog, or `None` when the id names
/// no model this build ships. Both the settings store (to refuse an unknown
/// choice) and `get_active_model` (to report identity and presence) read
/// through here, so there is one answer to "is this a real model".
pub fn describe(model_id: &str) -> Option<ActiveModel> {
    find(model_id).map(|entry| ActiveModel {
        id: entry.id(),
        name: entry.name.to_string(),
        installed: entry.cached_path().is_some(),
        supports_prompt: entry.supports_prompt,
        supports_language: entry.supports_language,
    })
}

/// Every catalog id. Exists for tests that need a real, resolvable identity
/// without hard-coding one that the catalog could later drop.
#[cfg(test)]
pub fn model_ids() -> Vec<String> {
    CATALOG.iter().map(|entry| entry.id()).collect()
}

/// Every catalog display name, so a test can assert that a message an
/// application receives names none of them.
#[cfg(test)]
pub fn model_names() -> Vec<&'static str> {
    CATALOG.iter().map(|entry| entry.name).collect()
}

/// A catalog model as Home's administration view sees it: identity, display
/// fields, static capabilities, and whether it is already downloaded. Home names
/// `id` when it activates, downloads, or reveals a model; it never learns the
/// Hugging Face coordinate. Applications see none of this.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    /// Approximate download size in bytes. `f64` because specta forbids 64-bit
    /// ints in TS; model sizes are far below `f64`'s exact-integer ceiling.
    #[specta(type = f64)]
    pub size_bytes: u64,
    pub supports_prompt: bool,
    pub supports_language: bool,
    pub recommended: bool,
    pub downloaded: bool,
}

#[derive(Error, Debug, Serialize, Deserialize, specta::Type)]
#[serde(tag = "name")]
pub enum CatalogError {
    #[error("Unknown model: {message}")]
    UnknownModel { message: String },

    #[error("Download failed: {message}")]
    DownloadFailed { message: String },

    #[error("Could not show the model file: {message}")]
    RevealFailed { message: String },
}

/// The full local GGUF catalog with per-model download status. The picker's one
/// data source: which models exist, what they can do, and which are on disk.
#[tauri::command]
#[specta::specta]
pub fn list_models() -> Vec<ModelInfo> {
    CATALOG
        .iter()
        .map(|entry| ModelInfo {
            id: entry.id(),
            name: entry.name.to_string(),
            description: entry.description.to_string(),
            size_bytes: entry.size_bytes,
            supports_prompt: entry.supports_prompt,
            supports_language: entry.supports_language,
            recommended: entry.recommended,
            downloaded: entry.cached_path().is_some(),
        })
        .collect()
}

/// Forwards `hf-hub` download progress onto a Tauri channel as a cumulative
/// `DownloadProgress`. Cloned across `hf-hub`'s internal chunk tasks, so the
/// running byte count lives in a shared `Arc<AtomicU64>` and `total` is fixed
/// from `init`.
#[derive(Clone)]
struct ChannelProgress {
    channel: Channel<DownloadProgress>,
    received: Arc<AtomicU64>,
    total: Arc<AtomicU64>,
}

impl ChannelProgress {
    fn emit(&self) {
        let received = self.received.load(Ordering::Relaxed);
        let total = self.total.load(Ordering::Relaxed);
        let _ = self
            .channel
            .send(DownloadProgress::new(received as f64, total as f64));
    }
}

impl Progress for ChannelProgress {
    async fn init(&mut self, size: usize, _filename: &str) {
        self.total.store(size as u64, Ordering::Relaxed);
        self.received.store(0, Ordering::Relaxed);
        self.emit();
    }

    async fn update(&mut self, size: usize) {
        self.received.fetch_add(size as u64, Ordering::Relaxed);
        self.emit();
    }

    async fn finish(&mut self) {
        self.emit();
    }
}

/// Download a catalog model into the shared Hugging Face cache, reporting
/// cumulative progress on `on_progress`. Registered under `download_id` so
/// `cancel_download(download_id)` can abort the in-flight transfer (the aborted
/// task drops mid-download; hf-hub leaves a temp file, never a corrupt final).
/// A no-op when the file is already cached, at any commit.
#[tauri::command]
#[specta::specta]
pub async fn download_model(
    model_id: String,
    download_id: String,
    on_progress: Channel<DownloadProgress>,
    manager: State<'_, DownloadManager>,
) -> Result<(), CatalogError> {
    let entry = find_or_unknown(&model_id)?;
    // `hf-hub` fetches the file again even when it is cached.
    if entry.cached_path().is_some() {
        return Ok(());
    }

    let api = ApiBuilder::from_env()
        .with_progress(false)
        .build()
        .map_err(|e| CatalogError::DownloadFailed {
            message: format!(
                "Failed to initialize Hugging Face API: {}",
                error_chain_message(&e)
            ),
        })?;
    let repo = api.repo(entry.repo());
    let filename = entry.coord.filename.to_string();
    let progress = ChannelProgress {
        channel: on_progress,
        received: Arc::new(AtomicU64::new(0)),
        total: Arc::new(AtomicU64::new(0)),
    };

    manager
        .run(&download_id, async move {
            repo.download_with_progress(&filename, progress).await
        })
        .await
        .map_err(|e| CatalogError::DownloadFailed { message: e })?
        .map(|_path| ())
        .map_err(|e| CatalogError::DownloadFailed {
            message: format!("Failed to download model: {}", error_chain_message(&e)),
        })
}

/// Show a downloaded model's file in the system file manager, so the user can
/// see where it lives in the shared Hugging Face cache and remove it with the
/// tools that own that cache. Epicenter itself never deletes a model file.
#[tauri::command]
#[specta::specta]
pub fn reveal_model<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    model_id: String,
) -> Result<(), CatalogError> {
    use tauri_plugin_opener::OpenerExt;
    let entry = find_or_unknown(&model_id)?;
    let path = entry
        .cached_path()
        .ok_or_else(|| CatalogError::RevealFailed {
            message: format!("{} is not downloaded.", entry.name),
        })?;
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|error| CatalogError::RevealFailed {
            message: error.to_string(),
        })
}

// The fixtures lay out `hf-hub`'s symlinked cache, which needs Unix symlinks.
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    /// The ids stored as the active choice and named on transcripts. A change
    /// here strands every saved choice, so it must be deliberate.
    #[test]
    fn shipped_model_ids_never_change() {
        assert_eq!(
            model_ids(),
            [
                "handy-computer/whisper-tiny-gguf@main/whisper-tiny-Q8_0.gguf",
                "handy-computer/whisper-small-gguf@main/whisper-small-Q4_K_M.gguf",
                "handy-computer/parakeet-tdt-0.6b-v3-gguf@main/parakeet-tdt-0.6b-v3-Q4_K_M.gguf",
            ]
        );
    }

    fn entry() -> &'static CatalogEntry {
        &CATALOG[0]
    }

    /// Lay a file out the way `hf-hub` does: bytes in `blobs/<hash>`, and a
    /// `snapshots/<commit>/<filename>` link to them.
    fn place(root: &Path, commit: &str, hash: &str) {
        let repo = root.join("models--handy-computer--whisper-tiny-gguf");
        let blob = repo.join("blobs").join(hash);
        fs::create_dir_all(blob.parent().unwrap()).unwrap();
        fs::write(&blob, b"model").unwrap();
        let snapshot = repo.join("snapshots").join(commit);
        fs::create_dir_all(&snapshot).unwrap();
        std::os::unix::fs::symlink(&blob, snapshot.join(entry().coord.filename)).unwrap();
    }

    #[test]
    fn an_empty_cache_has_no_model() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(entry().cached_path_in(Cache::new(root.path().into())), None);
    }

    #[test]
    fn the_file_at_the_pinned_commit_is_present() {
        let root = tempfile::tempdir().unwrap();
        place(root.path(), entry().coord.commit, entry().coord.sha256);
        assert!(entry()
            .cached_path_in(Cache::new(root.path().into()))
            .is_some());
    }

    #[test]
    fn the_same_bytes_at_another_commit_are_present() {
        let root = tempfile::tempdir().unwrap();
        place(
            root.path(),
            "0000000000000000000000000000000000000000",
            entry().coord.sha256,
        );
        let found = entry()
            .cached_path_in(Cache::new(root.path().into()))
            .unwrap();
        assert!(found.ends_with(entry().coord.filename));
    }

    #[test]
    fn other_bytes_at_another_commit_are_not_the_model() {
        let root = tempfile::tempdir().unwrap();
        place(
            root.path(),
            "0000000000000000000000000000000000000000",
            "different",
        );
        assert_eq!(entry().cached_path_in(Cache::new(root.path().into())), None);
    }
}
