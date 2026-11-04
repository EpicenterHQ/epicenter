/// Every command Whispering's window calls beside its plugins': the shared
/// account's and its connections' (`epicenter_account::COMMANDS` and
/// `CONNECTION_COMMANDS`, which a test holds this list to), `send_request`
/// (`http.rs`) and `set_shortcut` (`shortcut.rs`). The build script declares them, so
/// each `allow-<command>` is the one permission that lets a window call it.
/// Spelled out rather than read from `epicenter_account` so the build
/// script does not compile Tauri a second time for the host.
#[allow(dead_code)]
const COMMANDS: &[&str] = &[
    "account_state",
    "account_sign_in",
    "account_sign_out",
    "account_fetch",
    "account_fetch_cancel",
    "keychain_get",
    "keychain_set",
    "connection_fetch",
    "connection_fetch_cancel",
    "send_request",
    "set_shortcut",
];
