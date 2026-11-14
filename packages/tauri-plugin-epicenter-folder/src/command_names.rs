/// Every command this plugin exposes. The build script generates a permission
/// for each, and a test checks the list against the registered handlers.
pub const COMMANDS: &[&str] = &[
    "open_root",
    "reveal_root",
    "list_folder",
    "read_folder_file",
    "put_folder_file",
    "root_identity",
    "data_record",
];
