//! Git LFS without `git-lfs`: pointers, the local object store in the
//! layout `git-lfs` itself uses (`.git/lfs/objects/<aa>/<bb>/<oid>`), and
//! the batch API over HTTP with the basic transfer, mirroring
//! `packages/folder/src/remote/wire.ts`.
//!
//! Because the store layout is git-lfs's own, a person's stock `git lfs push`
//! or `git lfs checkout` in the same folder finds the objects this core wrote.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use ureq::http::Response;
use ureq::Body;

use crate::http::{self, agent, origin};
use crate::Error;

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Pointer {
    pub oid: String,
    pub size: u64,
}

const VERSION: &str = "version https://git-lfs.github.com/spec/v1\n";

impl Pointer {
    pub fn of(bytes: &[u8]) -> Pointer {
        Pointer {
            oid: hex(&Sha256::digest(bytes)),
            size: bytes.len() as u64,
        }
    }

    pub fn text(&self) -> String {
        format!("{VERSION}oid sha256:{}\nsize {}\n", self.oid, self.size)
    }

    /// The pointer a blob holds, or None when the blob is not exactly one
    /// (the same strict form as `parsePointer` in `@epicenter/definition`).
    pub fn parse(bytes: &[u8]) -> Option<Pointer> {
        if bytes.len() > 200 {
            return None;
        }
        let text = std::str::from_utf8(bytes).ok()?;
        let rest = text.strip_prefix(VERSION)?;
        let rest = rest.strip_prefix("oid sha256:")?;
        let (oid, rest) = rest.split_once('\n')?;
        let size = rest.strip_prefix("size ")?.strip_suffix('\n')?;
        if oid.len() != 64 || !oid.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
            return None;
        }
        if size.is_empty() || !size.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        Some(Pointer {
            oid: oid.to_string(),
            size: size.parse().ok()?,
        })
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Where `oid` lives in a repository's local LFS store.
pub fn object_path(git_dir: &Path, oid: &str) -> PathBuf {
    git_dir
        .join("lfs/objects")
        .join(&oid[0..2])
        .join(&oid[2..4])
        .join(oid)
}

pub fn has_local(git_dir: &Path, pointer: &Pointer) -> bool {
    fs::metadata(object_path(git_dir, &pointer.oid))
        .map(|m| m.len() == pointer.size)
        .unwrap_or(false)
}

/// Store `bytes` as an object (the clean filter's job) and return its pointer.
pub fn store(git_dir: &Path, bytes: &[u8]) -> Result<Pointer, Error> {
    let pointer = Pointer::of(bytes);
    if !has_local(git_dir, &pointer) {
        write_object(git_dir, &pointer.oid, bytes)?;
    }
    Ok(pointer)
}

fn write_object(git_dir: &Path, oid: &str, bytes: &[u8]) -> Result<(), Error> {
    let path = object_path(git_dir, oid);
    let dir = path.parent().expect("object path has a parent");
    fs::create_dir_all(dir)?;
    let tmp = git_dir.join("lfs/tmp");
    fs::create_dir_all(&tmp)?;
    let staged = tmp.join(format!("{oid}.{}", std::process::id()));
    fs::File::create(&staged)?.write_all(bytes)?;
    fs::rename(&staged, &path)?;
    Ok(())
}

/// The bytes of a stored object (the smudge filter's job).
pub fn read_local(git_dir: &Path, pointer: &Pointer) -> Result<Vec<u8>, Error> {
    fs::read(object_path(git_dir, &pointer.oid)).map_err(|e| {
        Error::retry(format!(
            "LFS object {} is not in the local store: {e}",
            pointer.oid
        ))
    })
}

/// Where a folder's LFS objects travel.
#[derive(Clone, Debug)]
pub enum Endpoint {
    /// The batch API under this URL (`<remote>.git/info/lfs`, or `lfs.url`).
    Http(String),
    /// A directory standing in for a server's store, for tests over `file://`
    /// remotes (git-lfs's own standalone file transfer plays this role).
    Dir(PathBuf),
}

#[derive(Serialize)]
struct BatchRequest<'a> {
    operation: &'a str,
    transfers: [&'a str; 1],
    objects: &'a [Pointer],
}

#[derive(Deserialize)]
struct BatchAnswer {
    objects: Vec<ObjectAnswer>,
}

#[derive(Deserialize)]
struct ObjectAnswer {
    oid: String,
    #[serde(default)]
    actions: Option<Actions>,
    #[serde(default)]
    error: Option<ObjectError>,
}

#[derive(Deserialize)]
struct Actions {
    upload: Option<Action>,
    download: Option<Action>,
}

#[derive(Deserialize)]
struct Action {
    href: String,
    #[serde(default)]
    header: std::collections::HashMap<String, String>,
}

#[derive(Deserialize)]
struct ObjectError {
    code: u16,
    message: String,
}

const LFS_JSON: &str = "application/vnd.git-lfs+json";

impl Endpoint {
    /// Store each object the server does not already have. Returns how many were sent.
    pub fn upload(
        &self,
        git_dir: &Path,
        objects: &[Pointer],
        token: Option<&str>,
    ) -> Result<usize, Error> {
        match self {
            Endpoint::Dir(dir) => {
                let mut sent = 0;
                for p in objects {
                    let to = dir.join(&p.oid);
                    if !to.exists() {
                        fs::create_dir_all(dir)?;
                        fs::copy(object_path(git_dir, &p.oid), &to)?;
                        sent += 1;
                    }
                }
                Ok(sent)
            }
            Endpoint::Http(url) => {
                let mut sent = 0;
                for chunk in objects.chunks(100) {
                    for answer in batch(url, "upload", chunk, token)? {
                        let Some(action) = answer.actions.and_then(|a| a.upload) else {
                            continue;
                        };
                        let pointer =
                            chunk.iter().find(|p| p.oid == answer.oid).ok_or_else(|| {
                                Error::stopped(format!(
                                    "the LFS server answered for an object not asked: {}",
                                    answer.oid
                                ))
                            })?;
                        let bytes = read_local(git_dir, pointer)?;
                        let mut request = agent()
                            .put(&action.href)
                            .header("content-type", "application/octet-stream");
                        for (name, value) in action_headers(url, &action, token) {
                            request = request.header(name, value);
                        }
                        checked(request.send(&bytes))?;
                        sent += 1;
                    }
                }
                Ok(sent)
            }
        }
    }

    /// Fetch each object into the local store, checked against its oid and size.
    pub fn download(
        &self,
        git_dir: &Path,
        objects: &[Pointer],
        token: Option<&str>,
    ) -> Result<usize, Error> {
        let mut got = 0;
        match self {
            Endpoint::Dir(dir) => {
                for p in objects {
                    let bytes = fs::read(dir.join(&p.oid)).map_err(|e| {
                        Error::retry(format!("LFS object {} unavailable: {e}", p.oid))
                    })?;
                    check_and_store(git_dir, p, &bytes)?;
                    got += 1;
                }
            }
            Endpoint::Http(url) => {
                for chunk in objects.chunks(100) {
                    for answer in batch(url, "download", chunk, token)? {
                        let pointer =
                            chunk.iter().find(|p| p.oid == answer.oid).ok_or_else(|| {
                                Error::stopped(format!(
                                    "the LFS server answered for an object not asked: {}",
                                    answer.oid
                                ))
                            })?;
                        let action = answer.actions.and_then(|a| a.download).ok_or_else(|| {
                            Error::retry(format!("{} has no download", pointer.oid))
                        })?;
                        let mut request = agent().get(&action.href);
                        for (name, value) in action_headers(url, &action, token) {
                            request = request.header(name, value);
                        }
                        let response = checked(request.call())?;
                        let mut bytes = Vec::with_capacity(pointer.size as usize);
                        response
                            .into_body()
                            .into_reader()
                            .take(pointer.size + 1)
                            .read_to_end(&mut bytes)?;
                        check_and_store(git_dir, pointer, &bytes)?;
                        got += 1;
                    }
                }
            }
        }
        Ok(got)
    }
}

fn check_and_store(git_dir: &Path, p: &Pointer, bytes: &[u8]) -> Result<(), Error> {
    if Pointer::of(bytes) != *p {
        return Err(Error::retry(format!(
            "the bytes downloaded for {} are not that object",
            p.oid
        )));
    }
    write_object(git_dir, &p.oid, bytes)
}

/// The headers an action is sent with: the ones the batch answer named,
/// and the bearer token only when the action is on the LFS server's own
/// origin (not a presigned store URL) and names no authorization itself.
fn action_headers(lfs_url: &str, action: &Action, token: Option<&str>) -> Vec<(String, String)> {
    let mut headers: Vec<(String, String)> = action
        .header
        .iter()
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect();
    let names_auth = headers
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("authorization"));
    if let Some(token) = token {
        if !names_auth && origin(&action.href) == origin(lfs_url) {
            headers.push(("authorization".into(), format!("Bearer {token}")));
        }
    }
    headers
}

fn batch(
    url: &str,
    operation: &str,
    objects: &[Pointer],
    token: Option<&str>,
) -> Result<Vec<ObjectAnswer>, Error> {
    let body = serde_json::to_string(&BatchRequest {
        operation,
        transfers: ["basic"],
        objects,
    })
    .expect("a batch request serializes");
    let mut request = agent()
        .post(format!("{url}/objects/batch"))
        .header("accept", LFS_JSON)
        .header("content-type", LFS_JSON);
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let response = checked(request.send(body))?;
    let answer: BatchAnswer = serde_json::from_reader(response.into_body().into_reader())
        .map_err(|e| Error::retry(format!("the LFS batch answer is not JSON: {e}")))?;
    if let Some(failed) = answer
        .objects
        .iter()
        .find_map(|o| o.error.as_ref().map(|e| (o, e)))
    {
        return Err(Error::retry(format!(
            "the LFS server refused {} ({}): {}",
            failed.0.oid, failed.1.code, failed.1.message
        )));
    }
    Ok(answer.objects)
}

/// A response with a success status, or the round's error for the request.
fn checked(sent: Result<Response<Body>, ureq::Error>) -> Result<Response<Body>, Error> {
    let response = sent.map_err(|e| Error::retry(format!("LFS transfer failed: {e}")))?;
    http::success(response).map_err(|refused| match refused.status {
        401 | 403 => Error::stopped(format!(
            "the LFS server refused this account ({})",
            refused.status
        )),
        status => Error::retry(format!(
            "the LFS server answered {status}: {}",
            refused.body
        )),
    })
}
