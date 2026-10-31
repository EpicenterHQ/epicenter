//! User Stop only stops waiting in the page; the download continues in the background.
//! App quit stays immediate and the OS releases the process's file locks.
//! Old async `.sync.part` files stay untouched; synchronous downloads use `.part`.
//!
//! The local GGUF model catalog: the one Rust-owned source of truth for which
//! local models exist, their Hugging Face coordinate, their static capabilities,
//! and their download/cache status.
//!
//! A model is identified by a stable `modelId` string such as
//! `"handy-computer/whisper-small-gguf@main/whisper-small-Q4_K_M.gguf"`. That id
//! is an opaque catalog key, frozen once shipped: the stored active choice and
//! every transcript name it. It is not a coordinate; the `@main` in shipped ids
//! predates pinning and no longer says what is downloaded. The app's model
//! settings name it when they administer models, and the app stores the
//! active dictation choice. Explicit file inference lists cached IDs and passes
//! the selected ID to `transcribe_file`; `ModelCache::prewarm` and
//! `ModelCache::transcribe` resolve the active choice. An unknown ID is refused
//! rather than parsed. (Custom drop-in GGUF is a later earned feature, not a
//! compatibility path.)
//!
//! Storage is the shared Hugging Face cache (`~/.cache/huggingface/hub`,
//! overridable by `HF_HOME`), owned by `hf-hub`: downloads stage and resume
//! through it, and a file already in the cache (from this app or any other HF
//! tool) is reused. This plugin downloads into that cache and never deletes from
//! it: other tools share the cache, so removing files is the user's call, made
//! with Hugging Face's own tools. Rust never stores a path; it resolves the
//! coordinate to a cache path at point of use, so a file removed outside
//! this app reads as not downloaded on the next look.
//!
//! Each model is pinned to a commit and to its file's content hash. Downloads
//! fetch that commit, and presence is decided by the cache's content address
//! (`blobs/<sha256>`), so another HF tool moving `refs/main`, or fetching the
//! same file at a different commit, never makes a model read as missing. The
//! file itself is not hashed: the cache's layout is trusted. The match at a different commit needs a
//! symlinked cache: where `hf-hub` cannot symlink (Windows without the
//! privilege), it moves the blob into the snapshot, so only the pinned commit's
//! file is found.

use super::error::error_chain_message;
use crate::download::{DownloadProgress, Downloads};
use hf_hub::api::{
    sync::{ApiBuilder, ApiError},
    Progress,
};
use hf_hub::{Cache, Repo, RepoType};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::ipc::Channel;
use tauri::State;
use thiserror::Error;

/// A Hugging Face coordinate: where a model's file is downloaded from and how
/// its presence in the cache is resolved.
struct ModelCoord {
    repo_id: &'static str,
    /// The commit downloads fetch. Pinned so a moving branch cannot change the
    /// bytes the app runs.
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
    CATALOG.iter().find(|entry| entry.id == model_id)
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
/// deleted outside this app is noticed on the very next call too.
pub fn installed_model_path(model_id: &str) -> Option<PathBuf> {
    find(model_id).and_then(CatalogEntry::cached_path)
}

/// This app's active local model: its identity and disk presence.
///
/// Administration reads this full description. Explicit inference discovers
/// installed catalog IDs through `list_inference_models`; capture hints use
/// `ModelCache::readiness`. Residency stays private to the host.
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
        id: entry.id.to_string(),
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
    CATALOG.iter().map(|entry| entry.id.to_string()).collect()
}

/// Every catalog display name, so a test can assert that a message an
/// application receives names none of them.
#[cfg(test)]
pub fn model_names() -> Vec<&'static str> {
    CATALOG.iter().map(|entry| entry.name).collect()
}

/// A catalog model for administration: identity, display fields, capabilities,
/// and disk presence. Settings use `id` to activate, download, or reveal a model;
/// the Hugging Face coordinate stays private to Rust.
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

    #[error("{message}")]
    Busy { message: String },

    #[error("{message}")]
    DownloadingElsewhere { message: String },

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
            id: entry.id.to_string(),
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

/// Forward synchronous download progress as a cumulative byte count.
struct ChannelProgress {
    channel: Channel<DownloadProgress>,
    received: u64,
    total: u64,
}

impl ChannelProgress {
    fn emit(&self) {
        let received = self.received;
        let total = self.total;
        let _ = self
            .channel
            .send(DownloadProgress::new(received as f64, total as f64));
    }
}

impl Progress for ChannelProgress {
    fn init(&mut self, size: usize, _filename: &str) {
        self.total = size as u64;
        self.received = 0;
        self.emit();
    }

    fn update(&mut self, size: usize) {
        self.received += size as u64;
        self.emit();
    }

    fn finish(&mut self) {
        self.emit();
    }
}

/// Download a catalog model in a detached blocking worker. Stopping the page's
/// wait does not stop the transfer or release its per-model reservation.
#[tauri::command]
#[specta::specta]
pub async fn download_model(
    model_id: String,
    on_progress: Channel<DownloadProgress>,
    downloads: State<'_, Downloads>,
) -> Result<(), CatalogError> {
    let entry = find_or_unknown(&model_id)?;
    if entry.cached_path().is_some() {
        return Ok(());
    }
    let worker = downloads.worker(model_id, move || {
        let api = ApiBuilder::from_env()
            .with_progress(false)
            .build()
            .map_err(download_error)?;
        let progress = ChannelProgress {
            channel: on_progress,
            received: 0,
            total: 0,
        };
        api.repo(entry.repo())
            .download_with_progress(entry.coord.filename, progress)
            .map(|_| ())
            .map_err(download_error)
    })?;
    tauri::async_runtime::spawn_blocking(worker)
        .await
        .map_err(|e| CatalogError::DownloadFailed {
            message: e.to_string(),
        })?
}

fn download_error(error: ApiError) -> CatalogError {
    match error {
        ApiError::LockAcquisition(_) => CatalogError::DownloadingElsewhere {
            message: "Another app on this computer is downloading this model.".into(),
        },
        error => CatalogError::DownloadFailed {
            message: format!("Failed to download model: {}", error_chain_message(&error)),
        },
    }
}

#[cfg(test)]
mod download_tests {
    use super::*;
    #[test]
    fn lock_contention_reports_another_app_instead_of_a_broken_model() {
        assert!(matches!(
            download_error(ApiError::LockAcquisition(PathBuf::from("unused"))),
            CatalogError::DownloadingElsewhere { .. }
        ));
    }
}

/// Show a downloaded model's folder in the shared Hugging Face cache, such as
/// `models--handy-computer--whisper-tiny-gguf`, so the user can see where it
/// lives and remove it themselves. This plugin never deletes a model.
///
/// The folder, not the file: the file is a symlink into the repo's `blobs/`,
/// and the file manager would select the 64-hex blob it resolves to. Deleting
/// the folder frees the space, and the model then reads as not downloaded.
/// Async so a slow file manager call never blocks the main thread.
#[tauri::command]
#[specta::specta]
pub async fn reveal_model<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    model_id: String,
) -> Result<(), CatalogError> {
    use tauri_plugin_opener::OpenerExt;
    let entry = find_or_unknown(&model_id)?;
    if entry.cached_path().is_none() {
        return Err(CatalogError::RevealFailed {
            message: format!("{} is not downloaded.", entry.name),
        });
    }
    let cache = Cache::from_env();
    let folder = cache.path().join(entry.repo().folder_name());
    app.opener()
        .reveal_item_in_dir(&folder)
        .map_err(|error| CatalogError::RevealFailed {
            message: error.to_string(),
        })
}

#[cfg(test)]
mod id_tests {
    use super::*;

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
}

// The fixtures lay out `hf-hub`'s symlinked cache, which needs Unix symlinks.
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

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

#[cfg(test)]
mod command_download_tests {
    use super::*;
    use std::{
        fs::{self, OpenOptions},
        io::{Read, Write},
        net::{SocketAddr, TcpListener, TcpStream},
        process::Command,
        sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            Arc, Condvar, Mutex,
        },
        thread,
        time::{Duration, Instant},
    };
    use tauri::Manager;

    const CHILD: &str = "EPICENTER_TEST_DOWNLOAD_CHILD";
    const FILTER: &str =
        "transcription::catalog::command_download_tests::production_download_outlives_its_waiter";
    const BYTES: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKL";
    const PREFIX: usize = 4;

    struct Fixture {
        address: SocketAddr,
        stop: Arc<AtomicBool>,
        gate: Arc<(Mutex<bool>, Condvar)>,
        thread: Option<thread::JoinHandle<()>>,
    }

    impl Fixture {
        fn start(entry: &'static CatalogEntry, truncate: bool) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let stop = Arc::new(AtomicBool::new(false));
            let gate = Arc::new((Mutex::new(false), Condvar::new()));
            let first = Arc::new(AtomicUsize::new(0));
            let thread_stop = stop.clone();
            let thread_gate = gate.clone();
            let worker = thread::spawn(move || {
                let mut handlers = Vec::new();
                while !thread_stop.load(Ordering::SeqCst) {
                    let (socket, _) = listener.accept().unwrap();
                    if thread_stop.load(Ordering::SeqCst) {
                        break;
                    }
                    let gate = thread_gate.clone();
                    let first = first.clone();
                    handlers.push(thread::spawn(move || {
                        serve(socket, entry, truncate, &first, &gate)
                    }));
                }
                for handler in handlers {
                    handler.join().unwrap();
                }
            });
            Self {
                address,
                stop,
                gate,
                thread: Some(worker),
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            *self.gate.0.lock().unwrap() = true;
            self.gate.1.notify_all();
            let _ = TcpStream::connect(self.address);
            self.thread.take().unwrap().join().unwrap();
        }
    }

    fn serve(
        mut socket: TcpStream,
        entry: &'static CatalogEntry,
        truncate: bool,
        first: &AtomicUsize,
        gate: &(Mutex<bool>, Condvar),
    ) {
        socket
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        socket
            .set_write_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let mut request = Vec::new();
        let mut byte = [0];
        while !request.ends_with(b"\r\n\r\n") {
            if socket.read(&mut byte).unwrap_or(0) == 0 {
                return;
            }
            request.push(byte[0]);
            assert!(request.len() < 16_384);
        }
        let request = String::from_utf8(request).unwrap();
        // Do not print a possibly inherited credential if isolation regresses.
        assert!(!request
            .lines()
            .any(|line| line.to_ascii_lowercase().starts_with("authorization:")));
        let path = request
            .lines()
            .next()
            .unwrap()
            .split_whitespace()
            .nth(1)
            .unwrap();
        if path == "/release" {
            *gate.0.lock().unwrap() = true;
            gate.1.notify_all();
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .unwrap();
            return;
        }
        let expected = format!(
            "/{}/resolve/{}/{}",
            entry.coord.repo_id, entry.coord.commit, entry.coord.filename
        );
        assert_eq!(path, expected);
        let range = request
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("range").then(|| value.trim())
            })
            .unwrap();
        if range == "bytes=0-0" {
            let headers = format!(
                "HTTP/1.1 206 Partial Content\r\nx-repo-commit: {}\r\netag: \"{}\"\r\nContent-Range: bytes 0-0/{}\r\nContent-Length: 1\r\nConnection: close\r\n\r\n",
                entry.coord.commit, entry.coord.sha256, BYTES.len()
            );
            socket.write_all(headers.as_bytes()).unwrap();
            socket.write_all(&BYTES[..1]).unwrap();
            return;
        }
        let start: usize = range
            .strip_prefix("bytes=")
            .unwrap()
            .strip_suffix('-')
            .unwrap()
            .parse()
            .unwrap();
        let is_first = first.fetch_add(1, Ordering::SeqCst) == 0;
        assert_eq!(start, if is_first { 0 } else { PREFIX });
        let body = &BYTES[start..];
        let headers = format!(
            "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {start}-{}/{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            BYTES.len() - 1, BYTES.len(), body.len()
        );
        socket.write_all(headers.as_bytes()).unwrap();
        if is_first {
            socket.write_all(&body[..PREFIX]).unwrap();
            socket.flush().unwrap();
            let mut released = gate.0.lock().unwrap();
            while !*released {
                released = gate.1.wait(released).unwrap();
            }
            if truncate {
                return; // An ordinary response-body error after an actual write.
            }
            socket.write_all(&body[PREFIX..]).unwrap();
        } else {
            socket.write_all(body).unwrap();
        }
    }

    fn release(address: SocketAddr) {
        let mut socket = TcpStream::connect(address).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        socket
            .write_all(b"GET /release HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .unwrap();
        let mut reply = String::new();
        socket.read_to_string(&mut reply).unwrap();
        assert!(reply.starts_with("HTTP/1.1 200"));
    }

    fn lock_available(path: &std::path::Path) -> bool {
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .unwrap();
        // Independent open, not a clone of hf-hub's descriptor. Drop releases it.
        lock.try_lock().is_ok()
    }

    async fn until(mut condition: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !condition() {
            assert!(Instant::now() < deadline, "condition did not settle");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    async fn child_case(truncate: bool) {
        let entry = &CATALOG[0];
        assert!(entry.cached_path().is_none());
        let app = tauri::test::mock_builder()
            .manage(Downloads::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let blob = Cache::from_env()
            .repo(entry.repo())
            .blob_path(entry.coord.sha256);
        let partial = blob.with_extension("part");
        let lock = blob.with_extension("lock");
        let abandoned = Arc::new(AtomicBool::new(false));
        let channel_abandoned = abandoned.clone();
        let progress = Channel::new(move |_| {
            if channel_abandoned.load(Ordering::SeqCst) {
                Err(
                    std::io::Error::new(std::io::ErrorKind::BrokenPipe, "test page departed")
                        .into(),
                )
            } else {
                Ok(())
            }
        });
        let handle = app.handle().clone();
        let waiter = tauri::async_runtime::spawn(async move {
            download_model(entry.id.into(), progress, handle.state::<Downloads>()).await
        });
        // Observe an actual file write, not just HTTP acceptance/progress emission.
        until(|| {
            fs::metadata(&partial)
                .map(|m| m.len() == PREFIX as u64)
                .unwrap_or(false)
        })
        .await;
        assert!(!lock_available(&lock));
        abandoned.store(true, Ordering::SeqCst);
        waiter.abort();
        assert!(waiter.await.is_err());
        assert!(!lock_available(&lock));
        let busy = tokio::time::timeout(
            Duration::from_secs(1),
            download_model(
                entry.id.into(),
                Channel::new(|_| Ok(())),
                app.state::<Downloads>(),
            ),
        )
        .await
        .unwrap();
        assert!(matches!(busy, Err(CatalogError::Busy { .. })));
        release(
            std::env::var("EPICENTER_TEST_DOWNLOAD_ADDRESS")
                .unwrap()
                .parse()
                .unwrap(),
        );
        // Cached fast-path success would hide a leaked reservation. Probe the
        // existing production reservation operation, then immediately drop it.
        until(
            || match app.state::<Downloads>().worker(entry.id.into(), || ()) {
                Ok(work) => {
                    drop(work);
                    true
                }
                Err(CatalogError::Busy { .. }) => false,
                Err(other) => panic!("unexpected reservation error: {other:?}"),
            },
        )
        .await;
        assert!(lock_available(&lock));
        if truncate {
            assert!(entry.cached_path().is_none());
            assert_eq!(fs::read(&partial).unwrap(), &BYTES[..PREFIX]);
            tokio::time::timeout(
                Duration::from_secs(10),
                download_model(
                    entry.id.into(),
                    Channel::new(|_| Ok(())),
                    app.state::<Downloads>(),
                ),
            )
            .await
            .unwrap()
            .unwrap();
        }
        assert_eq!(fs::read(entry.cached_path().unwrap()).unwrap(), BYTES);
        assert!(!partial.exists());
        assert!(lock_available(&lock));
        drop(
            app.state::<Downloads>()
                .worker(entry.id.into(), || ())
                .unwrap(),
        );
    }

    #[test]
    fn production_download_outlives_its_waiter() {
        if let Ok(case) = std::env::var(CHILD) {
            tauri::async_runtime::block_on(child_case(case == "truncate"));
            return;
        }
        for truncate in [false, true] {
            let cache = tempfile::tempdir().unwrap();
            let fixture = Fixture::start(&CATALOG[0], truncate);
            let output = Command::new(std::env::current_exe().unwrap())
                .args(["--exact", FILTER, "--nocapture", "--test-threads=1"])
                .env(CHILD, if truncate { "truncate" } else { "success" })
                .env("HF_HOME", cache.path())
                .env("HF_ENDPOINT", format!("http://{}", fixture.address))
                .env(
                    "EPICENTER_TEST_DOWNLOAD_ADDRESS",
                    fixture.address.to_string(),
                )
                .env_remove("HF_TOKEN")
                .env_remove("HUGGING_FACE_HUB_TOKEN")
                .env_remove("HF_HUB_CACHE")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "child failed:\n{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(
                String::from_utf8_lossy(&output.stdout).contains("1 passed"),
                "child filter ran no test"
            );
        }
    }
}
