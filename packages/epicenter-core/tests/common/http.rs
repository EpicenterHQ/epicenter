//! A Git remote over HTTP for the transport tests: smart HTTP through stock
//! `git http-backend` (CGI), and the Git LFS batch API with the basic
//! transfer, both under `<origin>/<name>.git` and both requiring
//! `Authorization: Bearer <token>`. Every request is recorded with whether
//! it carried the token. The Bun suite's `remote.test-support.ts` is the
//! same server in TypeScript.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use tiny_http::{Header, Request, Response, Server};

#[derive(Clone, Debug)]
pub struct Seen {
    pub line: String,
    /// The request carried the server's token.
    pub authorized: bool,
    /// The `Authorization` header it carried, if any.
    pub authorization: Option<String>,
}

pub struct HttpRemote {
    /// `http://127.0.0.1:<port>`.
    pub origin: String,
    pub requests: Arc<Mutex<Vec<Seen>>>,
    server: Arc<Server>,
}

impl Drop for HttpRemote {
    fn drop(&mut self) {
        self.server.unblock();
    }
}

impl HttpRemote {
    pub fn seen(&self) -> Vec<Seen> {
        self.requests.lock().unwrap().clone()
    }
}

/// Serve the bare repositories under `root` until the remote drops.
pub fn serve(root: &Path, token: &str) -> HttpRemote {
    start(root, Some(token), None)
}

/// A remote whose LFS answers send object transfers to a second server on
/// another origin, as a presigned storage URL would; the store takes any
/// request and keeps the same objects.
pub fn serve_with_store(root: &Path, token: &str) -> (HttpRemote, HttpRemote) {
    let store = start(root, None, None);
    let remote = start(root, Some(token), Some(store.origin.clone()));
    (remote, store)
}

fn start(root: &Path, token: Option<&str>, store: Option<String>) -> HttpRemote {
    let server = Arc::new(Server::http("127.0.0.1:0").unwrap());
    let port = server.server_addr().to_ip().unwrap().port();
    let origin = format!("http://127.0.0.1:{port}");
    let requests = Arc::new(Mutex::new(Vec::new()));
    let context = Arc::new(Context {
        root: root.to_path_buf(),
        objects: root.join("lfs-objects"),
        store: store.unwrap_or_else(|| origin.clone()),
        bearer: token.map(|t| format!("Bearer {t}")),
        requests: requests.clone(),
    });
    std::fs::create_dir_all(&context.objects).unwrap();
    let listening = server.clone();
    std::thread::spawn(move || {
        for request in listening.incoming_requests() {
            let context = context.clone();
            std::thread::spawn(move || context.answer(request));
        }
    });
    HttpRemote {
        origin,
        requests,
        server,
    }
}

struct Context {
    root: PathBuf,
    objects: PathBuf,
    /// The origin LFS object transfers are sent to.
    store: String,
    /// The token every request must carry; None takes any request.
    bearer: Option<String>,
    requests: Arc<Mutex<Vec<Seen>>>,
}

fn header(request: &Request, name: &str) -> Option<String> {
    request
        .headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str().to_string())
}

fn respond(request: Request, status: u16, headers: &[(String, String)], body: Vec<u8>) {
    let mut response = Response::from_data(body).with_status_code(status);
    for (name, value) in headers {
        response =
            response.with_header(Header::from_bytes(name.as_bytes(), value.as_bytes()).unwrap());
    }
    let _ = request.respond(response);
}

impl Context {
    fn answer(&self, mut request: Request) {
        let url = request.url().to_string();
        let carried = header(&request, "authorization");
        let authorized = carried.is_some() && carried == self.bearer;
        self.requests.lock().unwrap().push(Seen {
            line: format!("{} {url}", request.method()),
            authorized,
            authorization: carried,
        });
        if self.bearer.is_some() && !authorized {
            return respond(request, 403, &[], b"a bearer token is required".to_vec());
        }
        let mut body = Vec::new();
        request.as_reader().read_to_end(&mut body).unwrap();
        let (path, query) = url.split_once('?').unwrap_or((&url, ""));
        let (status, headers, out) = if path.contains("/info/lfs/") {
            self.lfs(request.method().as_str(), path, &body)
        } else {
            self.git(&request, path, query, &body)
        };
        respond(request, status, &headers, out);
    }

    fn lfs(&self, method: &str, path: &str, body: &[u8]) -> (u16, Vec<(String, String)>, Vec<u8>) {
        let json = vec![(
            "content-type".to_string(),
            "application/vnd.git-lfs+json".to_string(),
        )];
        let repo = path.trim_start_matches('/').split('/').next().unwrap();
        if path.ends_with("/info/lfs/objects/batch") {
            let asked: serde_json::Value = serde_json::from_slice(body).unwrap();
            let upload = asked["operation"] == "upload";
            let objects: Vec<serde_json::Value> = asked["objects"]
                .as_array()
                .unwrap()
                .iter()
                .map(|o| {
                    let oid = o["oid"].as_str().unwrap();
                    let href = format!("{}/{repo}/info/lfs/objects/{oid}", self.store);
                    let stored = self.objects.join(oid).exists();
                    match (upload, stored) {
                        (true, true) => serde_json::json!({ "oid": oid, "size": o["size"] }),
                        (true, false) => serde_json::json!({ "oid": oid, "size": o["size"], "actions": { "upload": { "href": href } } }),
                        (false, true) => serde_json::json!({ "oid": oid, "size": o["size"], "actions": { "download": { "href": href } } }),
                        (false, false) => serde_json::json!({ "oid": oid, "size": o["size"], "error": { "code": 404, "message": "not found" } }),
                    }
                })
                .collect();
            let answer = serde_json::json!({ "transfer": "basic", "objects": objects });
            return (200, json, answer.to_string().into_bytes());
        }
        let oid = path.rsplit('/').next().unwrap();
        let stored = self.objects.join(oid);
        match method {
            "PUT" => {
                let actual = epicenter_core::lfs::Pointer::of(body).oid;
                if actual != oid {
                    return (422, vec![], b"oid mismatch".to_vec());
                }
                std::fs::write(stored, body).unwrap();
                (200, vec![], vec![])
            }
            _ => match std::fs::read(stored) {
                Ok(bytes) => (200, vec![], bytes),
                Err(_) => (404, vec![], b"not found".to_vec()),
            },
        }
    }

    /// Smart HTTP through `git http-backend`, as CGI.
    fn git(
        &self,
        request: &Request,
        path: &str,
        query: &str,
        body: &[u8],
    ) -> (u16, Vec<(String, String)>, Vec<u8>) {
        let mut cgi = Command::new("git");
        cgi.arg("http-backend")
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("GIT_PROJECT_ROOT", &self.root)
            .env("GIT_HTTP_EXPORT_ALL", "1")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            // A signed-in user: http-backend enables receive-pack for one.
            .env("REMOTE_USER", "tester")
            .env("REMOTE_ADDR", "127.0.0.1")
            .env("REQUEST_METHOD", request.method().as_str())
            .env("PATH_INFO", path)
            .env("QUERY_STRING", query)
            .env(
                "CONTENT_TYPE",
                header(request, "content-type").unwrap_or_default(),
            )
            .env("CONTENT_LENGTH", body.len().to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if let Some(protocol) = header(request, "git-protocol") {
            cgi.env("GIT_PROTOCOL", protocol);
        }
        let mut child = cgi.spawn().unwrap();
        child.stdin.take().unwrap().write_all(body).unwrap();
        let out = child.wait_with_output().unwrap().stdout;
        let split = out.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        let mut status = 200;
        let mut headers = Vec::new();
        for line in String::from_utf8_lossy(&out[..split]).split("\r\n") {
            let (name, value) = line.split_once(':').unwrap();
            let value = value.trim().to_string();
            if name.eq_ignore_ascii_case("status") {
                status = value[..3].parse().unwrap();
            } else {
                headers.push((name.to_string(), value));
            }
        }
        (status, headers, out[split + 4..].to_vec())
    }
}
