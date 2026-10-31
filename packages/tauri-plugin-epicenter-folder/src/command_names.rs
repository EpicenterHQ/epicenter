/// Every command this plugin exposes. The build script generates a permission
/// for each, and a test checks the list against the registered handlers.
pub const COMMANDS: &[&str] = &[
    "open_folder",
    "resolve_folder",
    "subscribe_close",
    "unsubscribe_close",
    "destroy_bound_window",
    "list_folder",
    "read_folder_file",
    "put_folder_file",
    "sync_with_epicenter",
    "synced_with_epicenter",
];
