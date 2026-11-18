/// Every command Whispering's window calls beside its plugins': the
/// Keychain's (`secrets.rs`), `set_shortcut` (`shortcut.rs`), and the file
/// commands (`files.rs`). The build script declares them, so each
/// `allow-<command>` is the one permission that lets a window call it.
#[allow(dead_code)]
const COMMANDS: &[&str] = &[
    "secret_get",
    "secret_set",
    "set_shortcut",
    "files_read",
    "files_read_many",
    "files_write",
    "files_list",
    "files_remove",
    "files_change_folder",
    "folder_git",
];
