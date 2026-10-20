//! The `epicenter-app` scheme: Rust serves every page Epicenter shows from the
//! one origin `epicenter-app://localhost` (ADR-0561).
//!
//! ```txt
//! epicenter-app://localhost/<page>/…                Epicenter's own pages (`BuiltInApp`), from `<pages>/<page>/`
//! epicenter-app://localhost/<page>/…                an app Epicenter bundles (`BundledApp`), from `<pages>/<page>/`
//! epicenter-app://localhost/apps/<id>/<commit>/…    an installed app's build of one commit, from `<builds>/<id>/<commit>/`
//! ```
//!
//! An installed app's URL names its commit, so a window keeps the build it
//! opened on, every file of it, until it is opened again; a newer build only
//! changes which commit the next window opens (ADR-0588).
//!
//! The handler answers GET only. It serves a regular file inside the page's
//! or the app's directory and refuses a symbolic link and anything outside it;
//! an extensionless path that names no file is a client-side route and gets
//! that directory's `index.html`. Every response carries the one
//! Content-Security-Policy, and a document's policy also admits each of its
//! inline scripts by hash.

use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use percent_encoding::percent_decode_str;
use sha2::{Digest, Sha256};
use tauri::http::{header, Method, Request, Response, StatusCode};
use tauri::utils::mime_type::MimeType;
use tauri::{Builder, Manager, Runtime, Url};

use crate::bundled_apps::BundledApp;
use crate::{installed_apps, BuiltInApp};

/// The scheme every Epicenter window loads. Not `epicenter`, the deep-link
/// scheme.
pub const SCHEME: &str = "epicenter-app";
const HOST: &str = "localhost";

/// The directories the scheme reads, resolved once at startup.
pub struct Roots {
    /// Epicenter's own pages, one directory per `BuiltInApp` id, and each
    /// bundled app's build, one directory per `BundledApp` page.
    pub pages: PathBuf,
    /// Installed apps' builds: `<builds>/<id>/<commit>/`, the commit named by
    /// the URL (ADR-0588).
    pub builds: PathBuf,
}

/// Where Epicenter's own pages are built. A development build reads the
/// app's `dist/`, which `bun run build` writes; a release reads the copy
/// bundled as `apps-dist`.
#[cfg(debug_assertions)]
pub fn pages_dir<R: Runtime>(_app: &tauri::AppHandle<R>) -> tauri::Result<PathBuf> {
    Ok(Path::new(env!("CARGO_MANIFEST_DIR")).join("../dist"))
}

#[cfg(not(debug_assertions))]
pub fn pages_dir<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<PathBuf> {
    Ok(app.path().resource_dir()?.join("apps-dist"))
}

/// The URL of `path` on the scheme's origin. `path` starts with `/`.
pub fn url(path: &str) -> anyhow::Result<Url> {
    Ok(format!("{SCHEME}://{HOST}{path}").parse()?)
}

/// The path installed app `id`'s build of `commit` is served below.
pub fn installed_app_path(id: &str, commit: &str) -> String {
    format!("/apps/{id}/{commit}/")
}

/// Whether a window opened at `prefix`, the path its page is served below,
/// may navigate to `url`: only on the one origin, and only below that path,
/// so a built-in page's window stays that page, and an installed app's
/// window stays on its app and the commit it opened on.
pub fn is_allowed_navigation(prefix: &str, url: &Url) -> bool {
    url.scheme() == SCHEME
        && url.host_str() == Some(HOST)
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && prefix.starts_with('/')
        && prefix.ends_with('/')
        && url.path().starts_with(prefix)
}

/// Register the scheme. A response is read off disk on a blocking thread, so
/// no request holds up the main thread.
pub fn register<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    builder.register_asynchronous_uri_scheme_protocol(SCHEME, |context, request, responder| {
        let app = context.app_handle().clone();
        tauri::async_runtime::spawn_blocking(move || {
            let response = match app.try_state::<Roots>() {
                Some(roots) => respond(&roots, &request),
                None => plain(StatusCode::SERVICE_UNAVAILABLE, "Epicenter is starting."),
            };
            responder.respond(response);
        });
    })
}

/// The response to one request.
fn respond(roots: &Roots, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    if request.method() != Method::GET {
        let mut response = plain(StatusCode::METHOD_NOT_ALLOWED, "Method Not Allowed");
        response
            .headers_mut()
            .insert(header::ALLOW, header::HeaderValue::from_static("GET"));
        return response;
    }
    let path = request.uri().path();
    match resolve(roots, path) {
        Some(file) => serve(&file),
        None => {
            log::warn!("{SCHEME}: nothing to serve at {path}");
            plain(StatusCode::NOT_FOUND, "Not Found")
        }
    }
}

/// The file `path` names, or `None` when it names nothing this scheme serves.
fn resolve(roots: &Roots, path: &str) -> Option<PathBuf> {
    let decoded = percent_decode_str(path).decode_utf8().ok()?;
    if decoded.contains(['\0', '\\']) {
        return None;
    }
    let segments: Vec<&str> = decoded.strip_prefix('/')?.split('/').collect();
    let last = segments.len() - 1;
    if segments.iter().enumerate().any(|(index, segment)| {
        matches!(*segment, "." | "..") || (segment.is_empty() && index != last)
    }) {
        return None;
    }

    let (root, rest) = match segments.as_slice() {
        ["apps", id, commit, rest @ ..] => {
            if !installed_apps::is_app_id(id) || !installed_apps::is_commit(commit) {
                return None;
            }
            let app = roots.builds.join(id);
            let build = app.join(commit);
            // `contained_file` canonicalizes the root, so a linked app or
            // build directory is refused here, before it would be followed.
            if !is_real_directory(&app) || !is_real_directory(&build) {
                return None;
            }
            (build, rest)
        }
        [page, rest @ ..] => {
            let root = roots.pages.join(page_dir(page)?);
            if !is_real_directory(&root) {
                return None;
            }
            (root, rest)
        }
        [] => return None,
    };
    contained_file(&root, rest)
}

/// The directory below the pages directory that serves `page`: one of
/// Epicenter's own pages, or an app Epicenter bundles.
fn page_dir(page: &str) -> Option<&'static str> {
    match BuiltInApp::from_id(page) {
        Some(built_in) => Some(built_in.id()),
        None => BundledApp::from_page(page).map(BundledApp::page),
    }
}

/// The regular file at `rest` below `root`, or `root`'s `index.html` for a
/// client-side route. A path through a symbolic link, or one that leaves
/// `root`, resolves to nothing.
fn contained_file(root: &Path, rest: &[&str]) -> Option<PathBuf> {
    let root = root.canonicalize().ok()?;
    let named: Vec<&str> = rest.iter().copied().filter(|s| !s.is_empty()).collect();
    if let Some(last) = named.last() {
        let lexical = named
            .iter()
            .fold(root.clone(), |path, segment| path.join(segment));
        if let Some(file) = regular_file(&lexical) {
            return Some(file);
        }
        // Something is there that is not a plain file inside `root`: a link,
        // or a path that leaves it. A directory falls through to the route.
        if lexical.symlink_metadata().is_ok() && !lexical.is_dir() {
            return None;
        }
        if lexical
            .canonicalize()
            .is_ok_and(|canonical| canonical != lexical)
        {
            return None;
        }
        // A missing asset stays an honest 404; only a route gets the document.
        if last.contains('.') {
            return None;
        }
    }
    regular_file(&root.join("index.html"))
}

/// Whether `path` is a directory and not a symbolic link to one.
fn is_real_directory(path: &Path) -> bool {
    path.symlink_metadata()
        .is_ok_and(|metadata| metadata.is_dir())
}

/// `path` itself when it is a regular file reached through no symbolic link.
fn regular_file(path: &Path) -> Option<PathBuf> {
    let canonical = path.canonicalize().ok()?;
    (canonical == path && canonical.is_file()).then_some(canonical)
}

fn serve(file: &Path) -> Response<Vec<u8>> {
    let Ok(body) = std::fs::read(file) else {
        return plain(StatusCode::NOT_FOUND, "Not Found");
    };
    let mime = MimeType::parse_with_fallback(&body, &file.to_string_lossy(), MimeType::OctetStream);
    let policy = if mime == "text/html" {
        content_security_policy(&String::from_utf8_lossy(&body))
    } else {
        content_security_policy("")
    };
    // Text a page builds from is UTF-8; naming it keeps the browser from
    // guessing another encoding for a file without a `<meta charset>`.
    let content_type = if UTF8_TYPES.contains(&mime.as_str()) {
        format!("{mime}; charset=utf-8")
    } else {
        mime
    };
    response(StatusCode::OK, &content_type, &policy, body)
}

const UTF8_TYPES: &[&str] = &[
    "text/html",
    "text/javascript",
    "text/css",
    "application/json",
    "image/svg+xml",
];

fn plain(status: StatusCode, text: &str) -> Response<Vec<u8>> {
    response(
        status,
        "text/plain; charset=utf-8",
        &content_security_policy(""),
        text.as_bytes().to_vec(),
    )
}

fn response(
    status: StatusCode,
    content_type: &str,
    policy: &str,
    body: Vec<u8>,
) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_SECURITY_POLICY, policy)
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::REFERRER_POLICY, "no-referrer")
        .body(body)
        .expect("a response built from valid header values")
}

/// The one policy every response is served: a page talks to its own origin
/// and Tauri's IPC, and to no one else. `document` is the HTML whose inline
/// scripts it admits by hash, or empty for any other response.
///
/// `'wasm-unsafe-eval'` permits WebAssembly compilation and nothing else; it
/// does not restore `eval`. Voice activity detection runs onnxruntime in the
/// page, so the browser would otherwise refuse the compile.
fn content_security_policy(document: &str) -> String {
    let hashes: String = inline_scripts(document)
        .into_iter()
        .map(|script| {
            format!(
                " 'sha256-{}'",
                STANDARD.encode(Sha256::digest(script.as_bytes()))
            )
        })
        .collect();
    [
        "default-src 'self'".to_string(),
        format!("script-src 'self' 'wasm-unsafe-eval'{hashes}"),
        "style-src 'self' 'unsafe-inline'".to_string(),
        "connect-src 'self' ipc: http://ipc.localhost".to_string(),
        "img-src 'self' data: blob:".to_string(),
        "media-src 'self' data: blob:".to_string(),
        "worker-src 'self' blob:".to_string(),
        "object-src 'none'".to_string(),
        "base-uri 'self'".to_string(),
        "frame-ancestors 'none'".to_string(),
    ]
    .join("; ")
}

/// The text of each non-empty `<script>` element in `html`.
fn inline_scripts(html: &str) -> Vec<&str> {
    const OPEN: &str = "<script";
    const CLOSE: &str = "</script";
    // ASCII lowercasing keeps every byte offset, so offsets into `lower`
    // index `html`.
    let lower = html.to_ascii_lowercase();
    let mut scripts = Vec::new();
    let mut from = 0;
    while let Some(found) = lower[from..].find(OPEN) {
        let after_name = from + found + OPEN.len();
        if !lower[after_name..]
            .starts_with(|c: char| c == '>' || c == '/' || c.is_ascii_whitespace())
        {
            from = after_name;
            continue;
        }
        let Some(tag_end) = lower[after_name..].find('>') else {
            break;
        };
        let body_start = after_name + tag_end + 1;
        let Some(body_length) = lower[body_start..].find(CLOSE) else {
            break;
        };
        let body = &html[body_start..body_start + body_length];
        if !body.is_empty() {
            scripts.push(body);
        }
        from = body_start + body_length + CLOSE.len();
    }
    scripts
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const COMMIT: &str = "0123456789abcdef0123456789abcdef01234567";
    /// An earlier build of the same app, which a window opened before
    /// `COMMIT` was built still runs.
    const EARLIER: &str = "89abcdef0123456789abcdef0123456789abcdef";
    const BOARD: &str = "/apps/com.example.board/0123456789abcdef0123456789abcdef01234567/";

    /// A pages directory with Folders, Settings, and each bundled app, and
    /// two builds of one installed app, `COMMIT` the newer, under a fresh
    /// temporary directory.
    fn fixture() -> (tempfile::TempDir, Roots) {
        let temporary = tempfile::tempdir().unwrap();
        let base = temporary.path().canonicalize().unwrap();
        let pages = base.join("pages");
        let builds = base.join("builds");
        let bundled = BundledApp::ALL.map(BundledApp::page);
        for page in ["folders", "home"].into_iter().chain(bundled) {
            fs::create_dir_all(pages.join(page).join("assets")).unwrap();
            fs::write(
                pages.join(page).join("index.html"),
                format!("<!doctype html><title>{page}</title>"),
            )
            .unwrap();
        }
        fs::write(pages.join("folders/assets/index-abc.js"), "export {};").unwrap();
        fs::write(pages.join("folders/assets/index-abc.css"), "body{}").unwrap();
        fs::write(pages.join("folders/assets/data.json"), "{}").unwrap();
        fs::write(
            pages.join("folders/assets/icon.svg"),
            "<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
        )
        .unwrap();
        fs::write(pages.join("secret.txt"), "outside every page").unwrap();
        let app = builds.join("com.example.board");
        fs::create_dir_all(app.join(COMMIT).join("assets")).unwrap();
        fs::write(
            app.join(COMMIT).join("index.html"),
            "<html><script>boot()</script></html>",
        )
        .unwrap();
        fs::write(app.join(COMMIT).join("assets/app.wasm"), b"\0asm\x01\0\0\0").unwrap();
        fs::write(app.join(COMMIT).join("assets/chunk-new.js"), "new").unwrap();
        fs::create_dir_all(app.join(EARLIER).join("assets")).unwrap();
        fs::write(app.join(EARLIER).join("index.html"), "<html>earlier</html>").unwrap();
        fs::write(app.join(EARLIER).join("assets/chunk-old.js"), "old").unwrap();
        (temporary, Roots { pages, builds })
    }

    fn get(roots: &Roots, path: &str) -> Response<Vec<u8>> {
        let request = Request::builder()
            .uri(format!("{SCHEME}://{HOST}{path}"))
            .body(Vec::new())
            .unwrap();
        respond(roots, &request)
    }

    fn body(response: &Response<Vec<u8>>) -> String {
        String::from_utf8_lossy(response.body()).into_owned()
    }

    fn content_type(response: &Response<Vec<u8>>) -> &str {
        response.headers()[header::CONTENT_TYPE].to_str().unwrap()
    }

    #[test]
    fn serves_each_page_and_an_installed_apps_build_by_commit() {
        let (_temporary, roots) = fixture();
        assert_eq!(
            body(&get(&roots, "/folders/")),
            "<!doctype html><title>folders</title>"
        );
        assert_eq!(
            body(&get(&roots, "/home/")),
            "<!doctype html><title>home</title>"
        );
        // Each app Epicenter bundles, and its client-side routes.
        for app in BundledApp::ALL {
            let path = app.path();
            for page in [
                path.clone(),
                format!("{path}index.html"),
                format!("{path}todo/42"),
            ] {
                assert_eq!(
                    body(&get(&roots, &page)),
                    format!("<!doctype html><title>{}</title>", app.page()),
                    "{page}"
                );
            }
        }
        assert_eq!(
            body(&get(&roots, "/folders/index.html")),
            "<!doctype html><title>folders</title>"
        );
        assert_eq!(
            body(&get(&roots, "/folders/assets/index-abc.js")),
            "export {};"
        );
        assert_eq!(
            body(&get(&roots, BOARD)),
            "<html><script>boot()</script></html>"
        );
        // An app with no build, a URL naming no commit or one never built,
        // and a page Epicenter does not have.
        for missing in [
            "/apps/com.example.other/0123456789abcdef0123456789abcdef01234567/",
            "/apps/com.example.board/",
            "/apps/com.example.board",
            "/apps/com.example.board/current/",
            "/apps/com.example.board/HEAD/",
            "/apps/com.example.board/0123456789abcdef/",
            "/apps/com.example.board/ffffffffffffffffffffffffffffffffffffffff/",
            "/apps/",
            "/apps",
            "/unknown/",
            "/",
        ] {
            assert_eq!(
                get(&roots, missing).status(),
                StatusCode::NOT_FOUND,
                "{missing}"
            );
        }
    }

    /// A window keeps the build it opened on: every file of each commit comes
    /// from that commit's directory, so a page never mixes one build's
    /// document with another's chunks.
    #[test]
    fn each_commit_is_served_from_its_own_build() {
        let (_temporary, roots) = fixture();
        let earlier = format!("/apps/com.example.board/{EARLIER}/");
        assert_eq!(body(&get(&roots, &earlier)), "<html>earlier</html>");
        assert_eq!(
            body(&get(&roots, &format!("{earlier}assets/chunk-old.js"))),
            "old"
        );
        assert_eq!(
            body(&get(&roots, &format!("{earlier}todo/42"))),
            "<html>earlier</html>"
        );
        assert_eq!(
            body(&get(&roots, &format!("{BOARD}assets/chunk-new.js"))),
            "new"
        );
        for other_builds_chunk in [
            format!("{earlier}assets/chunk-new.js"),
            format!("{BOARD}assets/chunk-old.js"),
        ] {
            assert_eq!(
                get(&roots, &other_builds_chunk).status(),
                StatusCode::NOT_FOUND,
                "{other_builds_chunk}"
            );
        }
    }

    #[test]
    fn an_extensionless_route_falls_back_to_its_own_document() {
        let (_temporary, roots) = fixture();
        for route in [
            "/folders/data/notes",
            "/folders/assets/",
            "/folders",
            "/apps/com.example.board/0123456789abcdef0123456789abcdef01234567/board/42",
        ] {
            let response = get(&roots, route);
            assert_eq!(response.status(), StatusCode::OK, "{route}");
            assert_eq!(
                content_type(&response),
                "text/html; charset=utf-8",
                "{route}"
            );
        }
        assert_eq!(
            body(&get(
                &roots,
                "/apps/com.example.board/0123456789abcdef0123456789abcdef01234567/board/42"
            )),
            "<html><script>boot()</script></html>"
        );
        // A missing asset is not a route.
        for missing in [
            "/folders/assets/index-missing.js",
            "/apps/com.example.board/0123456789abcdef0123456789abcdef01234567/favicon.ico",
        ] {
            assert_eq!(
                get(&roots, missing).status(),
                StatusCode::NOT_FOUND,
                "{missing}"
            );
        }
    }

    #[test]
    fn nothing_outside_a_page_or_build_is_served() {
        let (temporary, roots) = fixture();
        for escape in [
            "/folders/../secret.txt",
            "/folders/%2e%2e/secret.txt",
            "/folders/%2E%2E/secret.txt",
            "/folders/..%2fsecret.txt",
            "/folders/..%5csecret.txt",
            "/folders/.%2e/secret.txt",
            "/folders/./index.html",
            "/folders//index.html",
            "/folders/%00index.html",
            "/folders/%ff",
            "/apps/com.example.board/../../pages/secret.txt",
            "/apps/..%2fpages/folders/",
            "/apps/%2e%2e/",
            "/apps/com.example.board%2f..%2f..%2fpages/folders/",
            "/apps/Com.Example.Board/",
            "/secret.txt",
        ] {
            let response = get(&roots, escape);
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{escape}");
            assert!(!body(&response).contains("outside"), "{escape}");
        }

        // A link is refused wherever it points, inside the page or out.
        let outside = temporary.path().join("outside.js");
        fs::write(&outside, "outside the page").unwrap();
        let assets = roots.pages.join("folders/assets");
        std::os::unix::fs::symlink(&outside, assets.join("escape.js")).unwrap();
        std::os::unix::fs::symlink(assets.join("index-abc.js"), assets.join("alias.js")).unwrap();
        std::os::unix::fs::symlink(temporary.path(), assets.join("up")).unwrap();
        for link in [
            "/folders/assets/escape.js",
            "/folders/assets/alias.js",
            "/folders/assets/up/outside.js",
            "/folders/assets/up",
        ] {
            let response = get(&roots, link);
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{link}");
        }

        // A page directory that is a link must not become the trusted root.
        fs::remove_dir_all(roots.pages.join("capture")).unwrap();
        std::os::unix::fs::symlink(temporary.path(), roots.pages.join("capture")).unwrap();
        assert_eq!(get(&roots, "/capture/").status(), StatusCode::NOT_FOUND);
        assert_eq!(
            get(&roots, "/capture/outside.js").status(),
            StatusCode::NOT_FOUND
        );

        // A build directory, or an app's builds directory, that is a link is
        // refused, wherever it points.
        let linked = "fedcba9876543210fedcba9876543210fedcba98";
        let app = roots.builds.join("com.example.board");
        std::os::unix::fs::symlink(app.join(COMMIT), app.join(linked)).unwrap();
        std::os::unix::fs::symlink(&app, roots.builds.join("com.example.alias")).unwrap();
        for link in [
            format!("/apps/com.example.board/{linked}/"),
            format!("/apps/com.example.board/{linked}/assets/app.wasm"),
            format!("/apps/com.example.alias/{COMMIT}/"),
        ] {
            assert_eq!(get(&roots, &link).status(), StatusCode::NOT_FOUND, "{link}");
        }
        // Uppercase hex names no build.
        assert_eq!(
            get(
                &roots,
                &format!("/apps/com.example.board/{}/", COMMIT.to_uppercase())
            )
            .status(),
            StatusCode::NOT_FOUND
        );

        // A commit segment that is not a commit never leaves the app's builds.
        for escape in [
            "/apps/com.example.board/..%2f..%2fpages/folders/",
            "/apps/com.example.board/%2e%2e/",
            "/apps/com.example.board/0123456789abcdef0123456789abcdef01234567%2f..%2f../",
        ] {
            assert_eq!(
                get(&roots, escape).status(),
                StatusCode::NOT_FOUND,
                "{escape}"
            );
        }
    }

    #[test]
    fn answers_get_alone() {
        let (_temporary, roots) = fixture();
        for method in [
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::HEAD,
            Method::OPTIONS,
        ] {
            let request = Request::builder()
                .method(method.clone())
                .uri(format!("{SCHEME}://{HOST}/folders/"))
                .body(Vec::new())
                .unwrap();
            let response = respond(&roots, &request);
            assert_eq!(
                response.status(),
                StatusCode::METHOD_NOT_ALLOWED,
                "{method}"
            );
            assert_eq!(response.headers()[header::ALLOW], "GET");
        }
    }

    #[test]
    fn each_file_carries_its_content_type() {
        let (_temporary, roots) = fixture();
        for (path, expected) in [
            ("/folders/", "text/html; charset=utf-8"),
            (
                "/folders/assets/index-abc.js",
                "text/javascript; charset=utf-8",
            ),
            ("/folders/assets/index-abc.css", "text/css; charset=utf-8"),
            (
                "/folders/assets/data.json",
                "application/json; charset=utf-8",
            ),
            ("/folders/assets/icon.svg", "image/svg+xml; charset=utf-8"),
            (
                "/apps/com.example.board/0123456789abcdef0123456789abcdef01234567/assets/app.wasm",
                "application/wasm",
            ),
        ] {
            assert_eq!(content_type(&get(&roots, path)), expected, "{path}");
        }
        let response = get(&roots, "/folders/assets/index-abc.js");
        assert_eq!(
            response.headers()[header::X_CONTENT_TYPE_OPTIONS],
            "nosniff"
        );
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    }

    #[test]
    fn a_documents_policy_admits_its_inline_scripts_by_hash() {
        let (_temporary, roots) = fixture();
        let policy = |path: &str| {
            get(&roots, path).headers()[header::CONTENT_SECURITY_POLICY]
                .to_str()
                .unwrap()
                .to_string()
        };
        let boot = format!("'sha256-{}'", STANDARD.encode(Sha256::digest(b"boot()")));
        assert!(policy(BOARD).contains(&boot));
        assert!(policy(
            "/apps/com.example.board/0123456789abcdef0123456789abcdef01234567/board/42"
        )
        .contains(&boot));
        for other in ["/folders/", "/folders/assets/index-abc.js", "/missing/"] {
            let policy = policy(other);
            assert!(!policy.contains("sha256-"), "{other}");
            assert!(
                policy.contains("script-src 'self' 'wasm-unsafe-eval'"),
                "{other}"
            );
            assert!(
                policy.contains("connect-src 'self' ipc: http://ipc.localhost;"),
                "{other}"
            );
            assert!(policy.contains("frame-ancestors 'none'"), "{other}");
            assert!(policy.contains("object-src 'none'"), "{other}");
        }
    }

    #[test]
    fn inline_scripts_are_found_in_any_case_and_skip_external_ones() {
        assert_eq!(
            inline_scripts(
                "<script type=\"module\">a()</script><SCRIPT>b()</Script>\
                 <script src=\"./c.js\"></script><scripts>d</scripts><script\n>e()</script>"
            ),
            ["a()", "b()", "e()"]
        );
        assert!(inline_scripts("<script>unterminated").is_empty());
        assert!(inline_scripts("").is_empty());
    }

    #[test]
    fn urls_and_navigation_stay_on_the_one_origin() {
        assert_eq!(
            url("/folders/").unwrap().as_str(),
            "epicenter-app://localhost/folders/"
        );
        for denied in [
            "epicenter-app://other/folders/",
            "epicenter-app://localhost:1/folders/",
            "epicenter-app://user@localhost/folders/",
            "epicenter://app/home",
            "http://127.0.0.1/folders/",
            "https://api.epicenter.so/dashboard",
        ] {
            assert!(
                !is_allowed_navigation("/folders/", &denied.parse().unwrap()),
                "{denied}"
            );
        }
    }

    /// Each window stays below the path it opened at: Folders, Settings, and
    /// each bundled app at their pages, and an installed app's window at its
    /// app and the commit it opened on, so it never loads another build, even
    /// its own app's newer one.
    #[test]
    fn each_window_navigates_only_below_the_path_it_opened_at() {
        let todos = installed_app_path("so.epicenter.todos", COMMIT);
        let todos_earlier = installed_app_path("so.epicenter.todos", EARLIER);
        let bundled = BundledApp::Todos.path();
        let bundled = bundled.as_str();
        let whispering = BundledApp::Whispering.path();
        let whispering = whispering.as_str();
        assert_eq!(
            url(&todos).unwrap().as_str(),
            format!("epicenter-app://localhost/apps/so.epicenter.todos/{COMMIT}/")
        );
        for (prefix, path) in [
            ("/folders/", "/folders/".to_string()),
            ("/folders/", "/folders/table/notes?row=1#x".to_string()),
            ("/home/", "/home/".to_string()),
            (bundled, "/todos/".to_string()),
            (bundled, "/todos/todo/42".to_string()),
            (whispering, "/whispering/recordings".to_string()),
            (todos.as_str(), todos.clone()),
            (todos.as_str(), format!("{todos}?folder=data%3AGroceries")),
            (todos.as_str(), format!("{todos}todo/42")),
            (todos_earlier.as_str(), format!("{todos_earlier}todo/42")),
        ] {
            assert!(
                is_allowed_navigation(prefix, &url(&path).unwrap()),
                "{prefix} {path}"
            );
        }
        for (prefix, path) in [
            ("/folders/", "/home/".to_string()),
            ("/folders/", "/folders".to_string()),
            ("/home/", "/folders/".to_string()),
            ("/home/", todos.clone()),
            (bundled, "/folders/".to_string()),
            (bundled, "/home/".to_string()),
            (bundled, todos.clone()),
            (bundled, "/whispering/".to_string()),
            (whispering, "/todos/".to_string()),
            (whispering, "/capture/".to_string()),
            ("/folders/", "/todos/".to_string()),
            (todos.as_str(), "/folders/".to_string()),
            (todos.as_str(), "/home/".to_string()),
            (todos.as_str(), todos_earlier.clone()),
            (todos_earlier.as_str(), format!("{todos}todo/42")),
            (todos.as_str(), "/apps/so.epicenter.todos/".to_string()),
            (
                todos.as_str(),
                format!("/apps/so.epicenter.whispering/{COMMIT}/"),
            ),
            (
                todos.as_str(),
                format!("/apps/so.epicenter.todosx/{COMMIT}/"),
            ),
            (todos.as_str(), format!("{todos}../{EARLIER}/")),
            (todos.as_str(), format!("{todos}%2e%2e/{EARLIER}/")),
            (todos.as_str(), format!("{todos}../../../home/")),
            (todos.as_str(), format!("{todos}%2e%2e/%2e%2e/%2e%2e/home/")),
            ("", "/folders/".to_string()),
            ("/apps", todos.clone()),
        ] {
            assert!(
                !is_allowed_navigation(prefix, &url(&path).unwrap()),
                "{prefix} {path}"
            );
        }
    }
}
