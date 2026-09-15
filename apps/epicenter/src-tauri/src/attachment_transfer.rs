//! One-shot byte I/O. The library owns scheduling, rows, generations and retries.
use crate::blobs::{
    blobs_directory, normalize_content_type, sync_directory, sync_file, BlobDestination,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use tauri::{Manager, State, WebviewWindow};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio_util::{io::ReaderStream, sync::CancellationToken};

const CHUNK: usize = 64 * 1024;
const MAX_SIZE: f64 = 5.0 * 1024.0 * 1024.0 * 1024.0;

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Content {
    pub sha256: String,
    // Specta deliberately refuses u64; this number is validated before conversion.
    pub size: f64,
    pub content_type: String,
}

#[derive(Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Ticket {
    pub url: String,
    #[serde(default)]
    pub required_headers: HashMap<String, String>,
}

#[derive(Debug, Clone, Copy, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Upload,
    Download,
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TransferError {
    Transport { cause: String, status: Option<u16> },
    Storage { cause: String },
    Conflict { cause: String },
}
type Result<T> = std::result::Result<T, TransferError>;
fn transport(cause: impl std::fmt::Display) -> TransferError {
    TransferError::Transport {
        cause: cause.to_string(),
        status: None,
    }
}
fn network(error: reqwest::Error) -> TransferError {
    // Signed URLs are capabilities; error display must not retain their query.
    transport(error.without_url())
}
fn storage(cause: impl std::fmt::Display) -> TransferError {
    TransferError::Storage {
        cause: cause.to_string(),
    }
}
fn conflict(cause: impl Into<String>) -> TransferError {
    TransferError::Conflict {
        cause: cause.into(),
    }
}

#[derive(Default)]
struct Document {
    epoch: u32,
    // Delayed lower sequences fail recoverably; history never retains UUID tombstones.
    high_water: u64,
    requests: HashMap<(u32, u64), CancellationToken>,
}
#[derive(Default)]
pub struct Transfers(Mutex<HashMap<String, Document>>);

impl Transfers {
    fn epoch(&self, owner: &str) -> Result<u32> {
        Ok(self
            .0
            .lock()
            .map_err(transport)?
            .entry(owner.into())
            .or_default()
            .epoch)
    }
    pub fn retire(&self, owner: &str) {
        if let Ok(mut documents) = self.0.lock() {
            let document = documents.entry(owner.into()).or_default();
            for token in document.requests.values() {
                token.cancel();
            }
            // Retired filesystem operations still occupy capacity until drained.
            document.high_water = 0;
            document.epoch = document
                .epoch
                .checked_add(1)
                .expect("document epoch exhausted");
        }
    }
    fn admit(&self, owner: &str, epoch: u32, request: &str) -> Result<CancellationToken> {
        let request = request_sequence(request)?;
        let mut documents = self.0.lock().map_err(transport)?;
        let document = documents.entry(owner.into()).or_default();
        if document.epoch != epoch || request <= document.high_water {
            return Err(transport("transfer request has retired"));
        }
        document.high_water = request;
        // The owner schedules at most two, but the native boundary also refuses
        // an unbounded caller queue instead of opening arbitrary numbers of files.
        if document.requests.len() >= 2 {
            return Err(transport("transfer capacity exhausted"));
        }
        let token = CancellationToken::new();
        document.requests.insert((epoch, request), token.clone());
        Ok(token)
    }
    fn cancel(&self, owner: &str, epoch: u32, request: &str) -> Result<()> {
        let request = request_sequence(request)?;
        let mut documents = self.0.lock().map_err(transport)?;
        let document = documents.entry(owner.into()).or_default();
        if document.epoch != epoch {
            return Ok(());
        }
        document.high_water = document.high_water.max(request);
        // Cancellation does not release capacity until the transfer finishes.
        if let Some(token) = document.requests.get(&(epoch, request)) {
            token.cancel();
        }
        Ok(())
    }
    fn finish(&self, owner: &str, epoch: u32, request: &str) {
        if let (Ok(request), Ok(mut documents)) = (request_sequence(request), self.0.lock()) {
            if let Some(document) = documents.get_mut(owner) {
                document.requests.remove(&(epoch, request));
            }
        }
    }
}

fn request_sequence(request: &str) -> Result<u64> {
    if request.len() > 16 {
        return Err(transport("invalid transfer request sequence"));
    }
    let sequence = request.parse::<u64>().map_err(transport)?;
    if sequence == 0 || sequence > 9_007_199_254_740_991 || sequence.to_string() != request {
        return Err(transport("invalid transfer request sequence"));
    }
    Ok(sequence)
}

// Synchronous epoch reads do not spawn an independently delayed command task.
#[tauri::command]
#[specta::specta]
pub fn attachment_transfer_epoch(
    transfers: State<'_, Transfers>,
    window: WebviewWindow,
) -> Result<u32> {
    transfers.epoch(window.label())
}
#[tauri::command]
#[specta::specta]
pub fn cancel_attachment_transfer(
    epoch: u32,
    request_id: String,
    transfers: State<'_, Transfers>,
    window: WebviewWindow,
) -> Result<()> {
    transfers.cancel(window.label(), epoch, &request_id)
}
#[tauri::command]
#[specta::specta]
pub async fn transfer_attachment(
    epoch: u32,
    request_id: String,
    destination: BlobDestination,
    storage_id: String,
    direction: Direction,
    expected: Content,
    ticket: Ticket,
    transfers: State<'_, Transfers>,
    window: WebviewWindow,
) -> Result<()> {
    let token = transfers.admit(window.label(), epoch, &request_id)?;
    let root = window
        .state::<crate::app_data::DesktopPaths>()
        .data_dir
        .clone();
    let result = transfer(
        &root,
        &destination,
        &storage_id,
        direction,
        &expected,
        ticket,
        &token,
    )
    .await;
    transfers.finish(window.label(), epoch, &request_id);
    result
}

fn validate(expected: &Content, id: &str) -> Result<()> {
    if !expected.size.is_finite()
        || expected.size.fract() != 0.0
        || expected.size < 0.0
        || expected.size > MAX_SIZE
        || expected.sha256.len() != 64
        || !expected
            .sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || normalize_content_type(&expected.content_type) != expected.content_type
    {
        return Err(conflict("invalid attachment content"));
    }
    // Attachment ids are the library's row/field address, never a filesystem path.
    crate::blobs::validate_blob_id(id).map_err(storage)?;
    if !id.starts_with("attachment.") {
        return Err(conflict("expected an attachment address"));
    }
    Ok(())
}

fn validate_ticket(
    ticket: &Ticket,
    direction: Direction,
    expected: &Content,
) -> Result<reqwest::Url> {
    if ticket.url.len() > 8192 || ticket.required_headers.len() > 16 {
        return Err(transport("attachment ticket exceeds bound"));
    }
    let mut total = ticket.url.len();
    let mut headers = reqwest::header::HeaderMap::new();
    for (name, value) in &ticket.required_headers {
        total = total.saturating_add(name.len()).saturating_add(value.len());
        if total > 32 * 1024 || value.len() > 4096 || value.contains(['\r', '\n']) {
            return Err(transport("attachment ticket headers exceed bound"));
        }
        let name = reqwest::header::HeaderName::from_bytes(name.as_bytes()).map_err(transport)?;
        if !matches!(name.as_str(), "content-type" | "if-none-match")
            && !name.as_str().starts_with("x-amz-")
        {
            return Err(transport("unsupported attachment ticket header"));
        }
        let value = reqwest::header::HeaderValue::from_str(value).map_err(transport)?;
        if headers.insert(name, value).is_some() {
            return Err(transport("duplicate attachment ticket header"));
        }
    }
    if serde_json::to_vec(ticket).map_err(transport)?.len() > 32 * 1024 {
        return Err(transport("encoded attachment ticket exceeds bound"));
    }
    if matches!(direction, Direction::Upload)
        && (headers
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            != Some(expected.content_type.as_str())
            || headers
                .get("if-none-match")
                .and_then(|value| value.to_str().ok())
                != Some("*"))
    {
        return Err(transport(
            "attachment upload ticket must preserve content and create-only publication",
        ));
    }
    let url = reqwest::Url::parse(&ticket.url).map_err(transport)?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(transport("invalid attachment transfer URL"));
    }
    Ok(url)
}

fn check_cancelled(token: &CancellationToken) -> Result<()> {
    if token.is_cancelled() {
        return Err(transport("attachment transfer cancelled"));
    }
    Ok(())
}

async fn verify_file(
    file: &mut tokio::fs::File,
    expected: &Content,
    token: &CancellationToken,
) -> Result<()> {
    let mut hash = Sha256::new();
    let mut size = 0_u64;
    let mut buffer = [0_u8; CHUNK];
    loop {
        check_cancelled(token)?;
        let read = file.read(&mut buffer).await.map_err(storage)?;
        if read == 0 {
            break;
        }
        size += read as u64;
        if size > expected.size as u64 {
            return Err(conflict("attachment exceeds expected size"));
        }
        hash.update(&buffer[..read]);
    }
    if size != expected.size as u64 || format!("{:x}", hash.finalize()) != expected.sha256 {
        return Err(conflict("attachment bytes differ from completed content"));
    }
    Ok(())
}

async fn open_verified(
    directory: &Path,
    expected: &Content,
    token: &CancellationToken,
) -> Result<tokio::fs::File> {
    // Metadata is deliberately bounded too; never trust a corrupt local JSON file.
    let mut metadata_file = tokio::fs::File::open(directory.join("metadata.json"))
        .await
        .map_err(storage)?;
    let mut encoded = Vec::new();
    (&mut metadata_file)
        .take(16 * 1024 + 1)
        .read_to_end(&mut encoded)
        .await
        .map_err(storage)?;
    if encoded.len() > 16 * 1024 {
        return Err(conflict("attachment metadata exceeds bound"));
    }
    let metadata: serde_json::Value = serde_json::from_slice(&encoded).map_err(storage)?;
    if metadata["size"].as_f64() != Some(expected.size)
        || metadata["contentType"].as_str() != Some(expected.content_type.as_str())
        || metadata["attachment"]["sha256"].as_str() != Some(expected.sha256.as_str())
        || metadata["attachment"]["size"].as_f64() != Some(expected.size)
        || metadata["attachment"]["contentType"].as_str() != Some(expected.content_type.as_str())
    {
        return Err(conflict(
            "attachment metadata differs from completed content",
        ));
    }
    let mut file = tokio::fs::File::open(directory.join("data"))
        .await
        .map_err(storage)?;
    verify_file(&mut file, expected, token).await?;
    file.rewind().await.map_err(storage)?;
    Ok(file)
}

fn durable(directory: &Path) -> Result<()> {
    sync_file(&directory.join("data")).map_err(storage)?;
    sync_file(&directory.join("metadata.json")).map_err(storage)?;
    for ancestor in directory.ancestors() {
        sync_directory(ancestor).map_err(storage)?;
    }
    Ok(())
}

/// Cancel network waits, but drain filesystem operations before dropping their
/// staging owner. Dropping a tokio filesystem future does not cancel its syscall.
async fn transfer(
    data_dir: &Path,
    destination: &BlobDestination,
    id: &str,
    direction: Direction,
    expected: &Content,
    ticket: Ticket,
    token: &CancellationToken,
) -> Result<()> {
    check_cancelled(token)?;
    validate(expected, id)?;
    let url = validate_ticket(&ticket, direction, expected)?;
    let directory = blobs_directory(data_dir, destination)
        .map_err(storage)?
        .join(id);
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(5 * 60))
        .build()
        .map_err(transport)?;
    let method = match direction {
        Direction::Upload => reqwest::Method::PUT,
        Direction::Download => reqwest::Method::GET,
    };
    let mut request = client.request(method, url);
    for (name, value) in ticket.required_headers {
        request = request.header(name, value);
    }
    if matches!(direction, Direction::Upload) {
        let file = open_verified(&directory, expected, token).await?;
        let sending = request
            .header(reqwest::header::CONTENT_TYPE, &expected.content_type)
            .header(reqwest::header::CONTENT_LENGTH, expected.size as u64)
            .body(reqwest::Body::wrap_stream(ReaderStream::with_capacity(
                file, CHUNK,
            )))
            .send();
        let response = tokio::select! {
            biased;
            _ = token.cancelled() => return Err(transport("attachment transfer cancelled")),
            result = sending => result.map_err(network)?,
        };
        // 409/412 are NOT equal-content proof. The library's finalize operation
        // verifies remote bytes after any uncertain upload response.
        return if response.status().is_success() {
            Ok(())
        } else {
            Err(TransferError::Transport {
                cause: "attachment upload refused".into(),
                status: Some(response.status().as_u16()),
            })
        };
    }
    if directory.exists() {
        open_verified(&directory, expected, token).await?;
        check_cancelled(token)?;
        return durable(&directory);
    }
    let mut response = tokio::select! {
        biased;
        _ = token.cancelled() => return Err(transport("attachment transfer cancelled")),
        result = request.send() => result.map_err(network)?,
    };
    if !response.status().is_success() {
        return Err(TransferError::Transport {
            cause: "attachment download refused".into(),
            status: Some(response.status().as_u16()),
        });
    }
    if response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        != Some(expected.content_type.as_str())
        || response
            .headers()
            .contains_key(reqwest::header::CONTENT_ENCODING)
        || response
            .content_length()
            .is_some_and(|length| length != expected.size as u64)
    {
        return Err(conflict("download headers differ from completed content"));
    }
    let root = directory.parent().unwrap();
    tokio::fs::create_dir_all(root).await.map_err(storage)?;
    let staging_root = root.join(".staging").join("rust");
    tokio::fs::create_dir_all(&staging_root)
        .await
        .map_err(storage)?;
    let temporary = tempfile::Builder::new()
        .prefix("transfer-")
        .tempdir_in(staging_root)
        .map_err(storage)?;
    let result = async {
    let mut file = tokio::fs::File::create(temporary.path().join("data"))
        .await
        .map_err(storage)?;
    let mut hash = Sha256::new();
    let mut size = 0_u64;
    loop {
        let chunk = tokio::select! {
            biased;
            _ = token.cancelled() => return Err(transport("attachment transfer cancelled")),
            result = response.chunk() => result.map_err(network)?,
        };
        let Some(chunk) = chunk else { break };
        size += chunk.len() as u64;
        if size > expected.size as u64 {
            return Err(conflict("download exceeds completed size"));
        }
        for part in chunk.chunks(CHUNK) {
            hash.update(part);
            file.write_all(part).await.map_err(storage)?;
        }
        // tokio File writes can return before their blocking syscall completes.
        // Flush drains that syscall before the next cancellable network await.
        file.flush().await.map_err(storage)?;
    }
    if size != expected.size as u64 || format!("{:x}", hash.finalize()) != expected.sha256 {
        return Err(conflict("download bytes differ from completed content"));
    }
    file.flush().await.map_err(storage)?;
    file.sync_all().await.map_err(storage)?;
    drop(file);
    let metadata = serde_json::json!({"size": size, "contentType": expected.content_type, "attachment": expected});
    // No originGeneration: downloaded bytes must never become upload work.
    tokio::fs::write(
        temporary.path().join("metadata.json"),
        serde_json::to_vec(&metadata).map_err(storage)?,
    )
    .await
    .map_err(storage)?;
    durable(temporary.path())?;
    check_cancelled(token)?;
    if let Err(error) = std::fs::rename(temporary.path(), &directory) {
        if !directory.exists() {
            return Err(storage(error));
        }
        open_verified(&directory, expected, token).await?;
    }
    // Cancellation after rename may leave verified local bytes. Only the
    // library can publish presence/rows and its captured generation fences that.
    durable(&directory)
    }.await;
    // Explicit cleanup reports a retained staging directory rather than silently
    // claiming cancellation removed it. All file operations have settled here.
    if let Err(error) = temporary.close() {
        if error.kind() != std::io::ErrorKind::NotFound {
            return Err(storage(error));
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn transfer(
        root: &Path,
        destination: &BlobDestination,
        id: &str,
        direction: Direction,
        expected: &Content,
        ticket: Ticket,
    ) -> Result<()> {
        super::transfer(
            root,
            destination,
            id,
            direction,
            expected,
            ticket,
            &CancellationToken::new(),
        )
        .await
    }
    use crate::blobs::LibraryReplica;
    use tokio::net::TcpListener;

    const ID: &str = "attachment.recordings.aaaaaaaaaaaaaaaaaaaaaaaa";
    fn destination() -> BlobDestination {
        BlobDestination {
            app_id: "com.test.transfer".into(),
            replica: LibraryReplica::Local {},
        }
    }
    fn content(size: usize) -> Content {
        let mut hash = Sha256::new();
        let zeros = [0_u8; CHUNK];
        for start in (0..size).step_by(CHUNK) {
            hash.update(&zeros[..CHUNK.min(size - start)]);
        }
        Content {
            sha256: format!("{:x}", hash.finalize()),
            size: size as f64,
            content_type: "audio/wav".into(),
        }
    }
    async fn local(root: &Path, expected: &Content) -> std::path::PathBuf {
        let directory = blobs_directory(root, &destination()).unwrap().join(ID);
        tokio::fs::create_dir_all(&directory).await.unwrap();
        let mut file = tokio::fs::File::create(directory.join("data"))
            .await
            .unwrap();
        let zeros = [0_u8; CHUNK];
        for start in (0..expected.size as usize).step_by(CHUNK) {
            file.write_all(&zeros[..CHUNK.min(expected.size as usize - start)])
                .await
                .unwrap();
        }
        file.flush().await.unwrap();
        tokio::fs::write(
            directory.join("metadata.json"),
            serde_json::to_vec(&serde_json::json!({
                "size": expected.size, "contentType": expected.content_type, "attachment": expected,
            }))
            .unwrap(),
        )
        .await
        .unwrap();
        directory
    }

    // The peer consumes/produces fixed chunks and deliberately yields. There is
    // no in-memory fixture body hiding a second unbounded stream implementation.
    async fn peer(
        bytes: usize,
        corrupt: bool,
        slow: bool,
        status: u16,
    ) -> (Ticket, tokio::task::JoinHandle<usize>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/bytes", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut header = Vec::new();
            while !header.ends_with(b"\r\n\r\n") {
                header.push(socket.read_u8().await.unwrap());
                assert!(header.len() < CHUNK);
            }
            let header = String::from_utf8(header).unwrap();
            if header.starts_with("PUT ") {
                assert!(header
                    .to_lowercase()
                    .contains(&format!("content-length: {bytes}\r\n")));
                let mut received = 0;
                let mut chunk = [0_u8; CHUNK];
                while received < bytes {
                    let read = socket
                        .read(&mut chunk[..CHUNK.min(bytes - received)])
                        .await
                        .unwrap();
                    if read == 0 {
                        return received;
                    }
                    assert!(chunk[..read].iter().all(|byte| *byte == 0));
                    received += read;
                    if slow && received % (CHUNK * 16) == 0 {
                        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
                    }
                }
                let _ = socket.write_all(format!("HTTP/1.1 {status} Result\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await;
                received
            } else {
                // Close-delimited body forces the client to enforce its own
                // expected bound, not rely on Content-Length as protection.
                socket.write_all(format!("HTTP/1.1 {status} Result\r\nContent-Type: audio/wav\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
                let chunk = [if corrupt { 1 } else { 0 }; CHUNK];
                let mut sent = 0;
                while sent < bytes {
                    let length = CHUNK.min(bytes - sent);
                    if socket.write_all(&chunk[..length]).await.is_err() {
                        break;
                    }
                    sent += length;
                    if slow {
                        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
                    }
                }
                sent
            }
        });
        (
            Ticket {
                url,
                required_headers: HashMap::from([
                    ("content-type".into(), "audio/wav".into()),
                    ("if-none-match".into(), "*".into()),
                ]),
            },
            task,
        )
    }

    #[test]
    fn cancellation_before_admission_and_retirement_cannot_touch_a_successor() {
        let transfers = Transfers::default();
        let epoch = transfers.epoch("window").unwrap();
        transfers.cancel("window", epoch, "1").unwrap();
        assert!(transfers.admit("window", epoch, "1").is_err());
        let active = transfers.admit("window", epoch, "2").unwrap();
        transfers.retire("window");
        assert!(active.is_cancelled());
        assert!(transfers.admit("window", epoch, "999").is_err());
        let next = transfers.epoch("window").unwrap();
        let successor = transfers.admit("window", next, "2").unwrap();
        transfers.cancel("window", epoch, "999").unwrap();
        assert!(!successor.is_cancelled());
        transfers.finish("window", epoch, "2");
        assert!(!successor.is_cancelled());
        assert!(transfers.admit("window", next, "3").is_ok());
    }

    #[test]
    fn retirement_keeps_draining_capacity_and_old_finish_cannot_remove_a_successor() {
        let transfers = Transfers::default();
        let first = transfers.admit("window", 0, "1").unwrap();
        let second = transfers.admit("window", 0, "2").unwrap();
        transfers.retire("window");
        assert!(first.is_cancelled());
        assert!(second.is_cancelled());
        assert!(transfers.admit("window", 1, "1").is_err());
        assert_eq!(transfers.0.lock().unwrap()["window"].requests.len(), 2);
        transfers.finish("window", 0, "1");
        let successor = transfers.admit("window", 1, "2").unwrap();
        assert!(transfers.admit("window", 1, "3").is_err());
        transfers.finish("window", 0, "2");
        assert!(!successor.is_cancelled());
        assert_eq!(transfers.0.lock().unwrap()["window"].requests.len(), 1);
        assert!(transfers.0.lock().unwrap()["window"]
            .requests
            .contains_key(&(1, 2)));
        transfers.finish("window", 0, "2");
        transfers.cancel("window", 0, "2").unwrap();
        assert!(!successor.is_cancelled());
        assert!(transfers.admit("window", 1, "4").is_ok());
        transfers.finish("window", 1, "2");
        transfers.finish("window", 1, "4");
        assert!(transfers.0.lock().unwrap()["window"].requests.is_empty());
    }

    #[test]
    fn sequence_fencing_retains_only_active_requests_and_refuses_reordered_admission() {
        let transfers = Transfers::default();
        for invalid in [
            "",
            "0",
            "-1",
            "+1",
            "01",
            "1.0",
            "9007199254740992",
            "18446744073709551616",
        ] {
            assert!(transfers.admit("window", 0, invalid).is_err());
            assert!(transfers.cancel("window", 0, invalid).is_err());
        }
        let first = transfers.admit("window", 0, "2").unwrap();
        assert!(transfers.admit("window", 0, "1").is_err());
        let second = transfers.admit("window", 0, "3").unwrap();
        transfers.cancel("window", 0, "2").unwrap();
        assert!(first.is_cancelled());
        assert!(!second.is_cancelled());
        assert!(transfers.admit("window", 0, "4").is_err());
        transfers.finish("window", 0, "2");
        assert!(transfers.admit("window", 0, "4").is_err());
        let retry = transfers.admit("window", 0, "5").unwrap();
        transfers.finish("window", 0, "2");
        assert!(!retry.is_cancelled());
        assert!(!second.is_cancelled());
        transfers.finish("window", 0, "3");
        transfers.finish("window", 0, "5");
        for sequence in 6..10_006 {
            let id = sequence.to_string();
            let token = transfers.admit("window", 0, &id).unwrap();
            transfers.cancel("window", 0, &id).unwrap();
            assert!(token.is_cancelled());
            transfers.finish("window", 0, &id);
        }
        let documents = transfers.0.lock().unwrap();
        assert_eq!(documents.len(), 1);
        assert_eq!(documents["window"].high_water, 10_005);
        assert!(documents["window"].requests.is_empty());
        assert!(documents["window"].requests.capacity() <= 3);
    }

    #[test]
    fn ticket_bounds_and_upload_preconditions_are_native_invariants() {
        let expected = content(CHUNK);
        let valid = || Ticket {
            url: "https://bytes.example/object?signature=private".into(),
            required_headers: HashMap::from([
                ("content-type".into(), "audio/wav".into()),
                ("if-none-match".into(), "*".into()),
            ]),
        };
        assert!(validate_ticket(&valid(), Direction::Upload, &expected).is_ok());
        for (name, value) in [
            ("authorization", "secret"),
            ("cookie", "secret"),
            ("content-type", "application/pdf"),
            ("if-none-match", "etag"),
            ("x-amz-meta-note", "bad\r\nheader"),
            ("Content-Type", "audio/wav"),
        ] {
            let mut ticket = valid();
            ticket.required_headers.insert(name.into(), value.into());
            assert!(
                validate_ticket(&ticket, Direction::Upload, &expected).is_err(),
                "{name}"
            );
        }
        let mut ticket = valid();
        ticket.required_headers.remove("if-none-match");
        assert!(validate_ticket(&ticket, Direction::Upload, &expected).is_err());
        let mut ticket = valid();
        ticket.url = format!("https://bytes.example/{}", "a".repeat(8192));
        assert!(validate_ticket(&ticket, Direction::Download, &expected).is_err());
        let mut ticket = valid();
        ticket
            .required_headers
            .insert("x-amz-meta-note".into(), "a".repeat(4097));
        assert!(validate_ticket(&ticket, Direction::Download, &expected).is_err());
        let mut ticket = valid();
        for index in 0..15 {
            ticket
                .required_headers
                .insert(format!("x-amz-meta-{index}"), "a".into());
        }
        assert!(validate_ticket(&ticket, Direction::Download, &expected).is_err());
        let mut ticket = valid();
        for index in 0..8 {
            ticket
                .required_headers
                .insert(format!("x-amz-meta-{index}"), "a".repeat(4096));
        }
        assert!(validate_ticket(&ticket, Direction::Download, &expected).is_err());
        for url in [
            "file:///tmp/file",
            "https://user:secret@bytes.example/object",
        ] {
            let mut ticket = valid();
            ticket.url = url.into();
            assert!(validate_ticket(&ticket, Direction::Download, &expected).is_err());
        }
    }

    #[tokio::test]
    async fn empty_finished_files_upload_and_download_through_real_http() {
        let expected = content(0);
        for direction in [Direction::Upload, Direction::Download] {
            let root = tempfile::tempdir().unwrap();
            if matches!(direction, Direction::Upload) {
                local(root.path(), &expected).await;
            }
            let (ticket, server) = peer(0, false, false, 200).await;
            transfer(
                root.path(),
                &destination(),
                ID,
                direction,
                &expected,
                ticket,
            )
            .await
            .unwrap();
            assert_eq!(server.await.unwrap(), 0);
            let directory = blobs_directory(root.path(), &destination())
                .unwrap()
                .join(ID);
            assert_eq!(std::fs::metadata(directory.join("data")).unwrap().len(), 0);
            let metadata: serde_json::Value =
                serde_json::from_slice(&std::fs::read(directory.join("metadata.json")).unwrap())
                    .unwrap();
            assert_eq!(metadata["attachment"]["sha256"], expected.sha256);
            assert_eq!(metadata["attachment"]["size"].as_f64(), Some(0.0));
            assert!(metadata["attachment"].get("originGeneration").is_none());
        }
    }

    #[tokio::test]
    async fn real_http_download_verifies_bytes_and_never_creates_upload_origin() {
        let root = tempfile::tempdir().unwrap();
        let expected = content(17_280_044);
        let (ticket, server) = peer(expected.size as usize, false, false, 200).await;
        transfer(
            root.path(),
            &destination(),
            ID,
            Direction::Download,
            &expected,
            ticket,
        )
        .await
        .unwrap();
        assert_eq!(server.await.unwrap(), expected.size as usize);
        let directory = blobs_directory(root.path(), &destination())
            .unwrap()
            .join(ID);
        let mut metadata: serde_json::Value =
            serde_json::from_slice(&std::fs::read(directory.join("metadata.json")).unwrap())
                .unwrap();
        assert!(metadata["attachment"].get("originGeneration").is_none());
        metadata["attachment"]["originGeneration"] = serde_json::Value::Null;
        std::fs::write(
            directory.join("metadata.json"),
            serde_json::to_vec(&metadata).unwrap(),
        )
        .unwrap();
        let receipt = directory.join("attachment-ack.json");
        std::fs::write(&receipt, b"preserved").unwrap();
        // Identical installed bytes need no network and preserve any origin/ack.
        transfer(
            root.path(),
            &destination(),
            ID,
            Direction::Download,
            &expected,
            Ticket {
                url: "http://127.0.0.1:1/not-used".into(),
                required_headers: HashMap::new(),
            },
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(receipt).unwrap(), b"preserved");
        let after: serde_json::Value =
            serde_json::from_slice(&std::fs::read(directory.join("metadata.json")).unwrap())
                .unwrap();
        assert_eq!(after, metadata);
    }

    #[tokio::test]
    async fn storage_failure_and_mime_mismatch_never_publish() {
        for fail_storage in [true, false] {
            let root = tempfile::tempdir().unwrap();
            let mut expected = content(CHUNK);
            if fail_storage {
                std::fs::write(root.path().join("apps"), b"obstruction").unwrap();
            } else {
                expected.content_type = "application/pdf".into();
            }
            let (ticket, server) = peer(CHUNK, false, false, 200).await;
            let error = transfer(
                root.path(),
                &destination(),
                ID,
                Direction::Download,
                &expected,
                ticket,
            )
            .await
            .unwrap_err();
            if fail_storage {
                assert!(matches!(error, TransferError::Storage { .. }));
            } else {
                assert!(matches!(error, TransferError::Conflict { .. }));
            }
            server.await.unwrap();
            assert!(!blobs_directory(root.path(), &destination())
                .unwrap()
                .join(ID)
                .exists());
        }
    }

    #[test]
    fn generic_transfer_size_exceeds_riff_without_number_rounding() {
        let mut expected = Content {
            sha256: "a".repeat(64),
            size: MAX_SIZE,
            content_type: "application/octet-stream".into(),
        };
        assert!(validate(&expected, ID).is_ok());
        assert_eq!(expected.size as u64, 5 * 1024 * 1024 * 1024);
        expected.size += 1.0;
        assert!(validate(&expected, ID).is_err());
    }

    #[tokio::test]
    async fn invalid_downloads_never_publish_and_status_is_preserved() {
        for (bytes, corrupt, status, kind) in [
            (CHUNK + 1, false, 200, "conflict"),
            (CHUNK, true, 200, "conflict"),
            (CHUNK - 1, false, 200, "conflict"),
            (0, false, 404, "transport"),
            (0, false, 302, "transport"),
        ] {
            let root = tempfile::tempdir().unwrap();
            let (ticket, server) = peer(bytes, corrupt, false, status).await;
            let error = transfer(
                root.path(),
                &destination(),
                ID,
                Direction::Download,
                &content(CHUNK),
                ticket,
            )
            .await
            .unwrap_err();
            assert_eq!(serde_json::to_value(error).unwrap()["kind"], kind);
            server.await.unwrap();
            assert!(!blobs_directory(root.path(), &destination())
                .unwrap()
                .join(ID)
                .exists());
        }
    }

    #[tokio::test]
    async fn upload_verifies_local_content_and_409_is_not_equal_content_proof() {
        let root = tempfile::tempdir().unwrap();
        let expected = content(CHUNK * 3);
        let directory = local(root.path(), &expected).await;
        let (ticket, server) = peer(expected.size as usize, false, false, 409).await;
        let error = transfer(
            root.path(),
            &destination(),
            ID,
            Direction::Upload,
            &expected,
            ticket,
        )
        .await
        .unwrap_err();
        assert!(matches!(
            error,
            TransferError::Transport {
                status: Some(409),
                ..
            }
        ));
        assert_eq!(server.await.unwrap(), expected.size as usize);
        std::fs::write(directory.join("data"), b"corrupt").unwrap();
        let error = transfer(
            root.path(),
            &destination(),
            ID,
            Direction::Upload,
            &expected,
            Ticket {
                url: "http://127.0.0.1:1/must-not-connect".into(),
                required_headers: HashMap::from([
                    ("content-type".into(), "audio/wav".into()),
                    ("if-none-match".into(), "*".into()),
                ]),
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(error, TransferError::Conflict { .. }));
    }

    #[tokio::test]
    async fn abort_drops_body_and_private_staging_without_installing_bytes() {
        let mut cases = tokio::task::JoinSet::new();
        let expected = content(CHUNK * 128);
        for delay in 1..=24 {
            let expected = expected.clone();
            cases.spawn(async move {
                let root = tempfile::tempdir().unwrap();
                let (ticket, server) = peer(expected.size as usize, false, true, 200).await;
                let token = CancellationToken::new();
                let cancelling = token.clone();
                let staging = blobs_directory(root.path(), &destination())
                    .unwrap()
                    .join(".staging/rust");
                let cancel = tokio::spawn(async move {
                    tokio::time::timeout(std::time::Duration::from_secs(10), async {
                        loop {
                            let written = std::fs::read_dir(&staging).is_ok_and(|entries| {
                                entries.flatten().any(|entry| {
                                    entry
                                        .path()
                                        .join("data")
                                        .metadata()
                                        .is_ok_and(|metadata| metadata.len() > 0)
                                })
                            });
                            if written {
                                break;
                            }
                            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
                        }
                    })
                    .await
                    .expect("transfer must write staging bytes before cancellation");
                    tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                    cancelling.cancel();
                });
                let result = super::transfer(
                    root.path(),
                    &destination(),
                    ID,
                    Direction::Download,
                    &expected,
                    ticket,
                    &token,
                )
                .await;
                cancel.await.unwrap();
                assert!(matches!(result, Err(TransferError::Transport { .. })));
                assert!(server.await.unwrap() < expected.size as usize);
                let directory = blobs_directory(root.path(), &destination()).unwrap();
                assert!(!directory.join(ID).exists());
                let staging = directory.join(".staging/rust");
                if staging.exists() {
                    assert_eq!(std::fs::read_dir(staging).unwrap().count(), 0);
                }
            });
        }
        while let Some(result) = cases.join_next().await {
            result.unwrap();
        }
    }

    #[tokio::test]
    async fn exact_cancel_and_document_retirement_abort_real_http_without_publishing() {
        for retire in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let expected = content(CHUNK * 128);
            let transfers = std::sync::Arc::new(Transfers::default());
            let epoch = transfers.epoch("window").unwrap();
            let token = transfers.admit("window", epoch, "1").unwrap();
            let cancelling = transfers.clone();
            let cancel = tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(30)).await;
                if retire {
                    cancelling.retire("window");
                } else {
                    cancelling.cancel("window", epoch, "1").unwrap();
                }
            });
            let (ticket, server) = peer(expected.size as usize, false, true, 200).await;
            let destination = destination();
            let result = super::transfer(
                root.path(),
                &destination,
                ID,
                Direction::Download,
                &expected,
                ticket,
                &token,
            )
            .await;
            cancel.await.unwrap();
            assert!(matches!(result, Err(TransferError::Transport { .. })));
            assert!(server.await.unwrap() < expected.size as usize);
            assert!(!blobs_directory(root.path(), &destination)
                .unwrap()
                .join(ID)
                .exists());
            transfers.finish("window", epoch, "1");
            assert!(transfers.admit("window", epoch, "1").is_err());
        }
    }

    fn resident_kib() -> u64 {
        let output = std::process::Command::new("ps")
            .args(["-o", "rss=", "-p", &std::process::id().to_string()])
            .output()
            .unwrap();
        String::from_utf8(output.stdout)
            .unwrap()
            .trim()
            .parse()
            .unwrap()
    }

    #[tokio::test]
    #[ignore = "explicit isolated-process native HTTP memory measurement"]
    async fn native_http_memory_evidence() {
        let bytes: usize = std::env::var("EPICENTER_TRANSFER_EVIDENCE_BYTES")
            .unwrap()
            .parse()
            .unwrap();
        let expected = content(bytes);
        for direction in [Direction::Upload, Direction::Download] {
            let root = tempfile::tempdir().unwrap();
            if matches!(direction, Direction::Upload) {
                local(root.path(), &expected).await;
            }
            let baseline = resident_kib();
            let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let sampling = stop.clone();
            let sampler = std::thread::spawn(move || {
                let mut peak = baseline;
                while !sampling.load(std::sync::atomic::Ordering::Relaxed) {
                    peak = peak.max(resident_kib());
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                peak
            });
            let (ticket, server) = peer(bytes, false, true, 200).await;
            let outcome = transfer(
                root.path(),
                &destination(),
                ID,
                direction,
                &expected,
                ticket,
            )
            .await;
            stop.store(true, std::sync::atomic::Ordering::Relaxed);
            let peak = sampler.join().unwrap();
            outcome.unwrap();
            assert_eq!(server.await.unwrap(), bytes);
            println!("NATIVE_HTTP_MEMORY direction={direction:?} bytes={bytes} baseline_kib={baseline} peak_kib={peak} growth_kib={}", peak.saturating_sub(baseline));
            assert!(
                peak.saturating_sub(baseline) < 64 * 1024,
                "native transfer resident growth must remain below 64MiB"
            );
        }
    }
}
