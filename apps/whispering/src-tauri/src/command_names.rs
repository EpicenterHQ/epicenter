/// Every command this app adds beside its plugins', as the build script and
/// the invoke handler name them.
#[allow(dead_code)]
const COMMANDS: &[&str] = &[
    "account_state",
    "account_sign_in",
    "account_sign_out",
    "account_token",
    "secret_get",
    "secret_set",
    "send_request",
    // `epicenter-standalone`'s, which an app registers itself.
    "choose_folder",
    "folder_path",
];
