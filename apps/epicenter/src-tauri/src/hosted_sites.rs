//! A published HTTPS hostname opens its reverse-DNS folder in one native window.
//! The page supplies a URL; the host alone chooses the directory and IPC grant.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;

use anyhow::{bail, Context, Result};
use epicenter_folder_core::library;
use tauri::ipc::CapabilityBuilder;
use tauri::webview::{NewWindowResponse, PermissionResponse};
use tauri::{AppHandle, Manager, Runtime, Url, WebviewUrl};
use tauri_plugin_epicenter_folder::{folder_window_label, Directory, FolderExt};

use crate::DesktopPaths;

/// Serializes opening and remembers runtime grants, which Tauri only adds.
#[derive(Default)]
pub struct HostedSites {
    granted: Mutex<HashSet<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Site {
    pub host: String,
    pub area: String,
}

impl Site {
    pub fn parse(input: &str) -> Result<Self> {
        let url = Url::parse(input).context("Enter an HTTPS site URL.")?;
        if url.scheme() != "https"
            || url.port().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
        {
            bail!("Use the site's HTTPS root URL, without a port, path, query, or fragment.");
        }
        let host = url.host_str().context("The site needs a DNS hostname.")?;
        Self::from_host(host)
    }

    fn from_host(host: &str) -> Result<Self> {
        // URL parsing has already made internationalized names ASCII and lower case.
        if host != host.to_ascii_lowercase()
            || host.ends_with('.')
            || host.parse::<std::net::IpAddr>().is_ok()
            || host.split('.').count() < 2
            || host.split('.').any(|label| {
                label.is_empty()
                    || label.starts_with('-')
                    || label.ends_with('-')
                    || !label.bytes().all(|byte| {
                        byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'
                    })
            })
        {
            bail!("A site needs a canonical DNS hostname.");
        }
        let area = host.split('.').rev().collect::<Vec<_>>().join(".");
        // Folder saves create sibling names such as .<area>.epicenter-save-lock.
        if area.len() > 233 {
            bail!("The site's hostname is too long for a folder name.");
        }
        if area == library::RECORDS.id {
            bail!("This URL names Epicenter's own records folder.");
        }
        Ok(Self {
            host: host.into(),
            area,
        })
    }

    pub fn origin(&self) -> String {
        format!("https://{}", self.host)
    }

    pub fn area_path(&self, paths: &DesktopPaths) -> PathBuf {
        paths.folder_dir.join(&self.area)
    }

    fn allows_navigation(&self, url: &Url) -> bool {
        url.scheme() == "https"
            && url.host_str() == Some(&self.host)
            && url.port().is_none()
            && url.username().is_empty()
            && url.password().is_none()
    }
}

fn open<R: Runtime>(app: &AppHandle<R>, site: &Site, granted: &mut HashSet<String>) -> Result<()> {
    let paths = app.state::<DesktopPaths>();
    let path = site.area_path(&paths);
    library::check_app_directory(&paths.data_dir, &paths.folder_dir, &path)
        .map_err(anyhow::Error::msg)?;
    let directory = Directory::create(&path)?;
    let label = folder_window_label("site", directory.root());
    if granted.insert(label.clone()) {
        let grant = CapabilityBuilder::new(format!("site-{label}"))
            .local(false)
            .remote(site.origin())
            .window(label.clone())
            .permission("epicenter-folder:default");
        if let Err(error) = app.add_capability(grant) {
            granted.remove(&label);
            return Err(error.into());
        }
    }
    let url = WebviewUrl::External(site.origin().parse()?);
    #[cfg(all(target_os = "macos", feature = "hosted-site-offline-gate"))]
    let transport = offline_gate::prepare(app, site)?;
    let site = site.clone();
    app.open_folder_window("site", directory, url, move |builder| {
        #[cfg(all(target_os = "macos", feature = "hosted-site-offline-gate"))]
        let builder = offline_gate::configure(builder, transport);
        let navigation_site = site.clone();
        // A reply to an in-flight IPC call must never land on a foreign page.
        Ok(builder
            .title(&site.host)
            .inner_size(1100.0, 760.0)
            .min_inner_size(680.0, 480.0)
            .disable_drag_drop_handler()
            .on_permission_request(|_, _| PermissionResponse::Deny)
            .on_navigation(move |url| navigation_site.allows_navigation(url))
            .on_new_window(|_, _| NewWindowResponse::Deny))
    })?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn open_hosted_site(app: AppHandle<tauri::Wry>, url: String) -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err(
            "Hosted sites need an origin-isolation check on this platform before they can open."
                .into(),
        );
    }
    tauri::async_runtime::spawn_blocking(move || {
        let site = Site::parse(&url).map_err(|error| error.to_string())?;
        let sites = app.state::<HostedSites>();
        let mut granted = sites.granted.lock().map_err(|error| error.to_string())?;
        open(&app, &site, &mut granted).map_err(|error| format!("{error:#}"))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Experiment only, for `evidence/offline-proxy/run-tauri.ts`; not a product
/// proxy. When the gate manages a [`offline_gate::Transport`], `open` gives the
/// site window a local HTTP CONNECT proxy and a WebKit data store of its own,
/// and accepts exactly one leaf certificate for the site's host in that store.
///
/// Wry exposes no authentication-challenge hook, so this adds
/// `webView:didReceiveAuthenticationChallenge:completionHandler:` at runtime to
/// the class of a live built-in WebView's navigation delegate, which is Wry's.
/// WebKit reads a delegate's methods when the delegate is set, so the method
/// must exist before the site WebView is built; `prepare` refuses until then.
/// A product proxy needs a real Wry hook instead. Stores without a pin, and
/// every window built without a `Transport`, keep WebKit's default handling.
#[cfg(all(target_os = "macos", feature = "hosted-site-offline-gate"))]
pub mod offline_gate {
    use std::ffi::{c_char, c_void, CStr, CString};
    use std::ptr::null_mut;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{mpsc, Mutex};

    use anyhow::{anyhow, Result};
    use sha2::{Digest, Sha256};
    use tauri::{AppHandle, Manager, Runtime, Url, WebviewWindowBuilder};
    use tauri_plugin_epicenter_folder::{folder_window_label, Directory};

    use super::{HostedSites, Site};
    use crate::DesktopPaths;

    /// How the gate's site windows reach the network.
    pub struct Transport {
        /// The local HTTP CONNECT proxy, for the site's data store only.
        pub proxy: Url,
        /// DER of the one certificate the site's host may present through it.
        pub pinned_leaf: Vec<u8>,
        /// Keeps one gate run's WebKit stores apart from another's.
        pub store_salt: String,
    }

    pub(super) struct Prepared {
        proxy: Url,
        store: [u8; 16],
    }

    /// The server-trust decisions the added delegate method has made.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct TrustCounts {
        pub matched: usize,
        pub rejected: usize,
        pub default_handling: usize,
    }

    /// What a WKWebView's data store is, as the gate inspects it.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct Store {
        pub address: usize,
        pub identifier: Option<[u8; 16]>,
        pub persistent: bool,
        pub proxies: usize,
    }

    struct Pin {
        store: [u8; 16],
        host: String,
        leaf: Vec<u8>,
    }

    static PINS: Mutex<Vec<Pin>> = Mutex::new(Vec::new());
    /// The delegate class that received the challenge method, once added.
    static INSTALLED: Mutex<Option<String>> = Mutex::new(None);
    static MATCHED: AtomicUsize = AtomicUsize::new(0);
    static REJECTED: AtomicUsize = AtomicUsize::new(0);
    static DEFAULT_HANDLING: AtomicUsize = AtomicUsize::new(0);
    /// The pending completion of `evaluate` or `remove_store`; the gate makes
    /// one such call at a time.
    static REPLY: Mutex<Option<mpsc::Sender<Option<String>>>> = Mutex::new(None);

    pub fn manage<R: Runtime>(app: &AppHandle<R>, transport: Transport) {
        app.manage(HostedSites::default());
        app.manage(transport);
    }

    /// Open `url` as `open_hosted_site` does and return the window's label.
    pub fn open<R: Runtime>(app: &AppHandle<R>, url: &str) -> Result<String> {
        let site = Site::parse(url)?;
        let sites = app.state::<HostedSites>();
        let mut granted = sites.granted.lock().map_err(|error| anyhow!("{error}"))?;
        super::open(app, &site, &mut granted)?;
        let paths = app.state::<DesktopPaths>();
        let directory = Directory::existing(&site.area_path(&paths))?;
        Ok(folder_window_label("site", directory.root()))
    }

    /// The data store identifier this run gives `host`.
    pub fn store_identifier(host: &str, salt: &str) -> [u8; 16] {
        let digest = Sha256::digest(format!("epicenter-site-store\0{salt}\0{host}"));
        let mut identifier = [0; 16];
        identifier.copy_from_slice(&digest[..16]);
        identifier
    }

    pub fn trust_counts() -> TrustCounts {
        TrustCounts {
            matched: MATCHED.load(Ordering::SeqCst),
            rejected: REJECTED.load(Ordering::SeqCst),
            default_handling: DEFAULT_HANDLING.load(Ordering::SeqCst),
        }
    }

    pub(super) fn prepare<R: Runtime>(app: &AppHandle<R>, site: &Site) -> Result<Option<Prepared>> {
        let Some(transport) = app.try_state::<Transport>() else {
            return Ok(None);
        };
        if INSTALLED
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_none()
        {
            return Err(anyhow!(
                "Add the challenge method from a live built-in WebView before opening a site."
            ));
        }
        let store = store_identifier(&site.host, &transport.store_salt);
        let mut pins = PINS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        pins.retain(|pin| pin.store != store);
        pins.push(Pin {
            store,
            host: site.host.clone(),
            leaf: transport.pinned_leaf.clone(),
        });
        Ok(Some(Prepared {
            proxy: transport.proxy.clone(),
            store,
        }))
    }

    pub(super) fn configure<'a, R: Runtime, M: Manager<R>>(
        builder: WebviewWindowBuilder<'a, R, M>,
        prepared: Option<Prepared>,
    ) -> WebviewWindowBuilder<'a, R, M> {
        match prepared {
            Some(prepared) => builder
                .proxy_url(prepared.proxy)
                .data_store_identifier(prepared.store),
            None => builder,
        }
    }

    #[link(name = "objc")]
    extern "C" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *const c_void;
        fn object_getClass(object: *mut c_void) -> *mut c_void;
        fn class_getName(class: *mut c_void) -> *const c_char;
        fn class_getSuperclass(class: *mut c_void) -> *mut c_void;
        fn class_getInstanceMethod(class: *mut c_void, selector: *const c_void) -> *const c_void;
        fn class_addMethod(
            class: *mut c_void,
            selector: *const c_void,
            implementation: *const c_void,
            types: *const c_char,
        ) -> bool;
        fn objc_msgSend();
    }

    #[link(name = "Security", kind = "framework")]
    extern "C" {
        fn SecTrustCopyCertificateChain(trust: *mut c_void) -> *const c_void;
        fn SecCertificateCopyData(certificate: *const c_void) -> *const c_void;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFArrayGetCount(array: *const c_void) -> isize;
        fn CFArrayGetValueAtIndex(array: *const c_void, index: isize) -> *const c_void;
        fn CFDataGetLength(data: *const c_void) -> isize;
        fn CFDataGetBytePtr(data: *const c_void) -> *const u8;
        fn CFRelease(value: *const c_void);
    }

    extern "C" {
        static _NSConcreteGlobalBlock: u8;
    }

    /// Message `receiver` through `objc_msgSend` cast to the method's C signature.
    macro_rules! send {
        ($receiver:expr, $selector:literal $(, $argument:expr => $kind:ty)* ; $output:ty) => {{
            let send: unsafe extern "C" fn(*mut c_void, *const c_void $(, $kind)*) -> $output =
                std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            send(
                $receiver,
                sel_registerName(concat!($selector, "\0").as_ptr().cast())
                $(, $argument)*
            )
        }};
    }

    unsafe fn class(name: &CStr) -> *mut c_void {
        objc_getClass(name.as_ptr())
    }

    unsafe fn responds(receiver: *mut c_void, selector: &CStr) -> bool {
        let selector = sel_registerName(selector.as_ptr());
        send!(receiver, "respondsToSelector:", selector => *const c_void; bool)
    }

    unsafe fn string(value: *mut c_void) -> Option<String> {
        if value.is_null()
            || !send!(value, "isKindOfClass:", class(c"NSString") => *mut c_void; bool)
        {
            return None;
        }
        let text = send!(value, "UTF8String"; *const c_char);
        if text.is_null() {
            return None;
        }
        Some(CStr::from_ptr(text).to_string_lossy().into_owned())
    }

    /// The layout every Objective-C block begins with (Clang's block ABI).
    #[repr(C)]
    struct Block {
        isa: *const c_void,
        flags: i32,
        reserved: i32,
        invoke: *const c_void,
        descriptor: *const BlockDescriptor,
    }

    #[repr(C)]
    struct BlockDescriptor {
        reserved: usize,
        size: usize,
    }

    static DESCRIPTOR: BlockDescriptor = BlockDescriptor {
        reserved: 0,
        size: std::mem::size_of::<Block>(),
    };

    /// A block that captures nothing, which WebKit may copy and call later.
    fn global_block(invoke: *const c_void) -> *const Block {
        const BLOCK_IS_GLOBAL: i32 = 1 << 28;
        Box::leak(Box::new(Block {
            isa: std::ptr::addr_of!(_NSConcreteGlobalBlock).cast(),
            flags: BLOCK_IS_GLOBAL,
            reserved: 0,
            invoke,
            descriptor: &DESCRIPTOR,
        }))
    }

    const CHALLENGE: &CStr = c"webView:didReceiveAuthenticationChallenge:completionHandler:";

    unsafe fn class_name(class: *mut c_void) -> String {
        CStr::from_ptr(class_getName(class))
            .to_string_lossy()
            .into_owned()
    }

    /// The runtime class of `webview`'s navigation delegate, skipping a KVO
    /// subclass: Wry builds each new delegate from the class beneath it.
    unsafe fn delegate_class(webview: *mut c_void) -> Result<(*mut c_void, *mut c_void), String> {
        let delegate = send!(webview, "navigationDelegate"; *mut c_void);
        if delegate.is_null() {
            return Err("The WebView has no navigation delegate.".into());
        }
        let mut class = object_getClass(delegate);
        while !class.is_null() && class_name(class).starts_with("NSKVONotifying_") {
            class = class_getSuperclass(class);
        }
        if class.is_null() {
            return Err("The navigation delegate has no class.".into());
        }
        Ok((delegate, class))
    }

    /// Add the challenge method to the class of a live built-in WebView's
    /// navigation delegate, which is Wry's, and return that class's name.
    /// Every WebView built afterwards gets a delegate that answers challenges;
    /// those built before keep WebKit's default handling.
    ///
    /// # Safety
    ///
    /// `webview` is a live `WKWebView` and this runs on the main thread.
    pub unsafe fn install_challenge_method(webview: *mut c_void) -> Result<String, String> {
        let mut installed = INSTALLED
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(name) = installed.as_ref() {
            return Ok(name.clone());
        }
        let (delegate, class) = delegate_class(webview)?;
        let name = class_name(class);
        if !responds(
            delegate,
            c"webView:decidePolicyForNavigationAction:decisionHandler:",
        ) {
            return Err(format!(
                "{name} does not decide navigation, so it is not Wry's delegate."
            ));
        }
        let selector = sel_registerName(CHALLENGE.as_ptr());
        if !class_getInstanceMethod(class, selector).is_null() {
            return Err(format!(
                "{name} already answers authentication challenges; use Wry's hook instead."
            ));
        }
        if !class_addMethod(
            class,
            selector,
            did_receive_challenge as *const c_void,
            c"v@:@@@?".as_ptr(),
        ) {
            return Err(format!("{name} refused the challenge method."));
        }
        log::info!("added the authentication challenge method to {name}");
        *installed = Some(name.clone());
        Ok(name)
    }

    /// Diagnostic: the name of the class of `webview`'s navigation delegate,
    /// and whether that delegate now answers authentication challenges.
    ///
    /// # Safety
    ///
    /// `webview` is a live `WKWebView` and this runs on the main thread.
    pub unsafe fn delegate_answers_challenges(
        webview: *mut c_void,
    ) -> Result<(String, bool), String> {
        let (delegate, class) = delegate_class(webview)?;
        Ok((class_name(class), responds(delegate, CHALLENGE)))
    }

    type ChallengeReply = unsafe extern "C" fn(*const Block, isize, *mut c_void);

    unsafe extern "C" fn did_receive_challenge(
        _delegate: *mut c_void,
        _selector: *const c_void,
        webview: *mut c_void,
        challenge: *mut c_void,
        reply: *const Block,
    ) {
        let (disposition, credential) = decide(webview, challenge);
        let reply_with: ChallengeReply = std::mem::transmute((*reply).invoke);
        reply_with(reply, disposition, credential);
    }

    /// `NSURLSessionAuthChallengeDisposition` and its credential.
    unsafe fn decide(webview: *mut c_void, challenge: *mut c_void) -> (isize, *mut c_void) {
        const USE_CREDENTIAL: isize = 0;
        const PERFORM_DEFAULT_HANDLING: isize = 1;
        const CANCEL: isize = 2;
        let space = send!(challenge, "protectionSpace"; *mut c_void);
        let host = string(send!(space, "host"; *mut c_void));
        let store = store_of(webview).identifier;
        let pins = PINS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(pin) = pins
            .iter()
            .find(|pin| Some(pin.store) == store && host.as_deref() == Some(pin.host.as_str()))
        else {
            DEFAULT_HANDLING.fetch_add(1, Ordering::SeqCst);
            return (PERFORM_DEFAULT_HANDLING, null_mut());
        };
        let method = string(send!(space, "authenticationMethod"; *mut c_void));
        let trust = send!(space, "serverTrust"; *mut c_void);
        if method.as_deref() == Some("NSURLAuthenticationMethodServerTrust")
            && !trust.is_null()
            && leaf_certificate(trust).as_deref() == Some(pin.leaf.as_slice())
        {
            MATCHED.fetch_add(1, Ordering::SeqCst);
            let credential = send!(
                class(c"NSURLCredential"),
                "credentialForTrust:",
                trust => *mut c_void;
                *mut c_void
            );
            return (USE_CREDENTIAL, credential);
        }
        REJECTED.fetch_add(1, Ordering::SeqCst);
        log::warn!(
            "refused {} for {}: not its pinned certificate",
            pin.host,
            method.unwrap_or_default()
        );
        (CANCEL, null_mut())
    }

    unsafe fn leaf_certificate(trust: *mut c_void) -> Option<Vec<u8>> {
        let chain = SecTrustCopyCertificateChain(trust);
        if chain.is_null() {
            return None;
        }
        let mut leaf = None;
        if CFArrayGetCount(chain) > 0 {
            let data = SecCertificateCopyData(CFArrayGetValueAtIndex(chain, 0));
            if !data.is_null() {
                let length = CFDataGetLength(data) as usize;
                leaf = Some(std::slice::from_raw_parts(CFDataGetBytePtr(data), length).to_vec());
                CFRelease(data);
            }
        }
        CFRelease(chain);
        leaf
    }

    /// # Safety
    ///
    /// `webview` is a live `WKWebView` and this runs on the main thread.
    pub unsafe fn store_of(webview: *mut c_void) -> Store {
        let configuration = send!(webview, "configuration"; *mut c_void);
        let store = send!(configuration, "websiteDataStore"; *mut c_void);
        let mut identifier = None;
        if responds(store, c"identifier") {
            let uuid = send!(store, "identifier"; *mut c_void);
            if !uuid.is_null() {
                let mut bytes = [0u8; 16];
                send!(uuid, "getUUIDBytes:", bytes.as_mut_ptr() => *mut u8; ());
                identifier = Some(bytes);
            }
        }
        let mut proxies = 0;
        if responds(store, c"proxyConfigurations") {
            let configurations = send!(store, "proxyConfigurations"; *mut c_void);
            if !configurations.is_null() {
                proxies = send!(configurations, "count"; usize);
            }
        }
        Store {
            address: store as usize,
            identifier,
            persistent: send!(store, "isPersistent"; bool),
            proxies,
        }
    }

    /// Run `script` in the page and send its result, when it is a string.
    ///
    /// # Safety
    ///
    /// `webview` is a live `WKWebView` and this runs on the main thread.
    pub unsafe fn evaluate(
        webview: *mut c_void,
        script: &str,
        reply: mpsc::Sender<Option<String>>,
    ) {
        *REPLY
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(reply);
        let script = CString::new(script).expect("a gate script has no NUL");
        let source = send!(
            class(c"NSString"),
            "stringWithUTF8String:",
            script.as_ptr() => *const c_char;
            *mut c_void
        );
        let done = global_block(evaluated as *const c_void);
        send!(
            webview,
            "evaluateJavaScript:completionHandler:",
            source => *mut c_void,
            done => *const Block;
            ()
        );
    }

    unsafe extern "C" fn evaluated(_block: *const Block, result: *mut c_void, _error: *mut c_void) {
        let value = string(result);
        if let Some(reply) = REPLY
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        {
            let _ = reply.send(value);
        }
    }

    /// Delete a gate store once no WebView uses it, sending WebKit's error.
    ///
    /// # Safety
    ///
    /// This runs on the main thread.
    pub unsafe fn remove_store(identifier: [u8; 16], reply: mpsc::Sender<Option<String>>) {
        *REPLY
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(reply);
        let uuid = send!(class(c"NSUUID"), "alloc"; *mut c_void);
        let uuid = send!(uuid, "initWithUUIDBytes:", identifier.as_ptr() => *const u8; *mut c_void);
        let done = global_block(removed as *const c_void);
        send!(
            class(c"WKWebsiteDataStore"),
            "removeDataStoreForIdentifier:completionHandler:",
            uuid => *mut c_void,
            done => *const Block;
            ()
        );
    }

    unsafe extern "C" fn removed(_block: *const Block, error: *mut c_void) {
        let message = if error.is_null() {
            None
        } else {
            string(send!(error, "localizedDescription"; *mut c_void))
        };
        if let Some(reply) = REPLY
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        {
            let _ = reply.send(message);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_https_hostnames_name_one_area_and_origin() {
        let site = Site::parse("https://Todos.Acme.dev/").unwrap();
        assert_eq!(site.area, "dev.acme.todos");
        assert_eq!(site.origin(), "https://todos.acme.dev");
        assert!(site.allows_navigation(&"https://todos.acme.dev/tasks/1".parse().unwrap()));
        assert!(!site.allows_navigation(&"https://other.acme.dev/".parse().unwrap()));
        assert!(!site.allows_navigation(&"http://todos.acme.dev/".parse().unwrap()));
        for url in [
            "http://todos.acme.dev",
            "https://todos.acme.dev/x",
            "https://todos.acme.dev:8443/",
            "https://epicenter.so/",
            "https://127.0.0.1/",
            "https://todos.acme.dev/?x=1",
        ] {
            assert!(Site::parse(url).is_err(), "{url}");
        }
        assert!(Site::parse(&format!(
            "https://{}.{}.{}.{}.com",
            "a".repeat(57),
            "b".repeat(57),
            "c".repeat(57),
            "d".repeat(57)
        ))
        .is_err());
    }
}
