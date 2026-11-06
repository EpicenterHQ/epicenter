/// Every command this plugin exposes. The build script generates a permission
/// for each, and a test checks the list against the registered handlers.
pub const COMMANDS: &[&str] = &[
    "open_root",
    "reveal_root",
    "list_folder",
    "list_epicenter",
    "make_epicenter_folder",
    "read_folder_file",
    "put_folder_file",
    "sync_with_epicenter",
    "synced_with_epicenter",
];
